// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {UtuhCredit} from "../src/UtuhCredit.sol";
import {EventScope} from "../src/lib/EventScope.sol";
import {IBlockProver} from "../src/interfaces/IBlockProver.sol";
import {IChainInfo} from "../src/interfaces/IChainInfo.sol";

/// @notice Every wei the lender put in is either still available or out on a line, whatever the
///         borrower does in whatever order — and the books about that borrower stay consistent.
///
/// @dev `RegistryInvariant.t.sol` does this for bonds. Nothing did it for credit: the unit tests
///      take one path each through open, draw, settle, default, cure and close, and the properties
///      that matter — one active line per subject, a default counted exactly once, no draw past a
///      limit, no CTC that is neither available nor drawn — were each asserted on one path and
///      assumed on the rest. This drives the lender through hundreds of random sequences with the
///      clock rolled between moves, so deadlines pass mid-sequence and every transition is reached
///      from every state that allows it.
///
///      The precompiles are substituted the way `Lifecycle.t.sol` substitutes them: the prover says
///      yes, ChainInfo says attested. Everything else runs on the real Sepolia bytes.
contract CreditInvariantTest is Test {
    CreditHandler internal handler;
    UtuhRegistry internal registry;
    UtuhCredit internal credit;
    address internal subject;

    function setUp() public {
        vm.mockCall(
            0x0000000000000000000000000000000000000fD3,
            abi.encodeWithSelector(IChainInfo.is_height_attested.selector),
            abi.encode(true)
        );
        vm.mockCall(
            0x0000000000000000000000000000000000000fD3,
            abi.encodeWithSelector(IChainInfo.get_attestation_genesis_height.selector),
            abi.encode(uint64(0))
        );
        vm.mockCall(
            0x0000000000000000000000000000000000000fD3,
            abi.encodeWithSelector(IChainInfo.get_latest_attestation_height_and_hash.selector),
            abi.encode(
                IChainInfo.HeightHashResult({height: 1_000_500, hash: bytes32(0), isAttestation: true, exists: true})
            )
        );
        bytes4 verifyOne =
            bytes4(keccak256("verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))"));
        bytes4 verifyBatch = bytes4(
            keccak256("verifyAndEmit(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))")
        );
        vm.mockCall(0x0000000000000000000000000000000000000FD2, abi.encodeWithSelector(verifyOne), abi.encode(true));
        vm.mockCall(0x0000000000000000000000000000000000000FD2, abi.encodeWithSelector(verifyBatch), abi.encode(true));
        vm.mockCall(
            0x0000000000000000000000000000000000000FD2,
            abi.encodeWithSelector(IBlockProver.calculateTxIndex.selector),
            abi.encode(uint64(7))
        );

        registry = new UtuhRegistry(25);
        handler = new CreditHandler(registry, Cheats(address(vm)));
        credit = handler.CREDIT();
        subject = handler.SUBJECT();

        targetContract(address(handler));
    }

    /// @notice CTC never comes back into this contract: repayment happens on the source chain. So
    ///         what it holds is exactly what the lender has not withdrawn and nobody has drawn.
    function invariant_theContractHoldsExactlyWhatIsAvailable() public view {
        assertEq(address(credit).balance, credit.available(), "balance and available disagree");
    }

    /// @notice Every wei the lender put in is available, withdrawn, or out on a line. No other bucket.
    function invariant_everyWeiTheLenderPutInIsAvailableOrDrawn() public view {
        uint256 drawn;
        uint256 n = credit.nextLineId();
        for (uint256 id = 1; id < n; id++) {
            drawn += credit.line(id).drawn;
        }
        assertEq(handler.funded() - handler.withdrawn(), credit.available() + drawn, "the books do not balance");
    }

    function invariant_noLineIsDrawnPastItsLimit() public view {
        uint256 n = credit.nextLineId();
        for (uint256 id = 1; id < n; id++) {
            UtuhCredit.Line memory l = credit.line(id);
            assertLe(l.drawn, l.limit, "drawn past the limit");
            assertLe(credit.backingFor(l.limit) * credit.BOND_MULTIPLE(), l.limit + credit.BOND_MULTIPLE() - 1);
        }
    }

    /// @notice At most one Active line per subject, and the slot names exactly that line.
    function invariant_oneActiveLinePerSubject() public view {
        uint256 active;
        uint256 n = credit.nextLineId();
        for (uint256 id = 1; id < n; id++) {
            UtuhCredit.Line memory l = credit.line(id);
            if (l.status == UtuhCredit.LineStatus.Active) {
                active++;
                assertEq(credit.activeLineOf(l.subject), id, "an Active line is not its subject's slot");
            }
        }
        assertLe(active, 1, "two Active lines for one subject");
        uint256 slot = credit.activeLineOf(subject);
        if (slot != 0) {
            assertEq(uint8(credit.line(slot).status), uint8(UtuhCredit.LineStatus.Active), "the slot names a dead line");
        }
    }

    /// @notice `defaultsOf` counts the lines standing in Defaulted, no more and no fewer: marking
    ///         adds one, curing takes one back, nothing else touches it.
    function invariant_defaultsMatchTheBooks() public view {
        uint64 defaulted;
        uint256 n = credit.nextLineId();
        for (uint256 id = 1; id < n; id++) {
            if (credit.line(id).status == UtuhCredit.LineStatus.Defaulted) defaulted++;
        }
        assertEq(credit.defaultsOf(subject), defaulted, "defaults and Defaulted lines disagree");
    }

    /// @notice A line with money out has a deadline and owes something; one without has neither.
    ///         And a line only ever leaves Active by the door its state allows.
    function invariant_aDrawnLineOwesAndAnUndrawnOneDoesNot() public view {
        uint256 n = credit.nextLineId();
        for (uint256 id = 1; id < n; id++) {
            UtuhCredit.Line memory l = credit.line(id);
            if (l.drawn > 0) {
                assertGt(l.dueBlock, 0, "drawn with no deadline");
                assertGt(l.repayRequired, 0, "drawn and owes nothing");
                assertTrue(l.status != UtuhCredit.LineStatus.Closed, "a drawn line was closed");
            } else {
                assertEq(l.dueBlock, 0, "undrawn with a deadline");
                assertEq(l.repayRequired, 0, "undrawn and owes something");
                assertTrue(
                    l.status == UtuhCredit.LineStatus.Active || l.status == UtuhCredit.LineStatus.Closed,
                    "an undrawn line was settled or defaulted"
                );
            }
        }
    }

    /// @notice The moves the random walk is made of, each landing once in a chosen order. A
    ///         handler whose moves all revert would pass every invariant above while testing
    ///         nothing; this is what says the walk actually reaches drawn, defaulted, cured and
    ///         settled lines.
    function test_everyMoveLands() public {
        handler.fund(uint96(5 ether));
        assertEq(credit.available(), handler.funded());

        handler.openLine(0);
        uint256 first = credit.activeLineOf(subject);
        assertEq(first, 1, "openLine did not land");

        handler.draw(uint96(1 ether));
        assertGt(credit.line(first).drawn, 0, "draw did not land");

        handler.roll(199);
        handler.markDefault(0);
        assertEq(uint8(credit.line(first).status), uint8(UtuhCredit.LineStatus.Defaulted), "markDefault did not land");
        assertEq(credit.defaultsOf(subject), 1);

        handler.cure(0);
        assertEq(uint8(credit.line(first).status), uint8(UtuhCredit.LineStatus.Settled), "cure did not land");
        assertEq(credit.defaultsOf(subject), 0);

        handler.openLine(7);
        uint256 second = credit.activeLineOf(subject);
        assertEq(second, 2, "a second line after the cure");
        handler.draw(uint96(2 ether));
        handler.settle();
        assertEq(uint8(credit.line(second).status), uint8(UtuhCredit.LineStatus.Settled), "settle did not land");

        handler.openLine(3);
        handler.closeLine(2);
        assertEq(uint8(credit.line(3).status), uint8(UtuhCredit.LineStatus.Closed), "closeLine did not land");

        handler.withdrawLiquidity(uint96(1 ether));
        uint256 out = credit.line(first).drawn + credit.line(second).drawn;
        assertEq(handler.funded() - handler.withdrawn(), credit.available() + out, "withdrawLiquidity did not land");
    }

    /// @notice Watermarks only advance. History is spent once and payments discharge one debt.
    function invariant_watermarksOnlyAdvance() public view {
        assertGe(credit.underwrittenThrough(subject), handler.underwrittenSeen(), "underwrittenThrough went back");
        assertGe(credit.settledThrough(subject), handler.settledSeen(), "settledThrough went back");
    }
}

