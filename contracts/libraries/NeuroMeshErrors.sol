// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title NeuroMeshErrors
 * @author NeuroMesh Protocol
 * @notice Single source of truth for every custom error raised anywhere in the NeuroMesh protocol.
 * @dev These are FILE-LEVEL error declarations (legal since Solidity 0.8.4), so consumers use named
 *      imports, e.g. `import {ZeroAddress, NotRegistered} from "./libraries/NeuroMeshErrors.sol";`.
 *
 *      Every error selector is a 4-byte constant, which replaces the old `require("...")` revert
 *      strings: cheaper deploy bytecode, cheaper reverts, and - unlike a string - each error carries
 *      the offending values so a failed transaction is self-describing.
 *
 *      ENCODING NOTE FOR OFF-CHAIN CONSUMERS
 *      -------------------------------------
 *      Arguments declared as `bytes32 field` / `bytes32 name` / `bytes32 reason` carry
 *      short-string-encoded identifiers produced by Solidity's `bytes32("cid")` literal: the ASCII
 *      bytes are LEFT aligned and right zero-padded. JavaScript decodes them with
 *      `ethers.decodeBytes32String(value)` and encodes them with `ethers.encodeBytes32String("cid")`.
 *      Identifiers are therefore capped at 31 bytes.
 *
 *      FIELD / PARAMETER IDENTIFIER TABLE (the complete set used by this suite)
 *      ----------------------------------------------------------------------
 *      | literal            | raised by                                              |
 *      |--------------------|--------------------------------------------------------|
 *      | "publicKey"        | AgentIdentity key length validation                    |
 *      | "metadataURI"      | AgentIdentity metadata length validation               |
 *      | "cid"              | MemoryLedger CID length validation                     |
 *      | "model"            | MemoryLedger embedding-model length validation         |
 *      | "reason"           | ReputationManager free-text reason length validation   |
 *      | "wrappedKey"       | MemoryAccessControl wrapped-key length validation      |
 *      | "limit"            | pagination limit validation                            |
 *      | "halfLife"         | ReputationManager.setHalfLife                          |
 *      | "prior"            | ReputationManager.setPrior                             |
 *      | "threshold"        | ReputationManager.setTrustThreshold                    |
 *      | "negMultiplier"    | ReputationManager.setNegativeMultiplier                |
 *      | "baseWeight"       | ReputationManager.setEndorserWeights                   |
 *      | "maxWeight"        | ReputationManager.setEndorserWeights                   |
 *      | "endorseCooldown"  | ReputationManager.setCooldowns                         |
 *      | "reportCooldown"   | ReputationManager.setCooldowns                         |
 *      | "actorCooldown"    | ReputationManager.setCooldowns                         |
 *      | "stake"            | ReputationManager.setEndorsementStake                  |
 *      | "stakeLock"        | ReputationManager.setStakeLockPeriod                   |
 *      | "logCapacity"      | ReputationManager constructor                          |
 *      | "amount"           | ReputationManager.withdrawTreasury                     |
 *      | "pow2Idx"          | DecayMath.pow2NegSixteenths                            |
 */

/*//////////////////////////////////////////////////////////////
                            GENERIC
//////////////////////////////////////////////////////////////*/

/// @notice A required address argument was the zero address.
error ZeroAddress();

/// @notice A required field was empty.
/// @param field Short-string identifier of the offending field.
error EmptyField(bytes32 field);

/// @notice A string/bytes field exceeded its maximum on-chain length.
error StringTooLong(bytes32 field, uint256 length, uint256 maxLength);

/// @notice A string/bytes field was shorter than its minimum on-chain length.
error StringTooShort(bytes32 field, uint256 length, uint256 minLength);

/// @notice A numeric protocol parameter was outside its permitted range.
error InvalidParameter(bytes32 name, uint256 value);

/// @notice A pagination `limit` was zero or above the protocol page cap.
error InvalidPageSize(uint256 limit, uint256 maxLimit);

/// @notice A batch call carried more elements than the protocol batch cap.
error BatchTooLarge(uint256 size, uint256 maxSize);

/// @notice Two parallel array arguments had different lengths.
error ArrayLengthMismatch(uint256 lengthA, uint256 lengthB);

/// @notice An address expected to hold contract code had none (EOA, or not yet deployed).
error NotAContract(address target);

/*//////////////////////////////////////////////////////////////
                            IDENTITY
//////////////////////////////////////////////////////////////*/

