# End-to-End Test Plan

These scenarios validate a packaged `dsh-plugin-project-memory` bundle against a DSH
0.1.5-rc.2 host. Automated unit and integration tests cover the underlying
contracts; release validation should also execute these user-path scenarios.

## E2E-MEM-01: Project continuity and isolation

1. Start DSH with the bundle and a temporary `DSH_HOME` in project A.
2. Ask the agent to read memory, save a verified test command, and read again;
   confirm each read renders as the Markdown document headed by `project:`,
   `revision:` and `directory:` lines rather than a JSON envelope.
3. Start a new Session in an alias of project A and confirm the command exists.
4. Start a Session in a different same-name directory and confirm its memory
   contains only the initial heading.
5. Confirm all knowledge paths are under
   `$DSH_HOME/plugin-data/memory/<hash>`.

## E2E-MEM-02: CAS and external edits

1. Read memory and retain the returned revision.
2. Edit the project's `memory.md` outside DSH.
3. Attempt a write with the retained revision and confirm
   `MEMORY_REVISION_CONFLICT`.
4. Read, reconcile both changes, and save with the current revision.

## E2E-MEM-03: Repeated-process maintenance

1. Complete one workflow and observe its stable process ID twice in the same
   host turn; confirm the second call is a duplicate and the count remains one.
2. Complete the workflow in another turn and confirm it becomes pending.
3. Read memory, update the verified procedure, and acknowledge the process with
   both current revisions.
4. Observe again in the acknowledgement turn and confirm it remains a
   duplicate with count zero.
5. Complete two later distinct turns and confirm maintenance is requested
   again.

## E2E-MEM-04: Credential boundary

1. Set a canary credential in project A with `memory_credentials`.
2. Confirm the tool result and transcript response do not repeat the canary.
3. Confirm status is configured in project A and not configured in project B.
4. Rotate the credential and confirm status remains configured.
5. Confirm there is no model-facing tool action that retrieves the value.
6. Inspect the DSH credential store only in an isolated test environment and
   confirm the record IDs differ between projects.

## E2E-MEM-05: Cancellation and unsafe storage

1. Cancel a memory call before dispatch and confirm no file or record changes.
2. Replace `memory.md` with a symlink and confirm the plugin refuses the read.
3. Replace it with a multi-link file and confirm the plugin refuses the read.
4. Hold the writer lock from another process and confirm the operation fails
   with `MEMORY_BUSY` without deleting the live lock.

## E2E-MEM-06: Read-only sandbox policy

1. Start a new project Session in `read-only` mode and call `memory.read`.
2. Confirm the initial owner-only memory files are created under `$DSH_HOME`
   and no file is created in the project working directory.
3. Attempt `write`, `forget`, `observe_process`, and `secret_set`; confirm each
   fails with `MEMORY_SANDBOX_DENIED` and changes no plugin-owned state.
4. Confirm `memory.read` and `secret_status` remain available.
5. Switch the Session to `workspace-write` and confirm the four mutations can
   proceed subject to their normal validation and CAS requirements.

## E2E-MEM-07: Prompt-driven automatic use

1. Start DSH with the bundle and confirm a fresh Session's system prompt
   contains the standing `tool:memory` policy: it must name reading before
   relying on stored facts, writing durable facts, correcting or deleting stale
   lines, keeping credentials out of the document, and documenting a procedure
   observed in two distinct turns.
2. In a project with no memory, confirm the model step's runtime context
   contributes nothing about memory.
3. Have the agent record one durable fact without being told to; confirm a later
   step's runtime context reports the document revision and size and does not
   repeat its content.
4. Ask the agent, in plain conversation, to forget that fact or to remember a
   replacement; confirm it acts in the same turn without any wake-up phrase.
5. Complete one repeated procedure in two distinct turns and confirm the next
   step's runtime context names the pending process ID together with the
   knowledge revision, the maintenance revision, and the acknowledgements.
6. Let the agent document the steps under `## Procedures`; confirm the
   maintenance directive disappears from the following step's context.
7. Boot a host without the `systemPrompt` service and confirm both tools still
   register and work.
