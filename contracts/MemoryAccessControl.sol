// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";
import {IMemoryAccessControl} from "./interfaces/IMemoryAccessControl.sol";
import {IMemoryLedger} from "./interfaces/IMemoryLedger.sol";
import {NeuroMeshGuarded} from "./base/NeuroMeshGuarded.sol";
import {Limits} from "./libraries/Limits.sol";
import {Pagination} from "./libraries/Pagination.sol";
import {Roles} from "./libraries/Roles.sol";
import {
    AccessAlreadyGranted,
    AccessNotGranted,
    AgentInactive,
    ArrayLengthMismatch,
    BatchTooLarge,
    DeadlineTooFar,
    InvalidExpiry,
    InvalidSignature,
    MemoryAlreadyRevoked,
    NotAContract,
    NotMemoryOwner,
    SelfAction,
    SignatureExpired
} from "./libraries/NeuroMeshErrors.sol";

/**
 * @title MemoryAccessControl
 * @author NeuroMesh Protocol
 * @notice Delegated decryption rights for encrypted memories: an owner publishes, per grantee, a
 *         wrapped content-encryption key plus an on-chain authorisation the backend enforces.
 *
 * @dev THIS CONTRACT REPLACES KEY SHARING WITH KEY WRAPPING. In the previous design the only way for
 *      agent B to read agent A's memory was for A to hand B the secret its AES key was derived from -
 *      its wallet private key. That is not sharing, it is key disclosure, and it destroys the
 *      identity system it is built on. Here, A encrypts the per-memory content key to B's PUBLISHED
 *      encryption public key and records the envelope on chain; A's signing key never moves.
 *
 *      EVERYTHING ON A BLOCKCHAIN IS PUBLIC. `wrappedKey` MUST be ciphertext encrypted to the
 *      grantee's public key (see `AgentIdentity.getPublicKey`). It MUST NEVER be a raw AES key,
 *      a passphrase, or anything else that is useful to a reader who is not the grantee. The
 *      contract cannot check this - it stores opaque bytes - so it is a protocol obligation on the
 *      client, and it is the single most important rule in this file.
 *
 *      REVOCATION IS FORWARD-LOOKING ONLY. `revokeAccess` withdraws future authorisation and deletes
 *      the stored envelope, but it cannot un-see what a grantee already decrypted, cannot recall a
 *      copied plaintext, and cannot unpin the IPFS object. Treat a granted key as permanently
 *      disclosed to that grantee; to genuinely rotate access, re-encrypt the payload under a fresh
 *      content key and commit a new memory.
 *
 *      KEY VERSION BINDING. Each grant records the grantee's `keyVersion` at the time of wrapping.
 *      If the grantee later rotates its encryption key, the envelope becomes undecryptable - and
 *      because the version is on chain, that failure is VISIBLE to clients rather than silent.
 *
 * @custom:security-contact security@neuromesh.protocol
 */
