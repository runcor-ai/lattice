import type { ActContext, Capability, ObserveContext, PermissionContext } from './types.js';

/**
 * MCP-shaped capability factory (intent §15; spec FR-042).
 *
 * Slice 10 ships an abstract transport interface — `McpTransport` —
 * that the real `@modelcontextprotocol/sdk` client conforms to AND
 * tests can stub. This keeps the SDK out of the capabilities
 * package's hot path (lazy-loaded by the engine layer in slice 12 if
 * needed for real MCP connections).
 *
 * Wraps a single MCP tool as a `Capability`. The capability's
 * `read()` (if a sense) or `invoke()` (if an action) calls the
 * transport's `callTool`.
 */

export interface McpToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface McpTransport {
  readonly uri: string;
  callTool(call: McpToolCall, signal?: AbortSignal): Promise<unknown>;
  close?(): Promise<void>;
}

export interface McpCapabilityOptions {
  readonly name: string;
  readonly description: string;
  readonly transport: McpTransport;
  /** The remote MCP tool name (often matches `name` but not always). */
  readonly toolName: string;
  readonly role: { sense: boolean; action: boolean };
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly concurrencySafe?: boolean;
  readonly enabled?: () => boolean;
  readonly canInvoke?: (ctx: PermissionContext) => { allow: true } | { allow: false; reason: string; escalate: boolean };
}

export function makeMcpCapability<I extends Record<string, unknown> = Record<string, unknown>, O = unknown>(
  opts: McpCapabilityOptions,
): Capability<I, O> {
  const enabledFn = opts.enabled ?? (() => true);
  const permissionFn = opts.canInvoke ?? ((_ctx) => ({ allow: true as const }));

  const read = async (ctx: ObserveContext): Promise<O> => {
    const r = await opts.transport.callTool(
      { name: opts.toolName, arguments: {} },
      ctx.abortSignal,
    );
    return r as O;
  };

  const invoke = async (input: I, ctx: ActContext): Promise<O> => {
    const r = await opts.transport.callTool(
      { name: opts.toolName, arguments: input },
      ctx.abortSignal,
    );
    return r as O;
  };

  const cap: Capability<I, O> = {
    name: opts.name,
    description: opts.description,
    role: opts.role,
    readOnly: opts.readOnly,
    destructive: opts.destructive,
    concurrencySafe: opts.concurrencySafe ?? true,
    isEnabled: enabledFn,
    canInvoke: permissionFn,
    ...(opts.role.sense ? { read } : {}),
    ...(opts.role.action ? { invoke } : {}),
  };
  return cap;
}
