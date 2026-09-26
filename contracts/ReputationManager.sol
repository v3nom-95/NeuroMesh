// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";
import {IReputationManager} from "./interfaces/IReputationManager.sol";
import {NeuroMeshGuarded} from "./base/NeuroMeshGuarded.sol";
import {DecayMath} from "./libraries/DecayMath.sol";
import {Limits} from "./libraries/Limits.sol";
import {Pagination} from "./libraries/Pagination.sol";
import {Roles} from "./libraries/Roles.sol";
import {
    AgentInactive,
    AlreadyEndorsed,
    AlreadyReported,
    BatchTooLarge,
    CooldownActive,
    EtherTransferFailed,
    InvalidParameter,
    InvalidRecipient,
    InvalidStake,
    NotAContract,
    NotEndorsed,
    NotReported,
    NothingToClaim,
    SelfAction,
    StakeAlreadySlashed,
    StakeLocked,
    StringTooLong,
    UnclaimedStake
} from "./libraries/NeuroMeshErrors.sol";

/**
 * @title ReputationManager
 * @author NeuroMesh Protocol
 * @notice Bounded, decaying, revocable trust accounting for NeuroMesh agents.
 *
 * @dev WHAT THIS CONTRACT FIXES relative to the previous version:
 *      - `endorserCount` was incremented but never decremented, and re-incremented by the same
 *        wallet after a report zeroed its local trust: one address could inflate an agent's endorser
 *        count without bound. Endorsements are now first-class, revocable edges; every teardown path
 *        decrements the counter exactly once, and an endorser can never hold two live edges.
 *      - There was no revocation at all: an endorser who later discovered poisoning could only add a
 *        report, which did not undo the endorsement. `revokeEndorsement` now removes the edge and its
 *        decayed mass, and filing a report auto-revokes any endorsement the reporter still holds.
 *      - Time decay and transitive trust were documented but absent. Both are implemented here.
 *      - The score was `endorsers * 1000 / (1 + 3 * negatives)`: integer-truncated, unbounded above,
 *        and compared against a hardcoded 500, so one endorsement from one throwaway wallet made an
 *        agent TRUSTED. The score is now a bounded WAD ratio with a Bayesian prior.
 *      - `trustLog` was an unbounded array of structs each holding an unbounded string. It is now a
 *        fixed-capacity ring of packed structs storing only `keccak256(reason)`.
 *      - `identityContract` was mutable, unchecked and non-immutable. `identity` is now immutable and
 *        validated for both zero address and contract code at construction.
 *
 *      SCORING MODEL
 *      -------------
 *      Endorsement weight (the one-hop transitive trust the old contract only claimed):
 *
 *          w(i) = baseEndorserWeightWad
 *               + (maxEndorserWeightWad - baseEndorserWeightWad) * reputationOf(i) / WAD
 *
 *      clamped to [base, max]. A fresh, unknown endorser contributes 0.25; a fully trusted one
 *      contributes 1.0. A report by the same actor carries `w(i) * negativeMultiplierWad / WAD`
 *      (0.75 to 3.0 at default parameters), preserving the asymmetric "trust is easier to lose than
 *      to gain" property while making it depend on WHO is reporting rather than on a flat multiplier.
 *
 *      Score, in WAD:
 *
 *          score(j) = P / (P + N + prior)
 *
 *      where P and N are the time-decayed positive and negative evidence masses accumulated against
 *      j. The score is bounded in [0, 1), never truncates, is monotone increasing in P and monotone
 *      decreasing in N, and is directly comparable across agents with wildly different endorser
 *      populations. `prior` (default 3.0) is a Bayesian pseudo-count representing "unknown".
 *
 *      SYBIL ARITHMETIC, stated honestly. With `trustThresholdWad = 0.6` and `priorWad = 3.0`,
 *      crossing the trust line requires P >= 4.5. A fresh, zero-reputation endorser contributes
 *      `baseEndorserWeightWad` (0.25), which would suggest 18 distinct endorsers.
 *
 *      THAT FIGURE IS AN UPPER BOUND, NOT THE REAL COST. `previewEndorsementWeight` reads the
 *      endorser's own LIVE reputation, and outgoing weight is not row-normalised, so members of a
 *      mutually-endorsing clique raise each other's weight before endorsing the target. Measured
 *      against this implementation the practical bar is about 8 mutually-endorsing wallets, not 18.
 *      Every one must still be separately registered and active in AgentIdentity, clear the
 *      per-pair and per-actor cooldowns, and lock `endorsementStakeWei` where staking is enabled.
 *
 *      Row normalisation (capping an endorser's total outgoing weight at w(i) and splitting it
 *      across its targets) is the principled fix and is tracked as NM-05 in
 *      docs/V2.1-HARDENING-PLAN.md. Operators who need the higher bar today should raise
 *      `trustThresholdWad` or lower `maxEndorserWeightWad`. For comparison, the pre-rewrite contract
 *      became "trusted" on a single endorsement from a single throwaway wallet.
 *
 *      DECAY IS LAZY. Nothing ever loops over an agent's endorsers. Each agent carries
 *      `(P, N, lastSettledAt)`; `_settle` multiplies both masses by `2^(-dt/halfLife)` and moves the
 *      timestamp forward. Views apply the same factor without writing, so a score decays correctly
 *      even if no transaction touches the agent for a year. `settle` / `settleBatch` are
 *      permissionless upkeep for anyone who wants the storage brought up to date.
 *
 *      WHY EVERY MASS SUBTRACTION SATURATES. Removing an edge subtracts that edge's individually
 *      decayed weight from an aggregate that was decayed in a different bucketing frame, and a
 *      governance half-life change re-frames past accruals entirely. The recomputed amount can
 *      therefore exceed the aggregate by a few wei. A checked subtraction would revert, permanently
 *      bricking `revokeEndorsement` for that pair; `Limits.satSub` clamps at zero instead. As an
 *      exactness anchor, removing the LAST endorsement (or report) zeroes the corresponding mass
 *      outright, so residual drift can never accumulate across cycles.
 *
 *      FUNDS INVARIANT. There is deliberately no `receive()` and no `fallback()`: the only way ether
 *      enters this contract is `endorseAgent`, which makes
 *      `treasuryBalance + sum(unclaimed stakes) == address(this).balance` a testable invariant.
 *
 * @custom:security-contact security@neuromesh.protocol
 */
