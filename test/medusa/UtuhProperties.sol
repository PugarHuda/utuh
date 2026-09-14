// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {UtuhRegistry} from "../../src/UtuhRegistry.sol";
import {UtuhCredit} from "../../src/UtuhCredit.sol";
import {EventScope} from "../../src/lib/EventScope.sol";
import {IBlockProver} from "../../src/interfaces/IBlockProver.sol";
import {IChainInfo} from "../../src/interfaces/IChainInfo.sol";

/// @notice A property harness over the registry and the lender together, for `medusa`.
///
/// @dev The forge invariant suites each drive one contract with the other held still. The four
///      properties below are about the seam between them — what a line may rest on — so this
///      drives both at once: anyone can open, append, seal, refute, abandon and finalize claims,
///      and the borrower may offer *any* claim that exists to {UtuhCredit.openLine}, `settle` and
///      `cure`, including sealed, abandoned and refuted ones. Composite moves ({underwrite},
///      {repay}) build honest finalized claims so the walk reaches drawn, defaulted and cured lines
///      rather than stalling at the first guard.
///
///      medusa has no `mockCall` and no `readFile`, so the two precompile answers are substituted
///      by tiny contracts placed at `0x0FD2` and `0x0FD3`, and the fixture bytes are inlined
///      verbatim from `test/fixtures/encodedTransactions.json`. Those are the same two answers
///      `LifecycleFixture` substitutes; everything else runs on the real Sepolia transaction.
///
///      Run with `medusa fuzz --config test/medusa/medusa.json`. The same properties also run
///      under `forge test` as invariants, in `test/UtuhProperties.t.sol`.
contract UtuhProperties {
    Hevm internal constant VM = Hevm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint64 internal constant SEPOLIA = 1;
    uint64 internal constant BASE = 1_000_000;
    address internal constant WATCHER = address(0xBEEF);

    /// A real Sepolia `Settled(payer, payee, amount)` from the recorded full-flow run.
    bytes internal constant SETTLEMENT =
        hex"000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000190000000000000000000000000000000000000000000000000000000000008acf00000000000000000000000001a802c650cccef077208a93c1cf43025239003f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000003af37c2b6a3954c856cdab3649971bf546a7c34d00000000000000000000000000000000000000000000000000038d7ea4c6800000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000246a256b2900000000000000000000000050577827700c0cf60240abd07f041f09c95d47480000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000aa36a700000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000817b97f000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000e780a5f53ed39caa2d87905af93531fce048292078e35bd352626af79eb6bcb744576ab2173cd67e43380150ead6c512d3f81a97afdd53317af3850a5f609e5c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000008109000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000003af37c2b6a3954c856cdab3649971bf546a7c34d000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000037e79a2206061184e05985ae0578dec52f817756a441996f984cdc817efc25a6800000000000000000000000001a802c650cccef077208a93c1cf43025239003f00000000000000000000000050577827700c0cf60240abd07f041f09c95d4748000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000400004080000000000000000002000000000000000000000000000000000000000000000000001000000000200000000000000000000000000000000008000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000040000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000001000000000000000000000000000000000000000";

    /// The payer's own Sepolia transaction carrying `utuh:control` and its own address.
    bytes internal constant CONTROL =
        hex"000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000002c00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000583900000000000000000000000001a802c650cccef077208a93c1cf43025239003f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a802c650cccef077208a93c1cf43025239003f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000020757475683a636f6e74726f6c01a802c650cccef077208a93c1cf43025239003f00000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000aa36a700000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000007ca3b1fe00000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000000071193a2e9c5ba3dc102ab94e911efb398546440770fef61a981202ffd32fb7a452e41f9eee0fac20ccce6239a80c1dd8c16a05b01f43d8b7d63afdac055a2e85000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000056ea000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

    UtuhRegistry public immutable REGISTRY;
    UtuhCredit public immutable CREDIT;
    address public immutable PAYER;

    /// The payment class covers volume and repayment claims; the adverse class is any settlement
    /// by the payer. The fixture log matches both, so a volume claim can hold real members and a
    /// clean claim can be refuted by a real event.
    EventScope.Scope internal paymentScope;
    EventScope.Scope internal adverseScope;

    /// What each line was opened on, and what settled or cured it.
    mapping(uint256 => uint256[2]) internal openedOn;
    mapping(uint256 => uint256) internal repaidWith;

    /// The highest watermarks seen before any move. A move that lowers one fails the property.
    uint64 internal highestUnderwritten;
    uint64 internal highestSettled;

    constructor() {
        // medusa places both at their addresses itself, through `predeployedContracts`: its `etch`
        // keeps the jump-destination analysis of the empty code it replaced, and the first jump in
        // the etched contract then fails. forge has no such config and no such bug, so it etches.
        if (address(0x0FD2).code.length == 0) VM.etch(address(0x0FD2), address(new ProverThatSaysYes()).code);
        if (address(0x0fD3).code.length == 0) {
            VM.etch(address(0x0fD3), address(new ChainInfoThatSaysAttested()).code);
        }

        EvmV1Decoder.LogEntry memory log = EvmV1Decoder.decodeReceiptFields(SETTLEMENT).receiptLogs[0];
        address payer = address(uint160(uint256(log.topics[1])));

        UtuhCredit.HistorySpec memory payment = UtuhCredit.HistorySpec({
            chainKey: SEPOLIA,
            emitter: log.address_,
            eventSig: log.topics[0],
            subjectTopic: 1,
            counterpartyTopic: 2,
            counterparty: address(uint160(uint256(log.topics[2]))),
            metric: EventScope.Metric.DATA_WORD,
            metricArg: 0
        });
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = UtuhCredit.HistorySpec({
            chainKey: SEPOLIA,
            emitter: log.address_,
            eventSig: log.topics[0],
            subjectTopic: 1,
            counterpartyTopic: 0,
            counterparty: address(0),
            metric: EventScope.Metric.COUNT,
            metricArg: 0
        });

        UtuhRegistry registry = new UtuhRegistry(20);
        UtuhCredit credit = new UtuhCredit(
            registry,
            UtuhCredit.Policy({
                volumeUnitInCtc: 20_000,
                minUnderwritingWindow: 25,
                minHistoryBlocks: 100,
                maxStalenessBlocks: 5_000,
                repaymentBps: 10_500,
                repayWindowBlocks: 40,
                peers: new address[](0)
            }),
            payment,
            clean,
            payment
        );
        paymentScope = credit.expectedScope(payment, payer);
        adverseScope = credit.expectedScope(clean[0], payer);

        VM.deal(address(this), 1e30);
        VM.deal(payer, 1e30);
        VM.deal(WATCHER, 1e30);

        UtuhCredit.ControlProof memory p;
        p.chainKey = SEPOLIA;
        p.blockHeight = BASE;
        p.encodedTransaction = CONTROL;
        p.merkleRoot = keccak256("control");
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
        credit.proveControl(p, _continuity());

        REGISTRY = registry;
        CREDIT = credit;
        PAYER = payer;
    }

    /// Liquidity the lender withdraws comes back here.
    receive() external payable {}

    modifier observed() {
        uint64 u = CREDIT.underwrittenThrough(PAYER);
        uint64 s = CREDIT.settledThrough(PAYER);
        if (u > highestUnderwritten) highestUnderwritten = u;
        if (s > highestSettled) highestSettled = s;
        _;
    }

    // ------------------------------------------------------------------ properties

    /// Every wei the registry holds is escrowed, credited or burned; every wei the lender holds is
    /// available. Nothing else.
    function property_bondsAreConserved() public view returns (bool) {
        uint256 escrowed;
        uint256 n = REGISTRY.nextClaimId();
        for (uint256 id = 1; id < n; id++) {
            escrowed += REGISTRY.claim(id).bond;
        }
        uint256 credited = REGISTRY.withdrawable(PAYER) + REGISTRY.withdrawable(WATCHER);
        return address(REGISTRY).balance == escrowed + credited + REGISTRY.burned()
            && address(CREDIT).balance == CREDIT.available();
    }

    /// No line was ever allowed to risk more than {UtuhCredit.BOND_MULTIPLE} times what a liar
    /// behind any claim it rests on is certain to lose.
    function property_noLineExceedsTenTimesEnforceableLoss() public view returns (bool) {
        uint256 lines = CREDIT.nextLineId();
        uint256 multiple = CREDIT.BOND_MULTIPLE();
        for (uint256 id = 1; id < lines; id++) {
            uint256 limit = CREDIT.line(id).limit;
            if (limit > multiple * REGISTRY.enforceableLoss(openedOn[id][0])) return false;
            if (limit > multiple * REGISTRY.enforceableLoss(openedOn[id][1])) return false;
        }
        return true;
    }

    /// Every claim a line opened on or was repaid with is Finalized. Finalized is terminal, so this
    /// is stronger than "not refuted": a refuted, sealed, open or abandoned claim never backs a line.
    function property_noRefutedClaimBacksALine() public view returns (bool) {
        uint256 lines = CREDIT.nextLineId();
        for (uint256 id = 1; id < lines; id++) {
            if (!_finalized(openedOn[id][0]) || !_finalized(openedOn[id][1])) return false;
            if (repaidWith[id] != 0 && !_finalized(repaidWith[id])) return false;
        }
        return true;
    }

    /// History is spent once and a payment discharges one debt, so neither watermark moves back.
    function property_watermarksOnlyAdvance() public view returns (bool) {
        return
            CREDIT.underwrittenThrough(PAYER) >= highestUnderwritten && CREDIT.settledThrough(PAYER) >= highestSettled;
    }

    // ------------------------------------------------------------------ registry moves

    function open(uint256 who, bool adverse, uint8 slot, uint8 span, uint96 bond, uint8 window) external observed {
        uint64 from = BASE + uint64(slot % 8) * 200;
        // 90, 100 or 110 blocks: one short of the lender's minimum history, and two that meet it.
        uint64 to = from + 90 + uint64(span % 3) * 10;
        EventScope.Scope memory scope = adverse ? adverseScope : paymentScope;
        VM.prank(_actor(who));
        // Windows 20..29 straddle the lender's floor of 25.
        try REGISTRY.open{value: 1 ether + (bond % 4 ether)}(scope, from, to, 20 + (window % 10)) {} catch {}
    }

    function append(uint256 claimSeed, uint8 offset, uint8 count) external observed {
        uint256 id = _claimId(claimSeed);
        if (id == 0) return;
        UtuhRegistry.Claim memory c = REGISTRY.claim(id);
        UtuhRegistry.EventProof[] memory ps = new UtuhRegistry.EventProof[](1 + (count % 3));
        for (uint256 i = 0; i < ps.length; i++) {
            ps[i] = _proof(c.fromBlock + uint64(offset % 40) + uint64(i));
        }
        VM.prank(c.claimant);
        try REGISTRY.appendBatch(id, ps, _continuity()) {} catch {}
    }

    function seal(uint256 claimSeed) external observed {
        uint256 id = _claimId(claimSeed);
        if (id == 0) return;
        VM.prank(REGISTRY.claim(id).claimant);
        try REGISTRY.seal(id) {} catch {}
    }

    function abandon(uint256 claimSeed) external observed {
        uint256 id = _claimId(claimSeed);
        if (id == 0) return;
        VM.prank(REGISTRY.claim(id).claimant);
        try REGISTRY.abandon(id) {} catch {}
    }

    /// The claimant refuting their own claim from either address is in scope: that is the
    /// front-run the burn exists for.
    function refute(uint256 who, uint256 claimSeed, uint8 offset) external observed {
        uint256 id = _claimId(claimSeed);
        if (id == 0) return;
        UtuhRegistry.EventProof memory p = _proof(REGISTRY.claim(id).fromBlock + uint64(offset % 40));
        VM.prank(_actor(who));
        try REGISTRY.refute(id, p, _continuity()) {} catch {}
    }

    function finalize(uint256 claimSeed, uint8 blocks) external observed {
        VM.roll(block.number + (blocks % 40));
        uint256 id = _claimId(claimSeed);
        if (id == 0) return;
        try REGISTRY.finalize(id) {} catch {}
    }

    function withdrawBond(uint256 who) external observed {
        VM.prank(_actor(who));
        try REGISTRY.withdraw() {} catch {}
    }

    function roll(uint8 blocks) external observed {
        VM.roll(block.number + blocks);
    }

    // ------------------------------------------------------------------ lender moves

    function fund(uint96 amount) external observed {
        try CREDIT.fund{value: 1 + (amount % 20 ether)}() {} catch {}
    }

    function withdrawLiquidity(uint96 amount) external observed {
        try CREDIT.withdraw(1 + (amount % 20 ether)) {} catch {}
    }

    /// Any two claims that exist, whatever state they are in.
    function openLine(uint256 volumeSeed, uint256 cleanSeed) external observed {
        _openLine(_claimId(volumeSeed), _claimId(cleanSeed));
    }

    /// Fresh history proven, sealed and finalized as a volume and a clean claim, then offered.
    function underwrite(uint8 span, uint96 volumeBond, uint96 cleanBond, uint8 members) external observed {
        uint64 from = CREDIT.underwrittenThrough(PAYER);
        if (from < BASE) from = BASE;
        uint64 to = from + 100 + (span % 50);
        uint256 volume = _finalizedClaim(paymentScope, from, to, 1 + (members % 3), 1 ether + (volumeBond % 4 ether));
        uint256 clean = _finalizedClaim(adverseScope, from, to, 0, 1 ether + (cleanBond % 4 ether));
        _openLine(volume, clean);
    }

    function draw(uint96 amount) external observed {
        uint256 id = CREDIT.activeLineOf(PAYER);
        if (id == 0) return;
        UtuhCredit.Line memory l = CREDIT.line(id);
        uint256 room = l.limit - l.drawn;
        VM.prank(PAYER);
        try CREDIT.draw(id, 1 + (amount % (room == 0 ? 1 : room))) {} catch {}
    }

    /// Any claim that exists, offered as repayment.
    function settle(uint256 lineSeed, uint256 claimSeed) external observed {
        _repay(_lineId(lineSeed), _claimId(claimSeed), false);
    }

    function cure(uint256 lineSeed, uint256 claimSeed) external observed {
        _repay(_lineId(lineSeed), _claimId(claimSeed), true);
    }

    /// An honest repayment claim starting where the line and the watermark allow.
    function repay(uint256 lineSeed, bool late, uint96 bond) external observed {
        uint256 id = _lineId(lineSeed);
        if (id == 0) return;
        uint64 from = CREDIT.line(id).repayFrom;
        uint64 mark = CREDIT.settledThrough(PAYER);
        if (mark > from) from = mark;
        _repay(id, _finalizedClaim(paymentScope, from, from + 10, 1, 1 ether + (bond % 4 ether)), late);
    }

    function markDefault(uint256 lineSeed) external observed {
        uint256 id = _lineId(lineSeed);
        if (id == 0) return;
        try CREDIT.markDefault(id) {} catch {}
    }

    function closeLine(uint256 lineSeed) external observed {
        uint256 id = _lineId(lineSeed);
        if (id == 0) return;
        VM.prank(PAYER);
        try CREDIT.closeLine(id) {} catch {}
    }

    // ------------------------------------------------------------------ building blocks

    function _openLine(uint256 volume, uint256 clean) internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = clean;
        VM.prank(PAYER);
        try CREDIT.openLine(PAYER, volume, ids) returns (uint256 lineId) {
            openedOn[lineId] = [volume, clean];
        } catch {}
    }

    function _repay(uint256 lineId, uint256 claimId, bool late) internal {
        if (lineId == 0) return;
        if (late) {
            try CREDIT.cure(lineId, claimId) {
                repaidWith[lineId] = claimId;
            } catch {}
        } else {
            try CREDIT.settle(lineId, claimId) {
                repaidWith[lineId] = claimId;
            } catch {}
        }
    }

    function _finalizedClaim(EventScope.Scope memory scope, uint64 from, uint64 to, uint256 members, uint256 bond)
        internal
        returns (uint256 id)
    {
        VM.prank(PAYER);
        id = REGISTRY.open{value: bond}(scope, from, to, 25);
        for (uint256 i = 0; i < members; i++) {
            UtuhRegistry.EventProof[] memory ps = new UtuhRegistry.EventProof[](1);
            ps[0] = _proof(from + 1 + uint64(i));
            VM.prank(PAYER);
            REGISTRY.appendBatch(id, ps, _continuity());
        }
        VM.prank(PAYER);
        REGISTRY.seal(id);
        VM.roll(REGISTRY.challengeUntil(id) + 1);
        REGISTRY.finalize(id);
    }

    function _finalized(uint256 claimId) internal view returns (bool) {
        return REGISTRY.claim(claimId).status == UtuhRegistry.Status.Finalized;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? PAYER : WATCHER;
    }

    function _claimId(uint256 seed) internal view returns (uint256) {
        uint256 n = REGISTRY.nextClaimId() - 1;
        return n == 0 ? 0 : 1 + (seed % n);
    }

    function _lineId(uint256 seed) internal view returns (uint256) {
        uint256 n = CREDIT.nextLineId() - 1;
        return n == 0 ? 0 : 1 + (seed % n);
    }

    function _proof(uint64 height) internal pure returns (UtuhRegistry.EventProof memory p) {
        p.blockHeight = height;
        p.encodedTransaction = SETTLEMENT;
        p.merkleRoot = keccak256(abi.encode(height));
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
    }

    function _continuity() internal pure returns (IBlockProver.ContinuityProof memory c) {
        c.lowerEndpointDigest = bytes32(uint256(1));
        c.roots = new bytes32[](1);
        c.roots[0] = bytes32(uint256(2));
    }
}

