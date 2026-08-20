// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IChainInfo
/// @notice Attestcoin Protocol ChainInfo precompile at `0x…0FD3` (4051).
/// @dev Function names are snake_case because that is how the precompile's ABI is published in
///      the Gluwa usc-sdk module, at dist/chain-info/chain_info.json. Renaming them would change
///      the selectors and silently break every call.
interface IChainInfo {
    struct HeightHashResult {
        uint64 height;
        bytes32 hash;
        bool isAttestation;
        bool exists;
    }

    struct ChainInfoEntry {
        uint64 chainKey;
        uint64 chainId;
        bytes chainName;
        uint64 chainEncoding;
    }

    /// @notice True once `targetHeight` on `chainKey` is covered by an attestation or checkpoint,
    ///         i.e. once a proof for a transaction in that block can be generated and verified.
    function is_height_attested(uint64 chainKey, uint64 targetHeight) external view returns (bool);

    /// @notice Highest source-chain height currently attested on Creditcoin.
    function get_latest_attestation_height_and_hash(uint64 chainKey)
        external
        view
        returns (HeightHashResult memory);

    /// @notice Lowest source-chain height Creditcoin holds attestation data for.
    function get_attestation_genesis_height(uint64 chainKey) external view returns (uint64);

    /// @notice Source chains this Creditcoin network can read from.
    function get_supported_chains() external view returns (ChainInfoEntry[] memory);
}

library ChainInfoLib {
    address internal constant PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000fD3;

    function getChainInfo() internal pure returns (IChainInfo) {
        return IChainInfo(PRECOMPILE_ADDRESS);
    }
}
