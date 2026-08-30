// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAgentIdentity} from "./IAgentIdentity.sol";

/**
 * @title IReputationManager
 * @author NeuroMesh Protocol
 * @notice Stable ABI surface of the NeuroMesh trust layer.
 * @dev All scores and weights are WAD fixed point (1.0 == 1e18). `reputationOf` is bounded in
 *      [0, 1e18) by construction - see the ReputationManager header for the full derivation.
 */
interface IReputationManager {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Kind discriminator for entries in the bounded trust-event ring buffer.
    enum TrustEventKind {
        None,
        Endorse,
        RevokeEndorse,
        Report,
        WithdrawReport,
        Slash
    }

    /**
     * @notice A single directed endorsement edge, `from -> to`.
     * @dev Packing: slot 0 = `weight` (16) + `createdAt` (8) + `revokedAt` (8) = 32 bytes exactly;
     *      slot 1 = `stake` (12) + `stakeClaimed` (1) + `slashed` (1) = 14 bytes.
     * @param weight       WAD weight captured at creation time, never recomputed.
     * @param createdAt    Unix seconds the edge was created; 0 means the edge never existed.
     * @param revokedAt    Unix seconds the edge was removed; 0 means active.
     * @param stake        Wei escrowed with the endorsement.
     * @param stakeClaimed Whether the escrow has been withdrawn by the endorser.
     * @param slashed      Whether the escrow was confiscated to the treasury.
     */
    struct Endorsement {
        uint128 weight;
        uint64 createdAt;
        uint64 revokedAt;
        uint96 stake;
        bool stakeClaimed;
        bool slashed;
    }

    /**
     * @notice A single directed report edge, `from -> to`.
     * @param weight      WAD weight captured at creation time (already multiplied by the negative
     *                    multiplier).
     * @param createdAt   Unix seconds the edge was created; 0 means the edge never existed.
     * @param withdrawnAt Unix seconds the edge was withdrawn; 0 means active.
     */
    struct Report {
        uint128 weight;
        uint64 createdAt;
        uint64 withdrawnAt;
    }

    /**
     * @notice One entry in the bounded on-chain recent-activity feed.
     * @dev Packing: slot 0 = `from` (20) + `kind` (1) + `timestamp` (8) = 29 bytes;
     *      slot 1 = `to` (20) + `weight` (12) = 32 bytes exactly; slot 2 = `reasonHash`.
     * @param from       Actor.
     * @param kind       A `TrustEventKind` value, stored as `uint8` so the struct packs.
     * @param timestamp  Unix seconds.
     * @param to         Subject.
     * @param weight     WAD weight narrowed to `uint96`; the protocol cap of 2e18 fits comfortably.
     * @param reasonHash `keccak256(bytes(reason))`; the plaintext reason lives only in the event log.
     */
    struct TrustEvent {
        address from;
        uint8 kind;
        uint64 timestamp;
        address to;
        uint96 weight;
        bytes32 reasonHash;
    }

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted when `from` endorses `to`.
    event AgentEndorsed(
        address indexed from,
        address indexed to,
        uint256 weightWad,
        uint256 stakeWei,
        string reason,
        bytes32 reasonHash
    );

    /// @notice Emitted when `from` withdraws its endorsement of `to`.
    event EndorsementRevoked(
        address indexed from,
        address indexed to,
        uint256 removedWeightWad,
        string reason,
        bytes32 reasonHash
    );

    /// @notice Emitted when `from` reports `to`.
    event AgentReported(
        address indexed from,
        address indexed to,
        uint256 weightWad,
        string reason,
        bytes32 reasonHash
    );

    /// @notice Emitted when `from` withdraws its report against `to`.
    event ReportWithdrawn(
        address indexed from,
        address indexed to,
        uint256 removedWeightWad,
        string reason,
        bytes32 reasonHash
    );

    /// @notice Emitted when a `SLASHER_ROLE` holder confiscates an endorsement stake.
    event EndorsementSlashed(
        address indexed from,
        address indexed to,
        address indexed slasher,
        uint256 stakeWei,
        bytes32 reason
    );

    /// @notice Emitted whenever an agent's score changes as a result of a trust action.
    event ReputationChanged(address indexed agent, uint256 scoreWad, uint256 positiveMassWad, uint256 negativeMassWad);

    /// @notice Emitted whenever decay is materialised into storage for an agent.
    event ReputationSettled(address indexed agent, uint256 positiveMassWad, uint256 negativeMassWad, uint64 settledAt);

    /// @notice Emitted by every governed parameter setter.
    event ParameterUpdated(bytes32 indexed name, uint256 previousValue, uint256 newValue);

    /// @notice Emitted when the treasury address changes.
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    /// @notice Emitted when an endorser withdraws its unlocked stake.
    event StakeClaimed(address indexed from, address indexed to, uint256 amountWei);

    /*//////////////////////////////////////////////////////////////
                            STATE CHANGING
    //////////////////////////////////////////////////////////////*/

    /// @notice Creates a stake-backed endorsement edge from `msg.sender` to `target`.
    function endorseAgent(address target, string calldata reason) external payable;