/// @dev The Block Prover's verdict, substituted: every proof verifies, every transaction is index 7.
contract ProverThatSaysYes {
    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        IBlockProver.MerkleProof calldata,
        IBlockProver.ContinuityProof calldata
    ) external pure returns (bool) {
        return true;
    }

    function verifyAndEmit(
        uint64,
        uint64[] calldata,
        bytes[] calldata,
        IBlockProver.MerkleProof[] calldata,
        IBlockProver.ContinuityProof calldata
    ) external pure returns (bool) {
        return true;
    }

    function calculateTxIndex(IBlockProver.MerkleProof calldata) external pure returns (uint64) {
        return 7;
    }
}

/// @dev ChainInfo's attestation heights, substituted: everything attested, frontier at 1_000_500.
contract ChainInfoThatSaysAttested {
    function is_height_attested(uint64, uint64) external pure returns (bool) {
        return true;
    }

    function get_attestation_genesis_height(uint64) external pure returns (uint64) {
        return 0;
    }

    function get_latest_attestation_height_and_hash(uint64)
        external
        pure
        returns (IChainInfo.HeightHashResult memory r)
    {
        r.height = 1_000_500;
        r.isAttestation = true;
        r.exists = true;
    }
}

/// @dev The cheatcodes medusa and forge both implement at the hevm address.
interface Hevm {
    function etch(address, bytes calldata) external;
    function prank(address) external;
    function roll(uint256) external;
    function deal(address, uint256) external;
}