contract ReputationManager is IReputationManager, NeuroMeshGuarded, ReentrancyGuard {
    /*//////////////////////////////////////////////////////////////
                            IMMUTABLE WIRING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReputationManager
    IAgentIdentity public immutable override identity;

    /// @inheritdoc IReputationManager
    uint256 public immutable override TRUST_LOG_CAPACITY;

    /*//////////////////////////////////////////////////////////////
                            EVIDENCE STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev Decayed positive evidence mass in WAD, as of `_lastSettledAt`.
    mapping(address => uint256) private _positiveMass;

    /// @dev Decayed negative evidence mass in WAD, as of `_lastSettledAt`.
    mapping(address => uint256) private _negativeMass;

    /// @dev Timestamp the masses were last materialised at; 0 until the agent is first touched.
    mapping(address => uint64) private _lastSettledAt;

    /// @inheritdoc IReputationManager
    mapping(address => uint256) public override endorserCount;

    /// @inheritdoc IReputationManager
    mapping(address => uint256) public override reporterCount;

    /// @dev from => to => endorsement edge.
    mapping(address => mapping(address => Endorsement)) private _endorsements;

    /// @dev from => to => report edge.
    mapping(address => mapping(address => Report)) private _reports;

    /// @dev from => to => timestamp before which this pair cannot act again.
    mapping(address => mapping(address => uint64)) private _pairCooldownEnd;

    /// @dev actor => timestamp before which this actor cannot take any trust action.
    mapping(address => uint64) private _actorCooldownEnd;

    /*//////////////////////////////////////////////////////////////
                              TRUST LOG
    //////////////////////////////////////////////////////////////*/

    /// @dev Fixed-capacity ring of recent trust events; hard-bounded at `TRUST_LOG_CAPACITY` slots.
    TrustEvent[] private _trustRing;

    /// @notice Monotone lifetime count of trust events, independent of the ring capacity.
    uint256 public trustEventCount;

    /*//////////////////////////////////////////////////////////////
                            TREASURY / PARAMS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReputationManager
    uint256 public override treasuryBalance;

    /// @inheritdoc IReputationManager
    address public override treasury;

    /// @inheritdoc IReputationManager
    uint256 public override halfLifeSeconds;

    /// @inheritdoc IReputationManager
    uint256 public override priorWad;

    /// @inheritdoc IReputationManager
    uint256 public override trustThresholdWad;

    /// @inheritdoc IReputationManager
    uint256 public override negativeMultiplierWad;

    /// @inheritdoc IReputationManager
    uint256 public override baseEndorserWeightWad;

    /// @inheritdoc IReputationManager
    uint256 public override maxEndorserWeightWad;

    /// @inheritdoc IReputationManager
    uint256 public override endorseCooldown;

    /// @inheritdoc IReputationManager
    uint256 public override reportCooldown;

    /// @inheritdoc IReputationManager
    uint256 public override actorCooldown;

    /// @inheritdoc IReputationManager
    uint256 public override endorsementStakeWei;

    /// @inheritdoc IReputationManager
    uint256 public override stakeLockPeriod;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deploys the trust layer with the protocol's default parameters.
     * @dev Every default is stored, not hardcoded, and every one is adjustable by `PARAM_ADMIN_ROLE`
     *      within the bounds declared in `Limits`.
     * @param admin            Protocol administrator; also receives `PARAM_ADMIN_ROLE`,
     *                         `SLASHER_ROLE` and `TREASURER_ROLE`.
     * @param identity_        Deployed AgentIdentity registry; validated and immutable.
     * @param treasury_        Address recorded as the owner of slashed stake.
     * @param trustLogCapacity Ring-buffer capacity, in (0, `Limits.MAX_TRUST_LOG_CAPACITY`].
     */
    constructor(
        address admin,
        address identity_,
        address treasury_,
        uint256 trustLogCapacity
    ) NeuroMeshGuarded(admin) {
        _requireNonZero(identity_);
        if (identity_.code.length == 0) revert NotAContract(identity_);
        _requireNonZero(treasury_);
        if (trustLogCapacity == 0 || trustLogCapacity > Limits.MAX_TRUST_LOG_CAPACITY) {
            revert InvalidParameter(bytes32("logCapacity"), trustLogCapacity);
        }

        identity = IAgentIdentity(identity_);
        TRUST_LOG_CAPACITY = trustLogCapacity;
        treasury = treasury_;

        _grantRole(Roles.PARAM_ADMIN_ROLE, admin);
        _grantRole(Roles.SLASHER_ROLE, admin);
        _grantRole(Roles.TREASURER_ROLE, admin);

        halfLifeSeconds = 90 days;
        priorWad = 3e18;
        trustThresholdWad = 6e17;
        negativeMultiplierWad = 3e18;
        baseEndorserWeightWad = 2.5e17;
        maxEndorserWeightWad = 1e18;
        endorseCooldown = 1 days;
        reportCooldown = 1 days;
        actorCooldown = 1 hours;
        endorsementStakeWei = 0;
        stakeLockPeriod = 7 days;
    }

    /*//////////////////////////////////////////////////////////////
                           ENDORSEMENT (WRITE)
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IReputationManager
     * @dev `msg.value` must equal `endorsementStakeWei` exactly - neither more nor less - so the
     *      escrow accounting is unambiguous. Any stake from a previous, already-revoked endorsement
     *      of the same target must be claimed first, otherwise overwriting the edge would strand it.
     */
    function endorseAgent(address target, string calldata reason) external payable override whenNotPaused nonReentrant {
        bytes32 reasonHash = _validateAction(target, reason);

        Endorsement storage e = _endorsements[msg.sender][target];
        if (e.createdAt != 0 && e.revokedAt == 0) revert AlreadyEndorsed(msg.sender, target);
        if (e.stake != 0 && !e.stakeClaimed && !e.slashed) revert UnclaimedStake(msg.sender, target);
        _checkCooldowns(target);
        if (msg.value != endorsementStakeWei) revert InvalidStake(endorsementStakeWei, msg.value);

        uint256 w = previewEndorsementWeight(msg.sender);

        _settle(target);
        _positiveMass[target] += w;
        unchecked {
            endorserCount[target] += 1;
        }

        _endorsements[msg.sender][target] = Endorsement({
            weight: uint128(w),
            createdAt: uint64(block.timestamp),
            revokedAt: 0,
            stake: uint96(msg.value),
            stakeClaimed: false,
            slashed: false
        });

        _setCooldowns(target, endorseCooldown);
        _pushTrustEvent(TrustEventKind.Endorse, msg.sender, target, w, reasonHash);

        emit AgentEndorsed(msg.sender, target, w, msg.value, reason, reasonHash);
        _emitReputationChanged(target);
    }

    /**
     * @inheritdoc IReputationManager
     * @dev THE FIX for the never-decremented endorser count. Removing the edge also starts the stake
     *      unlock timer; the stake itself is withdrawn later through {claimStake}.
     */
    function revokeEndorsement(address target, string calldata reason) external override nonReentrant {
        // DELIBERATELY NOT `whenNotPaused`. claimStake is pause-exempt so escrow is always
        // recoverable, but revocation is its precondition - gating this would have frozen every
        // endorsement stake for the duration of a pause, contradicting that exemption.
        bytes32 reasonHash = _checkReason(reason);
        Endorsement storage e = _endorsements[msg.sender][target];
        if (e.createdAt == 0 || e.revokedAt != 0) revert NotEndorsed(msg.sender, target);

        uint256 removed = _removeEndorsement(msg.sender, target, TrustEventKind.RevokeEndorse, reasonHash);
        _setCooldowns(target, endorseCooldown);

        emit EndorsementRevoked(msg.sender, target, removed, reason, reasonHash);
        _emitReputationChanged(target);
    }

    /*//////////////////////////////////////////////////////////////
                             REPORT (WRITE)
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IReputationManager
     * @dev If the reporter still holds a live endorsement of the target it is torn down first. The
     *      old contract merely zeroed `localTrust`, which left `endorserCount` overstated and allowed
     *      the same wallet to re-increment it on the next endorsement - the reputation-inflation bug.
     */
    function reportAgent(address target, string calldata reason) external override whenNotPaused nonReentrant {
        bytes32 reasonHash = _validateAction(target, reason);

        Report storage r = _reports[msg.sender][target];
        if (r.createdAt != 0 && r.withdrawnAt == 0) revert AlreadyReported(msg.sender, target);
        _checkCooldowns(target);

        Endorsement storage e = _endorsements[msg.sender][target];
        if (e.createdAt != 0 && e.revokedAt == 0) {
            uint256 autoRemoved = _removeEndorsement(msg.sender, target, TrustEventKind.RevokeEndorse, reasonHash);
            // The edge really is gone, so the edge-removal event MUST be emitted here too. The
            // contract's own documentation makes the indexed log - not the bounded on-chain ring -
            // the authoritative history, so a silent teardown would leave every off-chain mirror of
            // `endorserCount` permanently one too high for this pair.
            emit EndorsementRevoked(msg.sender, target, autoRemoved, reason, reasonHash);
        }

        uint256 rw = Math.mulDiv(previewEndorsementWeight(msg.sender), negativeMultiplierWad, Limits.WAD);

        _settle(target);
        _negativeMass[target] += rw;
        unchecked {
            reporterCount[target] += 1;
        }

        _reports[msg.sender][target] = Report({
            weight: uint128(rw),
            createdAt: uint64(block.timestamp),
            withdrawnAt: 0
        });

        _setCooldowns(target, reportCooldown);
        _pushTrustEvent(TrustEventKind.Report, msg.sender, target, rw, reasonHash);

        emit AgentReported(msg.sender, target, rw, reason, reasonHash);
        _emitReputationChanged(target);
    }

    /// @inheritdoc IReputationManager
    function withdrawReport(address target, string calldata reason) external override whenNotPaused nonReentrant {
        bytes32 reasonHash = _checkReason(reason);
        Report storage r = _reports[msg.sender][target];
        if (r.createdAt == 0 || r.withdrawnAt != 0) revert NotReported(msg.sender, target);

        _settle(target);
        uint256 removed = DecayMath.applyDecay(r.weight, block.timestamp - r.createdAt, halfLifeSeconds);
        _negativeMass[target] = Limits.satSub(_negativeMass[target], removed);
        reporterCount[target] = Limits.satSub(reporterCount[target], 1);
        if (reporterCount[target] == 0) _negativeMass[target] = 0;
        r.withdrawnAt = uint64(block.timestamp);

        _setCooldowns(target, reportCooldown);
        _pushTrustEvent(TrustEventKind.WithdrawReport, msg.sender, target, removed, reasonHash);

        emit ReportWithdrawn(msg.sender, target, removed, reason, reasonHash);
        _emitReputationChanged(target);
    }

    /*//////////////////////////////////////////////////////////////
                            STAKE (WRITE)
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IReputationManager
     * @dev DELIBERATELY NOT `whenNotPaused`: user funds must remain withdrawable during an incident.
     *      Checks-effects-interactions plus `nonReentrant` give two independent layers against a
     *      double claim - the `stakeClaimed` flag is written before the transfer, so even without the
     *      guard a re-entrant call would fail its own `NothingToClaim` check.
     */
    function claimStake(address target) external override nonReentrant {
        Endorsement storage e = _endorsements[msg.sender][target];
        if (e.slashed) revert StakeAlreadySlashed(msg.sender, target);
        if (e.stake == 0 || e.stakeClaimed) revert NothingToClaim(msg.sender, target);
        if (e.revokedAt == 0) revert StakeLocked(type(uint256).max, block.timestamp);

        uint256 unlockAt = uint256(e.revokedAt) + stakeLockPeriod;
        if (block.timestamp < unlockAt) revert StakeLocked(unlockAt, block.timestamp);

        uint256 amount = e.stake;
        e.stakeClaimed = true;

        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert EtherTransferFailed(msg.sender, amount);

        emit StakeClaimed(msg.sender, target, amount);
    }

    /**
     * @inheritdoc IReputationManager
     * @dev Removes the edge AND confiscates its escrow. The endorsement is torn down through the same
     *      shared path as a voluntary revocation, so `endorserCount` stays exact.
     */
    function slashEndorsement(
        address from,
        address to,
        bytes32 reason
    ) external override onlyRole(Roles.SLASHER_ROLE) nonReentrant {
        Endorsement storage e = _endorsements[from][to];
        // A revoked edge stays slashable until its stake is claimed. Requiring a LIVE edge let any
        // endorser front-run the slasher with revokeEndorsement and recover the stake in full,
        // which made slashing unenforceable against anyone paying attention.
        if (e.createdAt == 0 || e.slashed || e.stakeClaimed) revert NotEndorsed(from, to);

        // Only tear the edge down once. An already-revoked edge has had its mass and endorserCount
        // removed, so re-running teardown would double-decrement.
        if (e.revokedAt == 0) {
            _removeEndorsement(from, to, TrustEventKind.Slash, reason);
        }

        uint256 amount = e.stake;
        e.slashed = true;
        treasuryBalance += amount;

        emit EndorsementSlashed(from, to, msg.sender, amount, reason);
        _emitReputationChanged(to);
    }

    /**
     * @inheritdoc IReputationManager
     * @dev Bounded by `treasuryBalance`, which only ever grows through {slashEndorsement}, so this can
     *      never touch escrow that still belongs to an endorser.
     */
    function withdrawTreasury(
        address to,
        uint256 amount
    ) external override onlyRole(Roles.TREASURER_ROLE) nonReentrant {
        _requireNonZero(to);
        // The `treasury` address is the point of `setTreasury`. Allowing an arbitrary recipient
        // meant the stored value was never read and the setter granted nothing.
        if (to != treasury) revert InvalidRecipient(to, treasury);
        if (amount == 0 || amount > treasuryBalance) revert InvalidParameter(bytes32("amount"), amount);

        treasuryBalance -= amount;

        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EtherTransferFailed(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                             SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReputationManager
    function settle(address agent) external override whenNotPaused {
        _settle(agent);
    }

    /// @inheritdoc IReputationManager
    function settleBatch(address[] calldata agents) external override whenNotPaused {
        uint256 n = agents.length;
        if (n > Limits.MAX_BATCH_SIZE) revert BatchTooLarge(n, Limits.MAX_BATCH_SIZE);
        for (uint256 i = 0; i < n; ++i) {
            _settle(agents[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReputationManager
    function reputationOf(address account) public view override returns (uint256) {
        (uint256 p, uint256 n) = _currentMasses(account);
        return Math.mulDiv(p, Limits.WAD, p + n + priorWad);
    }

    /**
     * @inheritdoc IReputationManager
     * @custom:deprecated UNITS CHANGED. This used to return an unbounded integer on a 0..N*1000 scale
     *                    where 500 meant "trusted". It now returns WAD, i.e. 1e18 == 1.0, bounded in
     *                    [0, 1e18). Off-chain consumers MUST divide by 1e18 (or call
     *                    {reputationBps}); treating the new value as the old one overstates trust by
     *                    fifteen orders of magnitude.
     */
    function globalReputation(address account) external view override returns (uint256) {
        return reputationOf(account);
    }

    /// @inheritdoc IReputationManager
    function reputationBps(address account) external view override returns (uint256) {
        return reputationOf(account) / 1e14;
    }

    /// @inheritdoc IReputationManager
    function isTrusted(address account) external view override returns (bool) {
        return reputationOf(account) >= trustThresholdWad;
    }

    /// @inheritdoc IReputationManager
    function massesOf(
        address account
    ) external view override returns (uint256 positiveWad, uint256 negativeWad, uint64 lastSettledAt) {
        (positiveWad, negativeWad) = _currentMasses(account);
        lastSettledAt = _lastSettledAt[account];
    }

    /**
     * @inheritdoc IReputationManager
     * @dev Reads the endorser's CURRENT reputation, so the weight an endorsement carries is decided
     *      at the moment it is made and then frozen into the edge. Freezing is deliberate: otherwise
     *      every score change would retroactively re-price every edge that agent ever created, which
     *      is unbounded work.
     */
    function previewEndorsementWeight(address endorser) public view override returns (uint256) {
        uint256 base = baseEndorserWeightWad;
        uint256 max_ = maxEndorserWeightWad;
        uint256 w = base + Math.mulDiv(max_ - base, reputationOf(endorser), Limits.WAD);
        return Math.min(w, max_);
    }

    /// @inheritdoc IReputationManager
    function getEndorsement(address from, address to) external view override returns (Endorsement memory) {
        return _endorsements[from][to];
    }

    /// @inheritdoc IReputationManager
    function getReport(address from, address to) external view override returns (Report memory) {
        return _reports[from][to];
    }

    /// @inheritdoc IReputationManager
    function hasActiveEndorsement(address from, address to) external view override returns (bool) {
        Endorsement storage e = _endorsements[from][to];
        return e.createdAt != 0 && e.revokedAt == 0;
    }

    /// @inheritdoc IReputationManager
    function hasActiveReport(address from, address to) external view override returns (bool) {
        Report storage r = _reports[from][to];
        return r.createdAt != 0 && r.withdrawnAt == 0;
    }

    /**
     * @inheritdoc IReputationManager
     * @dev Legacy name, new meaning: this is the monotone LIFETIME count, which exceeds the number of
     *      entries actually retrievable from the ring once `TRUST_LOG_CAPACITY` is passed.
     */
    function getTrustLogLength() external view override returns (uint256) {
        return trustEventCount;
    }

    /**
     * @inheritdoc IReputationManager
     * @dev NEWEST FIRST: logical index 0 is the most recent event. The ring is a bounded on-chain
     *      recent-activity feed and is NEVER the complete history - the indexed event log is
     *      authoritative. `total` is the lifetime count, so a client can detect how much has scrolled
     *      out of the ring.
     */
    function getTrustEvents(
        uint256 offset,
        uint256 limit
    ) external view override returns (TrustEvent[] memory page, uint256 total) {
        total = trustEventCount;
        uint256 stored = Math.min(total, TRUST_LOG_CAPACITY);
        (uint256 start, uint256 count) = Pagination.slice(stored, offset, limit, Limits.MAX_PAGE_SIZE);
        page = new TrustEvent[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = _trustRing[(total - 1 - (start + i)) % TRUST_LOG_CAPACITY];
        }
    }

    /*//////////////////////////////////////////////////////////////
                          PARAMETER SETTERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Sets the decay half-life.
     * @dev NOT RETROACTIVE. Mass already accrued keeps decaying, but from the last settle point and
     *      under the NEW half-life; per-edge removal amounts are likewise recomputed under the new
     *      half-life. The two frames therefore disagree slightly, which is exactly why every mass
     *      subtraction saturates. Operators should call {settleBatch} on hot agents in the same block
     *      immediately before changing this.
     * @param value New half-life in seconds, within [`Limits.MIN_HALF_LIFE`, `Limits.MAX_HALF_LIFE`].
     */
    function setHalfLife(uint256 value) external onlyRole(Roles.PARAM_ADMIN_ROLE) {
        if (value < Limits.MIN_HALF_LIFE || value > Limits.MAX_HALF_LIFE) {
            revert InvalidParameter(bytes32("halfLife"), value);
        }
        emit ParameterUpdated(bytes32("halfLife"), halfLifeSeconds, value);
        halfLifeSeconds = value;
    }

    /**
     * @notice Sets the Bayesian prior pseudo-count.
     * @param value New prior in WAD, within [`Limits.MIN_PRIOR_WAD`, `Limits.MAX_PRIOR_WAD`].
     */
    function setPrior(uint256 value) external onlyRole(Roles.PARAM_ADMIN_ROLE) {
        if (value < Limits.MIN_PRIOR_WAD || value > Limits.MAX_PRIOR_WAD) {
            revert InvalidParameter(bytes32("prior"), value);
        }
        emit ParameterUpdated(bytes32("prior"), priorWad, value);
        priorWad = value;
    }

    /**
     * @notice Sets the score at or above which {isTrusted} returns true.
     * @param value New threshold in WAD, strictly inside (0, 1e18) - the score is bounded below 1.0,
     *              so a threshold of 1e18 would make trust unreachable.
     */
    function setTrustThreshold(uint256 value) external onlyRole(Roles.PARAM_ADMIN_ROLE) {
        if (value == 0 || value >= Limits.WAD) revert InvalidParameter(bytes32("threshold"), value);
        emit ParameterUpdated(bytes32("threshold"), trustThresholdWad, value);
        trustThresholdWad = value;
    }

    /**
     * @notice Sets the multiplier applied to an endorser's weight when it files a report.
     * @param value New multiplier in WAD, within
     *              [`Limits.MIN_NEG_MULTIPLIER_WAD`, `Limits.MAX_NEG_MULTIPLIER_WAD`].
     */
    function setNegativeMultiplier(uint256 value) external onlyRole(Roles.PARAM_ADMIN_ROLE) {
        if (value < Limits.MIN_NEG_MULTIPLIER_WAD || value > Limits.MAX_NEG_MULTIPLIER_WAD) {
            revert InvalidParameter(bytes32("negMultiplier"), value);
        }
        emit ParameterUpdated(bytes32("negMultiplier"), negativeMultiplierWad, value);
        negativeMultiplierWad = value;
    }

    /**
     * @notice Sets both endorser weight bounds together.
     * @dev Deliberately a single call: setting them independently would allow a transient state where
     *      `base > max`, which would make `previewEndorsementWeight` underflow.
     * @param base New floor weight in WAD; must be greater than zero.
     * @param max_ New ceiling weight in WAD; must be at least `base` and at most
     *             `Limits.MAX_ENDORSER_WEIGHT_WAD`.
     */
    function setEndorserWeights(uint256 base, uint256 max_) external onlyRole(Roles.PARAM_ADMIN_ROLE) {
        if (base == 0 || base > max_) revert InvalidParameter(bytes32("baseWeight"), base);
        if (max_ > Limits.MAX_ENDORSER_WEIGHT_WAD) revert InvalidParameter(bytes32("maxWeight"), max_);
        emit ParameterUpdated(bytes32("baseWeight"), baseEndorserWeightWad, base);
        emit ParameterUpdated(bytes32("maxWeight"), maxEndorserWeightWad, max_);
        baseEndorserWeightWad = base;
        maxEndorserWeightWad = max_;
    }

    /**
     * @notice Sets the three cooldown windows together.
     * @param endorse_ Per-pair cooldown after an endorsement, in seconds.
     * @param report_  Per-pair cooldown after a report, in seconds.
     * @param actor_   Per-actor cooldown between any two trust actions, in seconds.
     */
    function setCooldowns(uint256 endorse_, uint256 report_, uint256 actor_) external onlyRole(Roles.PARAM_ADMIN_ROLE) {
        if (endorse_ > Limits.MAX_COOLDOWN) revert InvalidParameter(bytes32("endorseCooldown"), endorse_);
        if (report_ > Limits.MAX_COOLDOWN) revert InvalidParameter(bytes32("reportCooldown"), report_);
        if (actor_ > Limits.MAX_COOLDOWN) revert InvalidParameter(bytes32("actorCooldown"), actor_);
        emit ParameterUpdated(bytes32("endorseCooldown"), endorseCooldown, endorse_);
        emit ParameterUpdated(bytes32("reportCooldown"), reportCooldown, report_);
        emit ParameterUpdated(bytes32("actorCooldown"), actorCooldown, actor_);
        endorseCooldown = endorse_;
        reportCooldown = report_;
        actorCooldown = actor_;
    }

    /**
     * @notice Sets the exact stake that must accompany an endorsement.
     * @dev Changing this does not touch escrow already locked at the old value; each edge remembers
     *      the amount it was created with.
     * @param value New stake in wei; zero disables staking.
     */
    function setEndorsementStake(uint256 value) external onlyRole(Roles.PARAM_ADMIN_ROLE) {
        emit ParameterUpdated(bytes32("stake"), endorsementStakeWei, value);
        endorsementStakeWei = value;
    }

    /**
     * @notice Sets how long a revoked endorsement's stake stays locked.
     * @param value New lock period in seconds, at most `Limits.MAX_STAKE_LOCK`.
     */
    function setStakeLockPeriod(uint256 value) external onlyRole(Roles.PARAM_ADMIN_ROLE) {
        if (value > Limits.MAX_STAKE_LOCK) revert InvalidParameter(bytes32("stakeLock"), value);
        emit ParameterUpdated(bytes32("stakeLock"), stakeLockPeriod, value);
        stakeLockPeriod = value;
    }

    /**
     * @notice Sets the treasury address recorded for slashed stake.
     * @dev `DEFAULT_ADMIN_ROLE` rather than `PARAM_ADMIN_ROLE`: this is a funds-adjacent decision.
     * @param treasury_ New treasury address; must be non-zero.
     */
    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireNonZero(treasury_);
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Shared precondition check for the two evidence-creating entrypoints.
     * @param target Subject of the action.
     * @param reason Free-text reason, length-capped and hashed on chain.
     * @return reasonHash `keccak256(bytes(reason))`.
     */
    function _validateAction(address target, string calldata reason) internal view returns (bytes32 reasonHash) {
        if (target == msg.sender) revert SelfAction(msg.sender);
        if (!identity.isActive(msg.sender)) revert AgentInactive(msg.sender);
        if (!identity.isActive(target)) revert AgentInactive(target);
        return _checkReason(reason);
    }

    /// @dev Enforces the reason length cap and returns its hash; the plaintext lives only in events.
    function _checkReason(string calldata reason) internal pure returns (bytes32) {
        uint256 len = bytes(reason).length;
        if (len > Limits.MAX_REASON_BYTES) revert StringTooLong(bytes32("reason"), len, Limits.MAX_REASON_BYTES);
        return keccak256(bytes(reason));
    }

    /// @dev Reverts while either the per-pair or the per-actor cooldown is still running.
    function _checkCooldowns(address target) internal view {
        uint64 pairEnd = _pairCooldownEnd[msg.sender][target];
        if (block.timestamp < pairEnd) revert CooldownActive(pairEnd, block.timestamp);
        uint64 actorEnd = _actorCooldownEnd[msg.sender];
        if (block.timestamp < actorEnd) revert CooldownActive(actorEnd, block.timestamp);
    }

    /// @dev Arms both cooldowns after a successful trust action.
    function _setCooldowns(address target, uint256 pairWindow) internal {
        _pairCooldownEnd[msg.sender][target] = uint64(block.timestamp + pairWindow);
        _actorCooldownEnd[msg.sender] = uint64(block.timestamp + actorCooldown);
    }

    /**
     * @dev The single endorsement teardown path, shared by {revokeEndorsement}, the auto-revoke inside
     *      {reportAgent} and {slashEndorsement}. Removing the last endorsement zeroes the positive
     *      mass outright so bucketed-decay drift cannot accumulate.
     * @return removed The decayed weight actually withdrawn from the target's positive mass.
     */
    function _removeEndorsement(
        address from,
        address to,
        TrustEventKind kind,
        bytes32 reasonHash
    ) internal returns (uint256 removed) {
        Endorsement storage e = _endorsements[from][to];
        _settle(to);
        removed = DecayMath.applyDecay(e.weight, block.timestamp - e.createdAt, halfLifeSeconds);
        _positiveMass[to] = Limits.satSub(_positiveMass[to], removed);
        endorserCount[to] = Limits.satSub(endorserCount[to], 1);
        if (endorserCount[to] == 0) _positiveMass[to] = 0;
        e.revokedAt = uint64(block.timestamp);
        _pushTrustEvent(kind, from, to, removed, reasonHash);
    }

    /**
     * @dev Materialises elapsed decay into storage. The first touch only records the timestamp, so an
     *      agent is never decayed for the epoch before it had any evidence.
     */
    function _settle(address agent) internal {
        uint64 last = _lastSettledAt[agent];
        if (last == 0) {
            _lastSettledAt[agent] = uint64(block.timestamp);
            return;
        }
        uint256 dt = block.timestamp - last;
        if (dt == 0) return;

        uint256 p = DecayMath.applyDecay(_positiveMass[agent], dt, halfLifeSeconds);
        uint256 n = DecayMath.applyDecay(_negativeMass[agent], dt, halfLifeSeconds);
        _positiveMass[agent] = p;
        _negativeMass[agent] = n;

        // decayFactor quantises to 1/16-half-life buckets, so any elapsed time shorter than
        // halfLife/16 decays by nothing. Advancing the clock to `now` regardless would discard that
        // unapplied time, and settling faster than one bucket would freeze the score forever
        // (`settle` is permissionless). Advance only by the time the quantised factor consumed and
        // carry the residual, so repeated settles compose to the same result as one long one.
        uint64 settledTo = uint64(last + _consumedBy(dt, halfLifeSeconds));
        _lastSettledAt[agent] = settledTo;

        emit ReputationSettled(agent, p, n, settledTo);
    }

    /**
     * @dev How much of `dt` the bucket-quantised decay factor actually consumed.
     *      Whole half-lives pass through exactly; the remainder is floored to a 1/16 bucket. The
     *      unconsumed tail (< halfLife/16) is carried forward by {_settle}.
     * @param dt       Seconds elapsed since the last settle.
     * @param halfLife Current half-life in seconds.
     * @return The consumed portion of `dt`, always <= `dt`.
     */
    function _consumedBy(uint256 dt, uint256 halfLife) internal pure returns (uint256) {
        if (halfLife == 0) return dt;
        uint256 whole = (dt / halfLife) * halfLife;
        uint256 rem = dt % halfLife;
        // floor(rem / (halfLife/16)) buckets, expressed without dividing by a possibly-zero bucket
        return whole + (((rem * 16) / halfLife) * halfLife) / 16;
    }

    /**
     * @dev The read-only twin of {_settle}: every view applies the same decay without writing, so a
     *      score is correct even if nobody has settled the agent for years.
     */
    function _currentMasses(address agent) internal view returns (uint256 p, uint256 n) {
        p = _positiveMass[agent];
        n = _negativeMass[agent];
        uint64 last = _lastSettledAt[agent];
        if (last == 0 || (p == 0 && n == 0)) return (p, n);
        uint256 dt = block.timestamp - last;
        if (dt == 0) return (p, n);
        uint256 f = DecayMath.decayFactor(dt, halfLifeSeconds);
        p = Math.mulDiv(p, f, Limits.WAD);
        n = Math.mulDiv(n, f, Limits.WAD);
    }

    /// @dev Appends to the bounded ring buffer, overwriting the oldest entry once it is full.
    function _pushTrustEvent(
        TrustEventKind kind,
        address from,
        address to,
        uint256 weightWad,
        bytes32 reasonHash
    ) internal {
        TrustEvent memory ev = TrustEvent({
            from: from,
            kind: uint8(kind),
            timestamp: uint64(block.timestamp),
            to: to,
            weight: uint96(weightWad),
            reasonHash: reasonHash
        });
        if (_trustRing.length < TRUST_LOG_CAPACITY) {
            _trustRing.push(ev);
        } else {
            _trustRing[trustEventCount % TRUST_LOG_CAPACITY] = ev;
        }
        unchecked {
            ++trustEventCount;
        }
    }

    /// @dev Emits the post-action score snapshot. Split out so every write path reports identically.
    function _emitReputationChanged(address agent) internal {
        emit ReputationChanged(agent, reputationOf(agent), _positiveMass[agent], _negativeMass[agent]);
    }
}
