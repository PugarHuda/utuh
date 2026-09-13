// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {UtuhRegistry} from "../../src/UtuhRegistry.sol";
import {UtuhCredit} from "../../src/UtuhCredit.sol";
import {EventScope} from "../../src/lib/EventScope.sol";
import {IBlockProver} from "../../src/interfaces/IBlockProver.sol";
import {IChainInfo} from "../../src/interfaces/IChainInfo.sol";

/// @notice A registry and a lender over real Sepolia bytes, with the two precompile answers
///         substituted — shared by `Lifecycle.t.sol` and `Audit.t.sol`.
///
/// @dev Every other suite stops at the first line that touches `0x0FD2` or `0x0FD3`, because those
///      are Substrate runtime natives with no bytecode and a plain EVM cannot execute them. What is
///      substituted here is exactly two answers and nothing else:
///
///        - the Block Prover's verdict on a proof (`verifyAndEmit` -> true) and the transaction
///          index it reads out of the Merkle path;
///        - the ChainInfo precompile's attestation heights.
///
///      Everything downstream runs for real on the bytes of a real Sepolia transaction captured
///      from the recorded full-flow run: the transaction is decoded by the real `EvmV1Decoder`, the
///      receipt status is read, the log is matched against the scope field by field, the metric is
///      pulled out of the log's data, the ordering key is packed, membership is binary-searched.
///
///      The two substituted answers are the two this repository checks against the live chain every
///      day instead: `npm run probe` proves real mainnet transactions through `0x0FD2` over
///      `eth_call`, and CI runs it on a schedule.
abstract contract LifecycleFixture is Test {
    address internal constant PROVER = 0x0000000000000000000000000000000000000FD2;
    address internal constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;

    /// The two `verifyAndEmit` overloads share a name, so `.selector` cannot name either of them.
    /// A wrong value here does not weaken a test — the mock simply never applies, the call lands on
    /// an address with no code, and decoding its empty return reverts.
    bytes4 internal constant VERIFY_ONE =
        bytes4(keccak256("verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))"));
    bytes4 internal constant VERIFY_BATCH =
        bytes4(keccak256("verifyAndEmit(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))"));

    /// The fixture transaction is Sepolia, which CC3 Testnet numbers chain key 1.
    uint64 internal constant SEPOLIA = 1;
    uint64 internal constant TX_INDEX = 7;

    uint64 internal constant WINDOW = 25;
    uint256 internal constant BOND = 2 ether;
    uint256 internal constant RATE = 20_000; // CTC wei per wei of settled ether

    uint64 internal constant VOL_FROM = 1_000_000;
    uint64 internal constant VOL_TO = 1_000_200;
    uint64 internal constant FRONTIER = 1_000_500;

    UtuhRegistry internal registry;
    UtuhCredit internal credit;

    bytes internal settlement;
    bytes internal control;

    /// Read out of the fixture rather than written down beside it.
    address internal ledger;
    bytes32 internal settledSig;
    address internal payer;
    address internal payee;
    uint256 internal settledAmount;

    address internal constant WATCHER = address(0xBEEF);

    function setUp() public {
        string memory json = vm.readFile("test/fixtures/encodedTransactions.json");
        settlement = vm.parseJsonBytes(json, ".settlement");
        control = vm.parseJsonBytes(json, ".control");

        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(settlement);
        EvmV1Decoder.LogEntry memory log = r.receiptLogs[0];
        ledger = log.address_;
        settledSig = log.topics[0];
        payer = address(uint160(uint256(log.topics[1])));
        payee = address(uint160(uint256(log.topics[2])));
        settledAmount = uint256(bytes32(log.data));

        registry = new UtuhRegistry(WINDOW);
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        credit = new UtuhCredit(registry, _policy(), _paymentSpec(), clean, _paymentSpec());

        _mockChainInfo(FRONTIER);
        _mockProver();

        vm.deal(payer, 100 ether);
        vm.deal(address(this), 100 ether);
        vm.deal(WATCHER, 1 ether);
    }

    // ------------------------------------------------------------------
    // Building blocks
    // ------------------------------------------------------------------

    function _policy() internal pure returns (UtuhCredit.Policy memory) {
        return UtuhCredit.Policy({
            volumeUnitInCtc: RATE,
            minUnderwritingWindow: WINDOW,
            minHistoryBlocks: 100,
            maxStalenessBlocks: 5_000,
            repaymentBps: 10_500,
            repayWindowBlocks: 400,
            peers: new address[](0)
        });
    }

    /// A payment from the subject to the payee the fixture actually names.
    function _paymentSpec() internal view returns (UtuhCredit.HistorySpec memory s) {
        s.chainKey = SEPOLIA;
        s.emitter = ledger;
        s.eventSig = settledSig;
        s.subjectTopic = 1;
        s.counterpartyTopic = 2;
        s.counterparty = payee;
        s.metric = EventScope.Metric.DATA_WORD;
        s.metricArg = 0;
    }

    /// The adverse class a clean claim asserts the absence of — the ledger's other event.
    function _adverseSpec() internal view returns (UtuhCredit.HistorySpec memory s) {
        s.chainKey = SEPOLIA;
        s.emitter = ledger;
        s.eventSig = keccak256("Adverse(address,uint256)");
        s.subjectTopic = 1;
        s.counterpartyTopic = 0;
        s.counterparty = address(0);
        s.metric = EventScope.Metric.COUNT;
        s.metricArg = 0;
    }

    function _volumeScope() internal view returns (EventScope.Scope memory) {
        return credit.expectedScope(_paymentSpec(), payer);
    }

    function _repayScope() internal view returns (EventScope.Scope memory) {
        return credit.expectedScope(_paymentSpec(), payer);
    }

    function _adverseScope() internal view returns (EventScope.Scope memory) {
        return credit.expectedScope(_adverseSpec(), payer);
    }

    function _heights(uint256 n) internal pure returns (uint64[] memory at) {
        at = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            at[i] = VOL_FROM + uint64(10 * (i + 1));
        }
    }

    function _open(EventScope.Scope memory scope, uint64 from, uint64 to) internal returns (uint256 claimId) {
        vm.prank(payer);
        claimId = registry.open{value: BOND}(scope, from, to, WINDOW);
    }

    /// Open, append one proof per height, and seal.
    function _sealedClaim(EventScope.Scope memory scope, uint64 from, uint64 to, uint64[] memory at)
        internal
        returns (uint256 claimId)
    {
        claimId = _open(scope, from, to);
        vm.startPrank(payer);
        for (uint256 i = 0; i < at.length; i++) {
            registry.appendBatch(claimId, _batch(_one(at[i], 0)), _continuity());
        }
        registry.seal(claimId);
        vm.stopPrank();
    }

    function _finalize(uint256 claimId) internal {
        vm.roll(registry.challengeUntil(claimId) + 1);
        registry.finalize(claimId);
    }

    function _volumeClaim(uint64 from, uint64 to) internal returns (uint256 claimId) {
        uint64[] memory at = new uint64[](3);
        for (uint256 i = 0; i < 3; i++) {
            at[i] = from + uint64(10 * (i + 1));
        }
        claimId = _sealedClaim(_volumeScope(), from, to, at);
        _finalize(claimId);
    }

    function _cleanClaim(uint64 from, uint64 to) internal returns (uint256 claimId) {
        claimId = _sealedClaim(_adverseScope(), from, to, new uint64[](0));
        _finalize(claimId);
    }

    function _repaymentClaim(uint64 from, uint64 to) internal returns (uint256 claimId) {
        uint64[] memory at = new uint64[](1);
        at[0] = from + 1;
        claimId = _sealedClaim(_repayScope(), from, to, at);
        _finalize(claimId);
    }

    function _bindPayer() internal {
        if (credit.controllerOf(payer) == payer) return;
        credit.proveControl(_controlProof(), _continuity());
    }

    function _openLine() internal returns (uint256 lineId) {
        return _openLineOver(VOL_FROM, VOL_TO);
    }

    function _openLineOver(uint64 from, uint64 to) internal returns (uint256 lineId) {
        _bindPayer();
        uint256 volume = _volumeClaim(from, to);
        uint256 clean = _cleanClaim(from, to);
        vm.prank(payer);
        lineId = credit.openLine(payer, volume, _ids(clean));
    }

    function _drawAndSettle(uint256 lineId) internal {
        credit.fund{value: 1 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        credit.settle(lineId, _repaymentClaim(VOL_TO + 1, VOL_TO + 100));
    }

    function _peerList(address one) internal pure returns (address[] memory peers) {
        peers = new address[](1);
        peers[0] = one;
    }

    /// A second lender over the same registry, with the same terms and its own books.
    function _lenderWithPeers(address[] memory peers) internal returns (UtuhCredit) {
        UtuhCredit.Policy memory p = _policy();
        p.peers = peers;
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        return new UtuhCredit(registry, p, _paymentSpec(), clean, _paymentSpec());
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _one(uint64 height, uint32 logIndex) internal view returns (UtuhRegistry.EventProof memory p) {
        p.blockHeight = height;
        p.encodedTransaction = settlement;
        p.merkleRoot = keccak256(abi.encode(height));
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
        p.logIndex = logIndex;
    }

    function _proofAt(uint64 height, uint32 logIndex) internal view returns (UtuhRegistry.EventProof memory) {
        return _one(height, logIndex);
    }

    function _batch(UtuhRegistry.EventProof memory p) internal pure returns (UtuhRegistry.EventProof[] memory ps) {
        ps = new UtuhRegistry.EventProof[](1);
        ps[0] = p;
    }

    function _continuity() internal pure returns (IBlockProver.ContinuityProof memory c) {
        c.lowerEndpointDigest = bytes32(uint256(1));
        c.roots = new bytes32[](1);
        c.roots[0] = bytes32(uint256(2));
    }

    function _controlProof() internal view returns (UtuhCredit.ControlProof memory p) {
        p.chainKey = SEPOLIA;
        p.blockHeight = VOL_FROM;
        p.encodedTransaction = control;
        p.merkleRoot = keccak256("control");
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
    }

    /// @dev What a volume claim of `members` fixture settlements underwrites, before any cap.
    function _limitFor(uint256 members) internal view returns (uint256) {
        return (members * settledAmount * RATE * credit.LTV_BPS()) / 10_000;
    }

    /// @dev A lender identical to the default one but demanding a longer challenge window.
    function _strictLender(uint64 window) internal returns (UtuhCredit) {
        UtuhCredit.Policy memory p = _policy();
        p.minUnderwritingWindow = window;
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        return new UtuhCredit(registry, p, _paymentSpec(), clean, _paymentSpec());
    }

    /// @dev Control is bound per lender, because each holds its own record of who proved what.
    function _bindOn(UtuhCredit c) internal {
        if (c.controllerOf(payer) == payer) return;
        c.proveControl(_controlProof(), _continuity());
    }

    /// @dev {_sealedClaim} with the challenge window spelled out rather than assumed.
    function _sealedClaimWithWindow(
        EventScope.Scope memory scope,
        uint64 from,
        uint64 to,
        uint64[] memory at,
        uint64 window
    ) internal returns (uint256 claimId) {
        vm.prank(payer);
        claimId = registry.open{value: BOND}(scope, from, to, window);
        vm.startPrank(payer);
        for (uint256 i = 0; i < at.length; i++) {
            registry.appendBatch(claimId, _batch(_one(at[i], 0)), _continuity());
        }
        registry.seal(claimId);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // The two substituted answers
    // ------------------------------------------------------------------

    function _mockChainInfo(uint64 frontier) internal {
        vm.mockCall(CHAIN_INFO, abi.encodeWithSelector(IChainInfo.is_height_attested.selector), abi.encode(true));
        vm.mockCall(
            CHAIN_INFO,
            abi.encodeWithSelector(IChainInfo.get_attestation_genesis_height.selector),
            abi.encode(uint64(0))
        );
        vm.mockCall(
            CHAIN_INFO,
            abi.encodeWithSelector(IChainInfo.get_latest_attestation_height_and_hash.selector),
            abi.encode(
                IChainInfo.HeightHashResult({height: frontier, hash: bytes32(0), isAttestation: true, exists: true})
            )
        );
    }

    function _mockProver() internal {
        vm.mockCall(PROVER, abi.encodeWithSelector(VERIFY_ONE), abi.encode(true));
        vm.mockCall(PROVER, abi.encodeWithSelector(VERIFY_BATCH), abi.encode(true));
        vm.mockCall(
            PROVER, abi.encodeWithSelector(IBlockProver.calculateTxIndex.selector), abi.encode(uint64(TX_INDEX))
        );
    }
}
