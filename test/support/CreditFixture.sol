// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {UtuhCredit} from "../../src/UtuhCredit.sol";
import {EventScope} from "../../src/lib/EventScope.sol";

/// @notice The source-chain history the credit tests underwrite against, described once.
///
/// @dev Four test contracts carried their own copy of this, identical but for the chain key, so
///      any change to what the tests underwrite against had to be made in four places to stay
///      true — and a suite whose contracts disagree about the thing under test says less than it
///      appears to. `UtuhCreditTest` keeps its own on purpose: it varies the emitter and the
///      counterparty to exercise the matching itself, which is the one case where sharing a single
///      description would defeat the point of the test.
abstract contract CreditFixture {
    address internal constant AAVE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    /// @notice An Aave repayment on `chainKey`, matched by topic position.
    function _specOn(uint64 chainKey, uint8 subjectTopic, uint8 counterpartyTopic)
        internal
        pure
        returns (UtuhCredit.HistorySpec memory s)
    {
        s.chainKey = chainKey;
        s.emitter = AAVE;
        s.eventSig = keccak256("Repay(address,address,address,uint256,bool)");
        s.subjectTopic = subjectTopic;
        s.counterpartyTopic = counterpartyTopic;
        s.counterparty = counterpartyTopic == 0 ? address(0) : USDC;
        s.metric = EventScope.Metric.DATA_WORD;
        s.metricArg = 0;
    }

    /// @notice The same, on chain key 3 — what CC3 Testnet numbers Ethereum mainnet as.
    function _spec(uint8 subjectTopic, uint8 counterpartyTopic) internal pure returns (UtuhCredit.HistorySpec memory) {
        return _specOn(3, subjectTopic, counterpartyTopic);
    }

    /// @notice The policy every test but `UtuhCreditTest` deploys against.
    function _policy() internal pure returns (UtuhCredit.Policy memory) {
        return UtuhCredit.Policy({
            volumeUnitInCtc: 15_000_000_000_000,
            minUnderwritingWindow: 25,
            minHistoryBlocks: 216_000,
            maxStalenessBlocks: 50_400,
            repaymentBps: 10_500,
            repayWindowBlocks: 400
        });
    }
}
