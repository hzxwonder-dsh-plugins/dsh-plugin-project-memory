# Project Memory Specification

## Scope

The plugin adds durable, per-project knowledge and project-namespaced
credential records to DeepSeek Harness. The DSH Session is the authority for
project and turn identity. Model arguments cannot select either identity.

## Project identity

1. Every tool requires an agent Session with an absolute
   `exec.agent.session.header.cwd`.
2. The path is resolved to its canonical real directory.
3. The project ID is the lowercase SHA-256 digest of that canonical path.
4. Knowledge is stored below
   `$DSH_HOME/plugin-data/memory/<project-id>`.
5. Credential record IDs include both the project digest and a digest of the
   supplied environment-style key.

## Knowledge contract

The initial `memory.md` is `# Project memory` followed by a blank line. A read
returns the exact content and its SHA-256 revision. `write` and `forget`
replace the complete document only when `baseRevision` matches. Content is at
most 64 KiB, contains no NUL, and must pass the secret-pattern guard.

Every knowledge operation uses one per-project cross-process writer lock.
Replacement is a same-directory atomic rename with mode `0600`. Managed
directories are mode `0700`. Reads do not follow a final symlink and require a
regular file with exactly one link. Storage failures are reduced to stable
`MEMORY_*` errors so paths and contents do not enter model-facing diagnostics.

## Repeatable process maintenance

`observe_process` accepts a stable 1-200 character process ID only after a
workflow completes successfully, including its final checks. The runtime
derives identity from the agent Session ID and the open host turn reported by
the `turnBoundary` projection. The plugin stores only a hash of that pair.

One turn counts once. The second distinct recent turn saturates the occurrence
counter at two and makes the process pending. A project stores at most 64
processes and the eight most recent turn hashes per process.

Every memory read returns pending processes and a revision of the complete
process state. An acknowledgement must name only pending processes, include
that revision, include the current knowledge revision, and change the Markdown
document. It resets only the acknowledged occurrence counters while retaining
recent hashes. A concurrent observation invalidates the maintenance revision.

## Credential contract

`memory_credentials` accepts environment-style names and offers only:

- `secret_set`: replace the project's `api-key` record with a nonempty value
  no larger than 16 KiB; return the name and saved status.
- `secret_status`: call `ctx.credentials.describeRecord` and return the name
  and configured status.

The plugin has no read, reveal, export, environment-injection, command, or
network action for credentials. DSH records complete tool arguments in the
Session log, including the value supplied to `secret_set`, before the plugin
stores the record. The value may also reach the configured model provider. The
plugin cannot redact that history.

## Sandbox policy

Every call resolves the calling Session through `ctx.sandboxPolicy`. In
`read-only` mode, `write`, `forget`, `observe_process`, and `secret_set` fail
with `MEMORY_SANDBOX_DENIED` before the plugin changes memory or credential
state. The two read actions remain available.

`memory.read` is logically read-only after initialization, but the first read
for a project lazily creates its owner-only directory and initial `memory.md`
under `$DSH_HOME`. This host-managed initialization is allowed in `read-only`
mode and does not modify the project working directory. `secret_status` does
not initialize ordinary memory storage.

## DSH integration

The ESM module exports `name`, `inject`, and `apply`. `apply` registers both
tools with `ctx.tools.register(defineTool(...))`. It requires the DSH `tools`,
`credentials`, `sessionProjections`, and `sandboxPolicy` services. Every
operation checks or forwards `exec.signal` before side effects.
