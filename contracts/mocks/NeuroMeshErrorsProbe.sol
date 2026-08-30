// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title NeuroMeshErrorsProbe
 * @author NeuroMesh Protocol
 * @notice An ABI-only contract that re-declares every custom error the protocol can revert with,
 *         so the test suite has one unambiguous interface to resolve error names against. Test-only.
 * @dev WHY THIS EXISTS. `AgentIdentity`, `MemoryLedger` and `MemoryAccessControl` all inherit
 *      OpenZeppelin's `EIP712`, which pulls in `ShortStrings.StringTooLong(string)`. Their ABIs
 *      therefore contain TWO errors named `StringTooLong` with different signatures, and
 *      `ethers.Interface.getError("StringTooLong")` throws `ambiguous error description`, which in
 *      turn breaks `expect(...).to.be.revertedWithCustomError(ledger, "StringTooLong")`.
 *
 *      `revertedWithCustomError` only ever uses the supplied contract's INTERFACE to resolve the
 *      name to a 4-byte selector and to decode the arguments - it does not require the error to have
 *      originated from that address. Pointing every assertion at this probe therefore keeps the
 *      selectors and the decoded `.withArgs` values exactly right while sidestepping the collision,
 *      and keeps the whole suite consistent instead of special-casing one error name.
 *
 *      Every signature below MUST stay byte-identical to its declaration in
 *      `libraries/NeuroMeshErrors.sol` (or, for the last group, in OpenZeppelin), because the
 *      4-byte selector is derived from it. The OpenZeppelin errors are re-declared rather than
 *      inherited so that this file pulls in no `EIP712`/`ShortStrings` dependency and stays
 *      collision-free.
 *
 *      NOT FOR PRODUCTION.
 */
contract NeuroMeshErrorsProbe {
    /*//////////////////////////////////////////////////////////////
                        GENERIC (NeuroMeshErrors.sol)
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error EmptyField(bytes32 field);
    error StringTooLong(bytes32 field, uint256 length, uint256 maxLength);
    error StringTooShort(bytes32 field, uint256 length, uint256 minLength);
    error InvalidParameter(bytes32 name, uint256 value);
    error InvalidPageSize(uint256 limit, uint256 maxLimit);
    error BatchTooLarge(uint256 size, uint256 maxSize);
    error ArrayLengthMismatch(uint256 lengthA, uint256 lengthB);
    error NotAContract(address target);

    /*//////////////////////////////////////////////////////////////
                                IDENTITY
    //////////////////////////////////////////////////////////////*/

    error AlreadyRegistered(address account);
    error NotRegistered(address account);
    error AgentInactive(address account);
    error AgentAlreadyActive(address account);

    /*//////////////////////////////////////////////////////////////
                               SIGNATURES
    //////////////////////////////////////////////////////////////*/

    error InvalidSignature(address expectedSigner);
    error SignatureExpired(uint256 deadline, uint256 blockTimestamp);
    error DeadlineTooFar(uint256 deadline, uint256 maxDeadline);

    /*//////////////////////////////////////////////////////////////
                              MEMORY LEDGER
    //////////////////////////////////////////////////////////////*/

    error MemoryAlreadyExists(bytes32 cidHash);
    error MemoryNotFound(bytes32 cidHash);
    error MemoryAlreadyRevoked(bytes32 cidHash);
    error NotMemoryOwner(bytes32 cidHash, address caller, address owner);
    error ParentNotFound(bytes32 prevCidHash);
    error ParentNotOwnedByAgent(bytes32 prevCidHash, address agent, address parentOwner);
    error ParentRevoked(bytes32 prevCidHash);
    error SelfReferentialParent(bytes32 cidHash);
    error InvalidEmbeddingDim(uint256 dim, uint256 minDim, uint256 maxDim);

    /*//////////////////////////////////////////////////////////////
                               REPUTATION
    //////////////////////////////////////////////////////////////*/

    error SelfAction(address account);
    error AlreadyEndorsed(address from, address to);
    error NotEndorsed(address from, address to);
    error AlreadyReported(address from, address to);
    error NotReported(address from, address to);
    error CooldownActive(uint256 availableAt, uint256 blockTimestamp);
    error InvalidStake(uint256 required, uint256 provided);
    error UnclaimedStake(address from, address to);
    error StakeLocked(uint256 unlockAt, uint256 blockTimestamp);
    error NothingToClaim(address from, address to);
    error StakeAlreadySlashed(address from, address to);
    error EtherTransferFailed(address to, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                          ACCESS / DELEGATION
    //////////////////////////////////////////////////////////////*/

    error AccessAlreadyGranted(bytes32 cidHash, address grantee);
    error AccessNotGranted(bytes32 cidHash, address grantee);
    error GrantExpired(bytes32 cidHash, address grantee, uint64 expiresAt);
    error InvalidExpiry(uint64 expiresAt, uint256 blockTimestamp);

    /*//////////////////////////////////////////////////////////////
                  OPENZEPPELIN v5 (re-declared verbatim)
    //////////////////////////////////////////////////////////////*/

    error EnforcedPause();
    error ExpectedPause();
    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);
    error AccessControlBadConfirmation();
    error ReentrancyGuardReentrantCall();
    error InvalidAccountNonce(address account, uint256 currentNonce);
}
