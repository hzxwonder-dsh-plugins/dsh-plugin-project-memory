# DSH Memory Plugin

`dsh-plugin-project-memory` provides project-scoped durable knowledge and write-only,
non-retrievable credential status tools for DeepSeek Harness. It also injects
the memory usage policy and the current project state into the system prompt so
the agent decides on its own when to read or write, and is prompted to maintain
procedures that repeat. It is an ESM Cordis plugin targeting Harness
`0.1.5-rc.2`.

## Host support

Harness Web (the `dsh web` browser client) and DSH Desktop (the Electron shell)
load the same package, `dsh-plugin-project-memory`; there is no desktop-only
package and no separate desktop repository to maintain, so this repository's one
implementation covers both hosts.

- Memory documents are isolated by project path (the realpath of `cwd`) and
  stored in the plugin data directory the host provides, so Web and Desktop each
  use their own home and stay independent.
- The client surface registers only through official slots and `defineTool`, and
  host-specific capabilities stay out of the top-level `inject`; see the
  [DSH Desktop plugin development guide](https://github.com/anywhere-labs/dsh-desktop/blob/master/docs/plugin-development.md).
- The package exports `./package.json` explicitly: the DSH Desktop host resolves
  the client entry through the Node loader fallback path inside its Electron
  Utility process, and silently skips that entry without the export; ordinary
  Web hosts are unaffected.
- Verification: `npm test` passes 18 cases; on the desktop side plugin loading
  and the client entry are confirmed, while memory-panel interactions were not
  verified item by item.

## Verification screenshot

![Memory plugin test evidence](docs/screenshots/memory-test-output.svg)

Figure: functional verification evidence rendered from the real `npm test`
output on 2026-09-12 (14 passed, 0 failed at that time), rather than a graphical
memory-panel capture. Prompt-contribution cases added later are outside that
figure; the table on this page carries the current counts. See
[`docs/screenshots/SOURCES.md`](docs/screenshots/SOURCES.md) for provenance
and validation boundaries.

## Install

One command (replace `web` with your profile name):

```sh
dsh plugin --profile web add github:hzxwonder-dsh-plugins/dsh-plugin-project-memory
```

That single command initializes the profile when it does not exist yet, fetches
the repository with pnpm, installs its dependencies, and — because the package
declares `dsh.bundle.patch` in its own `package.json` — adds the plugin to
`dsh.profile.bundles` automatically, so no manual profile edit is needed. The
plugin is plain JavaScript with no `prepare` build script, so no `allowBuilds`
authorization prompt appears either. To pin a released version, use the tag:

```sh
dsh plugin --profile web add github:hzxwonder-dsh-plugins/dsh-plugin-project-memory#v0.2.2
```

Use the same `DSH_HOME` for installation and every Harness launch. The host
profile must provide `tools`, `credentials`, `sessionProjections`,
`sandboxPolicy`, and `systemPrompt`. The bundle patch inserts the stable
`dsh-plugin-project-memory` entry and does not modify Harness source. Restart `dsh web`
(or the DSH app) afterwards; the host loads plugins at startup.

This plugin is not published to npm; the unscoped `dsh-plugin-memory` package
there belongs to another author's project and is unrelated to this repository.

The rename also changes the credential record scope
(`<scope>/project-<projectId>-<keyHash>`): a credential written under the
previous scope needs one `secret_set` call under the new name. Project memory is
keyed by the normalized project path, so it is unaffected.

For local development use `file:` instead:

```sh
git clone https://github.com/hzxwonder-dsh-plugins/dsh-plugin-project-memory.git
cd dsh-plugin-project-memory
npm ci
dsh plugin --profile web add "file:$PWD"
```

Keep the `file:` prefix; a bare path is treated as `link:` by pnpm and does not
resolve the plugin's declared dependencies.

## Current verification status

Local checks currently report:

| Check | Result | Evidence |
| --- | --- | --- |
| Unit and integration tests | Pass (18/18) | `npm test` |
| JavaScript syntax | Pass | `node --check index.js && node --check store.js` |
| Package contents | Pass | `npm run pack:check` |
| System prompt contributions | Pass | Assembly through the real `@deepseek-ai/dsh-system-prompt`: the policy section reaches the prompt and the dynamic context reports the project revision and pending processes |
| One-command install | Pass | `dsh plugin --profile web add github:…` in an isolated `DSH_HOME` initialized the profile, installed the dependencies, and joined `dsh.profile.bundles`; `--dump-config` shows the layer |
| migration profile loading | Confirmed | `dsh --profile migration --dump-config` |
| Harness Web startup | Pass | Disposable profile starts and loads the plugins |
| Real Harness Agent | Pass | Tool registration, memory read/write/CAS rejection, credential write and status-only results; deployment `tests/harness-integration.mjs` |

Storage, concurrency, policy, and credential boundaries are covered by automated checks and a real Harness Agent fixture. The fixture uses synthetic data and invokes the official tool registry without an external model request.

## The `memory` tool

Storage identity comes from `exec.agent.session.header.cwd`; the model cannot
choose a project path in tool arguments:

1. Resolve the path to a canonical real directory.
2. Hash that path with SHA-256 to obtain the project ID.
3. Store knowledge and process state below
   `$DSH_HOME/plugin-data/memory/<project-id>/`.

Aliases of one checkout share memory, while unrelated same-name directories
remain isolated. Actions:

- `read`: render the complete Markdown document itself, headed by `project:`,
  `revision:` and `directory:` lines (plus the maintenance revision and pending
  process IDs when maintenance is due), without a JSON envelope; the other
  actions still render JSON.
- `write`: replace the complete document when `baseRevision` still matches.
- `forget`: replace the document under the same revision check to remove
  obsolete facts.
- `observe_process`: record a process only after it and its final checks
  genuinely complete.

A process is counted once per host turn. Two distinct turns observing the same
process create a pending maintenance item. Acknowledgement must include the
latest knowledge revision, maintenance revision, and the exact updated process
IDs together with the complete new document.

## Automatic use (system prompt contributions)

When the `systemPrompt` service is available the plugin contributes two prompt
inputs, so the user never has to activate memory:

- A static section named `tool:memory` at order `2950` states the standing
  policy: when reading pays off, what deserves a write and what does not
  (transient status, one-off debugging output, restatements of the current
  task, and facts the repository already records), that `write` and
  `forget` replace the whole document under revision CAS, that stale lines must
  be corrected or deleted rather than duplicated, that credentials stay out of
  the document, and that a procedure observed in two distinct turns must be
  documented. The text is static, which keeps the cached prompt prefix stable.
- A dynamic context named `memory:project` at order `130` reports the current
  project on every model step: one line with the documented revision and size,
  and, when maintenance is due, a directive naming the pending process IDs plus
  the knowledge revision, maintenance revision and `acknowledgedProcesses` to
  submit, so the agent can document the steps and clear the pending state
  immediately.

The agent therefore decides on its own when to read and write: it refreshes or
deletes stale facts and is prompted to record repeated procedures under a
`## Procedures` heading. An explicit user request in the conversation ("store
this in memory", "forget X") is honored in the same turn.

The dynamic context carries revision, size and process IDs only — never
document content — so knowledge cannot leak into the prompt. It renders an
empty string when storage is missing, unsafe or unreadable, and it never
creates a file or directory, so storage errors are not exposed as prompt text.

## The `memory_credentials` tool

The tool accepts environment-style names and exposes two actions:

- `secret_set`: write or rotate a credential for the current project and
  return only its name and saved status.
- `secret_status`: report whether a named credential is configured.

Records are stored through Harness `ctx.credentials`, with an ID containing
both the project ID and a name digest. The plugin exposes no read, export,
environment-injection, command, or network action for credential values, and
tool results never return the value.

### Session-record boundary

Harness records complete tool arguments before execution. A value supplied to
`secret_set` can therefore appear in Session history and reach the configured
model provider. The plugin cannot alter that history. Use `secret_set` only
when this exposure is acceptable; record variable names, never values, in
ordinary knowledge.

## Sandbox policy

The plugin resolves the current Session's `sandboxPolicy` before every call:

- `read-only` permits `memory.read` and `secret_status`.
- `write`, `forget`, `observe_process`, and `secret_set` return
  `MEMORY_SANDBOX_DENIED` before plugin-owned state changes.
- The first `memory.read` lazily creates owner-only directories and the
  initial `memory.md` under `$DSH_HOME`; this does not write to the project
  workspace. `secret_status` does not initialize ordinary memory storage.

## Storage and safety

```text
$DSH_HOME/plugin-data/memory/<sha256-canonical-project-root>/
  memory.md
  processes.json
```

Directories use `0700` and files use `0600`. Knowledge and process state are
bounded to 64 KiB, and complete-document writes use a cross-process lock plus
atomic replacement. Symlinks, hard links, and unsafe managed paths are
rejected. Lock timeouts return the stable `MEMORY_BUSY` error without guessing
that a live lock is stale. Common private-key, token, password, and secret
assignment patterns are blocked; this is a heuristic guardrail, not a
complete secret scanner.

## Develop and verify

```sh
npm install --cache /private/tmp/npm-cache-dsh-migration
npm test
npm run pack:check
```

See [`docs/spec.md`](docs/spec.md) for the contract and
[`docs/e2e.md`](docs/e2e.md) for user-path scenarios. The Chinese primary
documentation is [`README.md`](README.md).

`test/system-prompt.test.js` assembles a prompt through the real
`@deepseek-ai/cordis` and `@deepseek-ai/dsh-system-prompt` packages. Those are
host-provided peers, so the case skips when they are not installed and the
remaining tests are unaffected.

## License and provenance

LGPL-3.0-or-later. The implementation derives from PI-Desktop's `pi.memory`
behavior and adapts it to official DSH services. Attribution is recorded in
[`NOTICE`](NOTICE); dependencies retain their own licenses.
