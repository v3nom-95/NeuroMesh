// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DecayMath} from "../libraries/DecayMath.sol";

/**
 * @title DecayMathHarness
 * @author NeuroMesh Protocol
 * @notice Thin external wrapper around the internal {DecayMath} library. Test-only.
 * @dev {DecayMath} is a pure `internal` library, so it is inlined into its consumers and has no
 *      callable ABI of its own. The decay curve is the single most load-bearing piece of arithmetic
 *      in the trust model, so the suite tests it directly - monotonicity, the exact half-life
 *      anchors, the saturation point and the disable-decay escape hatch - rather than only inferring
 *      it from ReputationManager scores.
 *
 *      NOT FOR PRODUCTION.
 */
contract DecayMathHarness {
    /// @notice Exposes {DecayMath.decayFactor}.
    function decayFactor(uint256 elapsed, uint256 halfLife) external pure returns (uint256) {
        return DecayMath.decayFactor(elapsed, halfLife);
    }

    /// @notice Exposes {DecayMath.applyDecay}.
    function applyDecay(uint256 valueWad, uint256 elapsed, uint256 halfLife) external pure returns (uint256) {
        return DecayMath.applyDecay(valueWad, elapsed, halfLife);
    }

    /// @notice Exposes {DecayMath.pow2NegSixteenths}, including its out-of-range revert.
    function pow2NegSixteenths(uint256 k) external pure returns (uint256) {
        return DecayMath.pow2NegSixteenths(k);
    }
}
