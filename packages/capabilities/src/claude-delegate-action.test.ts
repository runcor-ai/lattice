import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeClaudeDelegateAction } from './claude-delegate-action.js';
import type { ActContext } from './types.js';

/**
 * FIX-005 regression suite.
 *
 * Run-11 c22 hung the parent lattice for ~40 minutes after the sub-agent's
 * work had actually completed — because the delegate awaited child.on('close')
 * and 'close' waits for every stdio pipe to be closed. The CLI child had
 * exited cleanly, but grandchildren it spawned (MCP servers, tool
 * subprocesses using stdio: 'inherit') were still holding the pipes open,
 * so 'close' never fired and only the setTimeout timer released the
 * promise. The fix: resolve on child.on('exit') instead, and use a
 * detached process-group so the timeout can group-kill grandchildren.
 *
 * These tests use a Node shim as the "claude" command so we can reproduce
 * the exact grandchild-holds-stdio shape without needing the actual CLI.
 * A pre-fix version of the code will hang on the first test until the
 * short 2s test-timeoutMs fires (rejecting) — the test is written to
 * ASSERT the fixed behavior (resolves promptly on exit), so it will FAIL
 * on the pre-fix code.
 */

const NODE = process.execPath;
const isWin = process.platform === 'win32';

function makeCtx(): ActContext {
  return { abortSignal: new AbortController().signal };
}