contract MemoryAccessControl is IMemoryAccessControl, NeuroMeshGuarded, EIP712, Nonces {
    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMemoryAccessControl
    bytes32 public constant override ACCESS_GRANT_TYPEHASH =
        keccak256(
            // solhint-disable-next-line max-line-length -- one literal: the typehash preimage must stay greppable
            "AccessGrant(address owner,bytes32 cidHash,address grantee,bytes32 wrappedKeyHash,uint64 expiresAt,uint256 nonce,uint256 deadline)"
        );

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMemoryAccessControl
    IMemoryLedger public immutable override ledger;

    /// @inheritdoc IMemoryAccessControl
    IAgentIdentity public immutable override identity;

    /// @dev cidHash => grantee => grant record.
    mapping(bytes32 => mapping(address => Grant)) private _grants;

    /// @dev cidHash => grantee => wrapped content-encryption key; deleted on revocation.
    mapping(bytes32 => mapping(address => bytes)) private _wrappedKeys;

    /// @dev cidHash => every address ever granted access, appended at most once per grantee.
    mapping(bytes32 => address[]) private _granteeList;

    /// @dev grantee => every memory ever granted to it, appended at most once per memory.
    mapping(address => bytes32[]) private _grantsTo;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Wires the delegation contract to a ledger and an identity registry, both immutable.
     * @param admin     Protocol administrator; also receives `MODERATOR_ROLE`.
     * @param ledger_   Deployed MemoryLedger; ownership is always read from it, never duplicated here.
     * @param identity_ Deployed AgentIdentity; used to resolve grantee key versions and activity.
     */
    constructor(
        address admin,
        address ledger_,
        address identity_
    ) NeuroMeshGuarded(admin) EIP712("NeuroMeshAccessControl", "1") {
        _requireNonZero(ledger_);
        if (ledger_.code.length == 0) revert NotAContract(ledger_);
        _requireNonZero(identity_);
        if (identity_.code.length == 0) revert NotAContract(identity_);

        ledger = IMemoryLedger(ledger_);
        identity = IAgentIdentity(identity_);
        _grantRole(Roles.MODERATOR_ROLE, admin);
    }

    /*//////////////////////////////////////////////////////////////
                              GRANT (WRITE)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMemoryAccessControl
    function grantAccess(
        bytes32 cidHash,
        address grantee,
        bytes calldata wrappedKey,
        uint64 expiresAt
    ) external override whenNotPaused {
        _grant(msg.sender, cidHash, grantee, wrappedKey, expiresAt);
    }

    /**
     * @inheritdoc IMemoryAccessControl
     * @dev One memory, many grantees, one transaction - the common case when publishing a memory to a
     *      working group. Bounded by `Limits.MAX_BATCH_SIZE` so the call can never exceed the block
     *      gas limit.
     */
    function grantAccessBatch(
        bytes32 cidHash,
        address[] calldata grantees,
        bytes[] calldata wrappedKeys,
        uint64 expiresAt
    ) external override whenNotPaused {
        uint256 n = grantees.length;
        if (n != wrappedKeys.length) revert ArrayLengthMismatch(n, wrappedKeys.length);
        if (n > Limits.MAX_BATCH_SIZE) revert BatchTooLarge(n, Limits.MAX_BATCH_SIZE);
        for (uint256 i = 0; i < n; ++i) {
            _grant(msg.sender, cidHash, grantees[i], wrappedKeys[i], expiresAt);
        }
    }

    /**
     * @inheritdoc IMemoryAccessControl
     * @dev The owner signs over `keccak256(wrappedKey)` rather than the bytes themselves, so the
     *      digest stays a fixed size regardless of envelope length. The relayer cannot substitute a
     *      different envelope without invalidating the signature.
     */
    function grantAccessFor(
        address owner,
        bytes32 cidHash,
        address grantee,
        bytes calldata wrappedKey,
        uint64 expiresAt,
        uint256 deadline,
        bytes calldata signature
    ) external override whenNotPaused {
        _requireNonZero(owner);
        _checkDeadline(deadline);
        bytes32 digest = _hashTypedDataV4(
            _grantStructHash(owner, cidHash, grantee, keccak256(wrappedKey), expiresAt, deadline)
        );
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert InvalidSignature(owner);

        _grant(owner, cidHash, grantee, wrappedKey, expiresAt);
    }

    /*//////////////////////////////////////////////////////////////
                             REVOKE (WRITE)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMemoryAccessControl
    function revokeAccess(bytes32 cidHash, address grantee, bytes32 reason) external override whenNotPaused {
        address owner = ledger.getMemory(cidHash).owner;
        if (owner != msg.sender) revert NotMemoryOwner(cidHash, msg.sender, owner);
        _revokeAccess(cidHash, owner, grantee, reason);
    }

    /**
     * @inheritdoc IMemoryAccessControl
     * @dev DELIBERATELY NOT `whenNotPaused`: withdrawing authorisation for illegal or poisoned content
     *      is exactly what an operator must be able to do during an incident. Strictly restrictive - a
     *      moderator can remove a grant but can never create one.
     */
    function moderatorRevokeAccess(
        bytes32 cidHash,
        address grantee,
        bytes32 reason
    ) external override onlyRole(Roles.MODERATOR_ROLE) {
        address owner = ledger.getMemory(cidHash).owner;
        _revokeAccess(cidHash, owner, grantee, reason);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IMemoryAccessControl
     * @dev The single predicate the backend authorises decryption against. It NEVER reverts, for any
     *      input, so the node can call it on unvalidated user data and simply act on the boolean.
     */
    function canAccess(bytes32 cidHash, address account) public view override returns (bool) {
        if (!ledger.exists(cidHash)) return false;
        IMemoryLedger.MemoryRecord memory m = ledger.getMemory(cidHash);
        if (m.revoked) return false;
        if (account == m.owner) return true;

        Grant storage g = _grants[cidHash][account];
        if (!g.exists || g.revokedAt != 0) return false;
        if (g.expiresAt != 0 && block.timestamp >= g.expiresAt) return false;
        return true;
    }

    /// @inheritdoc IMemoryAccessControl
    function getGrant(bytes32 cidHash, address grantee) external view override returns (Grant memory) {
        return _grants[cidHash][grantee];
    }

    /// @inheritdoc IMemoryAccessControl
    function getWrappedKey(
        bytes32 cidHash,
        address grantee
    ) external view override returns (bytes memory wrappedKey, uint32 keyVersion) {
        Grant storage g = _grants[cidHash][grantee];
        if (!g.exists || g.revokedAt != 0) revert AccessNotGranted(cidHash, grantee);
        return (_wrappedKeys[cidHash][grantee], g.keyVersion);
    }

    /// @inheritdoc IMemoryAccessControl
    function getGrantees(
        bytes32 cidHash,
        uint256 offset,
        uint256 limit
    ) external view override returns (address[] memory page, uint256 total) {
        address[] storage list = _granteeList[cidHash];
        total = list.length;
        (uint256 start, uint256 count) = Pagination.slice(total, offset, limit, Limits.MAX_PAGE_SIZE);
        page = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = list[start + i];
        }
    }

    /// @inheritdoc IMemoryAccessControl
    function getGrantsFor(
        address grantee,
        uint256 offset,
        uint256 limit
    ) external view override returns (bytes32[] memory page, uint256 total) {
        bytes32[] storage list = _grantsTo[grantee];
        total = list.length;
        (uint256 start, uint256 count) = Pagination.slice(total, offset, limit, Limits.MAX_PAGE_SIZE);
        page = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = list[start + i];
        }
    }

    /// @inheritdoc IMemoryAccessControl
    function nonces(address owner) public view virtual override(IMemoryAccessControl, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Validates and writes one grant. Ownership is read from the ledger on every call, so a grant
     *      can never outlive the ownership claim it depends on.
     * @param owner      Claimed memory owner; must match the ledger record.
     * @param cidHash    The memory being shared.
     * @param grantee    Recipient of the wrapped key; must be an active registered agent.
     * @param wrappedKey Ciphertext envelope addressed to the grantee's published public key.
     * @param expiresAt  Unix seconds after which the grant lapses; 0 for no expiry.
     */
    function _grant(
        address owner,
        bytes32 cidHash,
        address grantee,
        bytes calldata wrappedKey,
        uint64 expiresAt
    ) internal {
        IMemoryLedger.MemoryRecord memory m = ledger.getMemory(cidHash);
        if (m.owner != owner) revert NotMemoryOwner(cidHash, owner, m.owner);
        if (m.revoked) revert MemoryAlreadyRevoked(cidHash);
        if (grantee == owner) revert SelfAction(owner);
        if (!identity.isActive(grantee)) revert AgentInactive(grantee);
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt, block.timestamp);
        Limits.checkBytesLen(bytes32("wrappedKey"), wrappedKey.length, 1, Limits.MAX_WRAPPED_KEY_BYTES);

        Grant storage g = _grants[cidHash][grantee];
        // An expired grant is not an active one. Treating it as active made a grant permanently
        // un-renewable once its expiry passed.
        bool stillActive = g.exists && g.revokedAt == 0 && (g.expiresAt == 0 || g.expiresAt > block.timestamp);
        if (stillActive) revert AccessAlreadyGranted(cidHash, grantee);
        if (!g.exists) {
            // Index once per pair, so re-granting after a revocation cannot duplicate index entries.
            _granteeList[cidHash].push(grantee);
            _grantsTo[grantee].push(cidHash);
        }

        (, uint32 keyVersion) = identity.getPublicKey(grantee);

        g.grantedAt = uint64(block.timestamp);
        g.expiresAt = expiresAt;
        g.revokedAt = 0;
        g.keyVersion = keyVersion;
        g.exists = true;
        _wrappedKeys[cidHash][grantee] = wrappedKey;

        emit AccessGranted(cidHash, owner, grantee, expiresAt, keyVersion, wrappedKey);
    }

    /**
     * @dev Withdraws a grant and deletes its envelope. Deleting refunds gas and, more importantly,
     *      removes the ciphertext from state so a future reader cannot fetch it and attack it offline.
     */
    function _revokeAccess(bytes32 cidHash, address owner, address grantee, bytes32 reason) internal {
        Grant storage g = _grants[cidHash][grantee];
        if (!g.exists || g.revokedAt != 0) revert AccessNotGranted(cidHash, grantee);

        g.revokedAt = uint64(block.timestamp);
        delete _wrappedKeys[cidHash][grantee];

        emit AccessRevoked(cidHash, owner, grantee, msg.sender, reason);
    }

    /**
     * @dev Builds the `AccessGrant` struct hash and consumes the owner's nonce. Split into its own
     *      frame so `grantAccessFor` stays clear of the 16-slot EVM stack limit without `viaIR`.
     * @return The EIP-712 struct hash, ready for `_hashTypedDataV4`.
     */
    function _grantStructHash(
        address owner,
        bytes32 cidHash,
        address grantee,
        bytes32 wrappedKeyHash,
        uint64 expiresAt,
        uint256 deadline
    ) internal returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    ACCESS_GRANT_TYPEHASH,
                    owner,
                    cidHash,
                    grantee,
                    wrappedKeyHash,
                    expiresAt,
                    _useNonce(owner),
                    deadline
                )
            );
    }

    /**
     * @dev Rejects expired authorisations and authorisations valid for longer than
     *      `Limits.MAX_SIGNATURE_VALIDITY`.
     */
    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
        uint256 maxDeadline = block.timestamp + Limits.MAX_SIGNATURE_VALIDITY;
        if (deadline > maxDeadline) revert DeadlineTooFar(deadline, maxDeadline);
    }
}
