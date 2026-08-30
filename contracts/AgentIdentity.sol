// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";
import {NeuroMeshGuarded} from "./base/NeuroMeshGuarded.sol";
import {Roles} from "./libraries/Roles.sol";
import {Limits} from "./libraries/Limits.sol";
import {Pagination} from "./libraries/Pagination.sol";
import {
    AgentAlreadyActive,
    AgentInactive,
    AlreadyRegistered,
    DeadlineTooFar,
    InvalidSignature,
    NotRegistered,
    SignatureExpired,
    StringTooLong
} from "./libraries/NeuroMeshErrors.sol";

/**
 * @title AgentIdentity
 * @author NeuroMesh Protocol
 * @notice The NeuroMesh agent registry: one record per address, holding a rotatable encryption
 *         public key, an optional metadata URI, and an activity flag.
 * @dev WHAT THIS CONTRACT FIXES relative to the previous version:
 *      - Registration was permanent and unchangeable. There is now key rotation with a monotonic
 *        `keyVersion`, mutable metadata, self-deactivation, self-reactivation, and administrative
 *        suspension under `REGISTRAR_ROLE`.
 *      - A deactivated agent could re-register and silently reset `registeredAt`. The `exists` flag
 *        is now the registration guard and is never cleared, so account age is immutable.
 *      - There was no admin, no pause, and one solitary event. There is now role-based access
 *        control, `Pausable`, and an event for every state transition.
 *      - Registration required the agent to hold gas. `registerAgentFor` / `rotateKeyFor` accept an
 *        EIP-712 authorisation from the agent, so a relayer can pay.
 *
 *      TRUST NOTE ON `publicKey`. The contract cannot verify that the published encryption key
 *      corresponds to the registering address - they are different cryptosystems. `publicKey` is a
 *      self-assertion, authenticated only by the fact that the address (or its EIP-712 signature)
 *      authorised its publication. Consumers must treat a key rotation as invalidating every
 *      previously wrapped key addressed to the old version, which is why `keyVersion` is recorded
 *      alongside every access grant in MemoryAccessControl.
 *
 *      REPLAY PROTECTION. The EIP-712 domain is `("NeuroMeshAgentIdentity", "1", chainId, address(this))`,
 *      so an authorisation cannot be replayed on another chain or against another deployment.
 *      OpenZeppelin's `EIP712` re-derives the separator if the chain id changes under a fork.
 *      Per-agent nonces (OpenZeppelin `Nonces`) prevent replay within a single deployment.
 *
 * @custom:security-contact security@neuromesh.protocol
 */
