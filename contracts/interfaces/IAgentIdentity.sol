// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IAgentIdentity
 * @author NeuroMesh Protocol
 * @notice Stable ABI surface of the NeuroMesh agent registry, consumed by MemoryLedger,
 *         ReputationManager, MemoryAccessControl and the off-chain node.
 * @dev The registry is a decentralised-identifier (DID) style directory keyed by address. It records
 *      an opaque, self-asserted encryption public key, an optional metadata URI, a monotonic key
 *      version, and an activity flag. It does NOT and CANNOT prove that the published key
 *      corresponds to the address - consumers must treat `publicKey` as a self-assertion.
 */
interface IAgentIdentity {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The full on-chain record for one agent.
     * @dev Field order is part of the ABI: the backend decodes this tuple positionally. The four
     *      value-type fields (8 + 8 + 4 + 1 + 1 = 22 bytes) share a single storage slot; the two
     *      dynamic fields occupy one slot each for their length pointer.
     * @param registeredAt      Unix seconds of first registration; never changes afterwards.
     * @param statusChangedAt   Unix seconds of the last activate/deactivate transition.
     * @param keyVersion        Monotonic counter, 1 at registration, incremented by every rotation.
     * @param active            False when self-deactivated or suspended by a registrar.
     * @param exists            True once registered; NEVER cleared, so `registeredAt` cannot be reset.
     * @param publicKey         Opaque encryption public key (X25519 raw or secp256k1 SEC1).
     * @param metadataURI       Optional off-chain profile pointer; may be empty.
     */
    struct Agent {
        uint64 registeredAt;
        uint64 statusChangedAt;
        uint32 keyVersion;
        bool active;
        bool exists;
        bytes publicKey;
        string metadataURI;
    }

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted once per address, on first registration.
    /// @param agent        The registered agent.
    /// @param registrar    `msg.sender` of the registering transaction (a relayer for meta-registration).
    /// @param publicKey    The agent's initial encryption public key.
    /// @param metadataURI  The agent's initial metadata URI.
    /// @param registeredAt Block timestamp of registration.
    event AgentRegistered(
        address indexed agent,
        address indexed registrar,
        bytes publicKey,
        string metadataURI,
        uint64 registeredAt
    );

    /// @notice Emitted whenever an agent publishes a new encryption public key.
    /// @param agent         The agent rotating its key.
    /// @param newKeyVersion The post-rotation key version; indexed so clients can spot gaps.
    /// @param newPublicKey  The newly published key.
    event AgentKeyRotated(address indexed agent, uint32 indexed newKeyVersion, bytes newPublicKey);

    /// @notice Emitted whenever an agent updates its metadata URI.
    event AgentMetadataUpdated(address indexed agent, string metadataURI);

    /// @notice Emitted on every activity transition, whether self-initiated or administrative.
    /// @param agent  The affected agent.
    /// @param active The new activity state.
    /// @param actor  Who caused the change (the agent itself, or a `REGISTRAR_ROLE` holder).
    /// @param reason Short-string reason code; `bytes32("self")` for self-service transitions.
    event AgentStatusChanged(address indexed agent, bool indexed active, address indexed actor, bytes32 reason);

    /*//////////////////////////////////////////////////////////////
                            STATE CHANGING
    //////////////////////////////////////////////////////////////*/

    /// @notice Registers `msg.sender` as an agent.
    function registerAgent(bytes calldata publicKey, string calldata metadataURI) external;

    /// @notice Registers `agent` using the agent's own EIP-712 signature, paid for by `msg.sender`.
    function registerAgentFor(
        address agent,
        bytes calldata publicKey,
        string calldata metadataURI,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice Publishes a new encryption public key for `msg.sender` and bumps its key version.
    function rotateKey(bytes calldata newPublicKey) external;

    /// @notice Rotates `agent`'s key using the agent's own EIP-712 signature, paid for by `msg.sender`.
    function rotateKeyFor(
        address agent,
        bytes calldata newPublicKey,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice Updates `msg.sender`'s metadata URI.
    function setMetadataURI(string calldata metadataURI) external;

    /// @notice Marks `msg.sender` inactive. Always available, even while the contract is paused.
    function deactivate() external;

    /// @notice Marks `msg.sender` active again.
    function reactivate() external;

    /// @notice Suspends or reinstates an agent administratively.
    function adminSetActive(address agent, bool active, bytes32 reason) external;

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice True when the agent is registered and currently active.
    function isActive(address account) external view returns (bool);

    /// @notice True when the agent has ever been registered, regardless of activity.
    function isRegistered(address account) external view returns (bool);

    /// @notice Alias of {isActive}.
    /// @custom:deprecated Retained so existing `server.js` / `simulate.js` ABI fragments keep working.
    function getAgentStatus(address account) external view returns (bool);

    /// @notice Returns the full agent record; reverts `NotRegistered` when absent.
    function getAgent(address account) external view returns (Agent memory);

    /// @notice Returns the agent's current encryption key and its version.
    function getPublicKey(address account) external view returns (bytes memory publicKey, uint32 keyVersion);

    /// @notice Number of registered agents (lifetime; registration is irreversible).
    function totalAgents() external view returns (uint256);

    /// @notice Paginated agent enumeration in registration order.
    function getAgents(uint256 offset, uint256 limit) external view returns (address[] memory page, uint256 total);

    /// @notice Current EIP-712 nonce for `owner`, consumed by `registerAgentFor` / `rotateKeyFor`.
    function nonces(address owner) external view returns (uint256);

    /// @notice EIP-712 type hash for the `Registration` struct.
    function REGISTRATION_TYPEHASH() external view returns (bytes32);

    /// @notice EIP-712 type hash for the `KeyRotation` struct.
    function KEY_ROTATION_TYPEHASH() external view returns (bytes32);
}
