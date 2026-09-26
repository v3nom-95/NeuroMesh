// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StringTooLong, StringTooShort} from "./NeuroMeshErrors.sol";

/**
 * @title Limits
 * @author NeuroMesh Protocol
 * @notice Every numeric bound in the protocol, plus the WAD fixed-point scale, in one auditable place.
 * @dev All members are `internal constant`, so referencing them costs a PUSH and nothing else. Any
 *      change here is a bytecode change and therefore an explicit, reviewable redeployment - none of
 *      these are governable at runtime. The values that ARE governable (half-life, prior, threshold,
 *      cooldowns, stake) live in ReputationManager storage and are bounded by the MIN_/MAX_ constants
 *      declared here.
 */
library Limits {
    /// @notice Fixed-point scale used for every ratio in the protocol: 1.0 == 1e18.
    uint256 internal constant WAD = 1e18;

    /*//////////////////////////////////////////////////////////////
                          IDENTITY FIELD BOUNDS
    //////////////////////////////////////////////////////////////*/

    /// @notice Minimum accepted public-key length. X25519 raw = 32 bytes.
    uint256 internal constant MIN_PUBLIC_KEY_BYTES = 32;

    /// @notice Maximum accepted public-key length. secp256k1 compressed = 33, uncompressed = 65.
    uint256 internal constant MAX_PUBLIC_KEY_BYTES = 128;

    /// @notice Maximum accepted metadata URI length. Metadata is optional, so there is no minimum.
    uint256 internal constant MAX_METADATA_URI_BYTES = 256;

    /*//////////////////////////////////////////////////////////////
                           MEMORY FIELD BOUNDS
    //////////////////////////////////////////////////////////////*/

    /// @notice Minimum accepted CID length; rejects obviously malformed content identifiers.
    uint256 internal constant MIN_CID_BYTES = 8;

    /// @notice Maximum accepted CID length. CIDv0 base58 = 46 chars, CIDv1 base32 = 59 chars.
    uint256 internal constant MAX_CID_BYTES = 100;

    /// @notice Maximum accepted embedding-model identifier length.
    uint256 internal constant MAX_MODEL_BYTES = 64;

    /// @notice Maximum accepted free-text reason length (hashed on chain, full text in the event).
    uint256 internal constant MAX_REASON_BYTES = 128;

    /// @notice Maximum accepted wrapped-CEK length (ECIES envelope over a 32-byte AES key).
    uint256 internal constant MAX_WRAPPED_KEY_BYTES = 512;

    /// @notice Minimum declared embedding dimension.
    uint256 internal constant MIN_EMBEDDING_DIM = 1;

    /// @notice Maximum declared embedding dimension; comfortably above any production text encoder.
    uint256 internal constant MAX_EMBEDDING_DIM = 8192;

    /*//////////////////////////////////////////////////////////////
                          CALL-SHAPE BOUNDS
    //////////////////////////////////////////////////////////////*/

    /// @notice Maximum `limit` accepted by any paginated getter.
    uint256 internal constant MAX_PAGE_SIZE = 100;

    /// @notice Maximum number of elements in any batched state-changing call.
    uint256 internal constant MAX_BATCH_SIZE = 50;

    /// @notice Maximum lifetime of an EIP-712 authorisation, measured from `block.timestamp`.
    uint256 internal constant MAX_SIGNATURE_VALIDITY = 30 days;

    /// @notice Hard cap on how far `getVersionChain` will walk a parent chain in one call.
    uint256 internal constant MAX_CHAIN_WALK = 512;

    /*//////////////////////////////////////////////////////////////
                       GOVERNED PARAMETER BOUNDS
    //////////////////////////////////////////////////////////////*/

    /// @notice Lower bound for the reputation decay half-life.
    uint256 internal constant MIN_HALF_LIFE = 1 hours;

    /// @notice Upper bound for the reputation decay half-life (~10 years).
    uint256 internal constant MAX_HALF_LIFE = 3650 days;

    /// @notice Lower bound for the Bayesian prior pseudo-count (0.1).
    uint256 internal constant MIN_PRIOR_WAD = 1e17;

    /// @notice Upper bound for the Bayesian prior pseudo-count (100.0).
    uint256 internal constant MAX_PRIOR_WAD = 100e18;

    /// @notice Lower bound for the negative-evidence multiplier (1.0 - reports never count for less
    ///         than an endorsement).
    uint256 internal constant MIN_NEG_MULTIPLIER_WAD = 1e18;

    /// @notice Upper bound for the negative-evidence multiplier (10.0).
    uint256 internal constant MAX_NEG_MULTIPLIER_WAD = 10e18;

    /// @notice Upper bound for any endorser weight (2.0).
    uint256 internal constant MAX_ENDORSER_WEIGHT_WAD = 2e18;

    /// @notice Upper bound for any cooldown window.
    uint256 internal constant MAX_COOLDOWN = 365 days;

    /// @notice Upper bound for the post-revocation stake lock.
    uint256 internal constant MAX_STAKE_LOCK = 365 days;

    /// @notice Upper bound for the ReputationManager trust-log ring capacity.
    uint256 internal constant MAX_TRUST_LOG_CAPACITY = 65536;

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Reverts unless `len` lies within the inclusive range [`minLen`, `maxLen`].
     * @dev The single length-validation entrypoint for the whole protocol, so every bound is
     *      enforced identically and reported with the same two errors.
     * @param field  Short-string identifier of the field being checked (see NeuroMeshErrors).
     * @param len    Actual byte length of the supplied value.
     * @param minLen Inclusive minimum byte length.
     * @param maxLen Inclusive maximum byte length.
     */
    function checkBytesLen(bytes32 field, uint256 len, uint256 minLen, uint256 maxLen) internal pure {
        if (len < minLen) revert StringTooShort(field, len, minLen);
        if (len > maxLen) revert StringTooLong(field, len, maxLen);
    }

    /**
     * @notice Saturating subtraction: `a - b`, clamped at zero instead of reverting on underflow.
     * @dev MANDATORY wherever decayed mass is removed from an aggregate. Bucketed decay always rounds
     *      down and a governance half-life change re-frames past accruals, so the recomputed amount
     *      being removed can legitimately exceed the aggregate it is removed from by a few wei. A
     *      revert there would let a single dust rounding permanently brick `revokeEndorsement`.
     * @param a Minuend.
     * @param b Subtrahend.
     * @return The difference, or zero when `b >= a`.
     */
    /// @notice Minimum age a precommit must reach before its reveal is accepted.
    /// @dev Two blocks' worth of time on a 12s chain. Long enough that an observer who first sees
    ///      a CID at reveal time cannot retroactively produce an older precommit for it.
    uint64 internal constant MIN_PRECOMMIT_DELAY = 24 seconds;

    /// @notice Maximum age of a precommit, after which it must be replaced.
    /// @dev Bounds how long a blinded claim can squat on the mapping.
    uint64 internal constant MAX_PRECOMMIT_AGE = 1 days;

    function satSub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