contract AgentIdentity is IAgentIdentity, NeuroMeshGuarded, EIP712, Nonces {
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentIdentity
    bytes32 public constant override REGISTRATION_TYPEHASH =
        keccak256("Registration(address agent,bytes32 publicKeyHash,bytes32 metadataURIHash,uint256 nonce,uint256 deadline)");

    /// @inheritdoc IAgentIdentity
    bytes32 public constant override KEY_ROTATION_TYPEHASH =
        keccak256("KeyRotation(address agent,bytes32 publicKeyHash,uint256 nonce,uint256 deadline)");

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev Agent records, keyed by address.
    mapping(address => Agent) private _agents;

    /// @dev Registration-ordered set of every registered address, for on-chain enumeration.
    EnumerableSet.AddressSet private _agentSet;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deploys the registry with `admin` holding administrative, pauser and registrar rights.
     * @param admin Protocol administrator; must be non-zero. Intended to be a multisig or timelock.
     */
    constructor(address admin) NeuroMeshGuarded(admin) EIP712("NeuroMeshAgentIdentity", "1") {
        _grantRole(Roles.REGISTRAR_ROLE, admin);
    }

    /*//////////////////////////////////////////////////////////////
                          REGISTRATION (WRITE)
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IAgentIdentity
     * @dev Self-service registration: `msg.sender` is both the agent and the registrar.
     */
    function registerAgent(bytes calldata publicKey, string calldata metadataURI) external override whenNotPaused {
        _register(msg.sender, publicKey, metadataURI, msg.sender);
    }

    /**
     * @inheritdoc IAgentIdentity
     * @dev Meta-transaction registration. Deliberately permissionless: the authorisation is the
     *      agent's own EIP-712 signature, so gating the relayer would add no security and would
     *      break the "any relayer can pay" property. Front-running is inert - a griefer who submits
     *      the signed payload first simply pays gas to register the victim exactly as intended.
     *      The nonce is consumed inside the digest computation, so a failed verification reverts the
     *      whole transaction and burns nothing.
     */
    function registerAgentFor(
        address agent,
        bytes calldata publicKey,
        string calldata metadataURI,
        uint256 deadline,
        bytes calldata signature
    ) external override whenNotPaused {
        _requireNonZero(agent);
        _checkDeadline(deadline);
        bytes32 structHash = keccak256(
            abi.encode(
                REGISTRATION_TYPEHASH,
                agent,
                keccak256(publicKey),
                keccak256(bytes(metadataURI)),
                _useNonce(agent),
                deadline
            )
        );
        _verify(structHash, agent, signature);
        _register(agent, publicKey, metadataURI, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                          KEY / METADATA (WRITE)
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IAgentIdentity
     * @dev Rotation is the recovery path for a compromised encryption key. It does not change the
     *      agent's address, so history, memories and reputation all survive it.
     */
    function rotateKey(bytes calldata newPublicKey) external override whenNotPaused {
        _rotateKey(msg.sender, newPublicKey);
    }

    /// @inheritdoc IAgentIdentity
    function rotateKeyFor(
        address agent,
        bytes calldata newPublicKey,
        uint256 deadline,
        bytes calldata signature
    ) external override whenNotPaused {
        _requireNonZero(agent);
        _checkDeadline(deadline);
        bytes32 structHash = keccak256(
            abi.encode(KEY_ROTATION_TYPEHASH, agent, keccak256(newPublicKey), _useNonce(agent), deadline)
        );
        _verify(structHash, agent, signature);
        _rotateKey(agent, newPublicKey);
    }

    /// @inheritdoc IAgentIdentity
    function setMetadataURI(string calldata metadataURI) external override whenNotPaused {
        Agent storage a = _agents[msg.sender];
        if (!a.exists) revert NotRegistered(msg.sender);
        _validateMetadata(metadataURI);
        a.metadataURI = metadataURI;
        emit AgentMetadataUpdated(msg.sender, metadataURI);
    }

    /*//////////////////////////////////////////////////////////////
                            STATUS (WRITE)
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IAgentIdentity
     * @dev DELIBERATELY NOT `whenNotPaused`. An agent that discovers its key is compromised must be
     *      able to stop the protocol from accepting new commits and endorsements in its name at any
     *      time, including during an incident pause - which is precisely when it matters most. The
     *      action is strictly restrictive, so it cannot be used to bypass a pause.
     */
    function deactivate() external override {
        Agent storage a = _agents[msg.sender];
        if (!a.exists) revert NotRegistered(msg.sender);
        if (!a.active) revert AgentInactive(msg.sender);
        a.active = false;
        a.statusChangedAt = uint64(block.timestamp);
        emit AgentStatusChanged(msg.sender, false, msg.sender, bytes32("self"));
    }

    /// @inheritdoc IAgentIdentity
    function reactivate() external override whenNotPaused {
        Agent storage a = _agents[msg.sender];
        if (!a.exists) revert NotRegistered(msg.sender);
        if (a.active) revert AgentAlreadyActive(msg.sender);
        a.active = true;
        a.statusChangedAt = uint64(block.timestamp);
        emit AgentStatusChanged(msg.sender, true, msg.sender, bytes32("self"));
    }

    /**
     * @inheritdoc IAgentIdentity
     * @dev DELIBERATELY NOT `whenNotPaused`: suspending a proven-malicious agent is exactly the tool
     *      an operator needs while the protocol is paused. Reverts when the requested state is
     *      already in force, so an administrative no-op can never be mistaken for an intervention.
     */
    function adminSetActive(
        address agent,
        bool active_,
        bytes32 reason
    ) external override onlyRole(Roles.REGISTRAR_ROLE) {
        Agent storage a = _agents[agent];
        if (!a.exists) revert NotRegistered(agent);
        if (active_ && a.active) revert AgentAlreadyActive(agent);
        if (!active_ && !a.active) revert AgentInactive(agent);
        a.active = active_;
        a.statusChangedAt = uint64(block.timestamp);
        emit AgentStatusChanged(agent, active_, msg.sender, reason);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentIdentity
    function isActive(address account) external view override returns (bool) {
        return _agents[account].active;
    }

    /// @inheritdoc IAgentIdentity
    function isRegistered(address account) external view override returns (bool) {
        return _agents[account].exists;
    }

    /**
     * @inheritdoc IAgentIdentity
     * @custom:deprecated Identical to {isActive}; kept so pre-existing off-chain ABI fragments in
     *                    `server.js` and `scripts/simulate.js` continue to resolve.
     */
    function getAgentStatus(address account) external view override returns (bool) {
        return _agents[account].active;
    }

    /// @inheritdoc IAgentIdentity
    function getAgent(address account) external view override returns (Agent memory) {
        Agent storage a = _agents[account];
        if (!a.exists) revert NotRegistered(account);
        return a;
    }

    /// @inheritdoc IAgentIdentity
    function getPublicKey(address account) external view override returns (bytes memory publicKey, uint32 keyVersion) {
        Agent storage a = _agents[account];
        if (!a.exists) revert NotRegistered(account);
        return (a.publicKey, a.keyVersion);
    }

    /// @inheritdoc IAgentIdentity
    function totalAgents() external view override returns (uint256) {
        return _agentSet.length();
    }

    /**
     * @inheritdoc IAgentIdentity
     * @dev Registration order. An `offset` past the end returns an empty page rather than reverting,
     *      so a client can loop until it sees one.
     */
    function getAgents(
        uint256 offset,
        uint256 limit
    ) external view override returns (address[] memory page, uint256 total) {
        total = _agentSet.length();
        (uint256 start, uint256 count) = Pagination.slice(total, offset, limit, Limits.MAX_PAGE_SIZE);
        page = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = _agentSet.at(start + i);
        }
    }

    /**
     * @inheritdoc IAgentIdentity
     * @dev Resolves the diamond between the interface declaration and OpenZeppelin `Nonces`.
     */
    function nonces(address owner) public view virtual override(IAgentIdentity, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Writes a first-time registration and indexes the agent.
     * @param agent       Address being registered.
     * @param publicKey   Opaque encryption public key.
     * @param metadataURI Optional metadata pointer.
     * @param registrar   `msg.sender`, recorded in the event for relayer attribution.
     */
    function _register(address agent, bytes calldata publicKey, string calldata metadataURI, address registrar) internal {
        Agent storage a = _agents[agent];
        if (a.exists) revert AlreadyRegistered(agent);
        _validateKey(publicKey);
        _validateMetadata(metadataURI);

        a.registeredAt = uint64(block.timestamp);
        a.statusChangedAt = uint64(block.timestamp);
        a.keyVersion = 1;
        a.active = true;
        a.exists = true;
        a.publicKey = publicKey;
        a.metadataURI = metadataURI;

        _agentSet.add(agent);
        emit AgentRegistered(agent, registrar, publicKey, metadataURI, uint64(block.timestamp));
    }

    /**
     * @dev Shared rotation body for the direct and meta-transaction entrypoints.
     * @param agent        Agent whose key is being replaced.
     * @param newPublicKey The replacement key.
     */
    function _rotateKey(address agent, bytes calldata newPublicKey) internal {
        Agent storage a = _agents[agent];
        if (!a.exists) revert NotRegistered(agent);
        if (!a.active) revert AgentInactive(agent);
        _validateKey(newPublicKey);

        uint32 newVersion = a.keyVersion + 1;
        a.keyVersion = newVersion;
        a.publicKey = newPublicKey;
        emit AgentKeyRotated(agent, newVersion, newPublicKey);
    }

    /// @dev Enforces the protocol bounds on an encryption public key.
    function _validateKey(bytes calldata publicKey) internal pure {
        Limits.checkBytesLen(
            bytes32("publicKey"),
            publicKey.length,
            Limits.MIN_PUBLIC_KEY_BYTES,
            Limits.MAX_PUBLIC_KEY_BYTES
        );
    }

    /// @dev Metadata is optional, so only the upper bound is enforced.
    function _validateMetadata(string calldata uri) internal pure {
        uint256 len = bytes(uri).length;
        if (len > Limits.MAX_METADATA_URI_BYTES) {
            revert StringTooLong(bytes32("metadataURI"), len, Limits.MAX_METADATA_URI_BYTES);
        }
    }

    /**
     * @dev Rejects expired authorisations and authorisations that would remain valid for longer than
     *      `Limits.MAX_SIGNATURE_VALIDITY`, which bounds how long a leaked signature stays dangerous.
     */
    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
        uint256 maxDeadline = block.timestamp + Limits.MAX_SIGNATURE_VALIDITY;
        if (deadline > maxDeadline) revert DeadlineTooFar(deadline, maxDeadline);
    }

    /**
     * @dev Verifies an EIP-712 authorisation. Uses `SignatureChecker` rather than raw `ECDSA` so
     *      ERC-1271 smart-contract agent wallets are first-class citizens of the protocol.
     * @param structHash The EIP-712 struct hash (without the domain prefix).
     * @param signer     The address that must have authorised it.
     * @param signature  ECDSA signature bytes, or ERC-1271 payload for a contract signer.
     */
    function _verify(bytes32 structHash, address signer, bytes calldata signature) internal view {
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) revert InvalidSignature(signer);
    }
}