/// @notice The agent is already present in the registry; registration is once per address, forever.
error AlreadyRegistered(address account);

/// @notice The address has never been registered in AgentIdentity.
error NotRegistered(address account);

/// @notice The agent exists but is not active (self-deactivated, or suspended by a registrar).
error AgentInactive(address account);

/// @notice The agent is already active, so the requested (re)activation would be a no-op.
error AgentAlreadyActive(address account);

/*//////////////////////////////////////////////////////////////
                           SIGNATURES
//////////////////////////////////////////////////////////////*/

/// @notice EIP-712 recovery did not yield `expectedSigner` (or ERC-1271 validation returned false).
error InvalidSignature(address expectedSigner);

/// @notice The signature deadline is in the past.
error SignatureExpired(uint256 deadline, uint256 blockTimestamp);

/// @notice The signature deadline is further out than `Limits.MAX_SIGNATURE_VALIDITY`.
error DeadlineTooFar(uint256 deadline, uint256 maxDeadline);

/*//////////////////////////////////////////////////////////////
                          MEMORY LEDGER
//////////////////////////////////////////////////////////////*/

/// @notice The CID hash is already committed; records are tombstoned, never re-registrable.
error MemoryAlreadyExists(bytes32 cidHash);

/// @notice No record exists for the CID hash.
error MemoryNotFound(bytes32 cidHash);

/// @notice The record has already been tombstoned.
error MemoryAlreadyRevoked(bytes32 cidHash);

/// @notice The caller is not the owner of the memory record.
error NotMemoryOwner(bytes32 cidHash, address caller, address owner);

/// @notice The declared parent version does not exist.
error ParentNotFound(bytes32 prevCidHash);

/// @notice The declared parent exists but belongs to a different agent.
error ParentNotOwnedByAgent(bytes32 prevCidHash, address agent, address parentOwner);

/// @notice The declared parent has been revoked and cannot be extended.
error ParentRevoked(bytes32 prevCidHash);

/// @notice A record declared itself as its own parent.
error SelfReferentialParent(bytes32 cidHash);

/// @notice The declared embedding dimension is outside the permitted range.
error InvalidEmbeddingDim(uint256 dim, uint256 minDim, uint256 maxDim);

/*//////////////////////////////////////////////////////////////
                           REPUTATION
//////////////////////////////////////////////////////////////*/

/// @notice An agent attempted to endorse or report itself.
error SelfAction(address account);

/// @notice `from` already holds an active endorsement of `to`.
error AlreadyEndorsed(address from, address to);

/// @notice `from` holds no active endorsement of `to`.
error NotEndorsed(address from, address to);

/// @notice `from` already holds an active report against `to`.
error AlreadyReported(address from, address to);

/// @notice `from` holds no active report against `to`.
error NotReported(address from, address to);

/// @notice A per-pair or per-actor cooldown has not yet elapsed.
error CooldownActive(uint256 availableAt, uint256 blockTimestamp);

/// @notice `msg.value` did not exactly match the configured endorsement stake.
error InvalidStake(uint256 required, uint256 provided);

/// @notice A previous endorsement stake is still escrowed and must be claimed before re-endorsing.
error UnclaimedStake(address from, address to);

/// @notice The stake is not yet withdrawable.
error StakeLocked(uint256 unlockAt, uint256 blockTimestamp);

/// @notice There is no escrowed stake to claim for this pair.
error NothingToClaim(address from, address to);

/// @notice The stake was slashed and is no longer claimable by the endorser.
error StakeAlreadySlashed(address from, address to);

/// @notice A low-level ETH transfer failed.
error EtherTransferFailed(address to, uint256 amount);

/*//////////////////////////////////////////////////////////////
                  ACCESS CONTROL / DELEGATION
//////////////////////////////////////////////////////////////*/

/// @notice An active grant for this (memory, grantee) pair already exists.
error AccessAlreadyGranted(bytes32 cidHash, address grantee);

/// @notice No active grant exists for this (memory, grantee) pair.
error AccessNotGranted(bytes32 cidHash, address grantee);

/// @notice The grant exists but its expiry has passed.
error GrantExpired(bytes32 cidHash, address grantee, uint64 expiresAt);

/// @notice A non-zero expiry was not strictly in the future.
error InvalidExpiry(uint64 expiresAt, uint256 blockTimestamp);
