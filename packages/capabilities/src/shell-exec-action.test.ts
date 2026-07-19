import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  makeShellExecAction,
  runShellCommand,
  tokenizeCommand,
} from './shell-exec-action.js';
import type { ActContext } from './types.js';

const ctx: ActContext = { abortSignal: new AbortController().signal };

describe('tokenizeCommand', () => {
  it('splits a plain multi-token command into argv', () => {
    expect(tokenizeCommand('node --version')).toEqual(['node', '--version']);
    expect(tokenizeCommand('node script.mjs a b c')).toEqual([
      'node',
      'script.mjs',
      'a',
      'b',
      'c',
    ]);
  });

  it('collapses runs of whitespace', () => {
    expect(tokenizeCommand('  node   --version  ')).toEqual(['node', '--version']);
  });

  it('preserves a quoted path with spaces as one argv entry', () => {
    expect(tokenizeCommand('cat "/tmp/path with spaces/file.md"')).toEqual([
      'cat',
      '/tmp/path with spaces/file.md',
    ]);
    expect(tokenizeCommand("cat '/tmp/path with spaces/file.md'")).toEqual([
      'cat',
      '/tmp/path with spaces/file.md',
    ]);
  });

  it('handles backslash escapes outside quotes and inside double quotes', () => {
    expect(tokenizeCommand('cat a\\ b')).toEqual(['cat', 'a b']);
    expect(tokenizeCommand('cat "a\\"b"')).toEqual(['cat', 'a"b']);
  });

  it('leaves single-quoted content literal (no escape processing)', () => {
    expect(tokenizeCommand("echo 'a\\nb'")).toEqual(['echo', 'a\\nb']);
  });

  it('throws on unterminated quotes', () => {
    expect(() => tokenizeCommand('cat "unterminated')).toThrow(/unterminated/);
    expect(() => tokenizeCommand("cat 'unterminated")).toThrow(/unterminated/);
  });

  it('returns [] for empty / whitespace-only input', () => {
    expect(tokenizeCommand('')).toEqual([]);
    expect(tokenizeCommand('   ')).toEqual([]);
  });

  it('preserves an intentionally-empty quoted arg', () => {
    expect(tokenizeCommand('echo "" hi')).toEqual(['echo', '', 'hi']);
  });
});

describe('runShellCommand — FIX-001 regression: multi-token commands must work on Linux', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shell-exec-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs `node --version` and returns exit 0 with output (would ENOENT pre-fix)', async () => {
    // Pre-fix: spawn("node --version", []) treats the whole string as argv[0]
    // and Node looks for a binary literally named "node --version" → ENOENT.
    // Post-fix: tokenize → argv=["node","--version"] → spawn("node",["--version"]) → works.
    const result = await runShellCommand({
      command: 'node --version',
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+/); // e.g. v22.x.y
    expect(result.stderr).toBe('');
    expect(result.truncated).toBe(false);
  });

  it('runs `node <script> <arg>` with a real script and reads the arg correctly', async () => {
    // This is the shape check-step-gates.mjs invocations take:
    // `node .claude/scripts/check-step-gates.mjs phase1-requirements`.
    const script = join(dir, 'echo-arg.mjs');
    writeFileSync(
      script,
      'process.stdout.write("arg=" + process.argv[2] + "\\n");',
      'utf8',
    );
    const result = await runShellCommand({
      command: `node ${script} phase1-requirements`,
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('arg=phase1-requirements\n');
  });

  it('preserves a quoted path with spaces as a single argv entry', async () => {
    const spacedDir = mkdtempSync(join(tmpdir(), 'has space '));
    try {
      const script = join(spacedDir, 'print.mjs');
      writeFileSync(script, 'process.stdout.write(process.argv[1]);', 'utf8');
      const result = await runShellCommand({
        command: `node "${script}"`,
        cwd: dir,
      });
      expect(result.exitCode).toBe(0);
      // The whole path (including spaces) should have arrived intact.
      expect(result.stdout).toBe(script);
    } finally {
      rmSync(spacedDir, { recursive: true, force: true });
    }
  });

  it('still rejects a verb not on the allowlist (allowlist logic keys on argv[0])', async () => {
    await expect(
      runShellCommand({ command: 'rm -rf /', cwd: dir }),
    ).rejects.toThrow(/verb "rm" not in allowlist/);
  });

  it('returns a real non-zero exit code for a failing command (not ENOENT)', async () => {
    // If the command REALLY runs but exits non-zero, we should get that
    // exit code — NOT a spawn ENOENT error. Pre-fix, we would have hit ENOENT
    // (thrown via child.on('error')). Post-fix, node runs and exits 1.
    const result = await runShellCommand({
      command: 'node -e "process.exit(3)"',
      cwd: dir,
    });
    expect(result.exitCode).toBe(3);
  });
});

describe('makeShellExecAction — same fix reachable via the capability', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shell-exec-cap-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('capability invokes a multi-token command and returns exit 0', async () => {
    const cap = makeShellExecAction({ cwd: dir });
    const result = await cap.invoke({ command: 'node --version' }, ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\.\d+/);
  });

  it('commandPrefix path still tokenizes correctly after prefix join', async () => {
    // Constrained-command shape: prefix "node -p" + input is a JS expression
    // node evaluates and prints. Use paren-free input because the prefix path
    // strips shell metacharacters including ( ) as an anti-injection guard.
    const cap = makeShellExecAction({
      cwd: dir,
      commandPrefix: 'node -p',
    });
    const result = await cap.invoke(
      { command: '"1+2"' },
      ctx,
    );
    // command becomes: node -p "1+2"
    // tokenized: ["node","-p","1+2"] → node evaluates 1+2, prints 3
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('3');
  });
});
