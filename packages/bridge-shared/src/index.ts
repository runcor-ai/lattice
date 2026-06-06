import { z } from 'zod';

/**
 * Bridge HTTP API schemas (spec FR-051..056 + contracts/bridge-http-api.md).
 * Shared by the Fastify API and the Vue UI so payload shapes can never drift.
 */

/* -------------------- Dials -------------------- */

export const DialNameSchema = z.enum([
  'autonomy',
  'exploration',
  'memoryDurability',
  'promotionThreshold',
  'memoryRecallBreadth',
  'planStability',
  'dialecticDepth',
  'reviewCadence',
  'drivePressure',
  'riskTolerance',
  'budget',
]);
export type DialName = z.infer<typeof DialNameSchema>;

export const AutonomySchema = z.enum(['low', 'medium', 'high']);
export type AutonomyValue = z.infer<typeof AutonomySchema>;

export const DialValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.unknown()),
]);

export const DialAdjustmentSchema = z.object({
  dials: z.record(DialValueSchema),
  why: z.string().min(1),
});
export type DialAdjustment = z.infer<typeof DialAdjustmentSchema>;

/* -------------------- Tool manifest -------------------- */

export const ManifestEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum([
    'echo',
    'noop',
    'fs-read',
    'fs-read-content',
    'fs-write',
    'shell-exec',
    'claude-delegate',
    'api',
    'mcp',
  ]),
  description: z.string().optional(),
  role: z.object({ sense: z.boolean(), action: z.boolean() }).optional(),
  readOnly: z.boolean().optional(),
  destructive: z.boolean().optional(),
  concurrencySafe: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

/* -------------------- Model backend -------------------- */

export const ModelBackendSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('direct-api'),
    config: z
      .object({
        provider: z.enum(['anthropic', 'openai']).default('anthropic'),
        model: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('claude-code-host'),
    config: z.object({ command: z.string().optional(), args: z.array(z.string()).optional() }).optional(),
  }),
  z.object({
    kind: z.literal('stub'),
    config: z.record(z.unknown()).optional(),
  }),
]);
export type ModelBackendSpec = z.infer<typeof ModelBackendSpecSchema>;

/* -------------------- Snapshot destination -------------------- */

export const SnapshotDestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-folder'), config: z.object({ path: z.string().min(1) }) }),
  z.object({ kind: z.literal('none'), config: z.object({}).optional() }),
]);
export type SnapshotDest = z.infer<typeof SnapshotDestSchema>;

/* -------------------- Instantiate -------------------- */

export const InstantiateSchema = z.object({
  name: z.string().min(1).max(80),
  identity_seed: z.string().min(1),
  /** Item 11 — ordered persona bundle names composed (with identity_seed appended) into Layer 1. */
  persona_bundles: z.array(z.string().min(1)).optional(),
  /** Item 10 — Layer 2 (init) seed content, promoted to memory once at startup. */
  init_seed: z.string().optional(),
  goals: z.array(z.string().min(1)).default([]),
  dials: z.record(DialValueSchema).default({}),
  tool_manifest: z.array(ManifestEntrySchema).default([]),
  model_backend: ModelBackendSpecSchema,
  snapshot: SnapshotDestSchema.optional(),
  bundle_id: z.string().optional(),
  autonomy: AutonomySchema.default('medium'),
  dialecticDepth: z.number().int().min(0).max(5).default(0),
  /**
   * Optional absolute path to an existing SQLite file the lattice
   * should resume from. The lattice's entity row's cycle counter is
   * the starting point — the new run continues from cycle+1 with
   * full memory, plan_item, and identity state intact. The lattice
   * id is derived from the file's basename (without .sqlite).
   *
   * Honours Constitution Principle II ("the database IS the entity"):
   * a running program is disposable, persistence is the entity itself,
   * and instantiation against an existing entity-file is just
   * "open the entity again."
   */
  resume_from_path: z.string().optional(),
});
export type InstantiateRequest = z.infer<typeof InstantiateSchema>;

