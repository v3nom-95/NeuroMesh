// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAgentIdentity} from "./IAgentIdentity.sol";

/**
 * @title IMemoryLedger
 * @author NeuroMesh Protocol
 * @notice Stable ABI surface of the memory proof ledger, consumed by MemoryAccessControl and the
 *         off-chain node.
 * @dev Records are keyed by `cidHash = keccak256(bytes(cid))`. The CID string itself is stored
 *      exactly once, inside the record; every index and every event topic carries the 32-byte hash.
 */
interface IMemoryLedger {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice One committed memory proof.
     * @dev STORAGE PACKING (declaration order is the packing order, and is asserted by the
     *      storage-layout test):
     *        slot 0: `owner` (20) + `committedAt` (8) + `embeddingDim` (4)  = 32 bytes, exactly full
     *        slot 1: `prevCidHash` (32)
     *        slot 2: `committedBy` (20) + `revokedAt` (8) + `version` (4)   = 32 bytes, exactly full
     *        slot 3: `isEncrypted` (1) + `revoked` (1)                      = 2 bytes
     *        slot 4: `cid` (dynamic)
     *        slot 5: `model` (dynamic)
     *      An earlier draft tried to fit `committedBy` alongside the slot-2 flags (20 + 8 + 4 + 1 + 1
     *      = 34 bytes) which does not fit a 32-byte slot; the flags were moved to their own slot
     *      rather than dropped, so `revoked` stays directly readable by clients that do not want to
     *      infer it from `revokedAt != 0`.
     * @param owner        The agent the proof is attributed to (the EIP-712 signer, not the submitter).
     * @param committedAt  Unix seconds of the commit.
     * @param embeddingDim Declared embedding dimension, validated against protocol bounds.
     * @param prevCidHash  Parent version, or `bytes32(0)` for the root of a chain.
     * @param committedBy  `msg.sender` of the committing transaction; equals `owner` for self-commits.
     * @param revokedAt    Unix seconds of revocation, or 0.
     * @param version      1 for a root, `parent.version + 1` otherwise.
     * @param isEncrypted  Whether the pinned payload's context field is ciphertext.
     * @param revoked      Tombstone flag; a revoked record is never deleted and never re-registrable.
     * @param cid          The IPFS content identifier, stored once.
     * @param model        The embedding model identifier.
     */
    struct MemoryRecord {
        address owner;
        uint64 committedAt;
        uint32 embeddingDim;
        bytes32 prevCidHash;
        address committedBy;
        uint64 revokedAt;
        uint32 version;
        bool isEncrypted;
        bool revoked;
        string cid;
        string model;
    }

    /**
     * @notice Caller-supplied commit payload.
     * @dev Passed as a single struct so both the direct and the meta-transaction entrypoint bind
     *      byte-for-byte identical data, and so neither function comes close to stack-too-deep.
     * @param cid          The IPFS content identifier.
     * @param prevCidHash  Parent version hash, or `bytes32(0)` for a genesis record.
     * @param model        Embedding model identifier.
     * @param embeddingDim Declared embedding dimension.
     * @param isEncrypted  Whether the payload context is encrypted.
     */
    struct MemoryInput {
        string cid;
        bytes32 prevCidHash;
        string model;
        uint32 embeddingDim;
        bool isEncrypted;
    }

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Emitted once per accepted memory proof.
     * @dev `cidHash` and `prevCidHash` are both indexed, so a client can filter logs by content
     *      identifier and walk a version chain purely from the log index - neither of which was
     *      possible with the previous non-indexed string event.
     */
    /// @notice A blinded CID claim was published. The CID itself is not revealed.
    event Precommitted(address indexed agent, bytes32 indexed blindedHash, uint64 at);

    event MemoryCommitted(
        address indexed owner,
        bytes32 indexed cidHash,
        bytes32 indexed prevCidHash,
        string cid,
        string model,
        uint32 embeddingDim,
        bool isEncrypted,
        uint32 version,
        address committedBy,
        uint64 committedAt
    );

    /**
     * @notice Emitted when a record is tombstoned.
     * @dev Named `MemoryRevokedEvent` so it cannot collide with the `MemoryAlreadyRevoked` /
     *      `ParentRevoked` error identifiers in client code generators.
     */
    event MemoryRevokedEvent(
        bytes32 indexed cidHash,
        address indexed owner,
        address indexed actor,
        bytes32 reason,
        uint64 revokedAt
    );

    /*//////////////////////////////////////////////////////////////
                            STATE CHANGING
    //////////////////////////////////////////////////////////////*/

