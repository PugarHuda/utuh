// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {UtuhRegistry} from "./UtuhRegistry.sol";
import {EventScope} from "./lib/EventScope.sol";
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

    /// @notice Credit extended per unit of bond behind the clean claim.
    /// @dev This is the consumer half of the bond mechanism. The registry cannot know what a
    ///      claim will be used for, so it cannot size the bond; only the party about to lend
    ///      knows its own exposure. A line is never allowed to risk more than a liar stood to
    ///      lose, which is what keeps the clean claim worth attacking when it is false.
    uint256 public constant BOND_MULTIPLE = 10;

    /// @notice Minimum span of source-chain history an underwriting must cover.
    /// @dev ~30 days of Ethereum blocks. A clean claim over a short window is cheap to keep
    ///      clean and says almost nothing.
    uint64 public constant MIN_HISTORY_BLOCKS = 216_000;

    /// @notice How far behind the attestation frontier an underwriting range may end.
    /// @dev ~7 days. Otherwise a borrower could underwrite on a spotless year that ended right
    ///      before the liquidation that ruined them.
    uint64 public constant MAX_STALENESS_BLOCKS = 50_400;

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

    struct Line {
        address borrower;
        LineStatus status;
        uint256 limit; // CTC
        uint256 drawn; // CTC
        uint256 repayRequired; // source-chain units, e.g. USDC 1e6
        uint64 repayFrom; // source-chain block the repayment claim must start at
        uint64 dueBlock; // Creditcoin block by which repayment must be proven
        bytes32 repayScopeId; // the only scope a settling claim may carry
    }

    HistorySpec public volumeSpec; // e.g. Aave V3 Repay(user)
    HistorySpec public cleanSpec; // e.g. Aave V3 LiquidationCall(user)
    HistorySpec public repaySpec; // e.g. USDC Transfer(borrower -> lender)

    address public immutable LENDER;

    uint256 public nextLineId = 1;
    mapping(uint256 => Line) private _lines;

    /// @notice CTC deposited by the lender and not yet drawn.
    uint256 public available;

    event LineOpened(
        uint256 indexed lineId,
        address indexed borrower,
        address indexed subject,
        uint256 limit,
        uint256 volumeClaimId,
        uint256 cleanClaimId
    );
    event Drawn(uint256 indexed lineId, uint256 amount, uint64 dueBlock, uint256 repayRequired);
    event Settled(uint256 indexed lineId, uint256 repayClaimId, uint256 proven);
    event Defaulted(uint256 indexed lineId, uint256 outstanding);
    event Funded(uint256 amount);

    error NotLender();
    error ClaimNotUsable(uint256 claimId, uint256 requiredBond);
    error ScopeMismatch(bytes32 expected, bytes32 actual);
    error RangeMismatch();
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

    constructor(
        UtuhRegistry registry,
        uint256 volumeUnitInCtc,
        HistorySpec memory volume,
        HistorySpec memory clean,
        HistorySpec memory repay
    ) {
        if (volumeUnitInCtc == 0) revert NoCredit();
        VOLUME_UNIT_IN_CTC = volumeUnitInCtc;
        REGISTRY = registry;
        CHAIN_INFO = ChainInfoLib.getChainInfo();
        LENDER = msg.sender;
        _requireSpec(volume);
        _requireSpec(clean);
        _requireSpec(repay);
        volumeSpec = volume;
        cleanSpec = clean;
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

    // ------------------------------------------------------------------
    // Underwriting
    // ------------------------------------------------------------------

    /// @notice Rebuild the exact scope a claim must carry for `subject` under `spec`.
    function expectedScope(HistorySpec memory spec, address subject)
        public
        pure
        returns (EventScope.Scope memory s)
    {
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
    /// @param cleanClaimId A finalized claim asserting the complete set of the borrower's
    ///        liquidations over the same range — normally empty.
    /// @dev Both claims must cover the *same* source-chain range. Splitting them would let a
    ///      borrower pair a long volume history with a short clean window.
    function openLine(address subject, uint256 volumeClaimId, uint256 cleanClaimId)
        external
        returns (uint256 lineId)
    {
        UtuhRegistry.Claim memory vol = REGISTRY.claim(volumeClaimId);
        UtuhRegistry.Claim memory cln = REGISTRY.claim(cleanClaimId);

        _requireScope(volumeSpec, subject, vol.scope);
        _requireScope(cleanSpec, subject, cln.scope);

        if (vol.fromBlock != cln.fromBlock || vol.toBlock != cln.toBlock) revert RangeMismatch();

        uint64 span = vol.toBlock - vol.fromBlock;
        if (span < MIN_HISTORY_BLOCKS) revert HistoryTooShort(span, MIN_HISTORY_BLOCKS);

        uint64 frontier = CHAIN_INFO.get_latest_attestation_height_and_hash(vol.scope.chainKey).height;
        if (frontier > vol.toBlock + MAX_STALENESS_BLOCKS) revert UnderwritingStale(vol.toBlock, frontier);

        // Any proven liquidation in the window disqualifies. The claim being empty is precisely
        // what the bond was posted against.
        if (cln.aggregate != 0) revert NotClean(cln.aggregate);

        uint256 limit = (vol.aggregate * VOLUME_UNIT_IN_CTC * LTV_BPS) / 10_000;
        uint256 bondCap = cln.bondPosted * BOND_MULTIPLE;
        if (limit > bondCap) limit = bondCap;
        if (limit == 0) revert NoCredit();

        // Now that the exposure is known, hold both claims to it.
        _requireUsable(volumeClaimId, limit / BOND_MULTIPLE);
        _requireUsable(cleanClaimId, limit / BOND_MULTIPLE);

        lineId = nextLineId++;
        Line storage l = _lines[lineId];
        l.borrower = msg.sender;
        l.status = LineStatus.Active;
        l.limit = limit;
        l.repayFrom = vol.toBlock;
        l.repayScopeId = EventScope.id(expectedScope(repaySpec, subject));

        emit LineOpened(lineId, msg.sender, subject, limit, volumeClaimId, cleanClaimId);
    }

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

    /// @param repayRequired Amount the borrower must prove on the source chain, in that chain's
    ///        units. Set by the lender at draw time; no price feed is consulted, so there is no
    ///        oracle to corrupt and none to pretend exists.
    function draw(uint256 lineId, uint256 amount, uint256 repayRequired, uint64 repayWindow) external {
        Line storage l = _lines[lineId];
        if (l.borrower != msg.sender) revert NotBorrower();
        if (l.status != LineStatus.Active) revert WrongLineStatus(LineStatus.Active, l.status);

        uint256 remaining = l.limit - l.drawn;
        if (amount > remaining) revert ExceedsLimit(amount, remaining);
        if (amount > available) revert InsufficientLiquidity(amount, available);

        l.drawn += amount;
        l.repayRequired += repayRequired;
        l.dueBlock = uint64(block.number) + repayWindow;
        available -= amount;

        emit Drawn(lineId, amount, l.dueBlock, l.repayRequired);
        _pay(msg.sender, amount);
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
        if (rc.fromBlock < l.repayFrom) revert RangeMismatch();

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

    function _pay(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
