import { expect } from 'chai';
import hre from 'hardhat';

import {
  DEFAULT_ADMIN_ROLE,
  DOMAIN_VERSION,
  IDENTITY_DOMAIN_NAME,
  KEY_ROTATION_TYPE_STRING,
  MAX_METADATA_URI_BYTES,
  MAX_PAGE_SIZE,
  MAX_PUBLIC_KEY_BYTES,
  MAX_SIGNATURE_VALIDITY,
  MIN_PUBLIC_KEY_BYTES,
  PAUSER_ROLE,
  REGISTRAR_ROLE,
  REGISTRATION_TYPE_STRING,
  bytesOfLength,
  deadline,
  field,
  strOfLength,
  validPubKey,
} from './helpers/constants.js';
import { deployFixture, loadFixture, time } from './helpers/fixtures.js';
import { signKeyRotation, signRegistration } from './helpers/eip712.js';

const { ethers } = hre;

describe('AgentIdentity', function () {
  let ctx;

  beforeEach(async function () {
    ctx = await loadFixture(deployFixture);
  });

  /* ====================================================================== */
  describe('deployment', function () {
    it('rejects a zero admin', async function () {
      const Factory = await ethers.getContractFactory('AgentIdentity');
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        ctx.errs,
        'ZeroAddress',
      );
    });

    it('bootstraps admin, pauser and registrar rights on the admin', async function () {
      const { identity, admin } = ctx;
      expect(await identity.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await identity.hasRole(PAUSER_ROLE, admin.address)).to.equal(true);
      expect(await identity.hasRole(REGISTRAR_ROLE, admin.address)).to.equal(true);
    });

    it('starts with an empty registry', async function () {
      expect(await ctx.identity.totalAgents()).to.equal(0n);
      const [page, total] = await ctx.identity.getAgents(0, 10);
      expect(page).to.deep.equal([]);
      expect(total).to.equal(0n);
    });

    it('publishes the documented EIP-712 domain', async function () {
      const { identity, chainId, identityAddr } = ctx;
      const d = await identity.eip712Domain();
      expect(d.name).to.equal(IDENTITY_DOMAIN_NAME);
      expect(d.version).to.equal(DOMAIN_VERSION);
      expect(d.chainId).to.equal(chainId);
      expect(d.verifyingContract).to.equal(identityAddr);
    });

    it('derives both typehashes from the exact canonical type strings', async function () {
      const { identity } = ctx;
      expect(await identity.REGISTRATION_TYPEHASH()).to.equal(ethers.id(REGISTRATION_TYPE_STRING));
      expect(await identity.KEY_ROTATION_TYPEHASH()).to.equal(ethers.id(KEY_ROTATION_TYPE_STRING));
    });
  });

  /* ====================================================================== */
  describe('registerAgent', function () {
    it('writes the record, indexes the agent and emits AgentRegistered', async function () {
      const { identity, agentA } = ctx;
      const key = validPubKey('A');
      const tx = await identity.connect(agentA).registerAgent(key, 'ipfs://a');
      const ts = await time.latest();

      await expect(tx)
        .to.emit(identity, 'AgentRegistered')
        .withArgs(agentA.address, agentA.address, key, 'ipfs://a', ts);

      const a = await identity.getAgent(agentA.address);
      expect(a.registeredAt).to.equal(ts);
      expect(a.statusChangedAt).to.equal(ts);
      expect(a.keyVersion).to.equal(1n);
      expect(a.active).to.equal(true);
      expect(a.exists).to.equal(true);
      expect(a.publicKey).to.equal(key);
      expect(a.metadataURI).to.equal('ipfs://a');

      expect(await identity.isActive(agentA.address)).to.equal(true);
      expect(await identity.isRegistered(agentA.address)).to.equal(true);
      expect(await identity.totalAgents()).to.equal(1n);
      const [page] = await identity.getAgents(0, 10);
      expect(page).to.deep.equal([agentA.address]);
    });

    it('rejects a duplicate registration', async function () {
      const { identity, agentA, errs } = ctx;
      await identity.connect(agentA).registerAgent(validPubKey('A'), '');
      await expect(identity.connect(agentA).registerAgent(validPubKey('A2'), ''))
        .to.be.revertedWithCustomError(errs, 'AlreadyRegistered')
        .withArgs(agentA.address);
    });

    it('rejects a public key below the minimum length', async function () {
      const { identity, agentA, errs } = ctx;
      await expect(identity.connect(agentA).registerAgent(bytesOfLength(31), ''))
        .to.be.revertedWithCustomError(errs, 'StringTooShort')
        .withArgs(field('publicKey'), 31, MIN_PUBLIC_KEY_BYTES);
    });

    it('rejects a public key above the maximum length', async function () {
      const { identity, agentA, errs } = ctx;
      await expect(identity.connect(agentA).registerAgent(bytesOfLength(129), ''))
        .to.be.revertedWithCustomError(errs, 'StringTooLong')
        .withArgs(field('publicKey'), 129, MAX_PUBLIC_KEY_BYTES);
    });

    it('accepts empty metadata but rejects metadata over the cap', async function () {
      const { identity, agentA, agentB, errs } = ctx;
      await identity.connect(agentA).registerAgent(validPubKey('A'), '');
      expect((await identity.getAgent(agentA.address)).metadataURI).to.equal('');

      await expect(identity.connect(agentB).registerAgent(validPubKey('B'), strOfLength(257)))
        .to.be.revertedWithCustomError(errs, 'StringTooLong')
        .withArgs(field('metadataURI'), 257, MAX_METADATA_URI_BYTES);

      // The bound is inclusive: exactly the cap must be accepted.
      await identity
        .connect(agentB)
        .registerAgent(validPubKey('B'), strOfLength(MAX_METADATA_URI_BYTES));
      expect((await identity.getAgent(agentB.address)).metadataURI.length).to.equal(
        MAX_METADATA_URI_BYTES,
      );
    });

    it('is blocked while paused', async function () {
      const { identity, pauser, agentA, errs } = ctx;
      await identity.connect(pauser).pause();
      await expect(
        identity.connect(agentA).registerAgent(validPubKey('A'), ''),
      ).to.be.revertedWithCustomError(errs, 'EnforcedPause');
    });
  });

  /* ====================================================================== */
  describe('registerAgentFor (EIP-712)', function () {
    it('lets a relayer pay while the signer becomes the agent', async function () {
      const { identity, agentA, relayer } = ctx;
      const key = validPubKey('A');
      const dl = await deadline();
      const { signature } = await signRegistration(agentA, identity, {
        agent: agentA.address,
        publicKey: key,
        metadataURI: 'ipfs://a',
        deadline: dl,
      });

      expect(await identity.nonces(agentA.address)).to.equal(0n);
      const tx = await identity
        .connect(relayer)
        .registerAgentFor(agentA.address, key, 'ipfs://a', dl, signature);
      const ts = await time.latest();

      await expect(tx)
        .to.emit(identity, 'AgentRegistered')
        .withArgs(agentA.address, relayer.address, key, 'ipfs://a', ts);
      expect(await identity.nonces(agentA.address)).to.equal(1n);
      expect(await identity.isActive(agentA.address)).to.equal(true);
      expect(await identity.isRegistered(relayer.address)).to.equal(false);
    });

    it('rejects a replay of the identical signature', async function () {
      const { identity, agentA, relayer, errs } = ctx;
      const key = validPubKey('A');
      const dl = await deadline();
      const { signature } = await signRegistration(agentA, identity, {
        agent: agentA.address,
        publicKey: key,
        metadataURI: 'ipfs://a',
        deadline: dl,
      });
      await identity
        .connect(relayer)
        .registerAgentFor(agentA.address, key, 'ipfs://a', dl, signature);

      // The nonce has advanced, so the replayed payload now hashes to a different digest and
      // recovery yields a different address - the failure surfaces as InvalidSignature, not
      // AlreadyRegistered.
      await expect(
        identity.connect(relayer).registerAgentFor(agentA.address, key, 'ipfs://a', dl, signature),
      )
        .to.be.revertedWithCustomError(errs, 'InvalidSignature')
        .withArgs(agentA.address);
    });

    it('rejects a signature produced by the wrong signer', async function () {
      const { identity, agentA, agentB, relayer, errs } = ctx;
      const key = validPubKey('A');
      const dl = await deadline();
      const { signature } = await signRegistration(agentB, identity, {
        agent: agentA.address,
        publicKey: key,
        metadataURI: 'ipfs://a',
        deadline: dl,
      });
      await expect(
        identity.connect(relayer).registerAgentFor(agentA.address, key, 'ipfs://a', dl, signature),
      )
        .to.be.revertedWithCustomError(errs, 'InvalidSignature')
        .withArgs(agentA.address);
    });

    it('rejects a tampered metadata URI', async function () {
      const { identity, agentA, relayer, errs } = ctx;
      const key = validPubKey('A');
      const dl = await deadline();
      const { signature } = await signRegistration(agentA, identity, {
        agent: agentA.address,
        publicKey: key,
        metadataURI: 'ipfs://a',
        deadline: dl,
      });
      await expect(
        identity
          .connect(relayer)
          .registerAgentFor(agentA.address, key, 'ipfs://attacker', dl, signature),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');
    });

    it('rejects an expired deadline', async function () {
      const { identity, agentA, relayer, errs } = ctx;
      const key = validPubKey('A');
      const dl = await deadline(1800);
      const { signature } = await signRegistration(agentA, identity, {
        agent: agentA.address,
        publicKey: key,
        metadataURI: '',
        deadline: dl,
      });
      await time.increase(3600);
      await expect(
        identity.connect(relayer).registerAgentFor(agentA.address, key, '', dl, signature),
      ).to.be.revertedWithCustomError(errs, 'SignatureExpired');
    });

    it('rejects a deadline further out than the protocol validity window', async function () {
      const { identity, agentA, relayer, errs } = ctx;
      const key = validPubKey('A');
      const dl = (await time.latest()) + MAX_SIGNATURE_VALIDITY + 24 * 3600;
      const { signature } = await signRegistration(agentA, identity, {
        agent: agentA.address,
        publicKey: key,
        metadataURI: '',
        deadline: dl,
      });
      await expect(
        identity.connect(relayer).registerAgentFor(agentA.address, key, '', dl, signature),
      ).to.be.revertedWithCustomError(errs, 'DeadlineTooFar');
    });

    it('rejects the zero address as agent', async function () {
      const { identity, relayer, errs } = ctx;
      await expect(
        identity
          .connect(relayer)
          .registerAgentFor(ethers.ZeroAddress, validPubKey('z'), '', await deadline(), '0x'),
      ).to.be.revertedWithCustomError(errs, 'ZeroAddress');
    });

    it('is blocked while paused', async function () {
      const { identity, agentA, relayer, pauser, errs } = ctx;
      const dl = await deadline();
      const { signature } = await signRegistration(agentA, identity, {
        agent: agentA.address,
        publicKey: validPubKey('A'),
        metadataURI: '',
        deadline: dl,
      });
      await identity.connect(pauser).pause();
      await expect(
        identity
          .connect(relayer)
          .registerAgentFor(agentA.address, validPubKey('A'), '', dl, signature),
      ).to.be.revertedWithCustomError(errs, 'EnforcedPause');
    });

    it('accepts an ERC-1271 smart-contract wallet and follows its owner', async function () {
      const { identity, agentA, agentB, relayer, errs } = ctx;
      const wallet = await (
        await ethers.getContractFactory('ERC1271Wallet')
      ).deploy(agentA.address);
      await wallet.waitForDeployment();
      const walletAddr = await wallet.getAddress();

      const key = validPubKey('w');
      const dl = await deadline();
      const { signature } = await signRegistration(agentA, identity, {
        agent: walletAddr,
        publicKey: key,
        metadataURI: '',
        deadline: dl,
      });
      await identity.connect(relayer).registerAgentFor(walletAddr, key, '', dl, signature);
      expect(await identity.isActive(walletAddr)).to.equal(true);

      // Flip the authorised signer: a freshly minted, otherwise valid signature from the OLD owner
      // must now be rejected, which proves real ERC-1271 dispatch rather than accidental EOA recovery.
      await wallet.setOwner(agentB.address);
      const dl2 = await deadline();
      const { signature: sig2 } = await signKeyRotation(agentA, identity, {
        agent: walletAddr,
        publicKey: validPubKey('w2'),
        deadline: dl2,
      });
      await expect(identity.connect(relayer).rotateKeyFor(walletAddr, validPubKey('w2'), dl2, sig2))
        .to.be.revertedWithCustomError(errs, 'InvalidSignature')
        .withArgs(walletAddr);

      // ...while a signature from the NEW owner is accepted.
      const dl3 = await deadline();
      const { signature: sig3 } = await signKeyRotation(agentB, identity, {
        agent: walletAddr,
        publicKey: validPubKey('w3'),
        deadline: dl3,
      });
      await identity.connect(relayer).rotateKeyFor(walletAddr, validPubKey('w3'), dl3, sig3);
      const [, version] = await identity.getPublicKey(walletAddr);
      expect(version).to.equal(2n);
    });
  });

  /* ====================================================================== */
  describe('rotateKey', function () {
    beforeEach(async function () {
      await ctx.identity.connect(ctx.agentA).registerAgent(validPubKey('A'), '');
    });

    it('increments keyVersion monotonically and replaces the key', async function () {
      const { identity, agentA } = ctx;
      const k2 = validPubKey('A2');
      await expect(identity.connect(agentA).rotateKey(k2))
        .to.emit(identity, 'AgentKeyRotated')
        .withArgs(agentA.address, 2, k2);
      let [key, version] = await identity.getPublicKey(agentA.address);
      expect(key).to.equal(k2);
      expect(version).to.equal(2n);

      const k3 = validPubKey('A3');
      await identity.connect(agentA).rotateKey(k3);
      [key, version] = await identity.getPublicKey(agentA.address);
      expect(key).to.equal(k3);
      expect(version).to.equal(3n);
    });

    it('rejects an unregistered caller', async function () {
      const { identity, outsider, errs } = ctx;
      await expect(identity.connect(outsider).rotateKey(validPubKey('o')))
        .to.be.revertedWithCustomError(errs, 'NotRegistered')
        .withArgs(outsider.address);
    });

    it('rejects a deactivated caller', async function () {
      const { identity, agentA, errs } = ctx;
      await identity.connect(agentA).deactivate();
      await expect(identity.connect(agentA).rotateKey(validPubKey('A2')))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(agentA.address);
    });

    it('rejects an oversize key', async function () {
      const { identity, agentA, errs } = ctx;
      await expect(identity.connect(agentA).rotateKey(bytesOfLength(200)))
        .to.be.revertedWithCustomError(errs, 'StringTooLong')
        .withArgs(field('publicKey'), 200, MAX_PUBLIC_KEY_BYTES);
    });

    it('rotates through a relayer, burning exactly one nonce', async function () {
      const { identity, agentA, relayer } = ctx;
      const k2 = validPubKey('A2');
      const dl = await deadline();
      const { signature } = await signKeyRotation(agentA, identity, {
        agent: agentA.address,
        publicKey: k2,
        deadline: dl,
      });
      expect(await identity.nonces(agentA.address)).to.equal(0n);
      await expect(identity.connect(relayer).rotateKeyFor(agentA.address, k2, dl, signature))
        .to.emit(identity, 'AgentKeyRotated')
        .withArgs(agentA.address, 2, k2);
      expect(await identity.nonces(agentA.address)).to.equal(1n);
    });

    it('rejects a stale rotation signature and a foreign signer', async function () {
      const { identity, agentA, agentB, relayer, errs } = ctx;
      const k2 = validPubKey('A2');
      const dl = await deadline();
      const { signature } = await signKeyRotation(agentA, identity, {
        agent: agentA.address,
        publicKey: k2,
        deadline: dl,
      });
      await identity.connect(relayer).rotateKeyFor(agentA.address, k2, dl, signature);

      // Stale: the nonce moved on.
      await expect(
        identity.connect(relayer).rotateKeyFor(agentA.address, k2, dl, signature),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');

      // Foreign: agentB signing agentA's rotation.
      const dl2 = await deadline();
      const { signature: sigB } = await signKeyRotation(agentB, identity, {
        agent: agentA.address,
        publicKey: validPubKey('A3'),
        deadline: dl2,
      });
      await expect(
        identity.connect(relayer).rotateKeyFor(agentA.address, validPubKey('A3'), dl2, sigB),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');
    });

    it('does not burn the nonce when verification fails', async function () {
      const { identity, agentA, agentB, relayer, errs } = ctx;
      const dl = await deadline();
      const { signature } = await signKeyRotation(agentB, identity, {
        agent: agentA.address,
        publicKey: validPubKey('A2'),
        deadline: dl,
      });
      await expect(
        identity.connect(relayer).rotateKeyFor(agentA.address, validPubKey('A2'), dl, signature),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');
      expect(await identity.nonces(agentA.address)).to.equal(0n);
    });
  });

  /* ====================================================================== */
  describe('metadata', function () {
    it('updates and emits', async function () {
      const { identity, agentA } = ctx;
      await identity.connect(agentA).registerAgent(validPubKey('A'), 'ipfs://old');
      await expect(identity.connect(agentA).setMetadataURI('ipfs://new'))
        .to.emit(identity, 'AgentMetadataUpdated')
        .withArgs(agentA.address, 'ipfs://new');
      expect((await identity.getAgent(agentA.address)).metadataURI).to.equal('ipfs://new');
    });

    it('rejects an unregistered caller', async function () {
      const { identity, outsider, errs } = ctx;
      await expect(identity.connect(outsider).setMetadataURI('x'))
        .to.be.revertedWithCustomError(errs, 'NotRegistered')
        .withArgs(outsider.address);
    });

    it('rejects an oversize URI', async function () {
      const { identity, agentA, errs } = ctx;
      await identity.connect(agentA).registerAgent(validPubKey('A'), '');
      await expect(identity.connect(agentA).setMetadataURI(strOfLength(257)))
        .to.be.revertedWithCustomError(errs, 'StringTooLong')
        .withArgs(field('metadataURI'), 257, MAX_METADATA_URI_BYTES);
    });
  });

  /* ====================================================================== */
  describe('deactivate / reactivate', function () {
    beforeEach(async function () {
      await ctx.identity.connect(ctx.agentA).registerAgent(validPubKey('A'), '');
    });

    it('flips activity, records the transition and keeps the registration', async function () {
      const { identity, agentA } = ctx;
      const tx = await identity.connect(agentA).deactivate();
      const ts = await time.latest();
      await expect(tx)
        .to.emit(identity, 'AgentStatusChanged')
        .withArgs(agentA.address, false, agentA.address, field('self'));

      expect(await identity.isActive(agentA.address)).to.equal(false);
      expect(await identity.isRegistered(agentA.address)).to.equal(true);
      expect((await identity.getAgent(agentA.address)).statusChangedAt).to.equal(ts);
    });

    it('REGRESSION: re-registering after deactivation cannot reset registeredAt', async function () {
      const { identity, agentA, errs } = ctx;
      const originalRegisteredAt = (await identity.getAgent(agentA.address)).registeredAt;

      await identity.connect(agentA).deactivate();
      await time.increase(365 * 24 * 3600);

      await expect(identity.connect(agentA).registerAgent(validPubKey('A2'), 'reset?'))
        .to.be.revertedWithCustomError(errs, 'AlreadyRegistered')
        .withArgs(agentA.address);

      const after = await identity.getAgent(agentA.address);
      expect(after.registeredAt).to.equal(originalRegisteredAt);
      expect(after.keyVersion).to.equal(1n);
    });

    it('rejects a second deactivation and reactivating an active agent', async function () {
      const { identity, agentA, errs } = ctx;
      await expect(identity.connect(agentA).reactivate())
        .to.be.revertedWithCustomError(errs, 'AgentAlreadyActive')
        .withArgs(agentA.address);

      await identity.connect(agentA).deactivate();
      await expect(identity.connect(agentA).deactivate())
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(agentA.address);
    });

    it('reactivate restores activity', async function () {
      const { identity, agentA } = ctx;
      await identity.connect(agentA).deactivate();
      await expect(identity.connect(agentA).reactivate())
        .to.emit(identity, 'AgentStatusChanged')
        .withArgs(agentA.address, true, agentA.address, field('self'));
      expect(await identity.isActive(agentA.address)).to.equal(true);
    });

    it('rejects deactivation from an unregistered address', async function () {
      const { identity, outsider, errs } = ctx;
      await expect(identity.connect(outsider).deactivate())
        .to.be.revertedWithCustomError(errs, 'NotRegistered')
        .withArgs(outsider.address);
      await expect(identity.connect(outsider).reactivate())
        .to.be.revertedWithCustomError(errs, 'NotRegistered')
        .withArgs(outsider.address);
    });

    it('DOCUMENTED EXEMPTION: deactivate works while paused, reactivate does not', async function () {
      const { identity, agentA, pauser, errs } = ctx;
      await identity.connect(pauser).pause();
      // Self-protection must survive an incident pause - that is when it matters most.
      await identity.connect(agentA).deactivate();
      expect(await identity.isActive(agentA.address)).to.equal(false);
      // Coming back online is new protocol state, so it stays gated.
      await expect(identity.connect(agentA).reactivate()).to.be.revertedWithCustomError(
        errs,
        'EnforcedPause',
      );
    });
  });

  /* ====================================================================== */
  describe('adminSetActive', function () {
    beforeEach(async function () {
      await ctx.identity.connect(ctx.agentA).registerAgent(validPubKey('A'), '');
    });

    it('lets a REGISTRAR_ROLE holder suspend and reinstate with a reason', async function () {
      const { identity, admin, agentA } = ctx;
      await expect(identity.connect(admin).adminSetActive(agentA.address, false, field('abuse')))
        .to.emit(identity, 'AgentStatusChanged')
        .withArgs(agentA.address, false, admin.address, field('abuse'));
      expect(await identity.isActive(agentA.address)).to.equal(false);

      await expect(identity.connect(admin).adminSetActive(agentA.address, true, field('appeal')))
        .to.emit(identity, 'AgentStatusChanged')
        .withArgs(agentA.address, true, admin.address, field('appeal'));
      expect(await identity.isActive(agentA.address)).to.equal(true);
    });

    it('rejects a caller without REGISTRAR_ROLE', async function () {
      const { identity, outsider, agentA, errs } = ctx;
      await expect(identity.connect(outsider).adminSetActive(agentA.address, false, field('abuse')))
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(outsider.address, REGISTRAR_ROLE);
    });

    it('rejects an unregistered target and administrative no-ops', async function () {
      const { identity, admin, agentA, outsider, errs } = ctx;
      await expect(identity.connect(admin).adminSetActive(outsider.address, false, field('x')))
        .to.be.revertedWithCustomError(errs, 'NotRegistered')
        .withArgs(outsider.address);
      await expect(identity.connect(admin).adminSetActive(agentA.address, true, field('x')))
        .to.be.revertedWithCustomError(errs, 'AgentAlreadyActive')
        .withArgs(agentA.address);
      await identity.connect(admin).adminSetActive(agentA.address, false, field('x'));
      await expect(identity.connect(admin).adminSetActive(agentA.address, false, field('x')))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(agentA.address);
    });

    it('DOCUMENTED EXEMPTION: works while paused', async function () {
      const { identity, admin, pauser, agentA } = ctx;
      await identity.connect(pauser).pause();
      await identity.connect(admin).adminSetActive(agentA.address, false, field('incident'));
      expect(await identity.isActive(agentA.address)).to.equal(false);
    });
  });

  /* ====================================================================== */
  describe('views and pagination', function () {
    let registered;

    beforeEach(async function () {
      const { identity, agentA, agentB, agentC, extras } = ctx;
      registered = [agentA, agentB, agentC, ...extras.slice(0, 9)];
      for (const [i, w] of registered.entries()) {
        await identity.connect(w).registerAgent(validPubKey(`p${i}`), '');
      }
    });

    it('pages in registration order and reports the true total', async function () {
      const { identity } = ctx;
      expect(await identity.totalAgents()).to.equal(12n);

      const [first, total1] = await identity.getAgents(0, 5);
      expect(first.length).to.equal(5);
      expect(total1).to.equal(12n);
      expect(first).to.deep.equal(registered.slice(0, 5).map((w) => w.address));

      const [tail, total2] = await identity.getAgents(10, 5);
      expect(tail.length).to.equal(2);
      expect(total2).to.equal(12n);
      expect(tail).to.deep.equal(registered.slice(10, 12).map((w) => w.address));
    });

    it('returns an empty page past the end rather than reverting', async function () {
      const { identity } = ctx;
      const [page, total] = await identity.getAgents(12, 5);
      expect(page).to.deep.equal([]);
      expect(total).to.equal(12n);
      const [page2] = await identity.getAgents(10_000, 5);
      expect(page2).to.deep.equal([]);
    });

    it('rejects a zero or oversized page limit', async function () {
      const { identity, errs } = ctx;
      await expect(identity.getAgents(0, 0))
        .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
        .withArgs(0, MAX_PAGE_SIZE);
      await expect(identity.getAgents(0, 101))
        .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
        .withArgs(101, MAX_PAGE_SIZE);
      // The cap itself is legal.
      const [page] = await identity.getAgents(0, MAX_PAGE_SIZE);
      expect(page.length).to.equal(12);
    });

    it('reverts NotRegistered on unknown lookups but never on the boolean views', async function () {
      const { identity, outsider, agentA, errs } = ctx;
      await expect(identity.getAgent(outsider.address))
        .to.be.revertedWithCustomError(errs, 'NotRegistered')
        .withArgs(outsider.address);
      await expect(identity.getPublicKey(outsider.address))
        .to.be.revertedWithCustomError(errs, 'NotRegistered')
        .withArgs(outsider.address);

      expect(await identity.getAgentStatus(outsider.address)).to.equal(false);
      expect(await identity.getAgentStatus(agentA.address)).to.equal(true);
      await identity.connect(agentA).deactivate();
      expect(await identity.getAgentStatus(agentA.address)).to.equal(
        await identity.isActive(agentA.address),
      );
      expect(await identity.getAgentStatus(agentA.address)).to.equal(false);
    });
  });
});
