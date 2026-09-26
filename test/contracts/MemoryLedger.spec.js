import { expect } from 'chai';
import hre from 'hardhat';

import {
  MAX_CHAIN_WALK,
  MAX_CID_BYTES,
  MAX_EMBEDDING_DIM,
  MAX_MODEL_BYTES,
  MAX_PAGE_SIZE,
  MIN_CID_BYTES,
  MIN_EMBEDDING_DIM,
  MODERATOR_ROLE,
  cid,
  field,
  strOfLength,
} from './helpers/constants.js';
import {
  input,
  loadFixture,
  registeredFixture,
  time,
  commitWithPrecommit,
} from './helpers/fixtures.js';

const { ethers } = hre;

const REASON = ethers.encodeBytes32String('superseded');

describe('MemoryLedger', function () {
  let ctx;

  beforeEach(async function () {
    ctx = await loadFixture(registeredFixture);
  });

  /* ====================================================================== */
  describe('deployment', function () {
    it('validates both constructor arguments', async function () {
      const Factory = await ethers.getContractFactory('MemoryLedger');
      const { admin, identityAddr, outsider, errs } = ctx;

      await expect(Factory.deploy(ethers.ZeroAddress, identityAddr)).to.be.revertedWithCustomError(
        errs,
        'ZeroAddress',
      );
      await expect(Factory.deploy(admin.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        errs,
        'ZeroAddress',
      );
      // An EOA cast to the identity interface would make every commit revert with an opaque
      // ABI-decode panic instead of a named error, so it is rejected up front.
      await expect(Factory.deploy(admin.address, outsider.address))
        .to.be.revertedWithCustomError(errs, 'NotAContract')
        .withArgs(outsider.address);
    });

    it('wires an immutable identity registry and starts empty', async function () {
      const { ledger, identityAddr, admin } = ctx;
      expect(await ledger.identity()).to.equal(identityAddr);
      expect(await ledger.totalMemoryCount()).to.equal(0n);
      expect(await ledger.totalRevokedCount()).to.equal(0n);
      expect(await ledger.hasRole(MODERATOR_ROLE, admin.address)).to.equal(true);
    });
  });

  /* ====================================================================== */
  describe('commitMemory', function () {
    it('stores the record and emits a filterable MemoryCommitted', async function () {
      const { ledger, agentA } = ctx;
      const inp = input(cid(1));
      const cidHash = ethers.id(inp.cid);

      const tx = await commitWithPrecommit(ledger, agentA, inp);
      // staticCall is exercised on the chained commit below, where a precommit already exists.
      const ts = await time.latest();

      await expect(tx)
        .to.emit(ledger, 'MemoryCommitted')
        .withArgs(
          agentA.address,
          cidHash,
          ethers.ZeroHash,
          inp.cid,
          inp.model,
          inp.embeddingDim,
          inp.isEncrypted,
          1,
          agentA.address,
          ts,
        );

      const m = await ledger.getMemory(cidHash);
      expect(m.owner).to.equal(agentA.address);
      expect(m.committedBy).to.equal(agentA.address);
      expect(m.committedAt).to.equal(ts);
      expect(m.version).to.equal(1n);
      expect(m.revoked).to.equal(false);
      expect(m.revokedAt).to.equal(0n);
      expect(m.prevCidHash).to.equal(ethers.ZeroHash);
      expect(m.cid).to.equal(inp.cid);
      expect(m.model).to.equal(inp.model);
      expect(m.embeddingDim).to.equal(384n);
      expect(m.isEncrypted).to.equal(true);

      // The indexed cidHash topic makes a single-record log query possible.
      const logs = await ledger.queryFilter(ledger.filters.MemoryCommitted(null, cidHash));
      expect(logs.length).to.equal(1);

      expect(await ledger.totalMemoryCount()).to.equal(1n);
      expect(await ledger.activeMemoryCount(agentA.address)).to.equal(1n);
      expect(await ledger.exists(cidHash)).to.equal(true);
      expect(await ledger.cidHashOf(inp.cid)).to.equal(cidHash);
      expect((await ledger.getMemoryByCid(inp.cid)).owner).to.equal(agentA.address);
    });

    it('rejects a duplicate CID', async function () {
      const { ledger, agentA, agentB, errs } = ctx;
      await commitWithPrecommit(ledger, agentA, input(cid(1)));
      await expect(commitWithPrecommit(ledger, agentA, input(cid(1))))
        .to.be.revertedWithCustomError(errs, 'MemoryAlreadyExists')
        .withArgs(ethers.id(cid(1)));
      // ...including by a different agent, so a CID can never be re-attributed.
      await expect(
        commitWithPrecommit(ledger, agentB, input(cid(1))),
      ).to.be.revertedWithCustomError(errs, 'MemoryAlreadyExists');
    });

    it('rejects an unregistered or deactivated committer', async function () {
      const { ledger, identity, outsider, agentA, errs } = ctx;
      await expect(commitWithPrecommit(ledger, outsider, input(cid(2))))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(outsider.address);

      await identity.connect(agentA).deactivate();
      await expect(commitWithPrecommit(ledger, agentA, input(cid(2))))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(agentA.address);
    });

    it('enforces every field bound', async function () {
      const { ledger, agentA, errs } = ctx;

      await expect(commitWithPrecommit(ledger, agentA, input(strOfLength(7))))
        .to.be.revertedWithCustomError(errs, 'StringTooShort')
        .withArgs(field('cid'), 7, MIN_CID_BYTES);

      await expect(commitWithPrecommit(ledger, agentA, input(strOfLength(101))))
        .to.be.revertedWithCustomError(errs, 'StringTooLong')
        .withArgs(field('cid'), 101, MAX_CID_BYTES);

      await expect(
        commitWithPrecommit(ledger, agentA, input(cid(3), ethers.ZeroHash, { model: '' })),
      )
        .to.be.revertedWithCustomError(errs, 'StringTooShort')
        .withArgs(field('model'), 0, 1);

      await expect(
        commitWithPrecommit(
          ledger,
          agentA,
          input(cid(3), ethers.ZeroHash, { model: strOfLength(65) }),
        ),
      )
        .to.be.revertedWithCustomError(errs, 'StringTooLong')
        .withArgs(field('model'), 65, MAX_MODEL_BYTES);

      await expect(
        commitWithPrecommit(ledger, agentA, input(cid(3), ethers.ZeroHash, { embeddingDim: 0 })),
      )
        .to.be.revertedWithCustomError(errs, 'InvalidEmbeddingDim')
        .withArgs(0, MIN_EMBEDDING_DIM, MAX_EMBEDDING_DIM);

      await expect(
        commitWithPrecommit(ledger, agentA, input(cid(3), ethers.ZeroHash, { embeddingDim: 8193 })),
      )
        .to.be.revertedWithCustomError(errs, 'InvalidEmbeddingDim')
        .withArgs(8193, MIN_EMBEDDING_DIM, MAX_EMBEDDING_DIM);

      // Both bounds are inclusive.
      await commitWithPrecommit(
        ledger,
        agentA,
        input(strOfLength(8), ethers.ZeroHash, { embeddingDim: 1 }),
      );
      await commitWithPrecommit(
        ledger,
        agentA,
        input(strOfLength(100), ethers.ZeroHash, { embeddingDim: MAX_EMBEDDING_DIM }),
      );
    });

    it('is blocked while paused', async function () {
      const { ledger, pauser, agentA, errs } = ctx;
      await ledger.connect(pauser).pause();
      await expect(
        commitWithPrecommit(ledger, agentA, input(cid(9))),
      ).to.be.revertedWithCustomError(errs, 'EnforcedPause');
    });
  });

  /* ====================================================================== */
  describe('version chains', function () {
    let h1, h2, h3;

    beforeEach(async function () {
      const { ledger, agentA } = ctx;
      h1 = ethers.id(cid(1));
      h2 = ethers.id(cid(2));
      h3 = ethers.id(cid(3));
      await commitWithPrecommit(ledger, agentA, input(cid(1)));
      await commitWithPrecommit(ledger, agentA, input(cid(2), h1));
      await commitWithPrecommit(ledger, agentA, input(cid(3), h2));
    });

    it('derives version from the parent and indexes children', async function () {
      const { ledger } = ctx;
      expect((await ledger.getMemory(h2)).version).to.equal(2n);
      expect((await ledger.getMemory(h3)).version).to.equal(3n);

      const [children, total] = await ledger.getChildren(h1, 0, 10);
      expect(children).to.deep.equal([h2]);
      expect(total).to.equal(1n);
    });

    it('walks the chain leaf-first and honours maxDepth', async function () {
      const { ledger, errs } = ctx;
      expect(await ledger.getVersionChain(h3, 10)).to.deep.equal([h3, h2, h1]);
      expect(await ledger.getVersionChain(h3, 2)).to.deep.equal([h3, h2]);
      expect(await ledger.getVersionChain(h1, 10)).to.deep.equal([h1]);

      await expect(ledger.getVersionChain(h3, 0))
        .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
        .withArgs(0, MAX_CHAIN_WALK);
      await expect(ledger.getVersionChain(h3, MAX_CHAIN_WALK + 1))
        .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
        .withArgs(MAX_CHAIN_WALK + 1, MAX_CHAIN_WALK);
      await expect(ledger.getVersionChain(ethers.id('nope'), 10)).to.be.revertedWithCustomError(
        errs,
        'MemoryNotFound',
      );
    });

    it('allows forks: two siblings off the same parent', async function () {
      const { ledger, agentA } = ctx;
      const hFork = ethers.id(cid(4));
      await commitWithPrecommit(ledger, agentA, input(cid(4), h1));
      const [children, total] = await ledger.getChildren(h1, 0, 10);
      expect(children).to.deep.equal([h2, hFork]);
      expect(total).to.equal(2n);
      expect((await ledger.getMemory(hFork)).version).to.equal(2n);
    });

    it('rejects a missing parent', async function () {
      const { ledger, agentA, errs } = ctx;
      const ghost = ethers.id('ghost-parent');
      await expect(commitWithPrecommit(ledger, agentA, input(cid(5), ghost)))
        .to.be.revertedWithCustomError(errs, 'ParentNotFound')
        .withArgs(ghost);
    });

    it('REGRESSION: rejects a parent owned by a different agent', async function () {
      const { ledger, agentB, errs } = ctx;
      // The previous ledger accepted any `previousVersionCID` string with no validation at all,
      // so anyone could graft their record onto someone else's chain.
      await expect(commitWithPrecommit(ledger, agentB, input(cid(6), h1)))
        .to.be.revertedWithCustomError(errs, 'ParentNotOwnedByAgent')
        .withArgs(h1, agentB.address, ctx.agentA.address);
    });

    it('rejects a revoked parent', async function () {
      const { ledger, agentA, errs } = ctx;
      await ledger.connect(agentA).revokeMemory(h3, REASON);
      await expect(commitWithPrecommit(ledger, agentA, input(cid(7), h3)))
        .to.be.revertedWithCustomError(errs, 'ParentRevoked')
        .withArgs(h3);
    });

    it('rejects a self-referential parent', async function () {
      const { ledger, agentA, errs } = ctx;
      const selfCid = cid(8);
      await expect(commitWithPrecommit(ledger, agentA, input(selfCid, ethers.id(selfCid))))
        .to.be.revertedWithCustomError(errs, 'SelfReferentialParent')
        .withArgs(ethers.id(selfCid));
    });
  });

  /* ====================================================================== */
  describe('revocation', function () {
    let h1;

    beforeEach(async function () {
      h1 = ethers.id(cid(1));
      await commitWithPrecommit(ctx.ledger, ctx.agentA, input(cid(1)));
    });

    it('tombstones the record and moves exactly the right counters', async function () {
      const { ledger, agentA } = ctx;
      const tx = await ledger.connect(agentA).revokeMemory(h1, REASON);
      const ts = await time.latest();

      await expect(tx)
        .to.emit(ledger, 'MemoryRevokedEvent')
        .withArgs(h1, agentA.address, agentA.address, REASON, ts);

      const m = await ledger.getMemory(h1);
      expect(m.revoked).to.equal(true);
      expect(m.revokedAt).to.equal(ts);
      expect(await ledger.activeMemoryCount(agentA.address)).to.equal(0n);
      expect(await ledger.totalRevokedCount()).to.equal(1n);
      // A tombstone is not a deletion: the lifetime count never decreases.
      expect(await ledger.totalMemoryCount()).to.equal(1n);
      expect(await ledger.getOwnerMemoryCount(agentA.address)).to.equal(1n);

      const [, , , , , revoked] = await ledger.verifyMemory(cid(1));
      expect(revoked).to.equal(true);
    });

    it('ANTI-SQUATTING: a revoked CID can never be re-committed by anyone', async function () {
      const { ledger, agentA, agentB, errs } = ctx;
      await ledger.connect(agentA).revokeMemory(h1, REASON);
      await expect(commitWithPrecommit(ledger, agentB, input(cid(1))))
        .to.be.revertedWithCustomError(errs, 'MemoryAlreadyExists')
        .withArgs(h1);
      await expect(
        commitWithPrecommit(ledger, agentA, input(cid(1))),
      ).to.be.revertedWithCustomError(errs, 'MemoryAlreadyExists');
    });

    it('rejects a non-owner, a double revoke and an unknown record', async function () {
      const { ledger, agentA, agentB, errs } = ctx;
      await expect(ledger.connect(agentB).revokeMemory(h1, REASON))
        .to.be.revertedWithCustomError(errs, 'NotMemoryOwner')
        .withArgs(h1, agentB.address, agentA.address);

      await ledger.connect(agentA).revokeMemory(h1, REASON);
      await expect(ledger.connect(agentA).revokeMemory(h1, REASON))
        .to.be.revertedWithCustomError(errs, 'MemoryAlreadyRevoked')
        .withArgs(h1);

      const ghost = ethers.id('ghost');
      await expect(ledger.connect(agentA).revokeMemory(ghost, REASON))
        .to.be.revertedWithCustomError(errs, 'MemoryNotFound')
        .withArgs(ghost);
    });

    it('moderatorRevokeMemory: role-gated, records the actor, works while paused', async function () {
      const { ledger, moderator, agentA, pauser, outsider, errs } = ctx;

      await expect(ledger.connect(outsider).moderatorRevokeMemory(h1, REASON))
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(outsider.address, MODERATOR_ROLE);

      await expect(
        ledger.connect(moderator).moderatorRevokeMemory(ethers.id('ghost'), REASON),
      ).to.be.revertedWithCustomError(errs, 'MemoryNotFound');

      await ledger.connect(pauser).pause();
      // Taking down poisoned content is exactly what an operator needs during an incident.
      const tx = await ledger.connect(moderator).moderatorRevokeMemory(h1, field('takedown'));
      const ts = await time.latest();
      await expect(tx)
        .to.emit(ledger, 'MemoryRevokedEvent')
        .withArgs(h1, agentA.address, moderator.address, field('takedown'), ts);
      expect((await ledger.getMemory(h1)).revoked).to.equal(true);
    });

    it('is blocked while paused for the owner path', async function () {
      const { ledger, pauser, agentA, errs } = ctx;
      await ledger.connect(pauser).pause();
      await expect(ledger.connect(agentA).revokeMemory(h1, REASON)).to.be.revertedWithCustomError(
        errs,
        'EnforcedPause',
      );
    });
  });

  /* ====================================================================== */
  describe('views and pagination', function () {
    let hashes;

    beforeEach(async function () {
      const { ledger, agentA } = ctx;
      hashes = [];
      for (let i = 0; i < 12; i++) {
        await commitWithPrecommit(ledger, agentA, input(cid(200 + i)));
        hashes.push(ethers.id(cid(200 + i)));
      }
    });

    it('pages owner memories in insertion order', async function () {
      const { ledger, agentA } = ctx;
      expect(await ledger.getOwnerMemoryCount(agentA.address)).to.equal(12n);

      const [page, total] = await ledger.getOwnerMemories(agentA.address, 0, 5);
      expect(page).to.deep.equal(hashes.slice(0, 5));
      expect(total).to.equal(12n);

      const [tail] = await ledger.getOwnerMemories(agentA.address, 10, 5);
      expect(tail).to.deep.equal(hashes.slice(10));

      const [empty, total2] = await ledger.getOwnerMemories(agentA.address, 12, 5);
      expect(empty).to.deep.equal([]);
      expect(total2).to.equal(12n);
    });

    it('pages full records without a second round trip', async function () {
      const { ledger, agentA } = ctx;
      const [records, total] = await ledger.getOwnerMemoryRecords(agentA.address, 5, 5);
      expect(total).to.equal(12n);
      expect(records.length).to.equal(5);
      expect(records.map((r) => r.cid)).to.deep.equal([5, 6, 7, 8, 9].map((i) => cid(200 + i)));
      expect(records.every((r) => r.owner === agentA.address)).to.equal(true);
    });

    it('rejects bad page limits on every paginated getter', async function () {
      const { ledger, agentA, errs } = ctx;
      for (const call of [
        () => ledger.getOwnerMemories(agentA.address, 0, 0),
        () => ledger.getOwnerMemoryRecords(agentA.address, 0, 0),
        () => ledger.getChildren(hashes[0], 0, 0),
      ]) {
        await expect(call())
          .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
          .withArgs(0, MAX_PAGE_SIZE);
      }
      for (const call of [
        () => ledger.getOwnerMemories(agentA.address, 0, 101),
        () => ledger.getOwnerMemoryRecords(agentA.address, 0, 101),
        () => ledger.getChildren(hashes[0], 0, 101),
      ]) {
        await expect(call())
          .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
          .withArgs(101, MAX_PAGE_SIZE);
      }
    });

    it('reverts MemoryNotFound on unknown lookups and returns the documented verify tuple', async function () {
      const { ledger, agentA, errs } = ctx;
      const ghost = ethers.id('ghost');
      await expect(ledger.getMemory(ghost))
        .to.be.revertedWithCustomError(errs, 'MemoryNotFound')
        .withArgs(ghost);
      await expect(ledger.getMemoryByCid('QmGhostGhostGhost')).to.be.revertedWithCustomError(
        errs,
        'MemoryNotFound',
      );
      await expect(ledger.verifyMemory('QmGhostGhostGhost')).to.be.revertedWithCustomError(
        errs,
        'MemoryNotFound',
      );
      expect(await ledger.exists(ghost)).to.equal(false);

      const inp = input(cid(200));
      const [owner, committedAt, isEncrypted, embeddingDim, model, revoked] =
        await ledger.verifyMemory(inp.cid);
      const record = await ledger.getMemory(hashes[0]);
      expect(owner).to.equal(agentA.address);
      expect(committedAt).to.equal(record.committedAt);
      expect(isEncrypted).to.equal(true);
      expect(embeddingDim).to.equal(384n);
      expect(model).to.equal(inp.model);
      expect(revoked).to.equal(false);
    });
  });
});
