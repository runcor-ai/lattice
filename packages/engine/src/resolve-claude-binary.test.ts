import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { resolveClaudeBinary } from './claude-code-host-backend.js';

/**
 * Fix B — resolve the real claude binary once, spawn it directly (no cmd.exe/.cmd shim). These tests
 * cover the resolver's contract without a real CLI or any model call:
 *   - an absolute existing path is used as-is;
 *   - a missing binary FAILS LOUDLY (startup error, not a mid-run crash);
 *   - a Windows .cmd shim is followed to the real claude.exe it launches.
 */
describe('resolveClaudeBinary — Fix B (direct-exec resolution)', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns an absolute path that exists (uses process.execPath as a known-present binary)', () => {
    expect(resolveClaudeBinary(process.execPath)).toBe(process.execPath);
  });

  it('FAILS LOUDLY on an absolute path that does not exist', () => {
    expect(() => resolveClaudeBinary(join(tmpdir(), 'no-such-claude-xyz.exe'))).toThrow(
      /does not exist/i,
    );
  });

  it('FAILS LOUDLY when a bare command cannot be resolved on PATH', () => {
    const savedPath = process.env.PATH;
    process.env.PATH = ''; // nothing resolvable
    try {
      expect(() => resolveClaudeBinary('definitely-not-a-real-cli-xyz')).toThrow(
        /could not resolve/i,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('follows a .cmd shim to the real claude.exe (Windows npm-shim layout)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-shim-'));
    tmps.push(dir);
    // fake npm shim + the real .exe it launches, mirroring the observed layout
    writeFileSync(join(dir, 'mycli.cmd'), '@echo off\r\n"%dp0%\\node_modules\\x\\claude.exe" %*\r\n');
    const binDir = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    mkdirSync(binDir, { recursive: true });
    const exe = join(binDir, 'claude.exe');
    writeFileSync(exe, '');
    const savedPath = process.env.PATH;
    process.env.PATH = dir + (process.platform === 'win32' ? ';' : ':') + (savedPath ?? '');
    try {
      // On win32 PATHEXT finds mycli.cmd; the resolver must follow it to the conventional exe path.
      if (process.platform === 'win32') {
        expect(resolveClaudeBinary('mycli')).toBe(exe);
      } else {
        // On non-win the .cmd isn't executable-by-PATHEXT; resolving the exe directly still works.
        expect(resolveClaudeBinary(exe)).toBe(exe);
      }
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