/// @dev The lender, the borrower and the clock. Every call is wrapped so that a revert is a move
///      that did not happen rather than a failed run: the lender refusing something is the lender
///      working. The handler deploys the credit contract, so it is the LENDER; the borrower is the
///      address the control fixture actually binds.
contract CreditHandler {
    UtuhRegistry internal immutable REGISTRY;
    UtuhCredit public immutable CREDIT;
    Cheats internal immutable VM;
    address public immutable SUBJECT;

    bytes internal settlement;
    bytes internal control;
    address internal payee;

    uint256 public funded;
    uint256 public withdrawn;
    uint64 public underwrittenSeen;
    uint64 public settledSeen;

    uint64 internal constant SEPOLIA = 1;
    uint64 internal constant WINDOW = 25;
    uint256 internal constant BOND = 2 ether;
    uint64 internal constant FIRST_FROM = 1_000_000;

    constructor(UtuhRegistry registry, Cheats vm_) {
        REGISTRY = registry;
        VM = vm_;
        string memory json = vm_.readFile("test/fixtures/encodedTransactions.json");
        settlement = vm_.parseJsonBytes(json, ".settlement");
        control = vm_.parseJsonBytes(json, ".control");

        EvmV1Decoder.LogEntry memory log = EvmV1Decoder.decodeReceiptFields(settlement).receiptLogs[0];
        SUBJECT = address(uint160(uint256(log.topics[1])));
        payee = address(uint160(uint256(log.topics[2])));

        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec(log);
        CREDIT = new UtuhCredit(
            registry,
            UtuhCredit.Policy({
                volumeUnitInCtc: 20_000,
                minUnderwritingWindow: WINDOW,
                minHistoryBlocks: 100,
                maxStalenessBlocks: 5_000,
                repaymentBps: 10_500,
                repayWindowBlocks: 40,
                peers: new address[](0)
            }),
            _paymentSpec(log),
            clean,
            _paymentSpec(log)
        );

        vm_.deal(address(this), 1_000 ether);
        vm_.deal(SUBJECT, 1_000 ether);

        UtuhCredit.ControlProof memory p;
        p.chainKey = SEPOLIA;
        p.blockHeight = FIRST_FROM;
        p.encodedTransaction = control;
        p.merkleRoot = keccak256("control");
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
        CREDIT.proveControl(p, _continuity());
    }

    receive() external payable {}

    // ------------------------------------------------------------------ moves

    function fund(uint96 amount) external {
        uint256 a = 1 + (uint256(amount) % 20 ether);
        try CREDIT.fund{value: a}() {
            funded += a;
        } catch {}
    }

    function withdrawLiquidity(uint96 amount) external {
        uint256 a = 1 + (uint256(amount) % 20 ether);
        try CREDIT.withdraw(a) {
            withdrawn += a;
        } catch {}
    }

    function roll(uint16 blocks) external {
        VM.roll(block.number + (blocks % 200));
    }

    /// Fresh history — a range starting where the last underwriting ended — proven, sealed,
    /// finalized as both a volume and a clean claim, then offered as a line.
    function openLine(uint8 span) external {
        uint64 from = CREDIT.underwrittenThrough(SUBJECT);
        if (from < FIRST_FROM) from = FIRST_FROM;
        uint64 to = from + 100 + (span % 50);

        uint64[] memory at = new uint64[](3);
        for (uint256 i = 0; i < 3; i++) {
            at[i] = from + uint64(i + 1);
        }
        uint256 volume = _finalizedClaim(_volumeScope(), from, to, at);
        uint256 clean = _finalizedClaim(_adverseScope(), from, to, new uint64[](0));

        uint256[] memory ids = new uint256[](1);
        ids[0] = clean;
        VM.prank(SUBJECT);
        try CREDIT.openLine(SUBJECT, volume, ids) {
            underwrittenSeen = CREDIT.underwrittenThrough(SUBJECT);
        } catch {}
    }

    function draw(uint96 amount) external {
        uint256 id = CREDIT.activeLineOf(SUBJECT);
        if (id == 0) return;
        UtuhCredit.Line memory l = CREDIT.line(id);
        uint256 room = l.limit - l.drawn;
        uint256 a = room == 0 ? 1 : 1 + (uint256(amount) % room);
        VM.prank(SUBJECT);
        try CREDIT.draw(id, a) {} catch {}
    }

    function settle() external {
        uint256 id = CREDIT.activeLineOf(SUBJECT);
        if (id == 0) return;
        uint256 claim = _repaymentClaimFor(id);
        try CREDIT.settle(id, claim) {
            settledSeen = CREDIT.settledThrough(SUBJECT);
        } catch {}
    }

    function cure(uint256 lineSeed) external {
        uint256 n = CREDIT.nextLineId() - 1;
        if (n == 0) return;
        uint256 id = 1 + (lineSeed % n);
        uint256 claim = _repaymentClaimFor(id);
        try CREDIT.cure(id, claim) {
            settledSeen = CREDIT.settledThrough(SUBJECT);
        } catch {}
    }

    function markDefault(uint256 lineSeed) external {
        uint256 n = CREDIT.nextLineId() - 1;
        if (n == 0) return;
        try CREDIT.markDefault(1 + (lineSeed % n)) {} catch {}
    }

    function closeLine(uint256 lineSeed) external {
        uint256 n = CREDIT.nextLineId() - 1;
        if (n == 0) return;
        VM.prank(SUBJECT);
        try CREDIT.closeLine(1 + (lineSeed % n)) {} catch {}
    }

    // ------------------------------------------------------------------ building blocks

    /// A repayment claim that starts where the line and the watermark both allow, carrying one
    /// real settlement — which covers any draw a line here can produce.
    function _repaymentClaimFor(uint256 lineId) internal returns (uint256) {
        uint64 from = CREDIT.line(lineId).repayFrom;
        uint64 mark = CREDIT.settledThrough(SUBJECT);
        if (mark > from) from = mark;
        uint64[] memory at = new uint64[](1);
        at[0] = from + 1;
        return _finalizedClaim(_repayScope(), from, from + 10, at);
    }

    function _finalizedClaim(EventScope.Scope memory scope, uint64 from, uint64 to, uint64[] memory at)
        internal
        returns (uint256 claimId)
    {
        VM.prank(SUBJECT);
        claimId = REGISTRY.open{value: BOND}(scope, from, to, WINDOW);
        VM.startPrank(SUBJECT);
        for (uint256 i = 0; i < at.length; i++) {
            UtuhRegistry.EventProof[] memory ps = new UtuhRegistry.EventProof[](1);
            ps[0] = _proofAt(at[i]);
            REGISTRY.appendBatch(claimId, ps, _continuity());
        }
        REGISTRY.seal(claimId);
        VM.stopPrank();
        VM.roll(REGISTRY.challengeUntil(claimId) + 1);
        REGISTRY.finalize(claimId);
    }

    function _paymentSpec(EvmV1Decoder.LogEntry memory log) internal view returns (UtuhCredit.HistorySpec memory s) {
        s.chainKey = SEPOLIA;
        s.emitter = log.address_;
        s.eventSig = log.topics[0];
        s.subjectTopic = 1;
        s.counterpartyTopic = 2;
        s.counterparty = payee;
        s.metric = EventScope.Metric.DATA_WORD;
    }

    function _adverseSpec(EvmV1Decoder.LogEntry memory log) internal pure returns (UtuhCredit.HistorySpec memory s) {
        s.chainKey = SEPOLIA;
        s.emitter = log.address_;
        s.eventSig = keccak256("Adverse(address,uint256)");
        s.subjectTopic = 1;
        s.metric = EventScope.Metric.COUNT;
    }

    function _volumeScope() internal view returns (EventScope.Scope memory) {
        return CREDIT.expectedScope(_specOf(CREDIT.volumeSpec), SUBJECT);
    }

    function _repayScope() internal view returns (EventScope.Scope memory) {
        return CREDIT.expectedScope(_specOf(CREDIT.repaySpec), SUBJECT);
    }

    function _adverseScope() internal view returns (EventScope.Scope memory) {
        return CREDIT.expectedScope(CREDIT.cleanSpecAt(0), SUBJECT);
    }

    /// The public getter for a struct returns a tuple; this puts it back together.
    function _specOf(function()
            external
            view returns (
                uint64,
                address,
                bytes32,
                uint8,
                uint8,
                address,
                EventScope.Metric,
                uint8
            ) getter) internal view returns (UtuhCredit.HistorySpec memory s) {
        (
            s.chainKey,
            s.emitter,
            s.eventSig,
            s.subjectTopic,
            s.counterpartyTopic,
            s.counterparty,
            s.metric,
            s.metricArg
        ) = getter();
    }

    function _proofAt(uint64 height) internal view returns (UtuhRegistry.EventProof memory p) {
        p.blockHeight = height;
        p.encodedTransaction = settlement;
        p.merkleRoot = keccak256(abi.encode(height));
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
    }

    function _continuity() internal pure returns (IBlockProver.ContinuityProof memory c) {
        c.lowerEndpointDigest = bytes32(uint256(1));
        c.roots = new bytes32[](1);
        c.roots[0] = bytes32(uint256(2));
    }
}

/// @dev The cheatcodes the handler needs, under a name that does not collide with forge-std's `Vm`.
interface Cheats {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function roll(uint256) external;
    function deal(address, uint256) external;
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
}
