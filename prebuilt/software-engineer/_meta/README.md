# software-engineer

A prebuilt role for autonomous codebase analysis, vulnerability scanning,
migration planning, and small ports.

## What this lattice does

Given a job (via `POST /api/lattices/:id/jobs`) describing a codebase task,
the lattice cycles through:

1. observe — list & re-read the source repo via `src-listing`
2. recall — surface findings from previous cycles
3. decide — choose one action (read a specific file, run an inspection
   command, write a deliverable, delegate a multi-step subtask to a CC
   subprocess)
4. act — execute the chosen capability
5. judge — substrate gate verifies the output
6. write — persist findings to memory + the output dir
7. pulse — continue to next cycle

Over many cycles it produces real artefacts under the configured output
directory.

## Default tool manifest

| Tool          | Kind             | Purpose                                                              |
|---------------|------------------|----------------------------------------------------------------------|
| `src-listing` | `fs-read`        | Sense: recursive listing of the source repo (read every observe)     |
| `src-read`    | `fs-read-content`| Action: read one file's contents on demand                           |
| `out-write`   | `fs-write`       | Action: write a deliverable to the output directory                  |
| `src-shell`   | `shell-exec`     | Action: run a read-only inspection command (grep/find/git log/npm ls)|
| `delegate-cc` | `claude-delegate`| Action: spawn a fresh CC subprocess for multi-step work              |

## Configuring paths

The bundle's `defaults.json` ships with `OPERATOR_MUST_OVERRIDE_*`
sentinel strings instead of real paths — this role has no idea which
codebase you're going to point it at. **The operator MUST instantiate
this bundle via `POST /api/lattices` with their own `tool_manifest`**
that supplies the concrete paths:

- `src-listing.config.root`, `src-read.config.root`,
  `src-shell.config.cwd` → absolute path to the source codebase
  (read-only reference material)
- `out-write.config.outDir`, `delegate-cc.config.workdir` → absolute
  path to a writable sandbox for deliverables and any port
  construction

Going through `POST /api/companies` with `members: [{bundle_id:
"software-engineer"}]` will FAIL: the supervisor's `buildCapabilities`
rejects empty / placeholder paths with a clear error. That's
intentional — running this role without operator-configured paths
would be a security boundary violation.

See the repository quickstart for an example instantiation script.

## Sandboxing

- `src-listing` and `src-read` are jailed to the source repo root; symlinks
  are realpath-resolved at construction; relative paths are joined to the
  jail; absolute paths must resolve inside the jail.
- `out-write` is jailed to the output dir. The lattice cannot write
  anywhere else.
- `src-shell` rejects any command whose first token is not on the
  allowlist (default: read-only verbs — `grep`, `find`, `ls`, `cat`,
  `head`, `tail`, `wc`, `git`, `npm`, `node`, `pnpm`, `yarn`, `jq`, `tree`).
- `delegate-cc` spawns `claude --print` with the subtask as stdin and
  the workdir locked under the configured root.