export const InstantiateResponseSchema = z.object({
  lattice_id: z.string(),
  sqlite_path: z.string(),
  pids: z.object({ fast: z.number().int(), slow: z.number().int().optional() }),
  trace_stream_url: z.string(),
});
export type InstantiateResponse = z.infer<typeof InstantiateResponseSchema>;

/* -------------------- Roster + inspect -------------------- */

export const LatticeStatusSchema = z.enum(['running', 'paused', 'stopped', 'crashed', 'paused_no_jobs']);
export type LatticeStatus = z.infer<typeof LatticeStatusSchema>;

export const RosterRowSchema = z.object({
  lattice_id: z.string(),
  name: z.string(),
  status: LatticeStatusSchema,
  cycle: z.number().int(),
  open_jobs: z.number().int(),
  current_plan_summary: z.string(),
  goals_summary: z.array(z.string()),
  budget: z
    .object({ unit: z.string(), ceiling: z.number(), spent: z.number() })
    .nullable(),
  model_backend: z.string(),
  pids: z.object({
    fast: z.number().int().nullable(),
    slow: z.number().int().nullable(),
  }),
  autonomy: AutonomySchema,
});
export type RosterRow = z.infer<typeof RosterRowSchema>;

export const InspectResponseSchema = RosterRowSchema.extend({
  identity: z.object({ composed_body: z.string(), at_cycle: z.number().int() }),
  memory_summary: z.object({
    identity_count: z.number().int(),
    plan_jobs_open: z.number().int(),
    plan_jobs_closed: z.number().int(),
    episodic_count: z.number().int(),
    semantic_count: z.number().int(),
  }),
  dials: z.record(DialValueSchema),
  recent_decisions: z.array(z.record(z.unknown())),
  drift_history: z.array(z.record(z.unknown())),
});
export type InspectResponse = z.infer<typeof InspectResponseSchema>;

/* -------------------- Trace -------------------- */

export const TraceEntrySchema = z.record(z.unknown());
export type TraceEntryShape = z.infer<typeof TraceEntrySchema>;

export const TraceQuerySchema = z.object({
  after_cycle: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  kind: z.enum(['phase', 'subconscious', 'job', 'substrate', 'operator']).optional(),
  phase: z
    .enum(['observe', 'ground', 'recall', 'decide', 'act', 'judge', 'write', 'pulse'])
    .optional(),
});
export type TraceQuery = z.infer<typeof TraceQuerySchema>;

/* -------------------- Jobs / escalations -------------------- */

export const JobsHandSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  why: z.string().min(1),
  items: z
    .array(
      z.object({
        description: z.string().min(1),
        completion_check: z.string().min(1),
      }),
    )
    .optional(),
});
export type JobsHand = z.infer<typeof JobsHandSchema>;

/** Item 8 — the lattice appends one item to an existing open job. */
export const AppendItemSchema = z.object({
  description: z.string().min(1),
  gate: z.object({
    type: z.string().min(1),
    args: z.record(z.unknown()).optional(),
  }),
  blocked_by: z.string().optional(),
  why: z.string().optional(),
});
export type AppendItem = z.infer<typeof AppendItemSchema>;

export const EscalationDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  operator_note: z.string().optional(),
});
export type EscalationDecision = z.infer<typeof EscalationDecisionSchema>;

/* -------------------- Companies (slice 15) -------------------- */

export const CompanyInstantiateSchema = z.object({
  members: z
    .array(
      z.object({
        bundle_id: z.string(),
        name_override: z.string().optional(),
        seed_prompt_override: z.string().optional(),
        budget: z.object({ unit: z.string(), ceiling: z.number() }).optional(),
      }),
    )
    .min(1),
  shared_source_of_truth: z
    .object({ uri: z.string().url(), auth: z.record(z.string()).optional() })
    .optional(),
  registry: z.object({ url: z.string().url() }).optional(),
});
export type CompanyInstantiate = z.infer<typeof CompanyInstantiateSchema>;

/* -------------------- Bundles (slice 15) -------------------- */

export {
  BundleDefaultsSchema,
  StartingKnowledgeSchema,
  type Bundle,
  type BundleDefaults,
  type StartingKnowledge,
} from './bundle.js';

/* -------------------- Errors -------------------- */

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
