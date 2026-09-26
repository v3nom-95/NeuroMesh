// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";
import {IMemoryLedger} from "./interfaces/IMemoryLedger.sol";
import {NeuroMeshGuarded} from "./base/NeuroMeshGuarded.sol";
import {Roles} from "./libraries/Roles.sol";
import {Limits} from "./libraries/Limits.sol";
import {Pagination} from "./libraries/Pagination.sol";
import {
    AgentInactive,
    DeadlineTooFar,
    InvalidEmbeddingDim,
    InvalidPageSize,
    InvalidParameter,
    InvalidSignature,
    MemoryAlreadyExists,
    MemoryAlreadyRevoked,
    MemoryNotFound,
    NotAContract,
    NotMemoryOwner,
    ParentNotFound,
    ParentNotOwnedByAgent,
    ParentRevoked,
    PrecommitAlreadyExists,
    PrecommitExpired,
    PrecommitNotFound,
    PrecommitTooYoung,
    SelfReferentialParent,
    SignatureExpired
} from "./libraries/NeuroMeshErrors.sol";

/**
 * @title MemoryLedger
 * @author NeuroMesh Protocol
 * @notice Cryptographic proof-of-memory ledger: an append-only, tombstone-able record binding an
 *         agent identity to an IPFS content identifier, its embedding metadata, and its position in
 *         a version chain.
 * @dev THE CENTRAL FIX. The previous contract declared `bytes signature` and never read it: the
 *      "cryptographic proof" was decorative, ownership came from `msg.sender`, and because a CID is
 *      public the moment it is pinned, anyone could front-run an honest agent and permanently own
 *      its memory (the duplicate-CID guard then locked the rightful owner out forever).
 *
 *      This contract has two authorisation paths and no others:
 *        1. `commitMemory` - `msg.sender` IS the agent. The transaction signature is the proof; no
 *           extra signature is meaningful, so none is accepted.
 *        2. `commitMemoryFor` - ownership follows an EIP-712 signature that binds
 *           `(agent, cidHash, prevCidHash, modelHash, embeddingDim, isEncrypted, nonce, deadline)`.
 *           A relayer submits it and pays gas; front-running is inert, because whoever submits the
 *           payload can only record the signer as owner.
 *      The digest is computed from the very `input` struct that is written to storage, so the signed
 *      commitment and the stored record can never diverge. Per-agent nonces (OpenZeppelin `Nonces`)
 *      give replay protection within the deployment, and the EIP-712 domain
 *      `("NeuroMeshMemoryLedger", "1", chainId, address(this))` gives it across chains and deployments.
 *
 *      STORAGE MODEL. Records are keyed by `cidHash = keccak256(bytes(cid))`. The CID string is
 *      stored exactly once, inside the record; owner indexes and child indexes hold only the hash.
 *      The old contract stored the same string three times and hashed a full string on every lookup.
 *      Every field has a length or range bound, so a caller cannot park a 4 KB string in state.
 *
 *      VERSION CHAINS are validated rather than asserted: a declared parent must exist, must belong
 *      to the same agent, must not be revoked, and cannot be the record itself. `version` is derived
 *      as `parent.version + 1` and can never be self-reported.
 *
 *      REVOCATION IS A TOMBSTONE. A revoked record is never deleted, so its `cidHash` can never be
 *      re-registered - otherwise revoking would hand the CID to a squatter.
 *
 *      IDENTITY GATING. Commits require `identity.isActive(agent)`. `identity` is `immutable` with no
 *      setter: a swappable identity oracle would let an administrator retroactively legitimise
 *      arbitrary commits. Migration therefore means deploying a new ledger, which is the intended
 *      trade-off.
 *
 * @custom:security-contact security@neuromesh.protocol
 */
