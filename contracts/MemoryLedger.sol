// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MemoryLedger - Cryptographic Proof of Memory Ownership
 * @notice Manages immutable, version-controlled memory records on-chain.
 *         Each memory is linked to an IPFS CID containing the encrypted
 *         vector embeddings and context. Supports version chains for
 *         memory evolution tracking.
 */
contract MemoryLedger {
    struct MemoryRecord {
        string ipfsCID;
        address owner;
        uint256 timestamp;
        string previousVersionCID;
        bool isEncrypted;       // Whether the IPFS payload is AES-256 encrypted
        uint256 embeddingDim;   // Dimensionality of the stored vector embedding
        string embeddingModel;  // Model identifier (e.g., "all-MiniLM-L6-v2")
    }

    // CID -> MemoryRecord
    mapping(string => MemoryRecord) public memories;

    // Owner -> list of CIDs they own
    mapping(address => string[]) public ownerMemories;

    // Total memory count for statistics
    uint256 public totalMemoryCount;

    event MemoryCommitted(
        address indexed owner,
        string ipfsCID,
        string previousVersionCID,
        bool isEncrypted,
        uint256 embeddingDim,
        string embeddingModel
    );

    event MemoryVerified(string ipfsCID, address owner, uint256 timestamp);

    function commitMemory(
        string memory ipfsCID,
        string memory previousVersionCID,
        bytes memory signature,
        bool isEncrypted,
        uint256 embeddingDim,
        string memory embeddingModel
    ) external {
        require(memories[ipfsCID].owner == address(0), "Memory CID already exists");

        memories[ipfsCID] = MemoryRecord({
            ipfsCID: ipfsCID,
            owner: msg.sender,
            timestamp: block.timestamp,
            previousVersionCID: previousVersionCID,
            isEncrypted: isEncrypted,
            embeddingDim: embeddingDim,
            embeddingModel: embeddingModel
        });

        ownerMemories[msg.sender].push(ipfsCID);
        totalMemoryCount += 1;

        emit MemoryCommitted(msg.sender, ipfsCID, previousVersionCID, isEncrypted, embeddingDim, embeddingModel);
    }

    function verifyMemory(string memory ipfsCID) external view returns (address, uint256, bool, uint256, string memory) {
        require(memories[ipfsCID].owner != address(0), "Memory does not exist");
        MemoryRecord storage m = memories[ipfsCID];
        return (m.owner, m.timestamp, m.isEncrypted, m.embeddingDim, m.embeddingModel);
    }

    function getOwnerMemoryCount(address owner) external view returns (uint256) {
        return ownerMemories[owner].length;
    }

    function getOwnerMemoryAtIndex(address owner, uint256 index) external view returns (string memory) {
        return ownerMemories[owner][index];
    }
}
