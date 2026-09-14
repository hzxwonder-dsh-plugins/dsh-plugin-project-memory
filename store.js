/**
 * Project-scoped knowledge storage for DeepSeek Harness.
 *
 * Derived from PI-Desktop's pi.memory behavior and adapted to DSH APIs.
 * Copyright (c) 2026 hzxwonder. LGPL-3.0-or-later; see LICENSE and NOTICE.
 */

import { createHash } from 'node:crypto'
import { constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const MAX_MEMORY_BYTES = 64 * 1024
export const MAX_PROCESSES = 64
export const MAX_RECENT_RUNS = 8
export const INITIAL_MEMORY = '# Project memory\n\n'

const PROCESS_STATE_VERSION = 1
const PROCESS_ID = /^[A-Za-z0-9._:/ -]{1,200}$/
const MEMORY_ACTIONS = new Set(['read', 'write', 'forget', 'observe_process'])
const SECRET_PATTERN = /-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,})|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"'<]{8,}/i
const OWNER_DIRECTORY_MODE = 0o700
const OWNER_FILE_MODE = 0o600

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

export class MemoryError extends Error {
  constructor(code) {
    super(code)
    this.name = 'MemoryError'
    this.code = code
  }
}

function fail(code) {
  throw new MemoryError(code)
}

function isErrno(error, code) {
  return error !== null && typeof error === 'object' && error.code === code
}

function checkSignal(signal) {
  signal?.throwIfAborted()
}

async function ensurePrivateDirectory(target) {
  try {
    await mkdir(target, { mode: OWNER_DIRECTORY_MODE })
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error
  }
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('MEMORY_UNSAFE_PATH')
  await chmod(target, OWNER_DIRECTORY_MODE)
}

async function ensurePrivateFile(target, content) {
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('MEMORY_INVALID_FILE')
    return
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
  await writeFileAtomic(target, content, { mode: OWNER_FILE_MODE, dirMode: OWNER_DIRECTORY_MODE })
}

async function readPrivateFile(target, { missing } = {}) {
  let handle
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0
    handle = await open(target, constants.O_RDONLY | noFollow)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_MEMORY_BYTES) {
      fail('MEMORY_INVALID_FILE')
    }
    await handle.chmod(OWNER_FILE_MODE)
    const data = await handle.readFile()
    if (data.byteLength > MAX_MEMORY_BYTES) fail('MEMORY_INVALID_FILE')
    return data.toString('utf8')
  } catch (error) {
    if (missing !== undefined && isErrno(error, 'ENOENT')) return missing
    throw error
  } finally {
    await handle?.close()
  }
}

async function assertReplaceableFile(target) {
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('MEMORY_INVALID_FILE')
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

async function replacePrivateFile(target, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_MEMORY_BYTES || content.includes('\0')) {
    fail('MEMORY_INVALID_SIZE')
  }
  await assertReplaceableFile(target)
  await writeFileAtomic(target, content, { mode: OWNER_FILE_MODE, dirMode: OWNER_DIRECTORY_MODE })
}

function checkKnowledge(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_MEMORY_BYTES || content.includes('\0')) {
    fail('MEMORY_INVALID_CONTENT')
  }
  if (SECRET_PATTERN.test(content)) fail('MEMORY_SECRET_IN_KNOWLEDGE')
}

function validProcessId(value) {
  return typeof value === 'string' && value === value.trim() && PROCESS_ID.test(value)
}

function emptyProcessState() {
  return { version: PROCESS_STATE_VERSION, processes: Object.create(null) }
}

