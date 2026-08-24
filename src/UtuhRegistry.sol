// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {IBlockProver, BlockProverLib} from "./interfaces/IBlockProver.sol";
import {IChainInfo, ChainInfoLib} from "./interfaces/IChainInfo.sol";
import {EventScope} from "./lib/EventScope.sol";

/// @title UtuhRegistry — a completeness layer for the Attestcoin Protocol
/// @author Utuh
///
/// @notice ## The gap this closes
///
/// Attestcoin proves that a source-chain transaction *happened*: a Merkle proof for inclusion in
/// a block, a continuity proof anchoring that block to an attestation on Creditcoin. What it
/// cannot prove is that a set of events is *complete* — that nothing was left out. Whoever
/// submits proofs chooses which proofs to submit, and every one of them verifies.
///
/// That gap is fatal for credit. "This borrower has never been liquidated" is a statement about
/// events that do not exist, and an inclusion proof can only speak about events that do.
///
/// ## How Utuh closes it
///
/// Two halves, each sound on its own:
///
///  - **Nothing invented.** Every event enters a claim through {appendBatch}, which runs the
///    Attestcoin Block Prover on it first. A claim can only ever contain events that provably
///    happened, so its aggregate cannot be inflated.
///  - **Nothing omitted.** The claimant bonds the assertion that the set is complete. Anyone may
///    {refute} it by proving a single in-scope event that the set does not contain. Absence is
///    never proven; a claim of absence is *refuted by presence*, which Attestcoin does prove.
///
/// Presence stays cryptographic. Absence becomes economic.
///
/// ## Why this scales
///
/// The registry never verifies a whole set. Appends verify each event once, and a refutation
/// verifies exactly one. A claim spanning ten thousand events is settled by a single proof, or
/// by none at all.
contract UtuhRegistry {
    using EventScope for EventScope.Scope;

    IBlockProver public immutable PROVER;
    IChainInfo public immutable CHAIN_INFO;

    /// @notice Shortest challenge window this deployment accepts, in Creditcoin blocks.
    /// @dev A window is only meaningful if a watcher can realistically notice the claim, fetch a
    ///      proof from the Proof Builder, and land a transaction inside it. At ~15s blocks the
    ///      recommended production value is {RECOMMENDED_CHALLENGE_WINDOW} (~24h). It is a
    ///      deployment parameter rather than a constant so a demonstration deployment can run a
    ///      short window without the protocol pretending 24 hours elapsed; the floor below stops
    ///      any deployment from choosing a window no watcher could act inside.
    uint64 public immutable MIN_CHALLENGE_WINDOW;
    uint64 public constant ABSOLUTE_MIN_CHALLENGE_WINDOW = 20; // ~5 minutes
    uint64 public constant RECOMMENDED_CHALLENGE_WINDOW = 5760; // ~24 hours
    uint64 public constant MAX_CHALLENGE_WINDOW = 403_200; // ~70 days

    /// @notice Minimum bond, so that refuting is never worth less than the gas it costs.
    uint256 public constant MIN_BOND = 1 ether; // 1 CTC

    /// @notice Share of a slashed bond paid to the refuter, in basis points.
    /// @dev Deliberately below 100%. If a refuter took the whole bond, a claimant caught lying
    ///      could refute their own claim and walk away whole, which would make a false claim free
    ///      to attempt. Burning the remainder puts a real price on being wrong.
    ///
    ///      The claimant can still take this share back. They know which event they omitted from
    ///      the moment they seal, so they can watch for an incoming refutation and front-run it
    ///      from another address — and no ordering scheme fixes that, because commit-reveal would
    ///      simply let them commit first with the same private knowledge. What survives is the
    ///      burn, which nobody can recover. See {enforceableLoss}.
    uint256 public constant REFUTER_SHARE_BPS = 5000;

    /// @notice The Attestcoin batch API shares one continuity proof across at most 10 queries.
    uint256 public constant MAX_BATCH = 10;

    enum Status {
        None,
        Open, // accepting appends from the claimant
        Sealed, // published and challengeable
        Finalized, // survived its challenge window
        Refuted // an omitted in-scope event was proven
    }

    struct Claim {
        address claimant;
        Status status;
        uint64 fromBlock; // inclusive, source chain
        uint64 toBlock; // inclusive, source chain
        uint64 sealedAt; // Creditcoin block at which the window opened
        uint64 challengeWindow; // in Creditcoin blocks
        uint256 bond; // escrowed now; zeroed once refunded or slashed
        uint256 bondPosted; // what was at stake during the window; never rewritten
        uint256 aggregate; // sum of EventScope.value over the set
        uint256 lastKey; // ordering cursor while Open
        EventScope.Scope scope;
    }

    /// @notice One proven source-chain event, as returned by the Proof Builder.
    struct EventProof {
        uint64 blockHeight;
        bytes encodedTransaction;
        bytes32 merkleRoot;
        IBlockProver.MerkleProofEntry[] siblings;
        uint32 logIndex; // index within *this transaction's* logs
    }

    uint256 public nextClaimId = 1;
    mapping(uint256 => Claim) private _claims;

    /// @notice Ordering keys of a claim's members, strictly ascending.
    /// @dev Held in storage rather than behind a Merkle root so that refutation is a binary
    ///      search the chain performs itself, with no witness the claimant could withhold.
    ///      ponytail: one SSTORE per event caps practical claims in the low thousands. If sets
    ///      ever outgrow that, replace the array with an incremental Merkle root and have the
    ///      refuter supply an adjacency proof of the two members bracketing the gap.
    mapping(uint256 => uint256[]) private _keys;

    /// @notice Bond value slashed and permanently locked in this contract.
    uint256 public burned;

    /// @notice Refunds owed but not yet collected.
    /// @dev Only {finalize} credits this. Every other payment in the registry goes to
    ///      `msg.sender`, who can always receive it or else reverts their own transaction —
    ///      but finalize is permissionless and pays the *claimant*, so a claimant that cannot
    ///      accept ether would brick their own claim in `Sealed` forever, and with it anything
    ///      waiting on it. Crediting instead of sending removes that.
    mapping(address => uint256) public withdrawable;

    event ClaimOpened(
        uint256 indexed claimId,
        address indexed claimant,
        bytes32 indexed scopeId,
        uint64 chainKey,
        uint64 fromBlock,
        uint64 toBlock,
        uint256 bond
    );
    event EventAppended(uint256 indexed claimId, uint256 key, bytes32 leaf, uint256 value);
    event ClaimSealed(uint256 indexed claimId, uint256 memberCount, uint256 aggregate, uint64 challengeUntil);
    event ClaimFinalized(uint256 indexed claimId, uint256 aggregate, uint256 memberCount);
    event Withdrawn(address indexed to, uint256 amount);
    event ClaimRefuted(uint256 indexed claimId, address indexed refuter, uint256 omittedKey, uint256 reward);
    event ClaimAbandoned(uint256 indexed claimId);

    error NotClaimant();
    error WrongStatus(Status expected, Status actual);
    error EmptyRange();
    error RangeNotAttested(uint64 chainKey, uint64 height);
    error RangeBeforeGenesis(uint64 fromBlock, uint64 genesis);
    error BondTooSmall(uint256 sent, uint256 required);
    error BadChallengeWindow(uint64 window);
    error BatchTooLarge(uint256 size);
    error EmptyBatch();
    error BlockOutOfRange(uint64 height, uint64 fromBlock, uint64 toBlock);
    error ProofRejected();
    error TransactionFailedOnSource(uint8 receiptStatus);
    error UnsupportedTransactionType(uint8 txType);
    error LogIndexOutOfRange(uint32 logIndex, uint256 logCount);
    error EventOutOfScope();
    error KeysOutOfOrder(uint256 lastKey, uint256 key);
    error ChallengeWindowClosed(uint64 nowBlock, uint64 until);
    error ChallengeWindowOpen(uint64 nowBlock, uint64 until);
    error EventAlreadyInSet(uint256 key);
    error TransferFailed();
    error NothingToWithdraw();

    error ChallengeWindowFloorTooLow(uint64 given, uint64 floor);

    constructor(uint64 minChallengeWindow) {
        if (minChallengeWindow < ABSOLUTE_MIN_CHALLENGE_WINDOW) {
            revert ChallengeWindowFloorTooLow(minChallengeWindow, ABSOLUTE_MIN_CHALLENGE_WINDOW);
        }
        MIN_CHALLENGE_WINDOW = minChallengeWindow;
        PROVER = BlockProverLib.getProver();
        CHAIN_INFO = ChainInfoLib.getChainInfo();
    }

    // ------------------------------------------------------------------
    // Claim lifecycle
    // ------------------------------------------------------------------

    /// @notice Open a claim over `[fromBlock, toBlock]` on the source chain named by `scope`.
    /// @dev The whole range must already be attested. That single requirement is what makes a
    ///      challenge window measured in Creditcoin blocks sound: if `toBlock` were still
    ///      unattested, a watcher could see the claim yet be unable to generate a proof for the
    ///      part of the range that betrays it, and the window would expire on a claim nobody
    ///      *could* have refuted. Attestation heights only advance, so once `toBlock` is
    ///      attested the entire range stays provable for the life of the claim.
    function open(EventScope.Scope calldata scope, uint64 fromBlock, uint64 toBlock, uint64 challengeWindow)
        external
        payable
        returns (uint256 claimId)
    {
        if (fromBlock > toBlock) revert EmptyRange();
        if (msg.value < MIN_BOND) revert BondTooSmall(msg.value, MIN_BOND);
        if (challengeWindow < MIN_CHALLENGE_WINDOW || challengeWindow > MAX_CHALLENGE_WINDOW) {
            revert BadChallengeWindow(challengeWindow);
        }
        if (!CHAIN_INFO.is_height_attested(scope.chainKey, toBlock)) {
            revert RangeNotAttested(scope.chainKey, toBlock);
        }
        uint64 genesis = CHAIN_INFO.get_attestation_genesis_height(scope.chainKey);
        if (fromBlock < genesis) revert RangeBeforeGenesis(fromBlock, genesis);

        claimId = nextClaimId++;
        Claim storage c = _claims[claimId];
        c.claimant = msg.sender;
        c.status = Status.Open;
        c.fromBlock = fromBlock;
        c.toBlock = toBlock;
        c.challengeWindow = challengeWindow;
        c.bond = msg.value;
        c.bondPosted = msg.value;
        c.scope = scope;

        emit ClaimOpened(claimId, msg.sender, scope.id(), scope.chainKey, fromBlock, toBlock, msg.value);
    }

    /// @notice Add up to {MAX_BATCH} proven events to an open claim.
    /// @param continuity One continuity proof shared by the whole batch, exactly as the Proof
    ///        Builder's batch endpoint returns it.
    /// @dev Every event in the batch is verified in a single call to the Block Prover, which is
    ///      what a shared continuity proof is for. The cap counts queries, not transactions: a
    ///      transaction carrying three in-scope logs uses three of the ten slots.
    ///
    ///      Members must arrive in strictly ascending key order. Enforcing the sort here rather
    ///      than trusting a sorted input buys two things at once: refutation becomes a binary
    ///      search, and duplicate members become impossible.
    function appendBatch(uint256 claimId, EventProof[] calldata proofs, IBlockProver.ContinuityProof calldata continuity)
        external
    {
        Claim storage c = _claims[claimId];
        if (c.claimant != msg.sender) revert NotClaimant();
        if (c.status != Status.Open) revert WrongStatus(Status.Open, c.status);
        if (proofs.length == 0) revert EmptyBatch();
        if (proofs.length > MAX_BATCH) revert BatchTooLarge(proofs.length);

        _verifyBatch(c.scope.chainKey, c.fromBlock, c.toBlock, proofs, continuity);

        for (uint256 i = 0; i < proofs.length; i++) {
            _record(claimId, c, proofs[i]);
        }
    }

    /// @dev One precompile call for the whole batch. Nothing downstream may touch a proof that
    ///      did not pass through here first.
    function _verifyBatch(
        uint64 chainKey,
        uint64 fromBlock,
        uint64 toBlock,
        EventProof[] calldata proofs,
        IBlockProver.ContinuityProof calldata continuity
    ) private {
        uint256 n = proofs.length;
        uint64[] memory heights = new uint64[](n);
        bytes[] memory encoded = new bytes[](n);
        IBlockProver.MerkleProof[] memory merkleProofs = new IBlockProver.MerkleProof[](n);

        for (uint256 i = 0; i < n; i++) {
            uint64 h = proofs[i].blockHeight;
            if (h < fromBlock || h > toBlock) revert BlockOutOfRange(h, fromBlock, toBlock);
            heights[i] = h;
            encoded[i] = proofs[i].encodedTransaction;
            merkleProofs[i] = IBlockProver.MerkleProof({root: proofs[i].merkleRoot, siblings: proofs[i].siblings});
        }

        if (!PROVER.verifyAndEmit(chainKey, heights, encoded, merkleProofs, continuity)) revert ProofRejected();
    }

    /// @dev Rebuild the event's identity from bytes the prover has already vouched for, then file
    ///      it. Emitter, topics, data and transaction index all come out of verified bytes; none
    ///      of them is taken from the caller.
    function _record(uint256 claimId, Claim storage c, EventProof calldata p) private {
        EvmV1Decoder.LogEntry memory log = _extractLog(c.scope, p);

        uint64 txIndex = PROVER.calculateTxIndex(
            IBlockProver.MerkleProof({root: p.merkleRoot, siblings: p.siblings})
        );
        uint256 k = EventScope.key(p.blockHeight, txIndex, p.logIndex);

        if (_keys[claimId].length > 0 && k <= c.lastKey) revert KeysOutOfOrder(c.lastKey, k);

        uint256 v = c.scope.value(log);

        c.lastKey = k;
        c.aggregate += v;
        _keys[claimId].push(k);

        emit EventAppended(claimId, k, EventScope.leaf(k, log), v);
    }

    /// @notice Publish the claim and start its challenge window.
    /// @dev An empty set is a legitimate and important claim — "this address was never
    ///      liquidated in this range" is exactly the assertion credit needs and cannot prove
    ///      directly. It is also the single most refutable claim in the registry.
    function seal(uint256 claimId) external {
        Claim storage c = _claims[claimId];
        if (c.claimant != msg.sender) revert NotClaimant();
        if (c.status != Status.Open) revert WrongStatus(Status.Open, c.status);

        c.status = Status.Sealed;
        c.sealedAt = uint64(block.number);

        emit ClaimSealed(claimId, _keys[claimId].length, c.aggregate, c.sealedAt + c.challengeWindow);
    }

    /// @notice Withdraw an unpublished claim and recover its bond.
    /// @dev Only while Open. Nothing downstream can have relied on it yet.
    function abandon(uint256 claimId) external {
        Claim storage c = _claims[claimId];
        if (c.claimant != msg.sender) revert NotClaimant();
        if (c.status != Status.Open) revert WrongStatus(Status.Open, c.status);

        uint256 bond = c.bond;
        c.bond = 0;
        c.status = Status.None;

        emit ClaimAbandoned(claimId);
        _pay(msg.sender, bond);
    }

    /// @notice Break a sealed claim by proving one in-scope event it left out.
    /// @dev The refuter needs no bond of their own: a refutation that does not hold up simply
    ///      reverts, so griefing costs gas and returns nothing.
    ///
    ///      Known limit: a claimant watching the mempool can front-run an incoming refutation with
    ///      their own, keeping half the bond and denying the watcher their reward. The burn still
    ///      makes lying costly, but it does erode the incentive to watch. Closing it properly
    ///      means committing to a refutation before revealing it, which is a round trip this does
    ///      not yet have.
    function refute(uint256 claimId, EventProof calldata p, IBlockProver.ContinuityProof calldata continuity)
        external
    {
        Claim storage c = _claims[claimId];
        if (c.status != Status.Sealed) revert WrongStatus(Status.Sealed, c.status);

        uint64 until = c.sealedAt + c.challengeWindow;
        if (block.number > until) revert ChallengeWindowClosed(uint64(block.number), until);

        if (p.blockHeight < c.fromBlock || p.blockHeight > c.toBlock) {
            revert BlockOutOfRange(p.blockHeight, c.fromBlock, c.toBlock);
        }

        (uint256 k, EvmV1Decoder.LogEntry memory log) = _verifyOne(c.scope, p, continuity);

        // A refutation must name an event the claimant could actually have appended. `value` is
        // the only step in an append that can reject an in-scope event — a metric reading past the
        // end of a log's data reverts — so it runs here too. Without this, a scope whose emitter
        // varies its payload length could produce events that are impossible to include and
        // sufficient to slash, and an honest claimant would be punished for an omission they had
        // no way to avoid.
        c.scope.value(log);

        if (_contains(claimId, k)) revert EventAlreadyInSet(k);

        uint256 bond = c.bond;
        uint256 reward = (bond * REFUTER_SHARE_BPS) / 10_000;

        c.bond = 0;
        c.status = Status.Refuted;
        burned += bond - reward;

        emit ClaimRefuted(claimId, msg.sender, k, reward);
        _pay(msg.sender, reward);
    }

    /// @notice Settle a claim whose challenge window has elapsed unrefuted, returning the bond.
    /// @dev The guarantee a finalized claim carries is precise: for `challengeWindow` blocks,
    ///      `bond` was at stake against anyone who could show the set was incomplete, and no one
    ///      did. Consumers must weigh that recorded bond against their own exposure — see
    ///      {isUsable}. The registry cannot do it for them, because only the consumer knows what
    ///      it is about to risk on the answer.
    function finalize(uint256 claimId) external {
        Claim storage c = _claims[claimId];
        if (c.status != Status.Sealed) revert WrongStatus(Status.Sealed, c.status);

        uint64 until = c.sealedAt + c.challengeWindow;
        if (block.number <= until) revert ChallengeWindowOpen(uint64(block.number), until);

        uint256 bond = c.bond;
        c.bond = 0;
        c.status = Status.Finalized;
        withdrawable[c.claimant] += bond;

        emit ClaimFinalized(claimId, c.aggregate, _keys[claimId].length);
    }

    /// @notice Collect refunds credited by {finalize}.
    function withdraw() external returns (uint256 amount) {
        amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        _pay(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Proof verification
    // ------------------------------------------------------------------

    /// @dev Single-query verification, which is all a refutation ever needs.
    function _verifyOne(
        EventScope.Scope storage scope,
        EventProof calldata p,
        IBlockProver.ContinuityProof calldata continuity
    ) private returns (uint256 key, EvmV1Decoder.LogEntry memory log) {
        IBlockProver.MerkleProof memory merkleProof =
            IBlockProver.MerkleProof({root: p.merkleRoot, siblings: p.siblings});

        if (!PROVER.verifyAndEmit(scope.chainKey, p.blockHeight, p.encodedTransaction, merkleProof, continuity)) {
            revert ProofRejected();
        }

        log = _extractLog(scope, p);
        uint64 txIndex = PROVER.calculateTxIndex(merkleProof);
        key = EventScope.key(p.blockHeight, txIndex, p.logIndex);
    }

    /// @dev Decode a verified transaction and pull out the one log the caller pointed at, after
    ///      checking it belongs to the claim's scope.
    function _extractLog(EventScope.Scope storage scope, EventProof calldata p)
        private
        view
        returns (EvmV1Decoder.LogEntry memory log)
    {
        uint8 txType = EvmV1Decoder.getTransactionType(p.encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) revert UnsupportedTransactionType(txType);

        // The prover attests to inclusion, not to success. A reverted transaction is still
        // included in its block, so this check is the difference between "it was mined" and
        // "it happened".
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(p.encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionFailedOnSource(receipt.receiptStatus);

        if (p.logIndex >= receipt.receiptLogs.length) {
            revert LogIndexOutOfRange(p.logIndex, receipt.receiptLogs.length);
        }
        log = receipt.receiptLogs[p.logIndex];

        EventScope.Scope memory s = scope;
        if (!EventScope.matches(s, log)) revert EventOutOfScope();
    }

    // ------------------------------------------------------------------
    // Membership
    // ------------------------------------------------------------------

    /// @dev Binary search over the ascending key array written by {appendBatch}.
    function _contains(uint256 claimId, uint256 k) private view returns (bool) {
        uint256[] storage ks = _keys[claimId];
        uint256 lo = 0;
        uint256 hi = ks.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            uint256 v = ks[mid];
            if (v == k) return true;
            if (v < k) lo = mid + 1;
            else hi = mid;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Consumer views
    // ------------------------------------------------------------------

    /// @notice What a false claim costs its author no matter what they do about it.
    /// @dev Not the bond. A claimant who sees a refutation coming can send their own from a
    ///      second address and take the refuter's share back, so the only part they cannot
    ///      recover is the part that gets burned. Anything relying on this claim should be sized
    ///      against this figure, and {isUsable} takes it rather than the bond for exactly that
    ///      reason — measuring against the bond would overstate the deterrent by the refuter's
    ///      share.
    function enforceableLoss(uint256 claimId) public view returns (uint256) {
        Claim storage c = _claims[claimId];
        // Only a claim that is still challengeable, or that survived being challengeable, has a
        // figure worth quoting. A refuted or abandoned one has nothing standing behind it, and
        // reporting the bond it once posted would read like a guarantee that no longer exists.
        if (c.status != Status.Sealed && c.status != Status.Finalized) return 0;
        return (c.bondPosted * (10_000 - REFUTER_SHARE_BPS)) / 10_000;
    }

    /// @notice Whether a consumer standing to lose `exposure` may rely on this claim.
    /// @dev Reads what was posted at seal time, not the live escrow: a finalized claim has already
    ///      refunded its bond, but what matters downstream is what stood behind the assertion
    ///      while it could still be broken.
    function isUsable(uint256 claimId, uint256 exposure) external view returns (bool) {
        Claim storage c = _claims[claimId];
        return c.status == Status.Finalized && enforceableLoss(claimId) >= exposure;
    }

    function claim(uint256 claimId) external view returns (Claim memory) {
        return _claims[claimId];
    }

    function memberCount(uint256 claimId) external view returns (uint256) {
        return _keys[claimId].length;
    }

    function keyAt(uint256 claimId, uint256 index) external view returns (uint256) {
        return _keys[claimId][index];
    }

    function contains(uint256 claimId, uint256 k) external view returns (bool) {
        return _contains(claimId, k);
    }

    function challengeUntil(uint256 claimId) external view returns (uint64) {
        Claim storage c = _claims[claimId];
        return c.sealedAt + c.challengeWindow;
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
