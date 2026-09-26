import { expect } from 'chai';
import hre from 'hardhat';

import { MAX_W, NEG_MULT, TRUST_LOG_CAPACITY, WAD, cid, deadline } from './helpers/constants.js';
import {
  input,
  loadFixture,
  registeredFixture,
  time,
  commitWithPrecommit,
} from './helpers/fixtures.js';
import { flipByte, signMemoryCommit } from './helpers/eip712.js';
import { attempt } from './helpers/revert.js';

const { ethers } = hre;

const STAKE = ethers.parseEther('0.001');
const ITERATIONS = 300;

/**
 * Reverts a well-formed random walk is ALLOWED to produce. Anything else - and in particular any
 * arithmetic panic (0x11 overflow/underflow, 0x12 divide-by-zero, 0x32 array bounds) - fails the
 * run. That allow-list is what makes this pass worth its runtime: a silent `catch {}` would prove
 * nothing at all.
 */
const ALLOWED = new Set([
  'AlreadyEndorsed',
  'NotEndorsed',
  'CooldownActive',
  'SelfAction',
  'MemoryAlreadyExists',
  'AgentInactive',
  'NotMemoryOwner',
  'MemoryAlreadyRevoked',
  'MemoryNotFound',
  'AlreadyReported',
  'NotReported',
  'ParentNotFound',
  'ParentNotOwnedByAgent',
  'ParentRevoked',
  'SelfReferentialParent',
  'InvalidStake',
  'UnclaimedStake',
]);