contract MemoryLedger is IMemoryLedger, NeuroMeshGuarded, EIP712, Nonces {
    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMemoryLedger
    bytes32 public constant override MEMORY_COMMIT_TYPEHASH =
        keccak256(
            // solhint-disable-next-line max-line-length -- one literal: the typehash preimage must stay greppable
            "MemoryCommit(address agent,bytes32 cidHash,bytes32 prevCidHash,bytes32 modelHash,uint32 embeddingDim,bool isEncrypted,uint256 nonce,uint256 deadline)"
        );

    /// @inheritdoc IMemoryLedger
    bytes32 public constant override MEMORY_REVOCATION_TYPEHASH =
        keccak256("MemoryRevocation(address agent,bytes32 cidHash,bytes32 reason,uint256 nonce,uint256 deadline)");

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMemoryLedger
    IAgentIdentity public immutable override identity;

    /// @dev cidHash => record. A record with `owner == address(0)` has never existed.
    mapping(bytes32 => MemoryRecord) private _memories;

    /// @dev owner => cidHashes in insertion order, including revoked ones.
    mapping(address => bytes32[]) private _ownerMemories;

    /// @dev parent cidHash => child cidHashes, so forks and successors are discoverable on chain.
    mapping(bytes32 => bytes32[]) private _children;

    /// @dev blindedHash => timestamp the precommit was made. See {precommit}.
    ///      blindedHash = keccak256(abi.encode(cidHash, agent, salt)) and reveals nothing about
    ///      the CID, so an observer cannot front-run a claim they have not yet seen.
    mapping(bytes32 => uint64) private _precommits;

    /// @inheritdoc IMemoryLedger
    mapping(address => uint256) public override activeMemoryCount;

    /// @inheritdoc IMemoryLedger
    uint256 public override totalMemoryCount;

    /// @inheritdoc IMemoryLedger
    uint256 public override totalRevokedCount;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deploys the ledger against an existing AgentIdentity registry.
     * @dev Both a zero check and a `code.length` check are performed: casting an EOA to the identity
     *      interface would make every commit revert with an opaque ABI-decoding panic instead of a
     *      named error.
     * @param admin     Protocol administrator; receives `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` and
     *                  `MODERATOR_ROLE`.
     * @param identity_ Address of the deployed AgentIdentity contract; immutable thereafter.
     */
    constructor(address admin, address identity_) NeuroMeshGuarded(admin) EIP712("NeuroMeshMemoryLedger", "1") {
        _requireNonZero(identity_);
        if (identity_.code.length == 0) revert NotAContract(identity_);
        identity = IAgentIdentity(identity_);
        _grantRole(Roles.MODERATOR_ROLE, admin);
    }

    /*//////////////////////////////////////////////////////////////
                            COMMIT (WRITE)
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IMemoryLedger
     * @dev Self-commit: the transaction signature already authenticates the agent, so no additional
     *      signature is accepted. This is the path the node uses when the agent holds its own gas.
     */
    function commitMemory(MemoryInput calldata input, bytes32 salt)
        external
        override
        whenNotPaused
        returns (bytes32)
    {
        // Validate before burning the precommit, so a malformed commit does not cost the agent
        // its salt and force a fresh precommit round-trip.
        _validateInput(input);
        _consumePrecommit(msg.sender, keccak256(bytes(input.cid)), salt);
        return _commit(msg.sender, input, msg.sender);
    }

    /**
     * @inheritdoc IMemoryLedger
     * @dev Stage one of commit-reveal. `blindedHash` binds the CID, the claiming agent and a secret
     *      salt, so it leaks nothing an observer could act on. Ownership is decided by precommit
     *      order, not by who lands a transaction first once the CID is public.
     */
    function precommit(bytes32 blindedHash) external override whenNotPaused {
        if (blindedHash == bytes32(0)) revert InvalidParameter(bytes32("blindedHash"), 0);
        uint64 existing = _precommits[blindedHash];
        if (existing != 0 && block.timestamp <= uint256(existing) + Limits.MAX_PRECOMMIT_AGE) {
            revert PrecommitAlreadyExists(blindedHash);
        }
        _precommits[blindedHash] = uint64(block.timestamp);
        emit Precommitted(msg.sender, blindedHash, uint64(block.timestamp));
    }

    /// @inheritdoc IMemoryLedger
    function precommitHash(bytes32 cidHash, address agent, bytes32 salt) public pure override returns (bytes32) {
        return keccak256(abi.encode(cidHash, agent, salt));
    }

    /// @inheritdoc IMemoryLedger
    function precommittedAt(bytes32 blindedHash) external view override returns (uint64) {
        return _precommits[blindedHash];
    }

    /**
     * @dev Verifies and burns the precommit backing this (agent, cid, salt) triple.
     *      Burning makes the salt single-use, so a revealed salt cannot be replayed.
     */
    function _consumePrecommit(address agent, bytes32 cidHash, bytes32 salt) private {
        bytes32 blinded = precommitHash(cidHash, agent, salt);
        uint64 madeAt = _precommits[blinded];
        if (madeAt == 0) revert PrecommitNotFound(blinded);

        uint256 revealableAt = uint256(madeAt) + Limits.MIN_PRECOMMIT_DELAY;
        if (block.timestamp < revealableAt) {
            revert PrecommitTooYoung(blinded, uint64(revealableAt), block.timestamp);
        }
        uint256 expiresAt = uint256(madeAt) + Limits.MAX_PRECOMMIT_AGE;
        if (block.timestamp > expiresAt) {
            revert PrecommitExpired(blinded, uint64(expiresAt), block.timestamp);
        }
        delete _precommits[blinded];
    }

    /**
     * @inheritdoc IMemoryLedger
     * @dev Meta-transaction commit. The digest is built from the same `input` calldata struct that is
     *      written to storage, so the authorisation and the record are byte-identical by construction.
     *      `_useNonce` is evaluated exactly once while building the digest; if verification fails the
     *      entire transaction reverts, so the nonce is not consumed.
     */
    function commitMemoryFor(
        address agent,
        MemoryInput calldata input,
        uint256 deadline,
        bytes calldata signature
    ) external override whenNotPaused returns (bytes32) {
        _requireNonZero(agent);
        _checkDeadline(deadline);
        bytes32 structHash = keccak256(
            abi.encode(
                MEMORY_COMMIT_TYPEHASH,
                agent,
                keccak256(bytes(input.cid)),
                input.prevCidHash,
                keccak256(bytes(input.model)),
                input.embeddingDim,
                input.isEncrypted,
                _useNonce(agent),
                deadline
            )
        );
        _verify(structHash, agent, signature);
        return _commit(agent, input, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                           REVOCATION (WRITE)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMemoryLedger
    function revokeMemory(bytes32 cidHash, bytes32 reason) external override whenNotPaused {
        MemoryRecord storage m = _memories[cidHash];
        if (m.owner == address(0)) revert MemoryNotFound(cidHash);
        if (m.owner != msg.sender) revert NotMemoryOwner(cidHash, msg.sender, m.owner);
        _revoke(cidHash, msg.sender, reason);
    }

    /// @inheritdoc IMemoryLedger
    function revokeMemoryFor(
        address agent,
        bytes32 cidHash,
        bytes32 reason,
        uint256 deadline,
        bytes calldata signature
    ) external override whenNotPaused {
        _requireNonZero(agent);
        _checkDeadline(deadline);
        bytes32 structHash = keccak256(
            abi.encode(MEMORY_REVOCATION_TYPEHASH, agent, cidHash, reason, _useNonce(agent), deadline)
        );
        _verify(structHash, agent, signature);

        MemoryRecord storage m = _memories[cidHash];
        if (m.owner == address(0)) revert MemoryNotFound(cidHash);
        if (m.owner != agent) revert NotMemoryOwner(cidHash, agent, m.owner);
        _revoke(cidHash, msg.sender, reason);
    }

    /**
     * @inheritdoc IMemoryLedger
     * @dev DELIBERATELY NOT `whenNotPaused`: taking down illegal or poisoned content is exactly what
     *      an operator needs to do while the protocol is paused. Restricted to `MODERATOR_ROLE`, and
     *      strictly restrictive - a moderator can tombstone a record but can never create, transfer
     *      or rewrite one.
     */
    function moderatorRevokeMemory(bytes32 cidHash, bytes32 reason) external override onlyRole(Roles.MODERATOR_ROLE) {
        if (_memories[cidHash].owner == address(0)) revert MemoryNotFound(cidHash);
        _revoke(cidHash, msg.sender, reason);
    }

    /*//////////////////////////////////////////////////////////////
                            RECORD VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMemoryLedger
    function exists(bytes32 cidHash) external view override returns (bool) {
        return _memories[cidHash].owner != address(0);
    }

    /// @inheritdoc IMemoryLedger
    function getMemory(bytes32 cidHash) external view override returns (MemoryRecord memory) {
        MemoryRecord storage m = _memories[cidHash];
        if (m.owner == address(0)) revert MemoryNotFound(cidHash);
        return m;
    }

    /// @inheritdoc IMemoryLedger
    function getMemoryByCid(string calldata cid) external view override returns (MemoryRecord memory) {
        bytes32 cidHash = keccak256(bytes(cid));
        MemoryRecord storage m = _memories[cidHash];
        if (m.owner == address(0)) revert MemoryNotFound(cidHash);
        return m;
    }

    /**
     * @inheritdoc IMemoryLedger
     * @dev BREAKING CHANGE vs the previous ledger, which returned
     *      `(address owner, uint256 timestamp, bool isEncrypted, uint256 embeddingDim, string model)`.
     *      The timestamp is now `uint64`, the dimension is now `uint32`, and a sixth return value
     *      `revoked` has been appended - a client that ignores it will happily treat tombstoned
     *      content as live. Backend ABI fragments must be updated.
     */
    function verifyMemory(
        string calldata cid
    )
        external
        view
        override
        returns (
            address owner,
            uint64 committedAt,
            bool isEncrypted,
            uint32 embeddingDim,
            string memory model,
            bool revoked
        )
    {
        bytes32 cidHash = keccak256(bytes(cid));
        MemoryRecord storage m = _memories[cidHash];
        if (m.owner == address(0)) revert MemoryNotFound(cidHash);
        return (m.owner, m.committedAt, m.isEncrypted, m.embeddingDim, m.model, m.revoked);
    }

    /// @inheritdoc IMemoryLedger
    function cidHashOf(string calldata cid) external pure override returns (bytes32) {
        return keccak256(bytes(cid));
    }

    /*//////////////////////////////////////////////////////////////
                          ENUMERATION VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMemoryLedger
    function getOwnerMemoryCount(address owner) external view override returns (uint256) {
        return _ownerMemories[owner].length;
    }

    /// @inheritdoc IMemoryLedger
    function getOwnerMemories(
        address owner,
        uint256 offset,
        uint256 limit
    ) external view override returns (bytes32[] memory page, uint256 total) {
        bytes32[] storage ids = _ownerMemories[owner];
        total = ids.length;
        (uint256 start, uint256 count) = Pagination.slice(total, offset, limit, Limits.MAX_PAGE_SIZE);
        page = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = ids[start + i];
        }
    }

    /**
     * @inheritdoc IMemoryLedger
     * @dev Replaces the old `getOwnerMemoryCount` + N x `getOwnerMemoryAtIndex` round-trip pattern:
     *      one call now returns up to `Limits.MAX_PAGE_SIZE` complete records plus the collection size.
     */
    function getOwnerMemoryRecords(
        address owner,
        uint256 offset,
        uint256 limit
    ) external view override returns (MemoryRecord[] memory page, uint256 total) {
        bytes32[] storage ids = _ownerMemories[owner];
        total = ids.length;
        (uint256 start, uint256 count) = Pagination.slice(total, offset, limit, Limits.MAX_PAGE_SIZE);
        page = new MemoryRecord[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = _memories[ids[start + i]];
        }
    }

    /// @inheritdoc IMemoryLedger
    function getChildren(
        bytes32 cidHash,
        uint256 offset,
        uint256 limit
    ) external view override returns (bytes32[] memory page, uint256 total) {
        bytes32[] storage ids = _children[cidHash];
        total = ids.length;
        (uint256 start, uint256 count) = Pagination.slice(total, offset, limit, Limits.MAX_PAGE_SIZE);
        page = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = ids[start + i];
        }
    }

    /**
     * @inheritdoc IMemoryLedger
     * @dev Returns leaf-first: index 0 is `cidHash` itself, the last element is the deepest ancestor
     *      reached. A cycle is structurally impossible, because a parent must already exist when a
     *      child is committed and records are never rewritten; `maxDepth` is nonetheless enforced as
     *      a belt-and-braces gas bound.
     */
    function getVersionChain(
        bytes32 cidHash,
        uint256 maxDepth
    ) external view override returns (bytes32[] memory chain) {
        if (maxDepth == 0 || maxDepth > Limits.MAX_CHAIN_WALK) revert InvalidPageSize(maxDepth, Limits.MAX_CHAIN_WALK);
        if (_memories[cidHash].owner == address(0)) revert MemoryNotFound(cidHash);

        chain = new bytes32[](maxDepth);
        bytes32 cur = cidHash;
        uint256 n = 0;
        while (cur != bytes32(0) && n < maxDepth) {
            chain[n] = cur;
            unchecked {
                ++n;
            }
            cur = _memories[cur].prevCidHash;
        }
        // Shrink the over-allocated array in place; `n <= maxDepth` is its allocated length.
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(chain, n)
        }
    }

    /*//////////////////////////////////////////////////////////////
                          SIGNATURE HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IMemoryLedger
     * @dev A `view`, so it cannot consume a nonce: callers pass the nonce they intend to sign with
     *      (normally `nonces(agent)`). Tests and the backend use it to prove their own EIP-712
     *      encoding matches the contract's byte for byte.
     */
    function hashCommit(
        address agent,
        MemoryInput calldata input,
        uint256 nonce,
        uint256 deadline
    ) external view override returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        MEMORY_COMMIT_TYPEHASH,
                        agent,
                        keccak256(bytes(input.cid)),
                        input.prevCidHash,
                        keccak256(bytes(input.model)),
                        input.embeddingDim,
                        input.isEncrypted,
                        nonce,
                        deadline
                    )
                )
            );
    }

    /// @inheritdoc IMemoryLedger
    function nonces(address owner) public view virtual override(IMemoryLedger, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Validates and writes one memory record. Shared by both commit entrypoints so the two paths
     *      cannot drift apart.
     * @param agent     The owner the record is attributed to.
     * @param input     The caller-supplied commit payload.
     * @param submitter `msg.sender`, recorded as `committedBy` for relayer attribution.
     * @return cidHash The record's primary key.
     */
    /**
     * @dev Field bounds for a memory input. Extracted so {commitMemory} can validate before it
     *      burns a precommit, and so both commit paths share one definition.
     */
    function _validateInput(MemoryInput calldata input) internal pure {
        Limits.checkBytesLen(bytes32("cid"), bytes(input.cid).length, Limits.MIN_CID_BYTES, Limits.MAX_CID_BYTES);
        Limits.checkBytesLen(bytes32("model"), bytes(input.model).length, 1, Limits.MAX_MODEL_BYTES);
        if (input.embeddingDim < Limits.MIN_EMBEDDING_DIM || input.embeddingDim > Limits.MAX_EMBEDDING_DIM) {
            revert InvalidEmbeddingDim(input.embeddingDim, Limits.MIN_EMBEDDING_DIM, Limits.MAX_EMBEDDING_DIM);
        }
    }

    function _commit(address agent, MemoryInput calldata input, address submitter) internal returns (bytes32 cidHash) {
        if (!identity.isActive(agent)) revert AgentInactive(agent);

        _validateInput(input);

        cidHash = keccak256(bytes(input.cid));

        if (_memories[cidHash].owner != address(0)) revert MemoryAlreadyExists(cidHash);

        uint32 version = 1;
        bytes32 prev = input.prevCidHash;
        if (prev != bytes32(0)) {
            if (prev == cidHash) revert SelfReferentialParent(cidHash);
            MemoryRecord storage p = _memories[prev];
            if (p.owner == address(0)) revert ParentNotFound(prev);
            if (p.owner != agent) revert ParentNotOwnedByAgent(prev, agent, p.owner);
            if (p.revoked) revert ParentRevoked(prev);
            version = p.version + 1;
        }

        MemoryRecord storage m = _memories[cidHash];
        m.owner = agent;
        m.committedAt = uint64(block.timestamp);
        m.embeddingDim = input.embeddingDim;
        m.prevCidHash = prev;
        m.committedBy = submitter;
        m.version = version;
        m.isEncrypted = input.isEncrypted;
        m.cid = input.cid;
        m.model = input.model;

        _ownerMemories[agent].push(cidHash);
        if (prev != bytes32(0)) _children[prev].push(cidHash);
        unchecked {
            ++totalMemoryCount;
            ++activeMemoryCount[agent];
        }

        emit MemoryCommitted(
            agent,
            cidHash,
            prev,
            input.cid,
            input.model,
            input.embeddingDim,
            input.isEncrypted,
            version,
            submitter,
            uint64(block.timestamp)
        );
    }

    /**
     * @dev Tombstones a record. Ownership has already been checked by the caller.
     * @param cidHash Record to tombstone.
     * @param actor   Who performed the revocation, for the event.
     * @param reason  Short-string reason code.
     */
    function _revoke(bytes32 cidHash, address actor, bytes32 reason) internal {
        MemoryRecord storage m = _memories[cidHash];
        if (m.revoked) revert MemoryAlreadyRevoked(cidHash);
        m.revoked = true;
        m.revokedAt = uint64(block.timestamp);
        activeMemoryCount[m.owner] = Limits.satSub(activeMemoryCount[m.owner], 1);
        unchecked {
            ++totalRevokedCount;
        }
        emit MemoryRevokedEvent(cidHash, m.owner, actor, reason, uint64(block.timestamp));
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

    /**
     * @dev Verifies an EIP-712 authorisation with ERC-1271 support, so smart-contract agent wallets
     *      can own memories.
     */
    function _verify(bytes32 structHash, address signer, bytes calldata signature) internal view {
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) revert InvalidSignature(signer);
    }
}
