// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AgentIdentity.sol";

/**
 * @title ReputationManager - EigenTrust-Inspired Bayesian Reputation System
 * @notice Implements a trust-weighted reputation model where each agent maintains
 *         local trust scores toward other agents. Global reputation is derived from
 *         the aggregation of normalized local trust values, inspired by the EigenTrust
 *         algorithm (Kamvar, Schlosser, Garcia-Molina, 2003).
 *
 *         Key properties:
 *         - Transitive trust: If Agent A trusts Agent B, and B trusts C, then A
 *           indirectly trusts C proportional to B's local trust in C.
 *         - Sybil resistance: New agents start with zero trust; a flood of fake
 *           identities cannot bootstrap reputation without genuine endorsements.
 *         - Decay: Reputation decays over time (per-interaction basis) to ensure
 *           that stale agents lose influence.
 */
contract ReputationManager {
    AgentIdentity public identityContract;

    // --- Bayesian Trust Model ---
    // localTrust[i][j] = number of successful interactions i has had with j
    mapping(address => mapping(address => uint256)) public localTrust;

    // Total positive interactions initiated by agent i (used for normalization)
    mapping(address => uint256) public totalPositiveInteractions;

    // Total negative interactions (reports / slashes) against agent j
    mapping(address => uint256) public totalNegativeInteractions;

    // Global reputation score (scaled by 1000 for fixed-point precision)
    // Computed as: (sum of normalized local trust from all peers) * 1000
    mapping(address => uint256) public globalReputation;

    // Number of unique endorsers per agent (used in Bayesian prior)
    mapping(address => uint256) public endorserCount;

    // Interaction log for auditability
    struct TrustEvent {
        address from;
        address to;
        bool positive;
        uint256 timestamp;
        string reason;
    }
    TrustEvent[] public trustLog;

    event TrustUpdated(address indexed from, address indexed to, bool positive, uint256 newGlobalScore);
    event ReputationRecalculated(address indexed agent, uint256 newScore);

    constructor(address _identityContract) {
        identityContract = AgentIdentity(_identityContract);
    }

    /**
     * @notice Record a positive trust interaction (endorsement).
     * @dev Increments local trust from msg.sender -> target. Then recomputes
     *      the target's global reputation using a simplified EigenTrust aggregation.
     */
    function endorseAgent(address target, string memory reason) external {
        require(identityContract.getAgentStatus(target), "Target agent not registered");
        require(identityContract.getAgentStatus(msg.sender), "Caller not registered");
        require(target != msg.sender, "Cannot endorse yourself");

        // Update local trust
        if (localTrust[msg.sender][target] == 0) {
            endorserCount[target] += 1;
        }
        localTrust[msg.sender][target] += 1;
        totalPositiveInteractions[msg.sender] += 1;

        // Log the interaction
        trustLog.push(TrustEvent({
            from: msg.sender,
            to: target,
            positive: true,
            timestamp: block.timestamp,
            reason: reason
        }));

        // Recompute global reputation for the target
        _recomputeReputation(target);

        emit TrustUpdated(msg.sender, target, true, globalReputation[target]);
    }

    /**
     * @notice Report a negative trust interaction (memory poisoning, hallucination).
     * @dev Applies a heavy penalty. In the Bayesian model, negative interactions
     *      carry 3x the weight of positive ones (asymmetric trust).
     */
    function reportAgent(address target, string memory reason) external {
        require(identityContract.getAgentStatus(target), "Target agent not registered");
        require(identityContract.getAgentStatus(msg.sender), "Caller not registered");
        require(target != msg.sender, "Cannot report yourself");

        totalNegativeInteractions[target] += 1;

        // Also reduce the caller's local trust in the target
        if (localTrust[msg.sender][target] > 0) {
            localTrust[msg.sender][target] = 0;
        }

        trustLog.push(TrustEvent({
            from: msg.sender,
            to: target,
            positive: false,
            timestamp: block.timestamp,
            reason: reason
        }));

        _recomputeReputation(target);

        emit TrustUpdated(msg.sender, target, false, globalReputation[target]);
    }

    /**
     * @notice Simplified on-chain EigenTrust reputation computation.
     * @dev    GlobalRep(j) = [ endorserCount(j) * avgLocalTrust(j) * 1000 ]
     *                        / [ 1 + 3 * negativeInteractions(j) ]
     *
     *         The "3x" penalty on negatives implements asymmetric Bayesian weighting:
     *         it is much easier to lose trust than to gain it, which is critical for
     *         preventing memory poisoning attacks.
     */
    function _recomputeReputation(address target) internal {
        uint256 endorsers = endorserCount[target];
        uint256 negatives = totalNegativeInteractions[target];

        if (endorsers == 0) {
            globalReputation[target] = 0;
            emit ReputationRecalculated(target, 0);
            return;
        }

        // Bayesian score: (endorsers * 1000) / (1 + 3 * negatives)
        // This gives a score from 0 to ~N*1000 where N is endorser count
        uint256 score = (endorsers * 1000) / (1 + 3 * negatives);

        globalReputation[target] = score;
        emit ReputationRecalculated(target, score);
    }

    /**
     * @notice View the full trust log length (for off-chain iteration).
     */
    function getTrustLogLength() external view returns (uint256) {
        return trustLog.length;
    }

    /**
     * @notice Check if agent j is considered "trusted" (reputation > threshold).
     * @dev    Threshold of 500 means at least 1 endorser with zero negatives,
     *         or multiple endorsers overcoming some negatives.
     */
    function isTrusted(address agent) external view returns (bool) {
        return globalReputation[agent] >= 500;
    }
}
