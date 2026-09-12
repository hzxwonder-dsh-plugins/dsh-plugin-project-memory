import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  INITIAL_MEMORY,
  MAX_MEMORY_BYTES,
  MemoryStore,
} from '../store.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh-home')
  const projectA = join(root, 'left', 'api')
  const projectB = join(root, 'right', 'api')
  await mkdir(projectA, { recursive: true })
  await mkdir(projectB, { recursive: true })
  const store = new MemoryStore({ dshHome })
  const run = (args, cwd = projectA, turn = 1, sessionId = 'session-a') => store.execute(args, {
    cwd,
    turn,
    sessionId,
    signal: new AbortController().signal,
  })
  return { root, dshHome, projectA, projectB, store, run }
}

test('canonical paths share memory while unrelated same-name projects stay isolated', async t => {
  const f = await fixture(t)
  const first = await f.run({ action: 'read' })
  const second = await f.run({ action: 'read' }, f.projectB)
  assert.equal(first.content, INITIAL_MEMORY)
  assert.notEqual(first.projectId, second.projectId)
  assert.equal(first.directory, join(f.dshHome, 'plugin-data', 'memory', first.projectId))

  const alias = join(f.root, 'project-alias')
  await symlink(f.projectA, alias)
  const aliased = await f.run({ action: 'read' }, alias)
  assert.equal(aliased.projectId, first.projectId)
  assert.equal(aliased.directory, first.directory)

  const saved = await f.run({
    action: 'write',
    baseRevision: first.revision,
    content: '# Project memory\n\nUse npm test.\n',
  })
  assert.equal(saved.saved, true)
  assert.equal((await f.run({ action: 'read' })).content, '# Project memory\n\nUse npm test.\n')
  assert.equal((await f.run({ action: 'read' }, f.projectB)).content, INITIAL_MEMORY)

  if (process.platform !== 'win32') {
    assert.equal((await stat(first.directory)).mode & 0o777, 0o700)
    assert.equal((await stat(join(first.directory, 'memory.md'))).mode & 0o777, 0o600)
  }
})

test('knowledge writes enforce revision CAS, secret guards, and the 64 KiB bound', async t => {
  const f = await fixture(t)
  const first = await f.run({ action: 'read' })
  await writeFile(join(first.directory, 'memory.md'), '# External edit\n')

  await assert.rejects(
    f.run({ action: 'write', baseRevision: first.revision, content: '# Stale\n' }),
    { message: 'MEMORY_REVISION_CONFLICT' },
  )
  const current = await f.run({ action: 'read' })
  await assert.rejects(
    f.run({ action: 'write', baseRevision: current.revision, content: 'x'.repeat(MAX_MEMORY_BYTES + 1) }),
    { message: 'MEMORY_INVALID_CONTENT' },
  )
  await assert.rejects(
    f.run({ action: 'write', baseRevision: current.revision, content: 'API_TOKEN=secret-value' }),
    { message: 'MEMORY_SECRET_IN_KNOWLEDGE' },
  )
  assert.equal((await f.run({ action: 'read' })).content, '# External edit\n')
})

test('two concurrent writers sharing one revision cannot both commit', async t => {
  const f = await fixture(t)
  const current = await f.run({ action: 'read' })
  const outcomes = await Promise.allSettled([
    f.run({ action: 'write', baseRevision: current.revision, content: '# Writer A\n' }),
    f.run({ action: 'write', baseRevision: current.revision, content: '# Writer B\n' }),
  ])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  const rejection = outcomes.find(outcome => outcome.status === 'rejected')
  assert.equal(rejection.reason.message, 'MEMORY_REVISION_CONFLICT')
  assert.match((await f.run({ action: 'read' })).content, /^# Writer [AB]\n$/)
})

test('managed symlinks and multi-link files are rejected without changing their targets', async t => {
  const f = await fixture(t)
  const first = await f.run({ action: 'read' })
  const memoryFile = join(first.directory, 'memory.md')
  const external = join(f.root, 'external-memory.md')
  await writeFile(external, '# External\n')

  await rm(memoryFile)
  await symlink(external, memoryFile)
  await assert.rejects(f.run({ action: 'read' }), { message: 'MEMORY_INVALID_FILE' })
  assert.equal(await readFile(external, 'utf8'), '# External\n')

  await rm(memoryFile)
  await link(external, memoryFile)
  await assert.rejects(f.run({ action: 'read' }), { message: 'MEMORY_INVALID_FILE' })
  assert.equal((await lstat(external)).nlink, 2)
  assert.equal(await readFile(external, 'utf8'), '# External\n')
})

test('repeat counters deduplicate host turns and acknowledgements require both revisions', async t => {
  const f = await fixture(t)
  const observe = turn => f.run({ action: 'observe_process', processId: '__proto__' }, f.projectA, turn)

  const first = await observe(1)
  assert.equal(first.occurrences, 1)
  assert.equal(first.updateSuggested, false)
  const duplicate = await observe(1)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.occurrences, 1)

  const second = await observe(2)
  assert.equal(second.occurrences, 2)
  assert.equal(second.updateSuggested, true)
  let current = await f.run({ action: 'read' })
  assert.deepEqual(current.maintenance.pendingProcesses, [{ processId: '__proto__', occurrences: 2 }])

  await assert.rejects(f.run({
    action: 'write',
    baseRevision: current.revision,
    content: current.content,
    maintenanceRevision: current.maintenance.revision,
    acknowledgedProcesses: ['__proto__'],
  }), { message: 'MEMORY_MAINTENANCE_UNCHANGED' })

  await observe(3)
  await assert.rejects(f.run({
    action: 'write',
    baseRevision: current.revision,
    content: '# Project memory\n\n## Build\n1. Run npm test.\n',
    maintenanceRevision: current.maintenance.revision,
    acknowledgedProcesses: ['__proto__'],
  }), { message: 'MEMORY_MAINTENANCE_CONFLICT' })

  current = await f.run({ action: 'read' })
  await f.run({
    action: 'forget',
    baseRevision: current.revision,
    content: '# Project memory\n\n## Build\n1. Run npm test.\n',
    maintenanceRevision: current.maintenance.revision,
    acknowledgedProcesses: ['__proto__'],
  })
  assert.deepEqual((await f.run({ action: 'read' })).maintenance.pendingProcesses, [])
  assert.equal((await observe(3)).occurrences, 0)
  assert.equal((await observe(4)).occurrences, 1)
  assert.equal((await observe(5)).updateSuggested, true)

  const processFile = join((await f.run({ action: 'read' })).directory, 'processes.json')
  const persisted = await readFile(processFile, 'utf8')
  assert.equal(persisted.includes('session-a'), false)
  assert.equal(persisted.includes('"turn"'), false)
})

test('an aborted call stops before creating project memory', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  controller.abort(new Error('cancelled by test'))
  await assert.rejects(f.store.execute({ action: 'read' }, {
    cwd: f.projectA,
    signal: controller.signal,
  }), { message: 'cancelled by test' })
  await assert.rejects(lstat(join(f.dshHome, 'plugin-data')), { code: 'ENOENT' })
})
