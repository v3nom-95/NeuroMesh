// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {InvalidPageSize} from "./NeuroMeshErrors.sol";

/**
 * @title Pagination
 * @author NeuroMesh Protocol
 * @notice Uniform offset/limit semantics for every paginated getter in the protocol.
 * @dev No getter in NeuroMesh ever returns an unbounded array: an agent with 100k memories must be
 *      readable in bounded pages, and a single caller must not be able to make a view function
 *      un-callable by growing an array. Every paginated getter therefore funnels through `slice`,
 *      allocates exactly `count` elements, and returns `(page, total)` so a client learns the full
 *      collection size from the same call.
 *
 *      Ordering convention: insertion order (oldest first) everywhere, with exactly one documented
 *      exception - `ReputationManager.getTrustEvents`, which is newest first because it backs a
 *      recent-activity feed.
 */
library Pagination {
    /**
     * @notice Resolves an (offset, limit) request against a collection of size `total`.
     * @dev Past-the-end offsets return an EMPTY page rather than reverting. That is deliberate: a
     *      client paging through a collection that is being appended to concurrently can loop until
     *      it receives an empty page without ever hitting a bounds race.
     * @param total    Number of elements in the collection.
     * @param offset   Index of the first element to return.
     * @param limit    Maximum number of elements to return; must be in (0, `maxLimit`].
     * @param maxLimit Protocol page cap, normally `Limits.MAX_PAGE_SIZE`.
     * @return start Index to begin reading at.
     * @return count Number of elements the caller should allocate and fill.
     */
    function slice(
        uint256 total,
        uint256 offset,
        uint256 limit,
        uint256 maxLimit
    ) internal pure returns (uint256 start, uint256 count) {
        if (limit == 0 || limit > maxLimit) revert InvalidPageSize(limit, maxLimit);
        if (offset >= total) return (0, 0);
        start = offset;
        count = Math.min(limit, total - offset);
    }
}
