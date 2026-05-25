import { randomUUID } from 'node:crypto';

import type { JobsService} from '@runcor/jobs';
import { type Job } from '@runcor/jobs';
import type { SkillStore} from '@runcor/skills';
import { surfaceActiveHandles, type SkillHandle } from '@runcor/skills';

import type {
  ConverseAck,
  ConverseRequest,
  DelegateRequest,
  DelegateResponse,
  EssenceResponse,
  SkillListItem,
} from './types.js';

/**
 * MCP self-exposure (intent §15.1).
 *
 * The lattice exposes ONLY these tools to authenticated peers:
 *   - essence  — read-only one-sentence "who am I"
 *   - converse — incoming message; opens/extends a conversation JOB
 *   - delegate — incoming job; routes into decide; accept/reject
 *   - skills_list / skills_get — read-only, opt-in
 *
 * What is NOT exposed: memory, the trace, SQLite, dials, substrate.
 *
 * Slice 13 ships these as plain TS functions. The MCP transport
 * (real `@modelcontextprotocol/sdk` server) wraps them in slice 14.
 */

export interface SelfExposureOptions {
  readonly lattice_id: string;
  readonly name: string;
  readonly essence: string;
  readonly jobs: JobsService;
  readonly skills: SkillStore;
  /** Whether peers may list/get our skills. Defaults to false (opt-in). */
  readonly skillsExposed?: boolean;
}

export interface IncomingContext {
  readonly cycle: number;
  readonly at_ms: number;
}

export class SelfExposure {
  readonly lattice_id: string;
  readonly name: string;
  readonly essence: string;
  private readonly jobs: JobsService;
  private readonly skills: SkillStore;
  private readonly skillsExposed: boolean;
  private readonly conversationJobs = new Map<string, string>(); // conversation_id → jobId

  constructor(opts: SelfExposureOptions) {
    this.lattice_id = opts.lattice_id;
    this.name = opts.name;
    this.essence = opts.essence;
    this.jobs = opts.jobs;
    this.skills = opts.skills;
    this.skillsExposed = opts.skillsExposed ?? false;
  }

  // ---------------- essence ----------------

  essenceResponse(): EssenceResponse {
    return {
      lattice_id: this.lattice_id,
      name: this.name,
      essence: this.essence,
    };
  }

  // ---------------- converse ----------------

  /**
   * Receives a message from a peer. Opens (or extends) a conversation
   * JOB on OUR plan; subsequent cycles advance it.
   */
  converse(req: ConverseRequest, ctx: IncomingContext): ConverseAck {
    let conversation_id = req.conversation_id;
    let jobId: string | undefined;

    if (conversation_id) {
      jobId = this.conversationJobs.get(conversation_id);
    }

    if (!jobId) {
      conversation_id = conversation_id ?? randomUUID();
      const job: Job = this.jobs.openJob({
        title: `conversation with ${req.from_lattice_id}`,
        source: `conversation:${req.from_lattice_id}`,
        why: `incoming converse: conversation_id=${conversation_id}`,
        cycle: ctx.cycle,
        at_ms: ctx.at_ms,
      });
      jobId = job.id;
      this.conversationJobs.set(conversation_id, jobId);
    }

    // Each incoming message becomes a new open item on the conversation job.
    this.jobs.addItem(jobId, {
      description: `respond to: ${truncate(req.message_rpp, 200)}`,
      spec: { hooks: [{ name: 'always_pass' }] },
    });

    return {
      ack: true,
      conversation_id: conversation_id!,
      received_at_cycle: ctx.cycle,
    };
  }

  // ---------------- delegate ----------------

  /**
   * Receives a delegated job spec. Standing/policy checks happen
   * BEFORE this is called (the caller has already passed the
   * substrate); here we just decide whether to accept the work.
   */
  delegate(req: DelegateRequest, ctx: IncomingContext): DelegateResponse {
    if (req.job.items.length === 0) {
      return { accepted: false, reason: 'empty checklist' };
    }
    const job = this.jobs.openJob({
      title: req.job.title,
      source: `delegation:${req.from_lattice_id}`,
      why: req.job.why || `delegated by ${req.from_lattice_id}`,
      cycle: ctx.cycle,
      at_ms: ctx.at_ms,
    });
    for (const it of req.job.items) {
      this.jobs.addItem(job.id, {
        description: it.description,
        spec: JSON.parse(it.completion_check),
      });
    }
    return { accepted: true, job_id: job.id };
  }

  // ---------------- skills_list / skills_get (opt-in) ----------------

  skillsList(): readonly SkillListItem[] {
    if (!this.skillsExposed) return [];
    return surfaceActiveHandles(this.skills).map(
      (h: SkillHandle): SkillListItem => ({
        name: h.name,
        description: h.description,
        abstraction: h.abstraction,
        minted_at_cycle: 0, // skills_list publishes a handle; full doc via skills_get
      }),
    );
  }

  skillsGet(name: string): { body_rpp: string } | null {
    if (!this.skillsExposed) return null;
    const all = this.skills.all().filter((s) => s.name === name && s.active === 1);
    const first = all[0];
    if (!first) return null;
    return { body_rpp: first.body_rpp };
  }

  /** Test-only inspection helper. */
  conversationJobIdFor(conversation_id: string): string | undefined {
    return this.conversationJobs.get(conversation_id);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