    /// @notice Commits a memory proof owned by `msg.sender`.
    /**
     * @notice Stage two of commit-reveal: record a memory whose claim was precommitted earlier.
     * @dev Requires a {precommit} for `keccak256(abi.encode(cidHash, msg.sender, salt))` that is at
     *      least `MIN_PRECOMMIT_DELAY` old and not older than `MAX_PRECOMMIT_AGE`. Without this,
     *      CID ownership would be first-come-first-served and an observer could claim another
     *      agent's content by front-running the commit transaction.
     * @param input The memory to record.
     * @param salt  The secret used when precommitting. Burned on use.
     * @return cidHash The keyed hash of the recorded CID.
     */
    function commitMemory(MemoryInput calldata input, bytes32 salt) external returns (bytes32 cidHash);

    /**
     * @notice Stage one of commit-reveal: publish a blinded claim over a CID.
     * @param blindedHash `keccak256(abi.encode(cidHash, agent, salt))`, which reveals nothing.
     */
    function precommit(bytes32 blindedHash) external;

    /// @notice Helper computing the blinded hash off-chain callers must submit to {precommit}.
    function precommitHash(bytes32 cidHash, address agent, bytes32 salt) external pure returns (bytes32);

    /// @notice Timestamp a blinded hash was precommitted, or zero if unknown.
    function precommittedAt(bytes32 blindedHash) external view returns (uint64);

    /// @notice Commits a memory proof owned by `agent`, authorised by the agent's EIP-712 signature.
    function commitMemoryFor(
        address agent,
        MemoryInput calldata input,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes32 cidHash);

    /// @notice Tombstones a record owned by `msg.sender`.
    function revokeMemory(bytes32 cidHash, bytes32 reason) external;

    /// @notice Tombstones a record owned by `agent`, authorised by the agent's EIP-712 signature.
    function revokeMemoryFor(
        address agent,
        bytes32 cidHash,
        bytes32 reason,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice Tombstones any record; restricted to `MODERATOR_ROLE`.
    function moderatorRevokeMemory(bytes32 cidHash, bytes32 reason) external;

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice True when a record exists for `cidHash` (revoked records still exist).
    function exists(bytes32 cidHash) external view returns (bool);

    /// @notice Full record; reverts `MemoryNotFound` when absent.
    function getMemory(bytes32 cidHash) external view returns (MemoryRecord memory);

    /// @notice Full record addressed by CID string; reverts `MemoryNotFound` when absent.
    function getMemoryByCid(string calldata cid) external view returns (MemoryRecord memory);

    /// @notice Legacy-shaped verification tuple, extended with a trailing `revoked` flag.
    function verifyMemory(
        string calldata cid
    )
        external
        view
        returns (
            address owner,
            uint64 committedAt,
            bool isEncrypted,
            uint32 embeddingDim,
            string memory model,
            bool revoked
        );

    /// @notice `keccak256(bytes(cid))`, the ledger's primary key.
    function cidHashOf(string calldata cid) external pure returns (bytes32);

    /// @notice Lifetime number of records committed by `owner`, including revoked ones.
    function getOwnerMemoryCount(address owner) external view returns (uint256);

    /// @notice Number of `owner`'s records that are not tombstoned.
    function activeMemoryCount(address owner) external view returns (uint256);

    /// @notice Paginated CID hashes for `owner`, oldest first.
    function getOwnerMemories(
        address owner,
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory page, uint256 total);

    /// @notice Paginated full records for `owner`, oldest first.
    function getOwnerMemoryRecords(
        address owner,
        uint256 offset,
        uint256 limit
    ) external view returns (MemoryRecord[] memory page, uint256 total);

    /// @notice Paginated direct children (forks and successors) of a record.
    function getChildren(
        bytes32 cidHash,
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory page, uint256 total);

    /// @notice Walks `prevCidHash` from `cidHash` to the root, leaf first, bounded by `maxDepth`.
    function getVersionChain(bytes32 cidHash, uint256 maxDepth) external view returns (bytes32[] memory chain);

    /// @notice Lifetime number of records in the ledger.
    function totalMemoryCount() external view returns (uint256);

    /// @notice Lifetime number of tombstoned records.
    function totalRevokedCount() external view returns (uint256);

    /// @notice Current EIP-712 nonce for `owner`.
    function nonces(address owner) external view returns (uint256);

    /// @notice The exact EIP-712 digest `commitMemoryFor` will verify for the given nonce/deadline.
    function hashCommit(
        address agent,
        MemoryInput calldata input,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32 digest);

    /// @notice EIP-712 type hash for the `MemoryCommit` struct.
    function MEMORY_COMMIT_TYPEHASH() external view returns (bytes32);

    /// @notice EIP-712 type hash for the `MemoryRevocation` struct.
    function MEMORY_REVOCATION_TYPEHASH() external view returns (bytes32);

    /// @notice The immutable AgentIdentity registry this ledger gates commits against.
    function identity() external view returns (IAgentIdentity);
}