describe('claude-delegate-action — FIX-005 exit-vs-close', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'claude-delegate-test-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it.skipIf(isWin)(
    'resolves promptly on child exit even when a grandchild holds stdio open',
    async () => {
      // Shim: spawn a grandchild that inherits stdio and sleeps 30s, then exit 0.
      // On the OLD code (child.on('close')), the parent hangs until the grandchild dies
      // or the timeout fires — because grandchild is still holding the pipe write-ends.
      // On the FIXED code (child.on('exit') + destroy pipes), the parent resolves within
      // ms of the shim's exit.
      const shim = [
        '-e',
        [
          "const cp = require('child_process');",
          // Grandchild inherits our stdio (which is the delegate's pipe write-ends).
          // detached + unref so we can exit independently of it.
          "const gc = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'inherit', detached: true });",
          'gc.unref();',
          "process.stdout.write('SHIM_DONE\\n');",
          'process.exit(0);',
        ].join(' '),
      ];

      const action = makeClaudeDelegateAction({
        workdir,
        command: NODE,
        args: shim,
        // 5s cap for the test — the fix should resolve in well under 1s.
        // Old (pre-fix) code would hang to this cap.
        timeoutMs: 5_000,
        outputMaxBytes: 4_000,
      });

      const started = Date.now();
      const result = await action.invoke({ subtask: 'ignored by shim' }, makeCtx());
      const elapsed = Date.now() - started;

      // FIX assertion: promise resolved (not rejected via timeout).
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('SHIM_DONE');
      // Timing: resolve happened well before the 5s timeout — on the fixed
      // code this is typically <500ms. On the OLD code this would only settle
      // when the grandchild dies (never during the test) or when the timer
      // fires (5s), so this assertion would fail the pre-fix code.
      expect(elapsed).toBeLessThan(3_000);
      expect(result.elapsedMs).toBeLessThan(3_000);
    },
    10_000, // vitest test-timeout ceiling: 10s
  );

  it.skipIf(isWin)(
    'exit code from the child is preserved through the promise',
    async () => {
      // A child that just exits with a specific non-zero code, no stdio drama.
      const shim = ['-e', 'process.exit(42);'];
      const action = makeClaudeDelegateAction({
        workdir,
        command: NODE,
        args: shim,
        timeoutMs: 5_000,
        outputMaxBytes: 4_000,
      });
      const result = await action.invoke({ subtask: 'ignored' }, makeCtx());
      expect(result.exitCode).toBe(42);
    },
    10_000,
  );

  it.skipIf(isWin)(
    'timeout still rejects when the child genuinely refuses to exit',
    async () => {
      // A child that hangs indefinitely — the timeout is the ONLY exit path here.
      // On the fixed code, timer fires, group-kills the child + any grandchildren,
      // and the promise rejects with the timeout message.
      const shim = ['-e', 'setTimeout(()=>{}, 60000); process.stdout.write("STARTED\\n");'];
      const action = makeClaudeDelegateAction({
        workdir,
        command: NODE,
        args: shim,
        timeoutMs: 800, // very short so the test completes fast
        outputMaxBytes: 4_000,
      });
      await expect(
        action.invoke({ subtask: 'ignored' }, makeCtx()),
      ).rejects.toThrow(/timed out after 800ms/);
    },
    10_000,
  );

  it.skipIf(isWin)(
    'group-kill reaches grandchildren on timeout (grandchild PID actually dies)',
    async () => {
      // Reliable strong check: the shim writes its grandchild's PID to a file
      // in workdir/ before hanging, so the test can read the PID even though
      // the delegate's rejection doesn't return stdout. After the timeout +
      // grace period, we assert the grandchild PID no longer exists by probing
      // `process.kill(pid, 0)` — signal 0 doesn't send anything, just checks
      // existence; ESRCH means the process is dead.
      //
      // Pre-fix (SIGTERM to direct child only): grandchild survives (adopted
      // by init), process.kill(pid, 0) succeeds → assertion fails.
      // Fixed (detached:true + process.kill(-pgid, SIGKILL) after grace):
      // grandchild is in the shim's process group, group-kill reaches it,
      // process.kill(pid, 0) throws ESRCH → assertion passes.
      const pidFile = join(workdir, 'grandchild.pid');
      const shim = [
        '-e',
        [
          "const cp = require('child_process');",
          "const fs = require('fs');",
          // Grandchild sleeps 30s. Does NOT detach — inherits the shim's pgid.
          // The delegate started the shim with detached:true, so the shim IS the
          // pgid leader and process.kill(-shim.pid, SIGKILL) will reach the gc.
          "const gc = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'inherit' });",
          // Write the grandchild pid to a file before hanging — the test reads it.
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
          "process.stdout.write('GC_PID=' + gc.pid + '\\n');",
          // Hang the shim indefinitely.
          'setTimeout(() => {}, 60000);',
        ].join(' '),
      ];

      const action = makeClaudeDelegateAction({
        workdir,
        command: NODE,
        args: shim,
        timeoutMs: 1_000,
        outputMaxBytes: 4_000,
      });

      let rejected = false;
      try {
        await action.invoke({ subtask: 'ignored' }, makeCtx());
      } catch (err) {
        rejected = true;
        expect(String(err)).toMatch(/timed out after 1000ms/);
      }
      expect(rejected).toBe(true);

      // Wait for SIGKILL grace period (2s in fix) + a small margin so the group
      // kill has had time to propagate through the tree.
      await new Promise((r) => setTimeout(r, 2_500));

      // Strong assertion: the grandchild PID must be readable AND dead.
      expect(existsSync(pidFile)).toBe(true);
      const gcPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      expect(Number.isFinite(gcPid)).toBe(true);
      expect(gcPid).toBeGreaterThan(0);

      // process.kill(pid, 0) — signal 0 doesn't send anything, just probes
      // existence. If the process still exists, this succeeds silently. If
      // ESRCH (no such process), it throws. Fixed code: throws. Pre-fix:
      // succeeds (grandchild orphaned, still alive).
      let stillAlive = true;
      try {
        process.kill(gcPid, 0);
      } catch (err) {
        // ESRCH is what we want — grandchild is gone.
        expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
        stillAlive = false;
      }

      if (stillAlive) {
        // If we got here on the fixed code, something's wrong. Clean up the
        // stray process before failing the assertion so the test doesn't leak.
        try { process.kill(gcPid, 'SIGKILL'); } catch { /* ignore */ }
      }
      expect(stillAlive).toBe(false);
    },
    15_000,
  );
});
