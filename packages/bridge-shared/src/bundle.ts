import { z } from 'zod';

/**
 * Bundle schema (intent §19.2 — prebuilt lattices).
 *
 * A prebuilt lattice is THREE pre-written files under
 * `prebuilt/<role>/`:
 *
 *   seed-prompt.rpp          — who this lattice is in this role
 *   starting-knowledge.json  — context loaded into memory at start
 *   defaults.json            — dial defaults + starting tool manifest
 *
 * The loader reads all three and produces a `Bundle` that the Bridge
 * feeds into the standard instantiate path.
 */

export const BundleDefaultsSchema = z.object({
  autonomy: z.enum(['low', 'medium', 'high']).default('medium'),
  dialecticDepth: z.number().int().min(0).max(5).default(0),
  dials: z.record(z.unknown()).default({}),
  tool_manifest: z
    .array(
      z.object({
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
      }),
    )
    .default([]),
});
export type BundleDefaults = z.infer<typeof BundleDefaultsSchema>;

export const StartingKnowledgeSchema = z.object({
  identity: z.array(z.object({ body: z.string().min(1), why: z.string().min(1) })).default([]),
  semantic: z
    .array(z.object({ body: z.string().min(1), why: z.string().min(1) }))
    .default([]),
});
export type StartingKnowledge = z.infer<typeof StartingKnowledgeSchema>;

export interface Bundle {
  readonly id: string;
  readonly seedPrompt: string;
  readonly startingKnowledge: StartingKnowledge;
  readonly defaults: BundleDefaults;
  readonly description?: string;
}
