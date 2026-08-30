// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAgentIdentity} from "./IAgentIdentity.sol";
import {IMemoryLedger} from "./IMemoryLedger.sol";

/**
 * @title IMemoryAccessControl
 * @author NeuroMesh Protocol
 * @notice Stable ABI surface of the decryption-delegation contract.
 * @dev The contract publishes, per (memory, grantee) pair, a wrapped content-encryption key and an
 *      on-chain authorisation record. `canAccess` is the single predicate the backend authorises
 *      reads against.
 */
interface IMemoryAccessControl {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice One delegation of decryption rights.
     * @dev All five fields pack into a single storage slot (8 + 8 + 8 + 4 + 1 = 29 bytes).
     * @param grantedAt  Unix seconds the grant was created (or most recently re-created).
     * @param expiresAt  Unix seconds after which the grant lapses; 0 means it never expires.
     * @param revokedAt  Unix seconds the grant was revoked; 0 means active.
     * @param keyVersion The grantee's AgentIdentity key version the wrapped key was encrypted to.
     * @param exists     True once a grant has ever been created for this pair; never cleared, so the
     *                   grantee index arrays are appended to at most once per pair.
     */
    struct Grant {
        uint64 grantedAt;
        uint64 expiresAt;
        uint64 revokedAt;
        uint32 keyVersion;
        bool exists;
    }

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted when decryption rights are delegated. Carries the wrapped key so a relayer or
    ///         client needs no follow-up RPC.
    event AccessGranted(
        bytes32 indexed cidHash,
        address indexed owner,
        address indexed grantee,
        uint64 expiresAt,
        uint32 keyVersion,
        bytes wrappedKey
    );

    /// @notice Emitted when a grant is withdrawn by its owner or by a moderator.
    event AccessRevoked(
        bytes32 indexed cidHash,
        address indexed owner,
        address indexed grantee,
        address actor,
        bytes32 reason
    );

    /*//////////////////////////////////////////////////////////////
                            STATE CHANGING
    //////////////////////////////////////////////////////////////*/

    /// @notice Delegates decryption of `cidHash` to `grantee`; caller must own the memory.
    function grantAccess(bytes32 cidHash, address grantee, bytes calldata wrappedKey, uint64 expiresAt) external;

    /// @notice Delegates decryption of one memory to many grantees in a single transaction.
    function grantAccessBatch(
        bytes32 cidHash,
        address[] calldata grantees,
        bytes[] calldata wrappedKeys,
        uint64 expiresAt
    ) external;

    /// @notice Delegates decryption on behalf of `owner`, authorised by the owner's EIP-712 signature.
    function grantAccessFor(
        address owner,
        bytes32 cidHash,
        address grantee,
        bytes calldata wrappedKey,
        uint64 expiresAt,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice Withdraws a grant; caller must own the memory.
    function revokeAccess(bytes32 cidHash, address grantee, bytes32 reason) external;

    /// @notice Withdraws any grant; restricted to `MODERATOR_ROLE`.
    function moderatorRevokeAccess(bytes32 cidHash, address grantee, bytes32 reason) external;

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The authorisation predicate. Never reverts, for any input.
    function canAccess(bytes32 cidHash, address account) external view returns (bool);

    /// @notice The raw grant record, active or not.
    function getGrant(bytes32 cidHash, address grantee) external view returns (Grant memory);

    /// @notice The stored wrapped key and the grantee key version it targets.
    function getWrappedKey(
        bytes32 cidHash,
        address grantee
    ) external view returns (bytes memory wrappedKey, uint32 keyVersion);

    /// @notice Paginated list of every address ever granted access to `cidHash`.
    function getGrantees(
        bytes32 cidHash,
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory page, uint256 total);

    /// @notice Paginated list of every memory ever granted to `grantee`.
    function getGrantsFor(
        address grantee,
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory page, uint256 total);

    /// @notice Current EIP-712 nonce for `owner`.
    function nonces(address owner) external view returns (uint256);

    /// @notice EIP-712 type hash for the `AccessGrant` struct.
    function ACCESS_GRANT_TYPEHASH() external view returns (bytes32);

    /// @notice The immutable MemoryLedger this contract reads ownership from.
    function ledger() external view returns (IMemoryLedger);

    /// @notice The immutable AgentIdentity registry used to resolve grantee key versions.
    function identity() external view returns (IAgentIdentity);
}
