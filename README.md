# dsh-plugin-memory

Project-scoped durable memory and write-only credential tools for DeepSeek
Harness 0.1.5-rc.2. This package is a public DSH bundle and a plain JavaScript
ESM Cordis plugin.

## Install

```sh
export DSH_HOME=/absolute/path/to/your/dsh-home
git clone https://github.com/hzxwonder-dsh-plugins/dsh-plugin-memory.git
cd dsh-plugin-memory
npm ci
dsh plugin --profile migration add "$PWD"
dsh --profile migration
```

The package is installed from its public GitHub repository. Use the same
`DSH_HOME` value for plugin installation and every Harness launch that should
load it. For another existing profile, replace `migration` in both DSH
commands.

The bundle patch inserts one Cordis entry:

```yaml
- insert:
    - id: dsh-plugin-memory
      name: dsh-plugin-memory
```

The host profile must already provide `tools`, `credentials`,
`sessionProjections`, and `sandboxPolicy`, as the standard DSH base profile
does.

## Credential transcript risk

DSH records tool arguments in the Session log. Calling `secret_set` therefore
records the supplied credential value in Session history before this plugin
stores it, and the value may be sent to the configured model provider. The
plugin cannot redact that history. Use `secret_set` only when this exposure is
acceptable.

## Tools

`memory` binds storage to `exec.agent.session.header.cwd`. The model cannot
provide a project path. The canonical real path is SHA-256 hashed, so aliases
of one checkout share memory and unrelated same-name directories remain
isolated. Its actions are:

- `read`: return the complete Markdown document, content revision, and pending
  maintenance requests.
- `write`: replace the complete document if `baseRevision` is current.
- `forget`: replace the complete document after removing obsolete facts, with
  the same revision check.
- `observe_process`: record one genuinely completed repeatable process. Calls
  in the same host session turn count once. Two distinct turns request a
  procedure update.

Acknowledging a procedure update requires a changed complete document, the
latest knowledge revision, the latest maintenance revision, and the exact
pending process IDs that were updated. Recent hashed turn identities remain
after acknowledgement, so the acknowledgement turn cannot count again.

`memory_credentials` has only `secret_set` and `secret_status`. Records are
stored through `ctx.credentials` under a SHA-256 project-and-key namespace.
Status uses `describeRecord`; the plugin exposes no credential retrieval tool.
A supplied value is never returned by the tool.

The plugin resolves the calling Session's current `sandboxPolicy` before every
mutation. `memory` actions `write`, `forget`, and `observe_process`, plus
`memory_credentials.secret_set`, fail with `MEMORY_SANDBOX_DENIED` in
`read-only` mode before plugin-owned storage changes. `memory.read` and
`memory_credentials.secret_status` remain available.

The first `memory.read` lazily creates the project directory and initial
`memory.md` under `$DSH_HOME` when no memory exists. This host-managed plugin
state initialization can occur in `read-only` mode; it never writes into the
project working directory. `secret_status` does not initialize ordinary memory
storage.

## Storage and safety

Ordinary knowledge lives at:

```text
$DSH_HOME/plugin-data/memory/<sha256-canonical-project-root>/
  memory.md
  processes.json
```

`$DSH_HOME` is resolved by `@deepseek-ai/dsh-home-paths`, including its
`~/.dsh` default. Directories are owner-only (`0700`) and files are owner-only
(`0600`) on POSIX systems. Managed links and multi-link files are rejected.
Reads and writes are bounded to 64 KiB. Complete-document writes use a
cross-process lock and atomic replacement from `@deepseek-ai/dsh-atomic-write`.
An unremoved lock is never guessed stale; an operator must confirm that no
writer is live before removing it.

Knowledge rejects common private-key, token, password, and secret assignment
patterns. This heuristic is a guardrail, not a complete secret scanner. Store
credentials with `memory_credentials` only after accounting for the Session-log
risk above, and document only their variable names.

## Development

```sh
npm install --cache /private/tmp/npm-cache-dsh-migration
npm test
npm run pack:check
```

See [the behavioral specification](docs/spec.md) and [E2E plan](docs/e2e.md).

## License and provenance

This DSH adaptation is derived from PI-Desktop's `pi.memory` plugin and is
licensed under LGPL-3.0-or-later. The complete license text is in
[LICENSE](LICENSE), and source attribution is in [NOTICE](NOTICE).
