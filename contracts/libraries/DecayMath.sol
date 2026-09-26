// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {InvalidParameter} from "./NeuroMeshErrors.sol";

/**
 * @title DecayMath
 * @author NeuroMesh Protocol
 * @notice Gas-cheap exponential time decay in WAD fixed point, with no external math dependency
 *         beyond OpenZeppelin's `Math.mulDiv`.
 * @dev The reputation model needs `value * 2^(-elapsed / halfLife)`. A full fixed-point `exp` costs
 *      hundreds of gas and a large chunk of bytecode for precision nobody can observe in a trust
 *      score. Instead this library splits the exponent into
 *
 *          elapsed / halfLife  =  wholeHalves  +  fraction
 *
 *      applies `wholeHalves` as a right shift (exact, one opcode), and quantises `fraction` into one
 *      of sixteen buckets looked up from a precomputed table of `2^(-k/16)`.
 *
 *      Properties every consumer may rely on:
 *        - Monotone non-increasing in `elapsed` (later never decays less than earlier).
 *        - The WAD multiplication rounds down, so aggregate decayed mass never exceeds the sum of
 *          its parts. NOTE this is not the same as the FACTOR being a lower bound - see below.
 *        - Maximum relative error against true `2^-x` is +4.43%, i.e. `2^(1/16) - 1`, and the error
 *          is one-sided UPWARD: flooring the exponent to a 1/16 bucket returns a LARGER factor than
 *          the true curve, so mass decays slightly SLOWER than the nominal half-life and scores are
 *          biased marginally high. Quoting 0.15% here was wrong by a factor of ~30. Bucket
 *          interpolation would close the gap; tracked as NM-12 in docs/V2.1-HARDENING-PLAN.md.
 *        - Pure: no storage, no state, no external calls, no loops.
 */
library DecayMath {
    /// @notice Fixed-point scale: 1.0 == 1e18.
    uint256 internal constant WAD = 1e18;

    /**
     * @notice Returns `2^(-k/16)` in WAD for `k` in [0, 15].
     * @dev Table entries are `round(1e18 * 2^(-k/16))`:
     *
     *      | k  | 2^(-k/16)            | WAD value             |
     *      |----|----------------------|-----------------------|
     *      |  0 | 1.000000000000000000 | 1000000000000000000   |
     *      |  1 | 0.957603280698574000 |  957603280698574000   |
     *      |  2 | 0.917004043204671000 |  917004043204671000   |
     *      |  3 | 0.878126080186649000 |  878126080186649000   |
     *      |  4 | 0.840896415253715000 |  840896415253715000   |
     *      |  5 | 0.805245165974627000 |  805245165974627000   |
     *      |  6 | 0.771105412703970000 |  771105412703970000   |
     *      |  7 | 0.738413072432719000 |  738413072432719000   |
     *      |  8 | 0.707106781186548000 |  707106781186548000   |
     *      |  9 | 0.677127773468660000 |  677127773468660000   |
     *      | 10 | 0.648419777325504000 |  648419777325504000   |
     *      | 11 | 0.620928906036742000 |  620928906036742000   |
     *      | 12 | 0.594603557501361000 |  594603557501361000   |
     *      | 13 | 0.569394338602045000 |  569394338602045000   |
     *      | 14 | 0.545253866332461000 |  545253866332461000   |
     *      | 15 | 0.522136891213916000 |  522136891213916000   |
     *
     *      The table is an in-function fixed-size array literal, which Solidity permits, unlike a
     *      file- or contract-level constant array.
     * @param k Bucket index in [0, 15].
     * @return The WAD-scaled factor.
     */
    function pow2NegSixteenths(uint256 k) internal pure returns (uint256) {
        if (k > 15) revert InvalidParameter(bytes32("pow2Idx"), k);
        uint256[16] memory t = [
            uint256(1000000000000000000),
            957603280698574000,
            917004043204671000,
            878126080186649000,
            840896415253715000,
            805245165974627000,
            771105412703970000,
            738413072432719000,
            707106781186548000,
            677127773468660000,
            648419777325504000,
            620928906036742000,
            594603557501361000,
            569394338602045000,
            545253866332461000,
            522136891213916000
        ];
        return t[k];
    }

    /**
     * @notice Computes the WAD decay factor `2^(-elapsed / halfLife)`, quantised to 1/16 half-life.
     * @dev Piecewise constant within each 1/16-half-life bucket and monotone non-increasing across
     *      buckets. A `halfLife` of zero disables decay entirely (factor 1.0), which is the documented
     *      escape hatch for deployments that want a purely cumulative model. Beyond 64 half-lives the
     *      factor is reported as exactly zero: `WAD >> 64` is already zero, and returning early keeps
     *      the shift well-defined for arbitrarily large elapsed times.
     * @param elapsed  Seconds since the value was last settled.
     * @param halfLife Half-life in seconds; zero disables decay.
     * @return factorWad The decay factor in WAD, in [0, 1e18].
     */
    function decayFactor(uint256 elapsed, uint256 halfLife) internal pure returns (uint256 factorWad) {
        if (halfLife == 0 || elapsed == 0) return WAD;

        uint256 halves = elapsed / halfLife;
        if (halves >= 64) return 0;

        uint256 f = WAD >> halves;
        uint256 idx = ((elapsed % halfLife) * 16) / halfLife;
        return Math.mulDiv(f, pow2NegSixteenths(idx), WAD);
    }

    /**
     * @notice Applies `decayFactor(elapsed, halfLife)` to a WAD-scaled value.
     * @dev Rounds down, by construction of `Math.mulDiv`.
     * @param valueWad WAD-scaled value to decay.
     * @param elapsed  Seconds since the value was last settled.
     * @param halfLife Half-life in seconds; zero disables decay.
     * @return The decayed WAD-scaled value.
     */
    function applyDecay(uint256 valueWad, uint256 elapsed, uint256 halfLife) internal pure returns (uint256) {
        return Math.mulDiv(valueWad, decayFactor(elapsed, halfLife), WAD);
    }
}