function parseProcessState(text) {
  let source
  try {
    source = JSON.parse(text)
  } catch {
    fail('MEMORY_INVALID_PROCESS_STATE')
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)
    || source.version !== PROCESS_STATE_VERSION || source.processes === null
    || typeof source.processes !== 'object' || Array.isArray(source.processes)
    || Object.keys(source.processes).length > MAX_PROCESSES) {
    fail('MEMORY_INVALID_PROCESS_STATE')
  }
  const processes = Object.create(null)
  for (const [processId, record] of Object.entries(source.processes)) {
    if (!validProcessId(processId) || record === null || typeof record !== 'object' || Array.isArray(record)
      || !Number.isInteger(record.occurrences) || record.occurrences < 0 || record.occurrences > 2
      || typeof record.pending !== 'boolean' || !Array.isArray(record.runs)
      || record.runs.length > MAX_RECENT_RUNS || new Set(record.runs).size !== record.runs.length
      || record.runs.some(run => typeof run !== 'string' || !/^[a-f0-9]{64}$/.test(run))
      || (record.occurrences >= 2 && !record.pending)
      || (record.pending && record.occurrences < 2)) {
      fail('MEMORY_INVALID_PROCESS_STATE')
    }
    Object.defineProperty(processes, processId, {
      value: { occurrences: record.occurrences, pending: record.pending, runs: [...record.runs] },
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return { version: PROCESS_STATE_VERSION, processes }
}

async function readProcessState(target) {
  const text = await readPrivateFile(target, { missing: null })
  return text === null ? emptyProcessState() : parseProcessState(text)
}

function maintenanceView(state) {
  return {
    revision: digest(JSON.stringify(state)),
    pendingProcesses: Object.entries(state.processes)
      .filter(([, record]) => record.pending)
      .map(([processId, record]) => ({ processId, occurrences: record.occurrences }))
      .sort((left, right) => left.processId.localeCompare(right.processId)),
  }
}

function validateAcknowledgements(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROCESSES
    || new Set(value).size !== value.length || value.some(item => !validProcessId(item))) {
    fail('MEMORY_INVALID_MAINTENANCE')
  }
}

function safeError(error, signal) {
  if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : error
  if (error instanceof MemoryError) return error
  if (error instanceof Error && error.message.startsWith('atomic-write: timed out waiting for the writer lock')) {
    return new MemoryError('MEMORY_BUSY')
  }
  return new MemoryError('MEMORY_STORAGE_ERROR')
}

export async function canonicalProjectIdentity(cwd, signal) {
  checkSignal(signal)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('MEMORY_PROJECT_REQUIRED')
  let root
  try {
    root = await realpath(cwd)
    if (!(await stat(root)).isDirectory()) fail('MEMORY_PROJECT_REQUIRED')
  } catch (error) {
    if (error instanceof MemoryError) throw error
    fail('MEMORY_PROJECT_REQUIRED')
  }
  checkSignal(signal)
  return { root, projectId: digest(root) }
}

/**
 * Read one project's prompt-facing state without creating or changing anything.
 *
 * The dynamic system-prompt context runs on every model step, so this path is
 * synchronous and side-effect free: it never creates directories or files,
 * never returns document content (only size and revision, so knowledge cannot
 * leak into the prompt), and degrades to `null` on any unsafe or unreadable
 * input because prompt text must not report storage errors.
 */
export function projectMemoryStateSync(dshHome, cwd) {
  let root
  let projectId
  try {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null
    root = realpathSync(cwd)
    if (!statSync(root).isDirectory()) return null
    projectId = digest(root)
  } catch {
    return null
  }
  const directory = join(dshHome, 'plugin-data', 'memory', projectId)
  const memoryFile = join(directory, 'memory.md')
  let content
  try {
    const info = lstatSync(memoryFile)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_MEMORY_BYTES) return null
    content = readFileSync(memoryFile, 'utf8')
  } catch {
    return null
  }
  if (content.includes('\0')) return null
  const trimmed = content.trim()
  return {
    projectId,
    directory,
    revision: digest(content),
    bytes: Buffer.byteLength(content),
    documented: trimmed.length > 0 && trimmed !== INITIAL_MEMORY.trim(),
    maintenance: readMaintenanceSync(directory),
  }
}

/** Best-effort synchronous maintenance view for prompt text; `null` when unusable. */
function readMaintenanceSync(directory) {
  try {
    const target = join(directory, 'processes.json')
    const info = lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_MEMORY_BYTES) return null
    return maintenanceView(parseProcessState(readFileSync(target, 'utf8')))
  } catch {
    return null
  }
}

export class MemoryStore {
  constructor({ dshHome } = {}) {
    this.dshHome = resolveDshHome(dshHome)
    this.memoryRoot = join(this.dshHome, 'plugin-data', 'memory')
  }

  async execute(args, context = {}) {
    try {
      return await this.#execute(args, context)
    } catch (error) {
      throw safeError(error, context.signal)
    }
  }

  async identify(cwd, signal) {
    return canonicalProjectIdentity(cwd, signal)
  }

  /** Prompt-facing project state for the dynamic system-prompt context. */
  promptState(cwd) {
    return projectMemoryStateSync(this.dshHome, cwd)
  }

