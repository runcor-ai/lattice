import { JobsService } from '@runcor/jobs';
import { SkillStore, mint } from '@runcor/skills';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import {
  InMemoryPeerRegistry,
  InProcessDelegateTransport,
  InProcessTransport,
  PeerKnownStore,
  SelfExposure,
  decideStanding,
  delegateTo,
  openConversation,
  say,
  type RegistryEntry,
} from './index.js';

function fresh() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE plan_job (
      id TEXT PRIMARY KEY, opened_at_cycle INTEGER NOT NULL, opened_at_ms INTEGER NOT NULL,
      title TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
      closed_at_cycle INTEGER, closed_at_ms INTEGER, why TEXT NOT NULL
    );
    CREATE TABLE plan_item (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      description TEXT NOT NULL, state TEXT NOT NULL,
      iteration_count INTEGER NOT NULL DEFAULT 0,
      completion_check TEXT NOT NULL,
      passed_at_cycle INTEGER, deferred_at_cycle INTEGER,
      defer_reason TEXT, unblock_condition TEXT, unblock_test TEXT
    );
    CREATE TABLE skill (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      body_rpp TEXT NOT NULL, abstraction TEXT NOT NULL,
      minted_at_cycle INTEGER NOT NULL,
      source_job_id TEXT, source_item_id TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      UNIQUE (name, abstraction)
    );
    CREATE TABLE peer_known (
      id TEXT PRIMARY KEY, essence TEXT NOT NULL, registry_url TEXT NOT NULL,
      first_seen_cycle INTEGER NOT NULL, last_seen_cycle INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL
    );
  `);
  return db;
}

function makeExposure(id: string, name: string, essence: string, opts?: { skillsExposed?: boolean }) {
  const db = fresh();
  const jobs = new JobsService(db);
  const skills = new SkillStore(db);
  return new SelfExposure({
    lattice_id: id,
    name,
    essence,
    jobs,
    skills,
    ...(opts?.skillsExposed !== undefined ? { skillsExposed: opts.skillsExposed } : {}),
  });
}

/* ============================== T236 ============================== */

describe('PeerRegistry round-trip (T236)', () => {
  it('register + list + heartbeat works in memory', async () => {
    const reg = new InMemoryPeerRegistry();
    await reg.register({
      lattice_id: 'a',
      name: 'CEO',
      essence: 'I am the CEO',
      mcp_uri: 'mcp://a:1',
    });
    await reg.register({
      lattice_id: 'b',
      name: 'CFO',
      essence: 'I am the CFO',
      mcp_uri: 'mcp://b:1',
    });
    const all = await reg.list();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.lattice_id).sort()).toEqual(['a', 'b']);
  });

  it('withdraw removes an entry', async () => {
    const reg = new InMemoryPeerRegistry();
    await reg.register({ lattice_id: 'x', name: 'X', essence: 'e', mcp_uri: 'mcp://x' });
    await reg.withdraw!('x');
    expect(await reg.list()).toHaveLength(0);
  });

  it('PeerKnownStore ingests registry entries', () => {
    const db = fresh();
    const store = new PeerKnownStore(db);
    const entries: RegistryEntry[] = [
      {
        lattice_id: 'p1',
        name: 'P1',
        essence: 'sales lattice',
        mcp_uri: 'mcp://x',
        posted_at_ms: 100,
      },
    ];
    store.ingest(entries, { cycle: 5, registry_url: 'mem://' });
    expect(store.size()).toBe(1);
    expect(store.get('p1')?.essence).toBe('sales lattice');
  });
});

/* ============================== Standing (T239) ============================== */

describe('decideStanding — Law 11 gate (T239)', () => {
  it('refuses by default — no licence in own identity', () => {
    const d = decideStanding({
      ownIdentity: 'I am the sales lattice',
      peerEssence: 'I am the CEO',
      peerLatticeId: 'ceo-1',
    });
    expect(d.can_initiate).toBe(false);
    expect(d.reason).toMatch(/Standing/);
  });

  it('admits when peer is a service role (sales / support / intake / etc.)', () => {
    const d = decideStanding({
      ownIdentity: 'I am the CEO',
      peerEssence: 'sales lattice for the company',
      peerLatticeId: 'sales-1',
    });
    expect(d.can_initiate).toBe(true);
  });

  it('admits when own identity explicitly licences engagement', () => {
    const d = decideStanding({
      ownIdentity: 'I am the CEO; I may engage the CFO on financial questions.',
      peerEssence: 'I am the CFO',
      peerLatticeId: 'cfo-1',
    });
    expect(d.can_initiate).toBe(true);
  });

  it('admits when peer is in preAuthorized list', () => {
    const d = decideStanding({
      ownIdentity: 'I am the sales lattice',
      peerEssence: 'I am the CEO',
      peerLatticeId: 'ceo-1',
      preAuthorized: ['ceo-1'],
    });
    expect(d.can_initiate).toBe(true);
  });
});

/* ============================== T235 ============================== */

describe('SelfExposure (T235 / intent §15.1 exposed surface)', () => {
  it('essence is the one-sentence identity', () => {
    const e = makeExposure('a', 'CEO', 'I am the CEO of the company');
    const r = e.essenceResponse();
    expect(r).toEqual({
      lattice_id: 'a',
      name: 'CEO',
      essence: 'I am the CEO of the company',
    });
  });

  it('converse opens a job + a per-message item; returns conversation_id', () => {
    const e = makeExposure('a', 'A', 'I am A');
    const ack = e.converse(
      { from_lattice_id: 'b', conversation_id: null, message_rpp: 'hello' },
      { cycle: 1, at_ms: 100 },
    );
    expect(ack.ack).toBe(true);
    expect(typeof ack.conversation_id).toBe('string');
    const jobId = e.conversationJobIdFor(ack.conversation_id)!;
    expect(jobId).toBeDefined();
  });

  it('subsequent converse on the same conversation_id reuses the job', () => {
    const e = makeExposure('a', 'A', 'I am A');
    const ack1 = e.converse(
      { from_lattice_id: 'b', conversation_id: null, message_rpp: 'hi' },
      { cycle: 1, at_ms: 100 },
    );
    const ack2 = e.converse(
      { from_lattice_id: 'b', conversation_id: ack1.conversation_id, message_rpp: 'follow up' },
      { cycle: 2, at_ms: 200 },
    );
    expect(ack2.conversation_id).toBe(ack1.conversation_id);
    expect(e.conversationJobIdFor(ack1.conversation_id)).toBe(
      e.conversationJobIdFor(ack2.conversation_id),
    );
  });

  it('delegate opens a job with the requested items', () => {
    const e = makeExposure('worker', 'Worker', 'I am the worker');
    const r = e.delegate(
      {
        from_lattice_id: 'manager',
        job: {
          title: 'do thing',
          body: 'body',
          why: 'because',
          items: [
            { description: 'sub a', completion_check: '{"hooks":[{"name":"always_pass"}]}' },
            { description: 'sub b', completion_check: '{"hooks":[{"name":"always_pass"}]}' },
          ],
        },
      },
      { cycle: 1, at_ms: 100 },
    );
    expect(r.accepted).toBe(true);
  });

  it('delegate rejects empty checklist', () => {
    const e = makeExposure('w', 'W', 'I am W');
    const r = e.delegate(
      {
        from_lattice_id: 'm',
        job: { title: 'empty', body: '', why: 'y', items: [] },
      },
      { cycle: 1, at_ms: 1 },
    );
    expect(r.accepted).toBe(false);
  });

  it('skills_list returns nothing when skillsExposed is false (default)', () => {
    const e = makeExposure('a', 'A', 'I am A');
    expect(e.skillsList()).toEqual([]);
    expect(e.skillsGet('anything')).toBeNull();
  });

  it('skills_list returns active skills when opted in', () => {
    const db = fresh();
    const jobs = new JobsService(db);
    const skills = new SkillStore(db);
    mint(
      skills,
      [{ item_id: 'i', description: 'send-email', completion_check: '{}', job_id: 'j' }],
      { cycle: 1 },
    );
    for (const s of skills.all()) skills.activate(s.id);

    const e = new SelfExposure({
      lattice_id: 'a',
      name: 'A',
      essence: 'I am A',
      jobs,
      skills,
      skillsExposed: true,
    });
    const list = e.skillsList();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]?.description).toBeDefined();
  });
});

/* ============================== T237 ============================== */

describe('Conversation as a job (T237)', () => {
  it('openConversation respects Law 11 (Standing) before opening the job', async () => {
    const peerEntry: RegistryEntry = {
      lattice_id: 'ceo-1',
      name: 'CEO',
      essence: 'I am the CEO',
      mcp_uri: 'mcp://x',
      posted_at_ms: 0,
    };
    const jobs = new JobsService(fresh());
    const result = await openConversation({
      peerEntry,
      fromLatticeId: 'sales-1',
      fromIdentity: 'I am the sales lattice',
      transport: new InProcessTransport(),
      jobs,
      cycle: 1,
    });
    expect(result.result).toBe('blocked_by_standing');
  });

  it('opens a conversation when standing permits', async () => {
    const peerEntry: RegistryEntry = {
      lattice_id: 'cfo-1',
      name: 'CFO',
      essence: 'I am the CFO',
      mcp_uri: 'mcp://x',
      posted_at_ms: 0,
    };
    const jobs = new JobsService(fresh());
    const result = await openConversation({
      peerEntry,
      fromLatticeId: 'ceo-1',
      fromIdentity: 'I am the CEO; I may engage the CFO',
      transport: new InProcessTransport(),
      jobs,
      cycle: 1,
    });
    expect(result.result).toBe('opened');
    if (result.result === 'opened') {
      expect(result.handle.peer_lattice_id).toBe('cfo-1');
    }
  });

  it('say() defers the conversation item when the peer is silent (transport throws)', async () => {
    const peerEntry: RegistryEntry = {
      lattice_id: 'cfo-1',
      name: 'CFO',
      essence: 'sales lattice',
      mcp_uri: 'mcp://x',
      posted_at_ms: 0,
    };
    const jobs = new JobsService(fresh());
    const opened = await openConversation({
      peerEntry,
      fromLatticeId: 'ceo-1',
      fromIdentity: 'I am the CEO',
      transport: new InProcessTransport(),
      jobs,
      cycle: 1,
    });
    if (opened.result !== 'opened') throw new Error('expected opened');
    // Add a first message-item then try to say something to a peer not attached.
    jobs.addItem(opened.handle.job_id, {
      description: 'first message',
      spec: { hooks: [{ name: 'always_pass' }] },
    });
    const r = await say({
      handle: opened.handle,
      fromLatticeId: 'ceo-1',
      message_rpp: 'TARGET { output: "hi" }',
      transport: new InProcessTransport(), // empty, will throw on converse
      jobs,
      cycle: 5,
    });
    expect(r.result).toBe('peer_silent');
    const items = jobs.checklist.items(opened.handle.job_id);
    const deferredItem = items.find((i) => i.state === 'deferred');
    expect(deferredItem).toBeDefined();
    expect(deferredItem?.defer_reason).toMatch(/silence/);
    expect(deferredItem?.unblock_test).toContain('cycle_after');
  });

  it('say() returns acked when transport succeeds', async () => {
    const peer = makeExposure('cfo-1', 'CFO', 'sales lattice CFO');
    const transport = new InProcessTransport();
    transport.attach(peer);

    const peerEntry: RegistryEntry = {
      lattice_id: 'cfo-1',
      name: 'CFO',
      essence: 'sales lattice CFO',
      mcp_uri: 'mcp://cfo:1',
      posted_at_ms: 0,
    };
    const jobs = new JobsService(fresh());
    const opened = await openConversation({
      peerEntry,
      fromLatticeId: 'ceo-1',
      fromIdentity: 'I am the CEO',
      transport,
      jobs,
      cycle: 1,
    });
    if (opened.result !== 'opened') throw new Error('expected opened');

    const r = await say({
      handle: opened.handle,
      fromLatticeId: 'ceo-1',
      message_rpp: 'TARGET { output: "hi" }',
      transport,
      jobs,
      cycle: 2,
    });
    expect(r.result).toBe('acked');
  });
});

/* ============================== T238 ============================== */

describe('Delegation flow (T238)', () => {
  it('delegateTo with valid standing opens a tracking job on the caller; remote job opens on peer', async () => {
    const peer = makeExposure('worker-1', 'Worker', 'sales lattice worker');
    const transport = new InProcessDelegateTransport();
    transport.attach(peer);

    const peerEntry: RegistryEntry = {
      lattice_id: 'worker-1',
      name: 'Worker',
      essence: 'sales lattice worker',
      mcp_uri: 'mcp://w:1',
      posted_at_ms: 0,
    };
    const callerJobs = new JobsService(fresh());

    const result = await delegateTo({
      peerEntry,
      fromLatticeId: 'manager-1',
      fromIdentity: 'I am the manager',
      job: {
        title: 'sub-work',
        body: 'b',
        why: 'because',
        items: [
          { description: 'do thing', completion_check: '{"hooks":[{"name":"always_pass"}]}' },
        ],
      },
      transport,
      jobs: callerJobs,
      cycle: 1,
    });
    expect(result.result).toBe('delegated');
    if (result.result === 'delegated') {
      // Caller has a tracking job with a deferred item.
      const tracking = callerJobs.checklist.getJob(result.local_tracking_job_id)!;
      expect(tracking.title).toContain('delegated');
      const items = callerJobs.checklist.items(tracking.id);
      expect(items[0]?.state).toBe('deferred');
      expect(items[0]?.unblock_test).toContain('sense_data_contains');
    }
  });

  it('delegateTo refuses when standing forbids', async () => {
    const peer = makeExposure('ceo-1', 'CEO', 'I am the CEO');
    const transport = new InProcessDelegateTransport();
    transport.attach(peer);

    const callerJobs = new JobsService(fresh());
    const result = await delegateTo({
      peerEntry: {
        lattice_id: 'ceo-1',
        name: 'CEO',
        essence: 'I am the CEO',
        mcp_uri: 'mcp://c:1',
        posted_at_ms: 0,
      },
      fromLatticeId: 'intern-1',
      fromIdentity: 'I am an intern',
      job: {
        title: 'do my taxes',
        body: '',
        why: 'help',
        items: [{ description: 'thing', completion_check: '{"hooks":[]}' }],
      },
      transport,
      jobs: callerJobs,
      cycle: 1,
    });
    expect(result.result).toBe('blocked_by_standing');
  });
});