    /// @notice Removes `msg.sender`'s endorsement of `target` and starts its stake unlock timer.
    function revokeEndorsement(address target, string calldata reason) external;

    /// @notice Creates a report edge from `msg.sender` to `target`.
    function reportAgent(address target, string calldata reason) external;

    /// @notice Withdraws `msg.sender`'s report against `target`.
    function withdrawReport(address target, string calldata reason) external;

    /// @notice Withdraws the escrowed stake of a revoked endorsement once its lock has elapsed.
    function claimStake(address target) external;

    /// @notice Removes an endorsement and confiscates its stake; restricted to `SLASHER_ROLE`.
    function slashEndorsement(address from, address to, bytes32 reason) external;

    /// @notice Materialises elapsed decay into storage for one agent. Permissionless upkeep.
    function settle(address agent) external;

    /// @notice Materialises elapsed decay for up to `Limits.MAX_BATCH_SIZE` agents.
    function settleBatch(address[] calldata agents) external;

    /// @notice Moves slashed stake out of the contract; restricted to `TREASURER_ROLE`.
    function withdrawTreasury(address to, uint256 amount) external;

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Current trust score in WAD, decay applied as of `block.timestamp`.
    function reputationOf(address account) external view returns (uint256 scoreWad);

    /// @notice Alias of {reputationOf}.
    /// @custom:deprecated UNITS CHANGED: this used to be an unbounded integer, it is now WAD.
    function globalReputation(address account) external view returns (uint256 scoreWad);

    /// @notice {reputationOf} expressed in basis points, 0..10000.
    function reputationBps(address account) external view returns (uint256);

    /// @notice True when {reputationOf} is at or above the governed trust threshold.
    function isTrusted(address account) external view returns (bool);

    /// @notice Decay-adjusted evidence masses and the last settle timestamp.
    function massesOf(address account) external view returns (uint256 positiveWad, uint256 negativeWad, uint64 lastSettledAt);

    /// @notice Number of currently active endorsements of `account`.
    function endorserCount(address account) external view returns (uint256);

    /// @notice Number of currently active reports against `account`.
    function reporterCount(address account) external view returns (uint256);

    /// @notice The raw endorsement edge, active or not.
    function getEndorsement(address from, address to) external view returns (Endorsement memory);

    /// @notice The raw report edge, active or not.
    function getReport(address from, address to) external view returns (Report memory);

    /// @notice True when `from` currently endorses `to`.
    function hasActiveEndorsement(address from, address to) external view returns (bool);

    /// @notice True when `from` currently reports `to`.
    function hasActiveReport(address from, address to) external view returns (bool);

    /// @notice The WAD weight an endorsement authored by `endorser` would carry right now.
    function previewEndorsementWeight(address endorser) external view returns (uint256 weightWad);

    /// @notice Lifetime count of trust events; larger than the ring capacity once the ring wraps.
    function getTrustLogLength() external view returns (uint256);

    /// @notice Paginated trust-event feed, NEWEST FIRST, bounded by the ring capacity.
    function getTrustEvents(
        uint256 offset,
        uint256 limit
    ) external view returns (TrustEvent[] memory page, uint256 total);

    /*//////////////////////////////////////////////////////////////
                          PARAMETERS / WIRING
    //////////////////////////////////////////////////////////////*/

    /// @notice Decay half-life in seconds; 0 disables decay.
    function halfLifeSeconds() external view returns (uint256);

    /// @notice Bayesian prior pseudo-count in WAD.
    function priorWad() external view returns (uint256);

    /// @notice Score at or above which {isTrusted} is true, in WAD.
    function trustThresholdWad() external view returns (uint256);

    /// @notice Multiplier applied to an endorser's weight when it files a report, in WAD.
    function negativeMultiplierWad() external view returns (uint256);

    /// @notice Weight contributed by an endorser with zero reputation, in WAD.
    function baseEndorserWeightWad() external view returns (uint256);

    /// @notice Weight contributed by a maximally trusted endorser, in WAD.
    function maxEndorserWeightWad() external view returns (uint256);

    /// @notice Per-pair cooldown after an endorsement, in seconds.
    function endorseCooldown() external view returns (uint256);

    /// @notice Per-pair cooldown after a report, in seconds.
    function reportCooldown() external view returns (uint256);

    /// @notice Per-actor cooldown between any two trust actions, in seconds.
    function actorCooldown() external view returns (uint256);

    /// @notice Exact wei that must accompany `endorseAgent`; 0 disables staking.
    function endorsementStakeWei() external view returns (uint256);

    /// @notice Seconds after revocation before an endorsement stake becomes claimable.
    function stakeLockPeriod() external view returns (uint256);

    /// @notice Address recorded as the treasury owner of slashed stake.
    function treasury() external view returns (address);

    /// @notice Wei of slashed stake currently held for the treasury.
    function treasuryBalance() external view returns (uint256);

    /// @notice Immutable capacity of the on-chain trust-event ring buffer.
    function TRUST_LOG_CAPACITY() external view returns (uint256);

    /// @notice The immutable AgentIdentity registry this contract gates trust actions against.
    function identity() external view returns (IAgentIdentity);
}
