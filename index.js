import { createHash } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryError, MemoryStore } from './store.js'

export const name = 'dsh-plugin-project-memory'
export const inject = ['tools', 'credentials', 'sessionProjections', 'sandboxPolicy']

const CREDENTIAL_ACTIONS = new Set(['secret_set', 'secret_status'])
const MEMORY_MUTATING_ACTIONS = new Set(['write', 'forget', 'observe_process'])
const CREDENTIAL_MUTATING_ACTIONS = new Set(['secret_set'])
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_CREDENTIAL_BYTES = 16 * 1024
const PROMPT_SECTION = 'tool:memory'
/** After first-party tool guidance (TOOL_REPORT `2900`), before the tool SDK (`5000`). */
const PROMPT_SECTION_ORDER = 2950
const PROMPT_CONTEXT = 'memory:project'
/** After the sandbox (`110`), approval (`115`), delegation (`120`) and ssh (`125`) contexts. */
const PROMPT_CONTEXT_ORDER = 130

/**
 * Standing usage policy for the `memory` tool.
 *
 * This text is the only thing that makes the agent use project memory on its
 * own initiative: the tools exist but nothing would tell a model that durable
 * cross-Session knowledge is available, when reading it pays off, when a fact
 * deserves a write, and that repeated procedures must be documented. It stays
 * static so the cached system prefix does not change between steps; per-project
 * facts live in the dynamic context contributed alongside it.
 */
const MEMORY_GUIDANCE = 'Project memory (`memory`, `memory_credentials`) keeps durable knowledge for this Session\'s project directory, shared by every Session in it. '
  + 'Use it on your own initiative; the user may also ask you directly to remember, update or forget something, and that request must be honored in the same turn. '
  + 'Read before relying on stored facts (`memory` with `action: read`): at the start of non-trivial work, when the user refers to earlier decisions, or when accumulated project knowledge could change your answer. '
  + 'Write when a fact will still matter in a later Session (`action: write`): commands that worked, architecture and layout decisions, environment quirks and workarounds, path and service conventions, and the user\'s durable preferences or constraints. '
  + 'Skip the write when nothing durable changed: transient status, one-off debugging output, restatements of the current task, and facts the repository already records do not belong in the document, and a candidate that only rephrases an existing line is not worth rewriting it for. '
  + '`write` and `forget` replace the whole Markdown document, so pass the revision from your latest read and keep the document short, factual and deduplicated: correct or delete stale lines instead of appending near-duplicates. '
  + 'Never put credentials, keys or personal data into the document; store a user-provided credential with `memory_credentials`, which never returns its value. '
  + 'Repeatable processes: after a multi-step procedure finishes successfully, including its final checks, call `observe_process` with a short stable id such as `release: build and publish plugin X`. '
  + 'One host turn counts once. When the same procedure is observed in a second distinct turn the plugin marks it pending and reports `updateSuggested`; you must then document its concrete steps under a `## Procedures` heading in the memory document and submit that update with the knowledge revision, the `maintenanceRevision` and the matching `acknowledgedProcesses`, which clears the pending state.'

/** Guard against a pathological prompt contribution from a large or odd process list. */
const MAX_PROMPT_PROCESSES = 8

const MAINTENANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'string', required: true },
    pendingProcesses: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          processId: { type: 'string', required: true },
          occurrences: { type: 'integer', required: true },
        },
      },
    },
  },
}

const MEMORY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { type: 'string' },
    directory: { type: 'string' },
    revision: { type: 'string' },
    content: { type: 'string' },
    maintenance: MAINTENANCE_SCHEMA,
    saved: { type: 'boolean' },
    processId: { type: 'string' },
    occurrences: { type: 'integer' },
    duplicate: { type: 'boolean' },
    updateSuggested: { type: 'boolean' },
  },
}

function executionProject(exec) {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new MemoryError('MEMORY_PROJECT_REQUIRED')
  return { cwd, signal: exec.signal }
}

function executionTurn(ctx, exec) {
  if (exec.agent === undefined) throw new MemoryError('MEMORY_RUN_REQUIRED')
  const boundary = ctx.sessionProjections.stateOf(exec.agent.session, 'turnBoundary')
  if (boundary === undefined || boundary.openTurnStartSeq === null || !Number.isSafeInteger(boundary.lastTurn)) {
    throw new MemoryError('MEMORY_RUN_REQUIRED')
  }
  return { sessionId: String(exec.agent.session.id), turn: boundary.lastTurn }
}

function enforceMutationPolicy(ctx, exec, action, mutatingActions) {
  if (!mutatingActions.has(action)) return
  const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  if (policy.mode === 'read-only') throw new MemoryError('MEMORY_SANDBOX_DENIED')
}

function credentialRecordId(projectId, key) {
  const keyHash = createHash('sha256').update(key).digest('hex')
  return `project-${projectId}-${keyHash}`
}

