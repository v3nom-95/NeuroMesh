// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAgentIdentity} from "../interfaces/IAgentIdentity.sol";

/**
 * @title ERC1271Wallet
 * @author NeuroMesh Protocol
 * @notice Minimal ERC-1271 smart-contract wallet, used only by the test suite.
 * @dev Exists to prove that every EIP-712 path in NeuroMesh accepts smart-contract agent wallets,
 *      because the protocol verifies with OpenZeppelin `SignatureChecker` rather than raw `ECDSA`.
 *      `setOwner` lets a test flip the authorised signer and assert that the very same signature is
 *      then rejected, which distinguishes real ERC-1271 dispatch from an accidental EOA recovery.
 *
 *      NOT FOR PRODUCTION: no replay protection, no access control on `setOwner`, no guards.
 */
contract ERC1271Wallet {
    /// @notice ERC-1271 magic value returned for a valid signature.
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;

    /// @notice The EOA whose signatures this wallet accepts.
    address public owner;

    /// @param owner_ Initial authorised signer.
    constructor(address owner_) {
        owner = owner_;
    }

    /// @notice Replaces the authorised signer.
    /// @param owner_ New authorised signer.
    function setOwner(address owner_) external {
        owner = owner_;
    }

    /**
     * @notice ERC-1271 signature validation.
     * @param hash      The digest that was signed.
     * @param signature The candidate signature.
     * @return The ERC-1271 magic value when `signature` recovers to `owner`, `0xffffffff` otherwise.
     */
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        if (err != ECDSA.RecoverError.NoError) return 0xffffffff;
        return recovered == owner ? MAGIC_VALUE : bytes4(0xffffffff);
    }

    /**
     * @notice Registers this contract as an agent, so it can go on to own memories.
     * @param identity_   The AgentIdentity deployment.
     * @param publicKey   Encryption public key to publish.
     * @param metadataURI Optional metadata pointer.
     */
    function callRegister(address identity_, bytes calldata publicKey, string calldata metadataURI) external {
        IAgentIdentity(identity_).registerAgent(publicKey, metadataURI);
    }
}
