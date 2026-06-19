import {
  ModelBackendError,
  type CostEstimate,
  type ModelBackend,
  type ModelCallRequest,
  type ModelCallResult,
} from './types.js';

/**
 * OpenRouterBackend — a ModelBackend that calls OpenRouter's
 * OpenAI-compatible chat-completions endpoint over plain `fetch`
 * (no SDK). Used to give the dialectic a SECOND voice (a non-Claude
 * coach) distinct from the primary claude-code-host player/judge.
 *
 * The API key is read from `OPENROUTER_API_KEY` (or an injected
 * `apiKey`) and is sent only in the Authorization header — it is
 * never placed in an error message, log, or the trace.
 */

export interface OpenRouterOptions {
  /** OpenRouter model id, e.g. 'openai/gpt-4o'. */
  readonly model: string;
  /** Defaults to process.env.OPENROUTER_API_KEY. */
  readonly apiKey?: string;
  /** Defaults to https://openrouter.ai/api/v1. */
  readonly baseUrl?: string;
  /** Request timeout; default 120_000ms. */
  readonly timeoutMs?: number;
  /** Override fetch (tests inject a mock). */
  readonly fetchImpl?: typeof fetch;
  readonly name?: string;
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
    readonly finish_reason?: string;
  }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly error?: { readonly message?: string };
}

function mapFinish(reason: string | undefined): ModelCallResult['finishReason'] {
  switch (reason) {
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'stop':
    default: return 'stop';
  }
}

export class OpenRouterBackend implements ModelBackend {
  readonly name: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenRouterOptions) {
    if (!opts.model) throw new Error('OpenRouterBackend: model is required');
    const key = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    if (!key) {
      throw new ModelBackendError('openrouter: OPENROUTER_API_KEY not set', 'auth');
    }
    this.model = opts.model;
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? `openrouter:${this.model}`;
  }

  async call(req: ModelCallRequest): Promise<ModelCallResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.abortSignal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'runcor-lattice',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: String(req.prompt) }],
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (req.abortSignal?.aborted) throw new ModelBackendError('openrouter: aborted', 'aborted');
      // timeout aborts land here too
      throw new ModelBackendError(
        `openrouter: request failed: ${err instanceof Error ? err.message : String(err)}`,
        controller.signal.aborted ? 'aborted' : 'network',
      );
    } finally {
      clearTimeout(timer);
      req.abortSignal?.removeEventListener('abort', onAbort);
    }

    if (!res.ok) {
      // Read the body for a reason but NEVER echo the key (it is not in the body).
      const bodyText = await res.text().catch(() => '');
      const kind =
        res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? 'rate_limited'
        : res.status >= 500 ? 'network'
        : 'invalid_request';
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new ModelBackendError(
        `openrouter: HTTP ${res.status} ${res.statusText} ${bodyText.slice(0, 300)}`,
        kind,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    if (!text) {
      throw new ModelBackendError(
        `openrouter: empty completion${data.error?.message ? ` (${data.error.message})` : ''}`,
        'invalid_request',
      );
    }

    return {
      text,
      usage: {
        input: data.usage?.prompt_tokens ?? Math.ceil(String(req.prompt).length / 4),
        output: data.usage?.completion_tokens ?? Math.ceil(text.length / 4),
      },
      modelUsed: this.name,
      finishReason: mapFinish(choice?.finish_reason),
    };
  }

  estimateCost(req: ModelCallRequest): CostEstimate {
    // Per-token pricing varies by model on OpenRouter; report a rough token estimate.
    return { unit: 'tokens', amount: Math.ceil(String(req.prompt).length / 4) + (req.maxTokens ?? 1024), confidence: 'low' };
  }
}
