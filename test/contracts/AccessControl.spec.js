import { expect } from 'chai';
import hre from 'hardhat';

import {
  DEFAULT_ADMIN_ROLE,
  MODERATOR_ROLE,
  PARAM_ADMIN_ROLE,
  PAUSER_ROLE,
  REGISTRAR_ROLE,
  SLASHER_ROLE,
  TREASURER_ROLE,
  WAD,
  field,
} from './helpers/constants.js';
import { loadFixture, memoriesFixture, time } from './helpers/fixtures.js';

const { ethers } = hre;

/** ERC-165 id of an interface: the XOR of every function selector it declares. */
function interfaceId(signatures) {
  let id = 0n;
  for (const sig of signatures) id ^= BigInt(ethers.dataSlice(ethers.id(sig), 0, 4));
  return ethers.toBeHex(id, 4);
}

const IACCESS_CONTROL_ID = interfaceId([
  'hasRole(bytes32,address)',
  'getRoleAdmin(bytes32)',
  'grantRole(bytes32,address)',
  'revokeRole(bytes32,address)',
  'renounceRole(bytes32,address)',
]);
const IACCESS_CONTROL_ENUMERABLE_ID = interfaceId([
  'getRoleMember(bytes32,uint256)',
  'getRoleMemberCount(bytes32)',
]);
const IERC165_ID = interfaceId(['supportsInterface(bytes4)']);

