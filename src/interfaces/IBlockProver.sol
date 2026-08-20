// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBlockProver
/// @notice Attestcoin Protocol Block Prover precompile at `0x…0FD2` (4050).
/// @dev Struct layouts and signatures are byte-identical to Gluwa's canonical
///      `block_prover.sol`. The copy packaged in the Gluwa usc-contracts npm module exposes only the
///      read-only `verify`; Utuh needs `verifyAndEmit` (state-changing, emits
///      `TransactionVerified`) and `calculateTxIndex`, so the full interface is declared here.
interface IBlockProver {
    struct MerkleProofEntry {
        bytes32 hash;
        bool isLeft;
    }

    struct MerkleProof {
        bytes32 root;
        MerkleProofEntry[] siblings;
    }

    struct ContinuityProof {
        bytes32 lowerEndpointDigest;
        bytes32[] roots;
    }

    /// @notice Verify a transaction's inclusion in a finalized, attested source-chain block.
    /// @dev Reverts on failure, returns true on success. Does NOT check the receipt status —
    ///      callers MUST validate `receiptStatus == 1` themselves.
    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external returns (bool);

    /// @notice Verify up to 10 queries against a single shared continuity proof.
    /// @dev This is what the Proof Builder's batch endpoint is shaped for: one continuity chain
    ///      spanning the batch's block range, with a Merkle proof per query. Feeding a shared
    ///      continuity proof to the single-query entrypoint only works when every query sits in
    ///      the same block; anywhere else it reverts with "Merkle root mismatch".
    ///      The cap is on queries, not transactions — a transaction with three in-scope logs
    ///      spends three slots. Exceeding it reverts with "heights: Value is too large for length".
    function verifyAndEmit(
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        MerkleProof[] calldata merkleProofs,
        ContinuityProof calldata sharedContinuityProof
    ) external returns (bool);

    /// @notice Read-only variant of {verifyAndEmit}.
    function verify(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external view returns (bool);

    /// @notice Recover the transaction's index within its block from the Merkle proof path.
    function calculateTxIndex(MerkleProof calldata merkleProof) external view returns (uint64);
}

library BlockProverLib {
    address internal constant PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000FD2;

    function getProver() internal pure returns (IBlockProver) {
        return IBlockProver(PRECOMPILE_ADDRESS);
    }
}
