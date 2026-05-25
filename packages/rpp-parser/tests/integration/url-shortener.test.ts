// End-to-end test: the URL-shortener R++ that the writing skill produced.
// Verifies the parser catches the 3 undefined-component errors that the
// writing skill's Step 9 manual review missed.

import { describe, it, expect } from 'vitest';
import { parse, validate } from '../../src/index.js';

const URL_SHORTENER_RPP = `
TARGET {
  output: "REST API for URL shortening with click tracking and per-user rate limit"
  lang: Python + FastAPI
  profile: api
}

TOKENS {
  shortCodeLen:6 | shortCodeAlphabet:"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  maxUrlBytes:2048 | redirectStatus:302
  dailyUrlCap:100 | rateWindowHours:24
  apiBase:"/api/v1"
  dbTableUrls:"urls" | dbTableClicks:"clicks"
  errCodeRateLimit:"RATE_LIMIT_EXCEEDED" | errCodeNotFound:"SHORT_CODE_NOT_FOUND" | errCodeInvalidUrl:"INVALID_URL"
}

STRUCTURE {
  API: sequence
    AuthMiddleware
    RateLimiter: optional
    Routes: sequence
      [ShortenUrlRoute] [GetStatsRoute] [RedirectRoute]
    ErrorHandler
}

COMPONENT ShortenUrlRoute {
  method: POST
  path: TOKENS.apiBase + "/shorten"
}

COMPONENT GetStatsRoute {
  method: GET
  path: TOKENS.apiBase + "/stats/:code"
}

COMPONENT RedirectRoute {
  method: GET
  path: "/:code"
}

CHECKLIST {
  [ ] every endpoint returns appropriate status codes
  [ ] auth middleware applied to /api/v1/shorten and /api/v1/stats/:code
  [ ] short_code generation uses secrets.choice (cryptographically secure, not random.choice)
}
`;

describe('URL-shortener regression — end-to-end writing-skill validation loop', () => {
  it('parses cleanly at the syntactic level', () => {
    const { ast, diagnostics } = parse(URL_SHORTENER_RPP);
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors).toEqual([]);
    expect(ast.blocks.length).toBe(7); // TARGET + TOKENS + STRUCTURE + 3 COMPONENT + CHECKLIST
  });

  it('flags undefined components as WARNINGS (not errors) — they may be engine-provided primitives', () => {
    const { ast } = parse(URL_SHORTENER_RPP);
    const semanticDiagnostics = validate(ast);
    const undefinedComponent = semanticDiagnostics.filter(d => d.code === 'undefined-component');

    // Step 9 (manual review) missed: AuthMiddleware, RateLimiter, ErrorHandler in STRUCTURE.
    // Validator surfaces them as warnings — consumer decides if they're missing or
    // engine-provided.
    const flaggedNames = undefinedComponent.map(d => d.data?.['name']).sort();
    expect(flaggedNames).toContain('AuthMiddleware');
    expect(flaggedNames).toContain('RateLimiter');
    expect(flaggedNames).toContain('ErrorHandler');

    // Default severity is warning, not error
    for (const d of undefinedComponent) {
      expect(d.severity).toBe('warning');
    }
  });

  it('strict mode elevates undefined components to errors', () => {
    const { ast } = parse(URL_SHORTENER_RPP);
    const semanticDiagnostics = validate(ast, { strictComponentResolution: true });
    const undefinedComponent = semanticDiagnostics.filter(d => d.code === 'undefined-component');
    expect(undefinedComponent.length).toBeGreaterThan(0);
    for (const d of undefinedComponent) {
      expect(d.severity).toBe('error');
    }
  });

  it('externalNames whitelist suppresses warnings for engine-provided primitives', () => {
    const { ast } = parse(URL_SHORTENER_RPP);
    const enginePrimitives = ['AuthMiddleware', 'RateLimiter', 'ErrorHandler', 'Routes', 'API'];
    const semanticDiagnostics = validate(ast, { externalNames: enginePrimitives });
    const undefinedComponent = semanticDiagnostics.filter(d => d.code === 'undefined-component');
    expect(undefinedComponent).toEqual([]);
  });

  it('Step 10 loop demonstration — adding the missing components clears the warnings', () => {
    const FIXED = URL_SHORTENER_RPP +
      `

COMPONENT AuthMiddleware {
  body: validate Authorization header
}

COMPONENT RateLimiter {
  body: enforce TOKENS.dailyUrlCap
}

COMPONENT ErrorHandler {
  body: format errors
}

COMPONENT Routes {
  body: route group
}

COMPONENT API {
  body: top-level
}
`;
    const { ast, diagnostics } = parse(FIXED);
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors).toEqual([]);
    const semanticDiagnostics = validate(ast);
    const undefinedComponent = semanticDiagnostics.filter(d => d.code === 'undefined-component');
    expect(undefinedComponent).toEqual([]);
  });
});
