import { createHash } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryError, MemoryStore } from './store.js'

export const name = 'dsh-plugin-memory'
export const inject = ['tools', 'credentials', 'sessionProjections', 'sandboxPolicy']

const CREDENTIAL_ACTIONS = new Set(['secret_set', 'secret_status'])
const MEMORY_MUTATING_ACTIONS = new Set(['write', 'forget', 'observe_process'])
const CREDENTIAL_MUTATING_ACTIONS = new Set(['secret_set'])
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_CREDENTIAL_BYTES = 16 * 1024

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

export function apply(ctx, config = {}) {
  const store = new MemoryStore({ dshHome: config.dshHome })
  ctx.tools.register(createMemoryTool(ctx, store))
  ctx.tools.register(createCredentialTool(ctx, store))
}

export { MemoryError, MemoryStore } from './store.js'