describe('Protocol invariants under a deterministic random walk', function () {
  let ctx;
  let agents;

  beforeEach(async function () {
    ctx = await loadFixture(registeredFixture);
    const { agentA, agentB, agentC, registeredExtras } = ctx;
    agents = [agentA, agentB, agentC, ...registeredExtras.slice(0, 7)];
    await ctx.reputation.connect(ctx.paramAdmin).setEndorsementStake(STAKE);
  });

  it(`holds every invariant across ${ITERATIONS} pseudo-random operations`, async function () {
    this.timeout(1_200_000);
    const { ledger, reputation, errs, outsider } = ctx;
    const iface = errs.interface;

    // Deterministic LCG - identical on every machine and every CI run.
    let s = 42;
    const rnd = (n) => (s = (s * 1103515245 + 12345) % 2147483648) % n;
    const pick = (arr) => arr[rnd(arr.length)];

    /* ---------------- JS mirror of the protocol state ---------------- */
    const endorsements = new Map(); // "from|to" -> boolean active
    const reports = new Map(); // "from|to" -> boolean active
    const memories = new Map(); // cidHash -> { owner, revoked, version, prev }
    const ownerMemories = new Map(agents.map((a) => [a.address, []]));
    let totalMemories = 0;
    let totalRevoked = 0;
    let trustEvents = 0;
    let escrowed = 0n;
    let cidCounter = 1000;

    const key = (a, b) => `${a}|${b}`;
    const activeEndorsers = (to) =>
      [...endorsements.entries()].filter(([k, v]) => v && k.endsWith(`|${to}`)).length;
    const activeReporters = (to) =>
      [...reports.entries()].filter(([k, v]) => v && k.endsWith(`|${to}`)).length;

    async function checkInvariants(deep) {
      for (const a of agents) {
        // I1: the score is a bounded WAD ratio, never the old unbounded integer.
        const rep = await reputation.reputationOf(a.address);
        expect(rep).to.be.at.least(0n);
        expect(rep).to.be.lessThan(WAD);

        // I2 / I3: counters equal the mirrored number of LIVE edges.
        const ec = await reputation.endorserCount(a.address);
        const rc = await reputation.reporterCount(a.address);
        expect(ec).to.equal(BigInt(activeEndorsers(a.address)));
        expect(rc).to.equal(BigInt(activeReporters(a.address)));

        const [p, n] = await reputation.massesOf(a.address);
        // I4: the zero-edge anchor, in both directions.
        if (ec === 0n) expect(p).to.equal(0n);
        if (rc === 0n) expect(n).to.equal(0n);
        // I5: mass can never exceed the number of edges times the weight ceiling.
        expect(p).to.be.at.most(ec * MAX_W);
        expect(n).to.be.at.most((rc * MAX_W * NEG_MULT) / WAD);

        // I6: per-owner active counts.
        const owned = ownerMemories.get(a.address);
        const live = owned.filter((h) => !memories.get(h).revoked).length;
        expect(await ledger.activeMemoryCount(a.address)).to.equal(BigInt(live));
        expect(await ledger.getOwnerMemoryCount(a.address)).to.equal(BigInt(owned.length));
      }

      expect(await ledger.totalMemoryCount()).to.equal(BigInt(totalMemories));
      expect(await ledger.totalRevokedCount()).to.equal(BigInt(totalRevoked));

      // I9: the funds invariant - there is no receive()/fallback(), so this is exact.
      expect(await ethers.provider.getBalance(await reputation.getAddress())).to.equal(
        (await reputation.treasuryBalance()) + escrowed,
      );

      // I10: the ring never grows past its capacity, whatever the lifetime count.
      expect(await reputation.getTrustLogLength()).to.equal(BigInt(trustEvents));
      const retained = Math.min(TRUST_LOG_CAPACITY, trustEvents);
      if (retained > 0) {
        const [page] = await reputation.getTrustEvents(0, retained);
        expect(page.length).to.equal(retained);
      }

      if (!deep) return;

      for (const a of agents) {
        const owned = ownerMemories.get(a.address);
        // I7: paging in chunks of 7 reconstructs the exact ordered list.
        const rebuilt = [];
        for (let offset = 0; offset < Math.max(owned.length, 1); offset += 7) {
          const [page, total] = await ledger.getOwnerMemories(a.address, offset, 7);
          expect(total).to.equal(BigInt(owned.length));
          rebuilt.push(...page);
        }
        expect(rebuilt).to.deep.equal(owned);
      }

      // I8: every stored version is exactly parent.version + 1, or 1 for a root.
      for (const [hash, m] of memories) {
        const record = await ledger.getMemory(hash);
        const expectedVersion = m.prev === ethers.ZeroHash ? 1 : memories.get(m.prev).version + 1;
        expect(record.version).to.equal(BigInt(expectedVersion));
        expect(m.version).to.equal(expectedVersion);
        expect(record.owner).to.equal(m.owner);
        expect(record.revoked).to.equal(m.revoked);
      }
    }

    for (let i = 0; i < ITERATIONS; i++) {
      const action = rnd(9);
      const from = pick(agents);
      const to = pick(agents);
      const knownHashes = [...memories.keys()];

      switch (action) {
        case 0:
        case 1: {
          // A fresh CID most of the time, a known one occasionally (to hit MemoryAlreadyExists).
          const reuseCid = knownHashes.length > 0 && rnd(5) === 0;
          const cidString = reuseCid ? memories.get(pick(knownHashes)).cid : cid(cidCounter++);
          const hash = ethers.id(cidString);
          const prev = knownHashes.length > 0 && rnd(3) === 0 ? pick(knownHashes) : ethers.ZeroHash;
          const inp = input(cidString, prev);

          let call;
          if (action === 0) {
            call = () => commitWithPrecommit(ledger, from, inp);
          } else {
            const dl = await deadline();
            const { signature } = await signMemoryCommit(from, ledger, {
              agent: from.address,
              input: inp,
              deadline: dl,
            });
            call = () =>
              ledger.connect(ctx.relayer).commitMemoryFor(from.address, inp, dl, signature);
          }

          const outcome = await attempt(call, iface);
          if (outcome.ok) {
            const version = prev === ethers.ZeroHash ? 1 : memories.get(prev).version + 1;
            memories.set(hash, {
              owner: from.address,
              revoked: false,
              version,
              prev,
              cid: cidString,
            });
            ownerMemories.get(from.address).push(hash);
            totalMemories += 1;
          } else {
            expect(outcome.kind, `commit: ${outcome.message}`).to.equal('custom');
            expect(ALLOWED.has(outcome.name), `commit raised ${outcome.name}`).to.equal(true);
          }
          break;
        }

        case 2: {
          if (knownHashes.length === 0) break;
          const hash = pick(knownHashes);
          const outcome = await attempt(
            () => ledger.connect(from).revokeMemory(hash, ethers.encodeBytes32String('fuzz')),
            iface,
          );
          if (outcome.ok) {
            memories.get(hash).revoked = true;
            totalRevoked += 1;
          } else {
            expect(outcome.kind, `revoke: ${outcome.message}`).to.equal('custom');
            expect(ALLOWED.has(outcome.name), `revoke raised ${outcome.name}`).to.equal(true);
          }
          break;
        }

        case 3: {
          const outcome = await attempt(
            () => reputation.connect(from).endorseAgent(to.address, 'fuzz', { value: STAKE }),
            iface,
          );
          if (outcome.ok) {
            endorsements.set(key(from.address, to.address), true);
            escrowed += STAKE;
            trustEvents += 1;
          } else {
            expect(outcome.kind, `endorse: ${outcome.message}`).to.equal('custom');
            expect(ALLOWED.has(outcome.name), `endorse raised ${outcome.name}`).to.equal(true);
          }
          break;
        }

        case 4: {
          const outcome = await attempt(
            () => reputation.connect(from).revokeEndorsement(to.address, 'fuzz'),
            iface,
          );
          if (outcome.ok) {
            endorsements.set(key(from.address, to.address), false);
            trustEvents += 1;
          } else {
            expect(outcome.kind, `revokeEndorsement: ${outcome.message}`).to.equal('custom');
            expect(ALLOWED.has(outcome.name), `revokeEndorsement raised ${outcome.name}`).to.equal(
              true,
            );
          }
          break;
        }

        case 5: {
          const hadEndorsement = endorsements.get(key(from.address, to.address)) === true;
          const outcome = await attempt(
            () => reputation.connect(from).reportAgent(to.address, 'fuzz'),
            iface,
          );
          if (outcome.ok) {
            reports.set(key(from.address, to.address), true);
            trustEvents += 1;
            if (hadEndorsement) {
              // Filing a report tears down the reporter's own endorsement in the same transaction,
              // which is a second trust event.
              endorsements.set(key(from.address, to.address), false);
              trustEvents += 1;
            }
          } else {
            expect(outcome.kind, `report: ${outcome.message}`).to.equal('custom');
            expect(ALLOWED.has(outcome.name), `report raised ${outcome.name}`).to.equal(true);
          }
          break;
        }

        case 6: {
          const outcome = await attempt(
            () => reputation.connect(from).withdrawReport(to.address, 'fuzz'),
            iface,
          );
          if (outcome.ok) {
            reports.set(key(from.address, to.address), false);
            trustEvents += 1;
          } else {
            expect(outcome.kind, `withdrawReport: ${outcome.message}`).to.equal('custom');
            expect(ALLOWED.has(outcome.name), `withdrawReport raised ${outcome.name}`).to.equal(
              true,
            );
          }
          break;
        }

        case 7: {
          const outcome = await attempt(
            () => reputation.connect(outsider).settle(to.address),
            iface,
          );
          expect(outcome.ok, `settle: ${outcome.message ?? ''}`).to.equal(true);
          break;
        }

        default: {
          await time.increase(60 + rnd(30 * 24 * 3600));
          break;
        }
      }

      await checkInvariants(i % 50 === 49);
    }

    await checkInvariants(true);
    // The walk must actually have done work, or the invariants are vacuous.
    expect(totalMemories).to.be.greaterThan(10);
    expect(trustEvents).to.be.greaterThan(10);
  });

  it('rejects 100 byte-mutated signatures without moving totalMemoryCount', async function () {
    this.timeout(300000);
    const { ledger, relayer, agentA } = ctx;
    const errsIface = ctx.errs.interface;

    const inp = input(cid(5000));
    const dl = await deadline();
    const { signature } = await signMemoryCommit(agentA, ledger, {
      agent: agentA.address,
      input: inp,
      deadline: dl,
    });

    const before = await ledger.totalMemoryCount();
    let s = 7;
    const rnd = (n) => (s = (s * 1103515245 + 12345) % 2147483648) % n;

    for (let i = 0; i < 100; i++) {
      const mutated = flipByte(signature, rnd(65));
      const outcome = await attempt(
        () => ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, mutated),
        errsIface,
      );
      expect(outcome.ok, `mutation ${i} was accepted`).to.equal(false);
      expect(outcome.kind, `mutation ${i}: ${outcome.message}`).to.equal('custom');
      expect(['InvalidSignature'], `mutation ${i} raised ${outcome.name}`).to.include(outcome.name);
    }

    expect(await ledger.totalMemoryCount()).to.equal(before);
    expect(await ledger.nonces(agentA.address)).to.equal(0n);

    // The untouched signature still works, proving the mutations were the only thing wrong.
    await ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature);
    expect(await ledger.totalMemoryCount()).to.equal(before + 1n);
  });
});