describe('Access control matrix', function () {
  let ctx;

  beforeEach(async function () {
    ctx = await loadFixture(memoriesFixture);
  });

  /* ====================================================================== */
  describe('every role-gated entrypoint refuses an unauthorised caller', function () {
    /** [contract key, method, required role, argument builder] */
    function tuples(c) {
      const { hashes, agentA, agentB, outsider, admin } = c;
      const someHash = hashes.m1;
      return [
        ['identity', 'pause', PAUSER_ROLE, []],
        ['identity', 'unpause', PAUSER_ROLE, []],
        ['identity', 'adminSetActive', REGISTRAR_ROLE, [agentA.address, false, field('x')]],

        ['ledger', 'pause', PAUSER_ROLE, []],
        ['ledger', 'unpause', PAUSER_ROLE, []],
        ['ledger', 'moderatorRevokeMemory', MODERATOR_ROLE, [someHash, field('x')]],

        ['reputation', 'pause', PAUSER_ROLE, []],
        ['reputation', 'unpause', PAUSER_ROLE, []],
        ['reputation', 'setHalfLife', PARAM_ADMIN_ROLE, [7 * 24 * 3600]],
        ['reputation', 'setPrior', PARAM_ADMIN_ROLE, [2n * WAD]],
        ['reputation', 'setTrustThreshold', PARAM_ADMIN_ROLE, [WAD / 2n]],
        ['reputation', 'setNegativeMultiplier', PARAM_ADMIN_ROLE, [2n * WAD]],
        ['reputation', 'setEndorserWeights', PARAM_ADMIN_ROLE, [WAD / 10n, WAD]],
        ['reputation', 'setCooldowns', PARAM_ADMIN_ROLE, [1, 1, 1]],
        ['reputation', 'setEndorsementStake', PARAM_ADMIN_ROLE, [1n]],
        ['reputation', 'setStakeLockPeriod', PARAM_ADMIN_ROLE, [1]],
        ['reputation', 'setTreasury', DEFAULT_ADMIN_ROLE, [outsider.address]],
        [
          'reputation',
          'slashEndorsement',
          SLASHER_ROLE,
          [agentB.address, agentA.address, field('x')],
        ],
        ['reputation', 'withdrawTreasury', TREASURER_ROLE, [admin.address, 1n]],

        ['access', 'pause', PAUSER_ROLE, []],
        ['access', 'unpause', PAUSER_ROLE, []],
        ['access', 'moderatorRevokeAccess', MODERATOR_ROLE, [someHash, agentB.address, field('x')]],
      ];
    }

    it('reverts AccessControlUnauthorizedAccount with the caller and the required role', async function () {
      const { outsider, errs } = ctx;
      for (const [key, method, role, args] of tuples(ctx)) {
        await expect(ctx[key].connect(outsider)[method](...args), `${key}.${method}`)
          .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
          .withArgs(outsider.address, role);
      }
    });

    it('covers all 22 role-gated entrypoints across the four contracts', function () {
      expect(tuples(ctx).length).to.equal(22);
    });
  });

  /* ====================================================================== */
  describe('the authorised caller succeeds', function () {
    it('PAUSER_ROLE can pause and unpause all four contracts', async function () {
      const { identity, ledger, reputation, access, pauser } = ctx;
      for (const c of [identity, ledger, reputation, access]) {
        await expect(c.connect(pauser).pause()).to.emit(c, 'Paused').withArgs(pauser.address);
        expect(await c.paused()).to.equal(true);
        await expect(c.connect(pauser).unpause()).to.emit(c, 'Unpaused').withArgs(pauser.address);
        expect(await c.paused()).to.equal(false);
      }
    });

    it('REGISTRAR_ROLE can suspend, MODERATOR_ROLE can take content down', async function () {
      const { identity, ledger, access, admin, moderator, agentA, agentB, hashes } = ctx;
      await identity.connect(admin).adminSetActive(agentA.address, false, field('x'));
      expect(await identity.isActive(agentA.address)).to.equal(false);
      await identity.connect(admin).adminSetActive(agentA.address, true, field('x'));

      await access.connect(agentA).grantAccess(hashes.m1, agentB.address, '0xdeadbeef', 0);
      await access.connect(moderator).moderatorRevokeAccess(hashes.m1, agentB.address, field('x'));
      expect(await access.canAccess(hashes.m1, agentB.address)).to.equal(false);

      await ledger.connect(moderator).moderatorRevokeMemory(hashes.m1, field('x'));
      expect((await ledger.getMemory(hashes.m1)).revoked).to.equal(true);
    });

    it('PARAM_ADMIN, SLASHER and TREASURER can each exercise their own surface', async function () {
      const { reputation, paramAdmin, slasher, admin, agentA, agentB } = ctx;
      const stake = ethers.parseEther('0.05');
      await reputation.connect(paramAdmin).setEndorsementStake(stake);
      expect(await reputation.endorsementStakeWei()).to.equal(stake);

      await reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: stake });
      await reputation
        .connect(slasher)
        .slashEndorsement(agentB.address, agentA.address, field('x'));
      expect(await reputation.treasuryBalance()).to.equal(stake);

      await reputation.connect(admin).withdrawTreasury(admin.address, stake);
      expect(await reputation.treasuryBalance()).to.equal(0n);
    });
  });

  /* ====================================================================== */
  describe('role administration', function () {
    it('DEFAULT_ADMIN_ROLE can grant and revoke every role on every contract, with immediate effect', async function () {
      const { identity, ledger, reputation, access, admin, outsider, errs } = ctx;
      const grid = [
        [identity, [PAUSER_ROLE, REGISTRAR_ROLE]],
        [ledger, [PAUSER_ROLE, MODERATOR_ROLE]],
        [reputation, [PAUSER_ROLE, PARAM_ADMIN_ROLE, SLASHER_ROLE, TREASURER_ROLE]],
        [access, [PAUSER_ROLE, MODERATOR_ROLE]],
      ];

      for (const [c, roles] of grid) {
        for (const role of roles) {
          expect(await c.hasRole(role, outsider.address)).to.equal(false);
          await expect(c.connect(admin).grantRole(role, outsider.address))
            .to.emit(c, 'RoleGranted')
            .withArgs(role, outsider.address, admin.address);
          expect(await c.hasRole(role, outsider.address)).to.equal(true);
          await expect(c.connect(admin).revokeRole(role, outsider.address))
            .to.emit(c, 'RoleRevoked')
            .withArgs(role, outsider.address, admin.address);
          expect(await c.hasRole(role, outsider.address)).to.equal(false);
        }
      }

      // Immediate effect, both directions.
      await identity.connect(admin).grantRole(PAUSER_ROLE, outsider.address);
      await identity.connect(outsider).pause();
      await identity.connect(admin).revokeRole(PAUSER_ROLE, outsider.address);
      await expect(identity.connect(outsider).unpause())
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(outsider.address, PAUSER_ROLE);
    });

    it('a non-admin cannot grant a role', async function () {
      const { identity, pauser, outsider, errs } = ctx;
      await expect(identity.connect(pauser).grantRole(PAUSER_ROLE, outsider.address))
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(pauser.address, DEFAULT_ADMIN_ROLE);
    });

    it("renounceRole only accepts the caller's own confirmation", async function () {
      const { identity, admin, pauser, errs } = ctx;
      await expect(
        identity.connect(admin).renounceRole(PAUSER_ROLE, pauser.address),
      ).to.be.revertedWithCustomError(errs, 'AccessControlBadConfirmation');
      await identity.connect(pauser).renounceRole(PAUSER_ROLE, pauser.address);
      expect(await identity.hasRole(PAUSER_ROLE, pauser.address)).to.equal(false);
    });

    it('enumerates role members and keeps the enumeration in sync', async function () {
      const { reputation, admin, outsider } = ctx;
      const before = await reputation.getRoleMemberCount(PARAM_ADMIN_ROLE);
      await reputation.connect(admin).grantRole(PARAM_ADMIN_ROLE, outsider.address);
      expect(await reputation.getRoleMemberCount(PARAM_ADMIN_ROLE)).to.equal(before + 1n);

      const members = [];
      for (let i = 0n; i < (await reputation.getRoleMemberCount(PARAM_ADMIN_ROLE)); i++) {
        members.push(await reputation.getRoleMember(PARAM_ADMIN_ROLE, i));
      }
      expect(members).to.include(outsider.address);

      await reputation.connect(admin).revokeRole(PARAM_ADMIN_ROLE, outsider.address);
      expect(await reputation.getRoleMemberCount(PARAM_ADMIN_ROLE)).to.equal(before);
    });

    it('IRREVERSIBLE: renouncing DEFAULT_ADMIN_ROLE leaves the contract with no administrator', async function () {
      const { access, admin, outsider, errs } = ctx;
      // This is a one-way door in production - once the last DEFAULT_ADMIN_ROLE holder renounces,
      // no role on the contract can ever be granted or revoked again. It is asserted here precisely
      // so nobody discovers that property by accident on mainnet.
      expect(await access.getRoleMemberCount(DEFAULT_ADMIN_ROLE)).to.equal(1n);
      await access.connect(admin).renounceRole(DEFAULT_ADMIN_ROLE, admin.address);
      expect(await access.getRoleMemberCount(DEFAULT_ADMIN_ROLE)).to.equal(0n);
      await expect(access.connect(admin).grantRole(MODERATOR_ROLE, outsider.address))
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(admin.address, DEFAULT_ADMIN_ROLE);
    });

    it('advertises ERC-165, IAccessControl and IAccessControlEnumerable on all four contracts', async function () {
      const { identity, ledger, reputation, access } = ctx;
      for (const c of [identity, ledger, reputation, access]) {
        expect(await c.supportsInterface(IERC165_ID)).to.equal(true);
        expect(await c.supportsInterface(IACCESS_CONTROL_ID)).to.equal(true);
        expect(await c.supportsInterface(IACCESS_CONTROL_ENUMERABLE_ID)).to.equal(true);
        expect(await c.supportsInterface('0xffffffff')).to.equal(false);
      }
      void time;
    });
  });
});