export function createMemoryTool(ctx, store) {
  return defineTool({
    name: 'memory',
    description: 'Read and maintain memory for the current Session project. Use read before relying on stored facts. '
      + 'Writes and forgets replace the complete Markdown document with revision CAS. Observe a repeatable process only after '
      + 'a genuinely successful completion; two distinct host turns request a documented procedure update.',
    parameters: {
      action: { type: 'string', enum: ['read', 'write', 'forget', 'observe_process'], required: true },
      baseRevision: { type: 'string' },
      content: { type: 'string' },
      processId: { type: 'string' },
      maintenanceRevision: { type: 'string' },
      acknowledgedProcesses: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: MEMORY_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: args => args.action === 'read',
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      enforceMutationPolicy(ctx, exec, args.action, MEMORY_MUTATING_ACTIONS)
      const context = executionProject(exec)
      if (args.action === 'observe_process') Object.assign(context, executionTurn(ctx, exec))
      return store.execute(args, context)
    },
  })
}

export function createCredentialTool(ctx, store) {
  return defineTool({
    name: 'memory_credentials',
    description: 'Store a user-provided credential for the current Session project or report whether a named credential is configured. '
      + 'Returns status only and cannot retrieve a credential value.',
    parameters: {
      action: { type: 'string', enum: ['secret_set', 'secret_status'], required: true },
      key: { type: 'string', required: true },
      value: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: { type: 'boolean' },
          key: { type: 'string', required: true },
          configured: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: args => args.action === 'secret_status',
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      enforceMutationPolicy(ctx, exec, args.action, CREDENTIAL_MUTATING_ACTIONS)
      if (!CREDENTIAL_ACTIONS.has(args.action) || !CREDENTIAL_NAME.test(args.key) || args.key === '__proto__') {
        throw new MemoryError(args.action && CREDENTIAL_ACTIONS.has(args.action) ? 'MEMORY_INVALID_KEY' : 'MEMORY_INVALID_ACTION')
      }
      const { cwd } = executionProject(exec)
      const { projectId } = await store.identify(cwd, exec.signal)
      const recordKey = credentialKey(name, credentialRecordId(projectId, args.key))
      if (args.action === 'secret_status') {
        const status = await ctx.credentials.describeRecord(recordKey)
        return { key: args.key, configured: status.configured }
      }
      if (typeof args.value !== 'string' || args.value.length === 0 || args.value.includes('\0')
        || Buffer.byteLength(args.value) > MAX_CREDENTIAL_BYTES) {
        throw new MemoryError('MEMORY_INVALID_SECRET')
      }
      exec.signal.throwIfAborted()
      await ctx.credentials.modifyRecord(recordKey, () => Promise.resolve({ kind: 'api-key', key: args.value }))
      return { saved: true, key: args.key }
    },
  })
}

/**
 * Dynamic per-step context: what this project's memory looks like right now.
 *
 * Emitted only when there is something to act on, so projects that never use
 * memory pay no prompt cost, and it never carries document content — only the
 * revision, its size, and the pending procedures still needing documentation.
 */
export function memoryContextText(store, context) {
  const cwd = context?.agent?.session?.header?.cwd
  const state = store.promptState(cwd)
  if (state === null) return ''
  const lines = []
  if (state.documented) {
    lines.push(`Project memory for this project directory holds ${state.bytes} bytes at revision ${state.revision}. `
      + 'Read it whenever the task may depend on knowledge accumulated in earlier Sessions.')
  }
  const pending = state.maintenance?.pendingProcesses ?? []
  if (pending.length > 0) {
    const shown = pending.slice(0, MAX_PROMPT_PROCESSES)
    const quoted = shown.map(entry => `"${entry.processId}"`).join(', ')
    const rest = pending.length > shown.length ? ` (and ${pending.length - shown.length} more)` : ''
    lines.push(`Memory maintenance is due: the repeatable process${pending.length === 1 ? '' : 'es'} ${quoted}${rest} `
      + 'already completed successfully in two distinct turns but is not documented yet. Document the concrete steps in the '
      + `memory document now with \`memory\` (\`action: write\`), passing baseRevision ${state.revision}, `
      + `maintenanceRevision ${state.maintenance.revision} and acknowledgedProcesses [${quoted}].`)
  }
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const store = new MemoryStore({ dshHome: config.dshHome })
  ctx.tools.register(createMemoryTool(ctx, store))
  ctx.tools.register(createCredentialTool(ctx, store))
  ctx.inject?.(['systemPrompt'], scope => {
    scope.systemPrompt.section({ name: PROMPT_SECTION, order: PROMPT_SECTION_ORDER, text: MEMORY_GUIDANCE })
    scope.systemPrompt.context({
      name: PROMPT_CONTEXT,
      order: PROMPT_CONTEXT_ORDER,
      text: context => memoryContextText(store, context),
    })
  })
}

export { MemoryError, MemoryStore } from './store.js'
