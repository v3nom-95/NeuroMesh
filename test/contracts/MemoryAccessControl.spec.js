import { expect } from 'chai';
import hre from 'hardhat';

import {
  ACCESS_DOMAIN_NAME,
  ACCESS_GRANT_TYPE_STRING,
  DOMAIN_VERSION,
  MAX_BATCH_SIZE,
  MAX_PAGE_SIZE,
  MAX_WRAPPED_KEY_BYTES,
  MODERATOR_ROLE,
  bytesOfLength,
  deadline,
  field,
  validPubKey,
} from './helpers/constants.js';
import { loadFixture, memoriesFixture, time } from './helpers/fixtures.js';
import { signAccessGrant } from './helpers/eip712.js';

const { ethers } = hre;

const KEY = bytesOfLength(200, 'wrapped-cek');
const REASON = ethers.encodeBytes32String('rotated');

describe('MemoryAccessControl', function () {
  let ctx;

  beforeEach(async function () {
    ctx = await loadFixture(memoriesFixture);
  });

  /* ====================================================================== */
  describe('deployment', function () {
    it('validates and freezes both dependencies', async function () {
      const Factory = await ethers.getContractFactory('MemoryAccessControl');
      const { admin, ledgerAddr, identityAddr, outsider, access, errs } = ctx;

      await expect(
        Factory.deploy(admin.address, ethers.ZeroAddress, identityAddr),
      ).to.be.revertedWithCustomError(errs, 'ZeroAddress');
      await expect(Factory.deploy(admin.address, outsider.address, identityAddr))
        .to.be.revertedWithCustomError(errs, 'NotAContract')
        .withArgs(outsider.address);
      await expect(
        Factory.deploy(admin.address, ledgerAddr, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(errs, 'ZeroAddress');
      await expect(Factory.deploy(admin.address, ledgerAddr, outsider.address))
        .to.be.revertedWithCustomError(errs, 'NotAContract')
        .withArgs(outsider.address);

      expect(await access.ledger()).to.equal(ledgerAddr);
      expect(await access.identity()).to.equal(identityAddr);
      expect(await access.ACCESS_GRANT_TYPEHASH()).to.equal(ethers.id(ACCESS_GRANT_TYPE_STRING));
      const d = await access.eip712Domain();
      expect(d.name).to.equal(ACCESS_DOMAIN_NAME);
      expect(d.version).to.equal(DOMAIN_VERSION);
    });
  });

  /* ====================================================================== */
  describe('grantAccess', function () {
    it("publishes an envelope bound to the grantee's current key version", async function () {
      const { access, identity, hashes, agentA, agentB, agentC } = ctx;
      const [, granteeKeyVersion] = await identity.getPublicKey(agentB.address);

      await expect(access.connect(agentA).grantAccess(hashes.m3, agentB.address, KEY, 0))
        .to.emit(access, 'AccessGranted')
        .withArgs(hashes.m3, agentA.address, agentB.address, 0, granteeKeyVersion, KEY);

      expect(await access.canAccess(hashes.m3, agentB.address)).to.equal(true);
      // The owner never needs a grant of its own.
      expect(await access.canAccess(hashes.m3, agentA.address)).to.equal(true);
      // A third party has nothing.
      expect(await access.canAccess(hashes.m3, agentC.address)).to.equal(false);

      const [key, version] = await access.getWrappedKey(hashes.m3, agentB.address);
      expect(key).to.equal(KEY);
      expect(version).to.equal(granteeKeyVersion);

      const g = await access.getGrant(hashes.m3, agentB.address);
      expect(g.exists).to.equal(true);
      expect(g.revokedAt).to.equal(0n);
      expect(g.expiresAt).to.equal(0n);
      expect(g.grantedAt).to.equal(await time.latest());
    });

    it('rejects a non-owner, an unknown record and a revoked record', async function () {
      const { access, ledger, hashes, agentA, agentB, agentC, errs } = ctx;
      await expect(access.connect(agentB).grantAccess(hashes.m3, agentC.address, KEY, 0))
        .to.be.revertedWithCustomError(errs, 'NotMemoryOwner')
        .withArgs(hashes.m3, agentB.address, agentA.address);

      const ghost = ethers.id('ghost');
      await expect(access.connect(agentA).grantAccess(ghost, agentB.address, KEY, 0))
        .to.be.revertedWithCustomError(errs, 'MemoryNotFound')
        .withArgs(ghost);

      await ledger.connect(agentA).revokeMemory(hashes.m3, REASON);
      await expect(access.connect(agentA).grantAccess(hashes.m3, agentB.address, KEY, 0))
        .to.be.revertedWithCustomError(errs, 'MemoryAlreadyRevoked')
        .withArgs(hashes.m3);
    });

    it('rejects self-grants, inactive grantees, bad expiries and bad key lengths', async function () {
      const { access, identity, hashes, agentA, agentB, outsider, errs } = ctx;

      await expect(access.connect(agentA).grantAccess(hashes.m3, agentA.address, KEY, 0))
        .to.be.revertedWithCustomError(errs, 'SelfAction')
        .withArgs(agentA.address);

      await expect(access.connect(agentA).grantAccess(hashes.m3, outsider.address, KEY, 0))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(outsider.address);

      await identity.connect(agentB).deactivate();
      await expect(access.connect(agentA).grantAccess(hashes.m3, agentB.address, KEY, 0))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(agentB.address);
      await identity.connect(agentB).reactivate();

      const past = (await time.latest()) - 1;
      await expect(access.connect(agentA).grantAccess(hashes.m3, agentB.address, KEY, past))
        .to.be.revertedWithCustomError(errs, 'InvalidExpiry')
        .withArgs(past, (await time.latest()) + 1);

      await expect(access.connect(agentA).grantAccess(hashes.m3, agentB.address, '0x', 0))
        .to.be.revertedWithCustomError(errs, 'StringTooShort')
        .withArgs(field('wrappedKey'), 0, 1);

      await expect(
        access.connect(agentA).grantAccess(hashes.m3, agentB.address, bytesOfLength(513), 0),
      )
        .to.be.revertedWithCustomError(errs, 'StringTooLong')
        .withArgs(field('wrappedKey'), 513, MAX_WRAPPED_KEY_BYTES);
    });

    it('rejects a duplicate live grant and is blocked while paused', async function () {
      const { access, pauser, hashes, agentA, agentB, agentC, errs } = ctx;
      await access.connect(agentA).grantAccess(hashes.m3, agentB.address, KEY, 0);
      await expect(access.connect(agentA).grantAccess(hashes.m3, agentB.address, KEY, 0))
        .to.be.revertedWithCustomError(errs, 'AccessAlreadyGranted')
        .withArgs(hashes.m3, agentB.address);

      await access.connect(pauser).pause();
      await expect(
        access.connect(agentA).grantAccess(hashes.m3, agentC.address, KEY, 0),
      ).to.be.revertedWithCustomError(errs, 'EnforcedPause');
    });
  });

  /* ====================================================================== */
  describe('expiry', function () {
    it('lapses on its own, with no transaction, and stays distinct from revocation', async function () {
      const { access, hashes, agentA, agentB } = ctx;
      const expiresAt = (await time.latest()) + 3600;
      await access.connect(agentA).grantAccess(hashes.m3, agentB.address, KEY, expiresAt);
      expect(await access.canAccess(hashes.m3, agentB.address)).to.equal(true);

      await time.increase(3601);
      expect(await access.canAccess(hashes.m3, agentB.address)).to.equal(false);
      // Expiry and revocation are different states: the grant record is still live and un-revoked.
      const g = await access.getGrant(hashes.m3, agentB.address);
      expect(g.revokedAt).to.equal(0n);
      expect(g.exists).to.equal(true);
    });
  });

  /* ====================================================================== */
  describe('revokeAccess', function () {
    beforeEach(async function () {
      await ctx.access.connect(ctx.agentA).grantAccess(ctx.hashes.m3, ctx.agentB.address, KEY, 0);
    });

    it('withdraws authorisation and deletes the stored envelope', async function () {
      const { access, hashes, agentA, agentB, errs } = ctx;
      await expect(access.connect(agentA).revokeAccess(hashes.m3, agentB.address, REASON))
        .to.emit(access, 'AccessRevoked')
        .withArgs(hashes.m3, agentA.address, agentB.address, agentA.address, REASON);

      expect(await access.canAccess(hashes.m3, agentB.address)).to.equal(false);
      // The ciphertext is removed from state, not merely flagged.
      await expect(access.getWrappedKey(hashes.m3, agentB.address))
        .to.be.revertedWithCustomError(errs, 'AccessNotGranted')
        .withArgs(hashes.m3, agentB.address);
      expect((await access.getGrant(hashes.m3, agentB.address)).revokedAt).to.equal(
        await time.latest(),
      );
    });

    it('rejects revoking a non-grant and a non-owner caller', async function () {
      const { access, hashes, agentA, agentB, agentC, errs } = ctx;
      await expect(access.connect(agentA).revokeAccess(hashes.m3, agentC.address, REASON))
        .to.be.revertedWithCustomError(errs, 'AccessNotGranted')
        .withArgs(hashes.m3, agentC.address);
      await expect(access.connect(agentB).revokeAccess(hashes.m3, agentB.address, REASON))
        .to.be.revertedWithCustomError(errs, 'NotMemoryOwner')
        .withArgs(hashes.m3, agentB.address, agentA.address);

      await access.connect(agentA).revokeAccess(hashes.m3, agentB.address, REASON);
      await expect(access.connect(agentA).revokeAccess(hashes.m3, agentB.address, REASON))
        .to.be.revertedWithCustomError(errs, 'AccessNotGranted')
        .withArgs(hashes.m3, agentB.address);
    });

    it('moderatorRevokeAccess is role-gated and survives a pause', async function () {
      const { access, moderator, pauser, outsider, hashes, agentA, agentB, errs } = ctx;
      await expect(
        access.connect(outsider).moderatorRevokeAccess(hashes.m3, agentB.address, REASON),
      )
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(outsider.address, MODERATOR_ROLE);

      await access.connect(pauser).pause();
      await expect(
        access
          .connect(moderator)
          .moderatorRevokeAccess(hashes.m3, agentB.address, field('illegal')),
      )
        .to.emit(access, 'AccessRevoked')
        .withArgs(hashes.m3, agentA.address, agentB.address, moderator.address, field('illegal'));
      expect(await access.canAccess(hashes.m3, agentB.address)).to.equal(false);
    });

    it('REGRESSION: re-granting after revocation does not duplicate the grantee index', async function () {
      const { access, hashes, agentA, agentB } = ctx;
      await access.connect(agentA).revokeAccess(hashes.m3, agentB.address, REASON);
      await access
        .connect(agentA)
        .grantAccess(hashes.m3, agentB.address, bytesOfLength(64, 'second'), 0);

      const [grantees, total] = await access.getGrantees(hashes.m3, 0, 10);
      expect(grantees).to.deep.equal([agentB.address]);
      expect(total).to.equal(1n);
      const [forB, totalB] = await access.getGrantsFor(agentB.address, 0, 10);
      expect(forB).to.deep.equal([hashes.m3]);
      expect(totalB).to.equal(1n);
      expect(await access.canAccess(hashes.m3, agentB.address)).to.equal(true);
    });

    it('is blocked while paused on the owner path', async function () {
      const { access, pauser, hashes, agentA, agentB, errs } = ctx;
      await access.connect(pauser).pause();
      await expect(
        access.connect(agentA).revokeAccess(hashes.m3, agentB.address, REASON),
      ).to.be.revertedWithCustomError(errs, 'EnforcedPause');
    });
  });

  /* ====================================================================== */
  describe('grantAccessBatch', function () {
    it('grants to many recipients in one transaction', async function () {
      const { access, hashes, agentA, agentB, agentC, registeredExtras } = ctx;
      const grantees = [agentB.address, agentC.address, registeredExtras[0].address];
      const keys = grantees.map((_, i) => bytesOfLength(48, `batch-${i}`));

      await access.connect(agentA).grantAccessBatch(hashes.m3, grantees, keys, 0);
      for (const g of grantees) expect(await access.canAccess(hashes.m3, g)).to.equal(true);
      expect((await access.getGrantees(hashes.m3, 0, 10))[1]).to.equal(3n);
    });

    it('rejects mismatched arrays and oversized batches', async function () {
      const { access, hashes, agentA, agentB, agentC, registeredExtras, errs } = ctx;
      await expect(
        access
          .connect(agentA)
          .grantAccessBatch(
            hashes.m3,
            [agentB.address, agentC.address, registeredExtras[0].address],
            [KEY, KEY],
            0,
          ),
      )
        .to.be.revertedWithCustomError(errs, 'ArrayLengthMismatch')
        .withArgs(3, 2);

      const many = new Array(MAX_BATCH_SIZE + 1).fill(agentB.address);
      await expect(
        access.connect(agentA).grantAccessBatch(hashes.m3, many, new Array(51).fill(KEY), 0),
      )
        .to.be.revertedWithCustomError(errs, 'BatchTooLarge')
        .withArgs(51, MAX_BATCH_SIZE);
    });

    it('is all-or-nothing: one bad grantee reverts the whole batch', async function () {
      const { access, hashes, agentA, agentB, outsider, errs } = ctx;
      await expect(
        access
          .connect(agentA)
          .grantAccessBatch(hashes.m3, [agentB.address, outsider.address], [KEY, KEY], 0),
      )
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(outsider.address);
      // No partial state: the first, perfectly valid grantee got nothing either.
      expect(await access.canAccess(hashes.m3, agentB.address)).to.equal(false);
      expect((await access.getGrantees(hashes.m3, 0, 10))[1]).to.equal(0n);
    });
  });

  /* ====================================================================== */
  describe('grantAccessFor (EIP-712)', function () {
    it("lets a relayer publish the owner's authorised envelope", async function () {
      const { access, hashes, agentA, agentB, relayer } = ctx;
      const dl = await deadline();
      const { signature } = await signAccessGrant(agentA, access, {
        owner: agentA.address,
        cidHash: hashes.m3,
        grantee: agentB.address,
        wrappedKey: KEY,
        expiresAt: 0,
        deadline: dl,
      });

      expect(await access.nonces(agentA.address)).to.equal(0n);
      await access
        .connect(relayer)
        .grantAccessFor(agentA.address, hashes.m3, agentB.address, KEY, 0, dl, signature);
      expect(await access.canAccess(hashes.m3, agentB.address)).to.equal(true);
      expect(await access.nonces(agentA.address)).to.equal(1n);
    });

    it('binds the envelope, the grantee and the expiry into the digest', async function () {
      const { access, hashes, agentA, agentB, agentC, relayer, errs } = ctx;
      const dl = await deadline();
      const expiresAt = (await time.latest()) + 7200;
      const { signature } = await signAccessGrant(agentA, access, {
        owner: agentA.address,
        cidHash: hashes.m3,
        grantee: agentB.address,
        wrappedKey: KEY,
        expiresAt,
        deadline: dl,
      });

      const other = bytesOfLength(200, 'attacker');
      await expect(
        access
          .connect(relayer)
          .grantAccessFor(
            agentA.address,
            hashes.m3,
            agentB.address,
            other,
            expiresAt,
            dl,
            signature,
          ),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');
      await expect(
        access
          .connect(relayer)
          .grantAccessFor(agentA.address, hashes.m3, agentC.address, KEY, expiresAt, dl, signature),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');
      await expect(
        access
          .connect(relayer)
          .grantAccessFor(
            agentA.address,
            hashes.m3,
            agentB.address,
            KEY,
            expiresAt + 1,
            dl,
            signature,
          ),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');
      await expect(
        access
          .connect(relayer)
          .grantAccessFor(agentA.address, hashes.m2, agentB.address, KEY, expiresAt, dl, signature),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');

      // A rejected authorisation must not have burned the nonce.
      expect(await access.nonces(agentA.address)).to.equal(0n);
    });

    it('rejects a replay and an expired deadline', async function () {
      const { access, hashes, agentA, agentB, relayer, errs } = ctx;
      const dl = await deadline();
      const { signature } = await signAccessGrant(agentA, access, {
        owner: agentA.address,
        cidHash: hashes.m3,
        grantee: agentB.address,
        wrappedKey: KEY,
        expiresAt: 0,
        deadline: dl,
      });
      await access
        .connect(relayer)
        .grantAccessFor(agentA.address, hashes.m3, agentB.address, KEY, 0, dl, signature);
      await expect(
        access
          .connect(relayer)
          .grantAccessFor(agentA.address, hashes.m3, agentB.address, KEY, 0, dl, signature),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');

      const dl2 = await deadline(1800);
      const { signature: sig2 } = await signAccessGrant(agentA, access, {
        owner: agentA.address,
        cidHash: hashes.m2,
        grantee: agentB.address,
        wrappedKey: KEY,
        expiresAt: 0,
        deadline: dl2,
      });
      await time.increase(3600);
      await expect(
        access
          .connect(relayer)
          .grantAccessFor(agentA.address, hashes.m2, agentB.address, KEY, 0, dl2, sig2),
      ).to.be.revertedWithCustomError(errs, 'SignatureExpired');
    });

    it('rejects the zero owner', async function () {
      const { access, hashes, agentB, relayer, errs } = ctx;
      await expect(
        access
          .connect(relayer)
          .grantAccessFor(
            ethers.ZeroAddress,
            hashes.m3,
            agentB.address,
            KEY,
            0,
            await deadline(),
            '0x',
          ),
      ).to.be.revertedWithCustomError(errs, 'ZeroAddress');
    });
  });

  /* ====================================================================== */
  describe('key rotation interaction', function () {
    it('leaves the grant valid but the stored keyVersion visibly stale', async function () {
      const { access, identity, hashes, agentA, agentB } = ctx;
      await access.connect(agentA).grantAccess(hashes.m3, agentB.address, KEY, 0);
      const [, versionAtGrant] = await access.getWrappedKey(hashes.m3, agentB.address);
      expect(versionAtGrant).to.equal(1n);

      await identity.connect(agentB).rotateKey(validPubKey('B2'));
      const [, currentVersion] = await identity.getPublicKey(agentB.address);
      expect(currentVersion).to.equal(2n);

      // The split is deliberate and must be asserted from both sides so the backend knows to re-wrap:
      // authorisation is unaffected...
      expect(await access.canAccess(hashes.m3, agentB.address)).to.equal(true);
      // ...but the envelope on chain targets a key the grantee no longer holds, and says so.
      const [, storedVersion] = await access.getWrappedKey(hashes.m3, agentB.address);
      expect(storedVersion).to.equal(1n);
      expect(storedVersion).to.be.lessThan(currentVersion);
    });
  });

  /* ====================================================================== */
  describe('pagination and the never-reverting predicate', function () {
    beforeEach(async function () {
      const { access, agentA, hashes, registeredExtras } = ctx;
      for (let i = 0; i < 12; i++) {
        await access
          .connect(agentA)
          .grantAccess(hashes.m3, registeredExtras[i].address, bytesOfLength(40, i), 0);
      }
    });

    it('pages grantees and reverse-indexes grants', async function () {
      const { access, agentA, hashes, registeredExtras } = ctx;
      const addresses = registeredExtras.slice(0, 12).map((w) => w.address);

      const [first, total] = await access.getGrantees(hashes.m3, 0, 5);
      expect(first).to.deep.equal(addresses.slice(0, 5));
      expect(total).to.equal(12n);
      const [tail] = await access.getGrantees(hashes.m3, 10, 5);
      expect(tail).to.deep.equal(addresses.slice(10));
      const [empty, total2] = await access.getGrantees(hashes.m3, 12, 5);
      expect(empty).to.deep.equal([]);
      expect(total2).to.equal(12n);

      await access.connect(agentA).grantAccess(hashes.m2, registeredExtras[0].address, KEY, 0);
      const [forExtra0, totalFor] = await access.getGrantsFor(registeredExtras[0].address, 0, 10);
      expect(forExtra0).to.deep.equal([hashes.m3, hashes.m2]);
      expect(totalFor).to.equal(2n);
    });

    it('rejects bad page limits', async function () {
      const { access, hashes, agentB, errs } = ctx;
      for (const call of [
        () => access.getGrantees(hashes.m3, 0, 0),
        () => access.getGrantsFor(agentB.address, 0, 0),
      ]) {
        await expect(call())
          .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
          .withArgs(0, MAX_PAGE_SIZE);
      }
      for (const call of [
        () => access.getGrantees(hashes.m3, 0, 101),
        () => access.getGrantsFor(agentB.address, 0, 101),
      ]) {
        await expect(call())
          .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
          .withArgs(101, MAX_PAGE_SIZE);
      }
    });

    it('canAccess never reverts, for any input', async function () {
      const { access, ledger, hashes, agentA, outsider } = ctx;
      expect(await access.canAccess(ethers.id('no-such-memory'), outsider.address)).to.equal(false);
      expect(await access.canAccess(ethers.ZeroHash, ethers.ZeroAddress)).to.equal(false);
      expect(await access.canAccess(hashes.m3, ethers.ZeroAddress)).to.equal(false);
      expect(await access.canAccess(hashes.m3, outsider.address)).to.equal(false);

      // A revoked memory withdraws every downstream authorisation, including the owner's.
      await ledger.connect(agentA).revokeMemory(hashes.m3, REASON);
      expect(await access.canAccess(hashes.m3, agentA.address)).to.equal(false);
      expect(await access.canAccess(hashes.m3, ctx.registeredExtras[0].address)).to.equal(false);
    });
  });
});
