// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {UtuhRegistry} from "./UtuhRegistry.sol";
import {EventScope} from "./lib/EventScope.sol";
import {IBlockProver, BlockProverLib} from "./interfaces/IBlockProver.sol";
import {IChainInfo, ChainInfoLib} from "./interfaces/IChainInfo.sol";

/// @title UtuhCredit — undercollateralized credit on Creditcoin, underwritten on Ethereum
/// @author Utuh
///
/// @notice Nothing bridges. The borrower's history stays on Ethereum, the credit is issued in
/// CTC on Creditcoin, and repayment happens back on Ethereum. The only thing that crosses is
/// proof.
///
/// ## What makes this different from a credit score
///
/// Underwriting rests on two claims in {UtuhRegistry}, and they are adversarial in opposite
/// directions on purpose:
///
///  - **Volume** — the borrower's proven repayment history. Every member was verified by the
///    Attestcoin Block Prover on the way in, so the borrower cannot inflate it.
///  - **Clean** — the complete set of the borrower's liquidations over the same range, which the
///    borrower asserts is empty. Here omission is what pays, so the assertion carries a bond and
///    anyone holding a single liquidation proof can take it.
///
/// "This address has never been liquidated" is the sentence every on-chain credit score needs and
/// none of them can prove. An inclusion proof cannot speak about events that do not exist. Utuh
/// does not prove it either — it makes the claim expensive to get wrong and leaves it standing
/// only if nobody knocks it down.
///
/// ## Default without proving a negative
///
/// A drawn line is settled by the borrower proving repayment. If no finalized claim arrives
/// before the deadline, the line defaults. The contract never has to establish that a payment
/// was missed; the burden sits with the party who can discharge it. Silence is the default
/// condition, not an inference.
contract UtuhCredit {
    UtuhRegistry public immutable REGISTRY;
    IChainInfo public immutable CHAIN_INFO;

    /// @notice Fraction of proven repayment volume extended as credit, in basis points.
    uint256 public constant LTV_BPS = 2000; // 20%

    /// @notice CTC wei credited per one unit of the volume claim's reserve asset.
    /// @dev A volume claim aggregates `amount` in the source asset's own decimals — 1e6 for USDC —
    ///      while a line is denominated in CTC wei at 1e18. Something has to bridge the two, and
    ///      it is a price. There is no oracle here and none is faked: the lender fixes the rate
    ///      when it deploys, and it is visible on-chain for anyone to judge. A lender who wants a
    ///      live price puts a feed in front of this contract rather than pretending the protocol
    ///      knows one.
    uint256 public immutable VOLUME_UNIT_IN_CTC;

    /// @notice Credit extended per unit of enforceable loss behind the clean claim.
    /// @dev This is the consumer half of the bond mechanism. The registry cannot know what a claim
    ///      will be used for, so it cannot size the stake; only the party about to lend knows its
    ///      own exposure. A line is never allowed to risk more than a liar is certain to lose.
    ///
    ///      "Certain to lose" is the burned share, not the whole bond — see
    ///      {UtuhRegistry.enforceableLoss}. Measuring against the bond, as this did at first, let
    ///      a line carry twice the exposure the deterrent actually covered.
    uint256 public constant BOND_MULTIPLE = 10;

    /// @notice Minimum span of source-chain history an underwriting must cover.
    /// @dev A clean claim over a short window is cheap to keep clean and says almost nothing. How
    ///      much history is enough is a credit policy rather than a property of the protocol, so
    ///      the lender sets it. {RECOMMENDED_HISTORY_BLOCKS} is about 30 days of Ethereum blocks.
    uint64 public immutable MIN_HISTORY_BLOCKS;
    uint64 public constant RECOMMENDED_HISTORY_BLOCKS = 216_000;

    /// @notice Shortest challenge window an underwriting claim may have carried.
    /// @dev The registry lets each claimant pick a window above its floor, so a lender that only
    ///      checks the bond would happily rely on a claim that was exposed for a handful of
    ///      blocks. Exposure is a function of both how much was staked and how long anyone had to
    ///      take it, and only the lender can say which pairs it will accept — so this is set per
    ///      deployment, like the registry's own floor. The production value is
    ///      {RECOMMENDED_UNDERWRITING_WINDOW}.
    uint64 public immutable MIN_UNDERWRITING_WINDOW;
    uint64 public constant RECOMMENDED_UNDERWRITING_WINDOW = 5760; // ~24h

    /// @notice Tag that distinguishes a control commitment from ordinary calldata.
    bytes12 public constant CONTROL_TAG = bytes12("utuh:control");

    /// @notice How far behind the attestation frontier an underwriting range may end.
    /// @dev Otherwise a borrower could underwrite on a spotless year that ended the day before the
    ///      liquidation that ruined them. Lender policy as well;
    ///      {RECOMMENDED_STALENESS_BLOCKS} is about 7 days.
    uint64 public immutable MAX_STALENESS_BLOCKS;
    uint64 public constant RECOMMENDED_STALENESS_BLOCKS = 50_400;

    /// @notice What a draw must repay, in basis points of what it paid out.
    /// @dev 10_000 is principal only; anything above it is the lender's spread. Terms belong to
    ///      whoever is lending, which is the whole reason this is not a parameter of {draw}.
    uint64 public immutable REPAYMENT_BPS;

    /// @notice How long a borrower has to prove repayment, in Creditcoin blocks.
    uint64 public immutable REPAY_WINDOW_BLOCKS;

    /// @notice Describes a class of source-chain events about a subject address.
    /// @dev Set once by the deployer for each of the two roles. Underwriting rebuilds the exact
    ///      scope a claim must carry from this template plus the borrower's own address, then
    ///      compares scope identities — so a borrower cannot underwrite with a claim about some
    ///      other address, some other contract, or some other event.
    struct HistorySpec {
        uint64 chainKey;
        address emitter;
        bytes32 eventSig;
        uint8 subjectTopic; // 1..3: which indexed topic carries the subject address
        uint8 counterpartyTopic; // 0 = unconstrained, else 1..3
        address counterparty; // required value at counterpartyTopic
        EventScope.Metric metric;
        uint8 metricArg;
    }

    enum LineStatus {
        None,
        Active,
        Settled,
        Defaulted
    }

    /// @notice A source-chain transaction offered as proof that its sender controls that address.
    struct ControlProof {
        uint64 chainKey;
        uint64 blockHeight;
        bytes encodedTransaction;
        bytes32 merkleRoot;
        IBlockProver.MerkleProofEntry[] siblings;
    }

    struct Line {
        address borrower;
        address subject; // the source-chain address this line was underwritten on
        LineStatus status;
        uint256 limit; // CTC
        uint256 drawn; // CTC
        uint256 repayRequired; // source-chain units, e.g. USDC 1e6
        uint64 repayFrom; // source-chain block the repayment claim must start at
        uint64 dueBlock; // Creditcoin block by which repayment must be proven
        bytes32 repayScopeId; // the only scope a settling claim may carry
    }

    HistorySpec public volumeSpec; // e.g. Aave V3 Repay(user)
    HistorySpec public repaySpec; // e.g. USDC Transfer(borrower -> lender)

    /// @notice Every adverse-event class a borrower must come up clean on.
    /// @dev A real history is spread across protocols, and one clean claim only ever speaks about
    ///      the contract its scope names. A borrower with a spotless Aave record and a liquidated
    ///      Compound position is not clean, and a lender that asked about Aave alone would never
    ///      find out. So the lender lists what it cares about and a line requires one finalized,
    ///      empty claim per entry.
    HistorySpec[] private _cleanSpecs;

    address public immutable LENDER;

    IBlockProver public immutable PROVER;

    uint256 public nextLineId = 1;
    mapping(uint256 => Line) private _lines;

    /// @notice Creditcoin account each source-chain address has bound itself to.
    mapping(address => address) public controllerOf;

    /// @notice Claims already spent on a line, so one underwriting funds one line.
    /// @dev Without this the same finalized pair could open lines without limit, and the bond cap
    ///      would bound each line while bounding nothing in aggregate.
    mapping(uint256 => bool) public claimSpent;

    /// @notice First source-chain block whose payments a subject has not already spent settling.
    /// @dev Marking claims spent stops a claim being reused; it does not stop a *payment* being
    ///      reused. A borrower with two lines could build two claims over overlapping ranges, both
    ///      containing the same transfer, and settle both with one payment. The watermark makes
    ///      each settlement consume the range it rests on, so the next one has to prove money that
    ///      has not already discharged a debt.
    mapping(address => uint64) public settledThrough;

    /// @notice CTC deposited by the lender and not yet drawn.
    uint256 public available;

    event LineOpened(
        uint256 indexed lineId,
        address indexed borrower,
        address indexed subject,
        uint256 limit,
        uint256 volumeClaimId,
        uint256 cleanClaimCount
    );
    event Drawn(uint256 indexed lineId, uint256 amount, uint64 dueBlock, uint256 repayRequired);
    event Settled(uint256 indexed lineId, uint256 repayClaimId, uint256 proven);
    event Defaulted(uint256 indexed lineId, uint256 outstanding);
    event Funded(uint256 amount);
    event Withdrawn(uint256 amount);
    event ControlProven(address indexed subject, address indexed account, uint64 blockHeight);

    error NotLender();
    error ClaimNotUsable(uint256 claimId, uint256 requiredBond);
    error ScopeMismatch(bytes32 expected, bytes32 actual);
    error RangeMismatch();
    error RepaymentAlreadyCounted(uint64 fromBlock, uint64 required);
    error HistoryTooShort(uint64 span, uint64 required);
    error UnderwritingStale(uint64 toBlock, uint64 frontier);
    error NotClean(uint256 adverseCount);
    error NoCredit();
    error WrongLineStatus(LineStatus expected, LineStatus actual);
    error ExceedsLimit(uint256 requested, uint256 remaining);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error NotBorrower();
    error PastDue(uint64 nowBlock, uint64 dueBlock);
    error NotYetDue(uint64 nowBlock, uint64 dueBlock);
    error RepaymentShort(uint256 proven, uint256 required);
    error BadSubjectTopic(uint8 topic);
    error TransferFailed();
    error ProofRejected();
    error TransactionFailedOnSource(uint8 receiptStatus);
    error UnsupportedTransactionType(uint8 txType);
    error NotAControlCommitment();
    error SubjectNotControlled(address subject, address caller);
    error ClaimAlreadySpent(uint256 claimId);
    error WindowTooShort(uint64 window, uint64 required);
    error NothingToWithdraw();
    error BadTerms();
    error NoCleanSpecs();
    error WrongNumberOfCleanClaims(uint256 given, uint256 required);

    /// @notice Thresholds the lender chooses, gathered so the constructor stays legible.
    struct Policy {
        uint256 volumeUnitInCtc;
        uint64 minUnderwritingWindow;
        uint64 minHistoryBlocks;
        uint64 maxStalenessBlocks;
        uint64 repaymentBps; // what must come back, in basis points of what went out
        uint64 repayWindowBlocks; // how long the borrower has
    }

    constructor(
        UtuhRegistry registry,
        Policy memory policy,
        HistorySpec memory volume,
        HistorySpec[] memory clean,
        HistorySpec memory repay
    ) {
        uint256 volumeUnitInCtc = policy.volumeUnitInCtc;
        uint64 minUnderwritingWindow = policy.minUnderwritingWindow;
        if (volumeUnitInCtc == 0) revert NoCredit();
        if (minUnderwritingWindow < registry.ABSOLUTE_MIN_CHALLENGE_WINDOW()) {
            revert WindowTooShort(minUnderwritingWindow, registry.ABSOLUTE_MIN_CHALLENGE_WINDOW());
        }
        if (policy.minHistoryBlocks == 0 || policy.maxStalenessBlocks == 0) revert NoCredit();
        if (policy.repaymentBps < 10_000 || policy.repayWindowBlocks == 0) revert BadTerms();
        REPAYMENT_BPS = policy.repaymentBps;
        REPAY_WINDOW_BLOCKS = policy.repayWindowBlocks;
        MIN_UNDERWRITING_WINDOW = minUnderwritingWindow;
        MIN_HISTORY_BLOCKS = policy.minHistoryBlocks;
        MAX_STALENESS_BLOCKS = policy.maxStalenessBlocks;
        VOLUME_UNIT_IN_CTC = volumeUnitInCtc;
        REGISTRY = registry;
        CHAIN_INFO = ChainInfoLib.getChainInfo();
        PROVER = BlockProverLib.getProver();
        LENDER = msg.sender;
        if (clean.length == 0) revert NoCleanSpecs();
        _requireSpec(volume);
        _requireSpec(repay);
        for (uint256 i = 0; i < clean.length; i++) {
            _requireSpec(clean[i]);
            _cleanSpecs.push(clean[i]);
        }
        volumeSpec = volume;
        repaySpec = repay;
    }

    function _requireTopic(uint8 t) private pure {
        if (t == 0 || t > 3) revert BadSubjectTopic(t);
    }

    function _requireSpec(HistorySpec memory spec) private pure {
        _requireTopic(spec.subjectTopic);
        if (spec.counterpartyTopic > 3) revert BadSubjectTopic(spec.counterpartyTopic);
        if (spec.counterpartyTopic == spec.subjectTopic) revert BadSubjectTopic(spec.counterpartyTopic);
    }

    // ------------------------------------------------------------------
    // Liquidity
    // ------------------------------------------------------------------

    function fund() external payable {
        if (msg.sender != LENDER) revert NotLender();
        available += msg.value;
        emit Funded(msg.value);
    }

    /// @notice Take back liquidity that has not been drawn.
    function withdraw(uint256 amount) external {
        if (msg.sender != LENDER) revert NotLender();
        if (amount == 0 || amount > available) revert NothingToWithdraw();
        available -= amount;
        emit Withdrawn(amount);
        _pay(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Proving control of a source-chain address
    // ------------------------------------------------------------------

    /// @notice Bind a source-chain address to a Creditcoin account by proving a transaction the
    ///         source address itself sent.
    ///
    /// @dev Underwriting reads someone's Ethereum history. Without this step, reading it would be
    ///      enough to borrow against it — anyone could point at a stranger's spotless record and
    ///      draw on it. The history is public; the key that wrote it is not.
    ///
    ///      The commitment is an ordinary Ethereum transaction from `subject` whose calldata is
    ///      exactly {CONTROL_TAG} followed by the Creditcoin account being bound. Nothing but the
    ///      subject key can produce it, and the tag keeps it from colliding with real calldata.
    ///      The `from` field comes out of bytes the Block Prover has already verified.
    ///
    ///      Any supported source chain will do, because an EOA address is derived from its public
    ///      key and is the same on all of them. Sepolia gas is cheaper than mainnet gas and proves
    ///      exactly as much.
    // slither-disable-next-line reentrancy-benign,reentrancy-events
    function proveControl(ControlProof calldata p, IBlockProver.ContinuityProof calldata continuity)
        external
        returns (address subject, address account)
    {
        if (!PROVER.verifyAndEmit(
                p.chainKey,
                p.blockHeight,
                p.encodedTransaction,
                IBlockProver.MerkleProof({root: p.merkleRoot, siblings: p.siblings}),
                continuity
            )) revert ProofRejected();

        (subject, account) = _readControlTx(p.encodedTransaction);
        controllerOf[subject] = account;

        emit ControlProven(subject, account, p.blockHeight);
    }

    /// @dev Everything here is read out of bytes the prover has already vouched for.
    function _readControlTx(bytes calldata encodedTransaction) private pure returns (address subject, address account) {
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) revert UnsupportedTransactionType(txType);

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionFailedOnSource(receipt.receiptStatus);

        EvmV1Decoder.CommonTxFields memory fields = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        (bool ok, address bound) = _readCommitment(fields.data);
        if (!ok) revert NotAControlCommitment();

        return (fields.from, bound);
    }

    /// @dev calldata is CONTROL_TAG (12 bytes) followed by a 20-byte address.
    ///
    ///      `internal` rather than `private` so a test can reach it. This is the check that decides
    ///      whether an address may be bound to an account, and getting it wrong in the permissive
    ///      direction lets a stranger claim someone else's history — the worst failure the contract
    ///      has. Reaching it through {proveControl} means going through `0x0FD2`, which no local
    ///      test can execute, so it would otherwise be exercised only by the demo's happy path.
    function _readCommitment(bytes memory data) internal pure returns (bool ok, address account) {
        if (data.length != 32) return (false, address(0));
        bytes32 word;
        assembly {
            word := mload(add(data, 0x20))
        }
        if (bytes12(word) != CONTROL_TAG) return (false, address(0));
        return (true, address(uint160(uint256(word))));
    }

    /// @notice The calldata a subject must send on the source chain to bind `account`.
    function controlCommitment(address account) external pure returns (bytes memory) {
        return abi.encodePacked(CONTROL_TAG, account);
    }

    // ------------------------------------------------------------------
    // Underwriting
    // ------------------------------------------------------------------

    /// @notice Rebuild the exact scope a claim must carry for `subject` under `spec`.
    function expectedScope(HistorySpec memory spec, address subject) public pure returns (EventScope.Scope memory s) {
        s.chainKey = spec.chainKey;
        s.emitter = spec.emitter;
        s.eventSig = spec.eventSig;
        s.topics[spec.subjectTopic - 1] = bytes32(uint256(uint160(subject)));
        s.topicMask = uint8(1) << (spec.subjectTopic - 1);
        // A repayment scope has to pin the destination as well, or "repaying" would be
        // satisfiable by sending funds to oneself.
        if (spec.counterpartyTopic != 0) {
            s.topics[spec.counterpartyTopic - 1] = bytes32(uint256(uint160(spec.counterparty)));
            s.topicMask |= uint8(1) << (spec.counterpartyTopic - 1);
        }
        s.metric = spec.metric;
        s.metricArg = spec.metricArg;
    }

    /// @notice Open a credit line for `subject`'s Ethereum history.
    /// @param volumeClaimId A finalized claim over the borrower's proven repayment volume.
    /// @param cleanClaimIds One finalized claim per configured adverse-event class, each
    ///        asserting the complete set of the borrower's liquidations there — normally empty.
    /// @dev Both claims must cover the *same* source-chain range. Splitting them would let a
    ///      borrower pair a long volume history with a short clean window.
    function openLine(address subject, uint256 volumeClaimId, uint256[] calldata cleanClaimIds)
        external
        returns (uint256 lineId)
    {
        // Reading a history is not the same as owning it.
        if (controllerOf[subject] != msg.sender) revert SubjectNotControlled(subject, msg.sender);
        if (cleanClaimIds.length != _cleanSpecs.length) {
            revert WrongNumberOfCleanClaims(cleanClaimIds.length, _cleanSpecs.length);
        }

        // One underwriting funds one line. Otherwise the cap would bound each line while bounding
        // nothing in aggregate.
        _spend(volumeClaimId);

        UtuhRegistry.Claim memory vol = REGISTRY.claim(volumeClaimId);
        if (vol.challengeWindow < MIN_UNDERWRITING_WINDOW) {
            revert WindowTooShort(vol.challengeWindow, MIN_UNDERWRITING_WINDOW);
        }
        _requireScope(volumeSpec, subject, vol.scope);

        uint64 span = vol.toBlock - vol.fromBlock;
        if (span < MIN_HISTORY_BLOCKS) revert HistoryTooShort(span, MIN_HISTORY_BLOCKS);

        uint64 frontier = CHAIN_INFO.get_latest_attestation_height_and_hash(vol.scope.chainKey).height;
        if (frontier > vol.toBlock + MAX_STALENESS_BLOCKS) revert UnderwritingStale(vol.toBlock, frontier);

        uint256 limit = (vol.aggregate * VOLUME_UNIT_IN_CTC * LTV_BPS) / 10_000;
        uint256 cap = _checkClean(subject, vol, cleanClaimIds);
        if (limit > cap) limit = cap;
        if (limit == 0) revert NoCredit();

        // Now that the exposure is known, hold every claim it rests on to it.
        _requireUsable(volumeClaimId, limit / BOND_MULTIPLE);
        for (uint256 i = 0; i < cleanClaimIds.length; i++) {
            _requireUsable(cleanClaimIds[i], limit / BOND_MULTIPLE);
        }

        lineId = nextLineId++;
        Line storage l = _lines[lineId];
        l.borrower = msg.sender;
        l.subject = subject;
        l.status = LineStatus.Active;
        l.limit = limit;
        l.repayFrom = vol.toBlock;
        l.repayScopeId = EventScope.id(expectedScope(repaySpec, subject));

        emit LineOpened(lineId, msg.sender, subject, limit, volumeClaimId, cleanClaimIds.length);
    }

    /// @dev Every clean claim must be empty, cover the volume claim's exact range, and carry a
    ///      window worth having. The cap it returns is the weakest of them: exposure can only be
    ///      as large as the least-backed assertion holding it up, because breaking any single one
    ///      is enough to have made the underwriting wrong.
    function _checkClean(address subject, UtuhRegistry.Claim memory vol, uint256[] calldata ids)
        private
        returns (uint256 cap)
    {
        cap = type(uint256).max;
        for (uint256 i = 0; i < ids.length; i++) {
            _spend(ids[i]);
            UtuhRegistry.Claim memory cln = REGISTRY.claim(ids[i]);

            if (cln.challengeWindow < MIN_UNDERWRITING_WINDOW) {
                revert WindowTooShort(cln.challengeWindow, MIN_UNDERWRITING_WINDOW);
            }
            _requireScope(_cleanSpecs[i], subject, cln.scope);
            if (vol.fromBlock != cln.fromBlock || vol.toBlock != cln.toBlock) revert RangeMismatch();

            // Counting members rather than reading the aggregate keeps this true whatever metric
            // the clean scope carries: a DATA_WORD scope over an adverse event that happened to
            // carry a zero amount would sum to nothing while the liquidation sat in the set.
            uint256 adverse = REGISTRY.memberCount(ids[i]);
            if (adverse != 0) revert NotClean(adverse);

            uint256 backing = REGISTRY.enforceableLoss(ids[i]) * BOND_MULTIPLE;
            if (backing < cap) cap = backing;
        }
    }

    function _spend(uint256 claimId) private {
        if (claimSpent[claimId]) revert ClaimAlreadySpent(claimId);
        claimSpent[claimId] = true;
    }

    function cleanSpecCount() external view returns (uint256) {
        return _cleanSpecs.length;
    }

    function cleanSpecAt(uint256 i) external view returns (HistorySpec memory) {
        return _cleanSpecs[i];
    }

    /// @dev solc suggests `pure` here for the same reason it does in {UtuhRegistry._extractLog},
    ///      and it is wrong for the same reason: `spec` is a storage pointer and this reads it.
    function _requireScope(HistorySpec storage spec, address subject, EventScope.Scope memory actual) private view {
        bytes32 want = EventScope.id(expectedScope(spec, subject));
        bytes32 got = EventScope.id(actual);
        if (want != got) revert ScopeMismatch(want, got);
    }

    function _requireUsable(uint256 claimId, uint256 minBond) private view {
        if (!REGISTRY.isUsable(claimId, minBond)) revert ClaimNotUsable(claimId, minBond);
    }

    // ------------------------------------------------------------------
    // Drawing and settlement
    // ------------------------------------------------------------------

    /// @notice Draw against an open line.
    /// @dev The borrower chooses how much to take and nothing else. What must come back, and by
    ///      when, are both computed from lender policy — an earlier version took them as
    ///      arguments to this borrower-only function, which meant a borrower could draw the full
    ///      limit and owe one wei of it. The conversion from CTC back to source units runs at the
    ///      same {VOLUME_UNIT_IN_CTC} that produced the limit, so the two sides stay consistent,
    ///      and it rounds up so that no draw is ever small enough to owe nothing.
    function draw(uint256 lineId, uint256 amount) external returns (uint256 due) {
        Line storage l = _lines[lineId];
        if (l.borrower != msg.sender) revert NotBorrower();
        if (l.status != LineStatus.Active) revert WrongLineStatus(LineStatus.Active, l.status);
        if (amount == 0) revert NoCredit();

        uint256 remaining = l.limit - l.drawn;
        if (amount > remaining) revert ExceedsLimit(amount, remaining);
        if (amount > available) revert InsufficientLiquidity(amount, available);

        due = _repaymentFor(amount);

        l.drawn += amount;
        l.repayRequired += due;
        available -= amount;

        // The deadline is set by the first draw and never moves. Letting a later draw reset it
        // would hand a borrower who owes money an unlimited extension for the price of drawing
        // one more wei.
        if (l.dueBlock == 0) l.dueBlock = uint64(block.number) + REPAY_WINDOW_BLOCKS;

        emit Drawn(lineId, amount, l.dueBlock, l.repayRequired);
        _pay(msg.sender, amount);
    }

    /// @notice What drawing `amount` obliges the borrower to prove on the source chain.
    function _repaymentFor(uint256 amount) private view returns (uint256) {
        uint256 sourceUnits = _ceilDiv(amount, VOLUME_UNIT_IN_CTC);
        return _ceilDiv(sourceUnits * REPAYMENT_BPS, 10_000);
    }

    function repaymentFor(uint256 amount) external view returns (uint256) {
        return _repaymentFor(amount);
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @notice Settle a drawn line with a finalized claim proving repayment on the source chain.
    /// @dev The claim's members were each verified by the Block Prover before they could be
    ///      appended, so `aggregate` is a floor on what was actually paid, never a ceiling on
    ///      what was asserted.
    function settle(uint256 lineId, uint256 repayClaimId) external {
        Line storage l = _lines[lineId];
        if (l.status != LineStatus.Active) revert WrongLineStatus(LineStatus.Active, l.status);
        if (block.number > l.dueBlock) revert PastDue(uint64(block.number), l.dueBlock);

        UtuhRegistry.Claim memory rc = REGISTRY.claim(repayClaimId);

        bytes32 got = EventScope.id(rc.scope);
        if (got != l.repayScopeId) revert ScopeMismatch(l.repayScopeId, got);

        // The claim must start after both the underwriting it rests on and anything this subject
        // has already settled with.
        uint64 watermark = settledThrough[l.subject];
        uint64 required = l.repayFrom > watermark ? l.repayFrom : watermark;
        if (rc.fromBlock < required) revert RepaymentAlreadyCounted(rc.fromBlock, required);

        if (claimSpent[repayClaimId]) revert ClaimAlreadySpent(repayClaimId);
        claimSpent[repayClaimId] = true;
        settledThrough[l.subject] = rc.toBlock + 1;

        _requireUsable(repayClaimId, l.drawn / BOND_MULTIPLE);

        if (rc.aggregate < l.repayRequired) revert RepaymentShort(rc.aggregate, l.repayRequired);

        l.status = LineStatus.Settled;
        emit Settled(lineId, repayClaimId, rc.aggregate);
    }

    /// @notice Record a default once the deadline passes with no proven repayment.
    /// @dev No proof is required and none exists to give. The contract is not asserting that a
    ///      payment was missed — it is recording that the borrower, who alone could have proven
    ///      otherwise, did not.
    function markDefault(uint256 lineId) external {
        Line storage l = _lines[lineId];
        if (l.status != LineStatus.Active) revert WrongLineStatus(LineStatus.Active, l.status);
        if (l.drawn == 0) revert NoCredit();
        if (block.number <= l.dueBlock) revert NotYetDue(uint64(block.number), l.dueBlock);

        l.status = LineStatus.Defaulted;
        emit Defaulted(lineId, l.drawn);
    }

    function line(uint256 lineId) external view returns (Line memory) {
        return _lines[lineId];
    }

    /// @dev Slither reports this as sending ether to an arbitrary destination. Both call sites
    ///      pass `msg.sender` — a borrower drawing their own line, and the lender collecting a
    ///      settled repayment — and both set their state first.
    // slither-disable-next-line arbitrary-send-eth
    function _pay(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