  async #project(cwd, signal) {
    const identity = await canonicalProjectIdentity(cwd, signal)
    await mkdir(this.dshHome, { recursive: true, mode: OWNER_DIRECTORY_MODE })
    const pluginData = join(this.dshHome, 'plugin-data')
    await ensurePrivateDirectory(pluginData)
    await ensurePrivateDirectory(this.memoryRoot)
    const directory = join(this.memoryRoot, identity.projectId)
    await ensurePrivateDirectory(directory)
    return {
      ...identity,
      directory,
      memoryFile: join(directory, 'memory.md'),
      processesFile: join(directory, 'processes.json'),
    }
  }

  async #execute(args, context) {
    checkSignal(context.signal)
    if (args === null || typeof args !== 'object' || !MEMORY_ACTIONS.has(args.action)) {
      fail('MEMORY_INVALID_ACTION')
    }
    const project = await this.#project(context.cwd, context.signal)
    return withFileLock(project.memoryFile, async () => {
      checkSignal(context.signal)
      await ensurePrivateFile(project.memoryFile, INITIAL_MEMORY)
      const current = await readPrivateFile(project.memoryFile)
      checkKnowledge(current)
      const revision = digest(current)

      if (args.action === 'read') {
        const state = await readProcessState(project.processesFile)
        return {
          projectId: project.projectId,
          directory: project.directory,
          revision,
          content: current,
          maintenance: maintenanceView(state),
        }
      }

      if (args.action === 'observe_process') {
        return this.#observeProcess(args, context, project)
      }

      if (typeof args.baseRevision !== 'string' || args.baseRevision !== revision) {
        fail('MEMORY_REVISION_CONFLICT')
      }
      checkKnowledge(args.content)
      let acknowledgedState
      if (args.acknowledgedProcesses !== undefined) {
        validateAcknowledgements(args.acknowledgedProcesses)
        acknowledgedState = await readProcessState(project.processesFile)
        if (args.maintenanceRevision !== maintenanceView(acknowledgedState).revision) {
          fail('MEMORY_MAINTENANCE_CONFLICT')
        }
        if (args.acknowledgedProcesses.some(processId => !acknowledgedState.processes[processId]?.pending)) {
          fail('MEMORY_INVALID_MAINTENANCE')
        }
        if (args.content === current) fail('MEMORY_MAINTENANCE_UNCHANGED')
        for (const processId of args.acknowledgedProcesses) {
          const record = acknowledgedState.processes[processId]
          acknowledgedState.processes[processId] = {
            occurrences: 0,
            pending: false,
            runs: record.runs,
          }
        }
      }

      checkSignal(context.signal)
      await replacePrivateFile(project.memoryFile, args.content)
      if (acknowledgedState !== undefined) {
        await replacePrivateFile(project.processesFile, JSON.stringify(acknowledgedState))
      }
      return { saved: true, revision: digest(args.content) }
    })
  }

  async #observeProcess(args, context, project) {
    if (!validProcessId(args.processId)) fail('MEMORY_INVALID_PROCESS')
    checkKnowledge(args.processId)
    if (typeof context.sessionId !== 'string' || context.sessionId.length === 0 || context.sessionId.length > 512
      || !Number.isSafeInteger(context.turn) || context.turn < 1) {
      fail('MEMORY_RUN_REQUIRED')
    }
    const state = await readProcessState(project.processesFile)
    const existing = state.processes[args.processId]
    if (existing === undefined && Object.keys(state.processes).length >= MAX_PROCESSES) {
      fail('MEMORY_PROCESS_LIMIT')
    }
    const record = existing ?? { occurrences: 0, pending: false, runs: [] }
    const run = digest(JSON.stringify([context.sessionId, context.turn]))
    const duplicate = record.runs.includes(run)
    if (!duplicate) {
      record.runs = [...record.runs, run].slice(-MAX_RECENT_RUNS)
      record.occurrences = Math.min(2, record.occurrences + 1)
      record.pending ||= record.occurrences >= 2
      state.processes[args.processId] = record
      checkSignal(context.signal)
      await replacePrivateFile(project.processesFile, JSON.stringify(state))
    }
    return {
      processId: args.processId,
      occurrences: record.occurrences,
      duplicate,
      updateSuggested: record.pending,
      maintenance: maintenanceView(state),
    }
  }
}
