import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, inject, name } from '../index.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  await mkdir(projectA)
  await mkdir(projectB)
  const records = new Map()
  const credentialCalls = []
  const tools = new Map()
  const ctx = {
    tools: {
      register(tool) {
        assert.equal(tools.has(tool.name), false)
        tools.set(tool.name, tool)
      },
    },
    credentials: {
      async describeRecord(key) {
        credentialCalls.push({ method: 'describeRecord', key })
        return { configured: records.has(key), kind: records.get(key)?.kind, writable: true }
      },
      async modifyRecord(key, mutate) {
        credentialCalls.push({ method: 'modifyRecord', key })
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return records.get(key)
      },
      async readRecord() {
        throw new Error('credential retrieval is forbidden')
      },
    },
    sessionProjections: {
      stateOf(session) {
        return session.boundary
      },
    },
    sandboxPolicy: {
      resolve({ session } = {}) {
        return {
          mode: session?.sandboxMode ?? 'workspace-write',
          workspaceRoot: session?.header.cwd ?? root,
        }
      },
    },
  }
  apply(ctx, { dshHome: join(root, 'dsh-home') })

  function execution(cwd, { sessionId = 'session-a', turn = 1, signal, sandboxMode = 'workspace-write' } = {}) {
    return {
      agent: {
        session: {
          id: sessionId,
          header: { cwd },
          boundary: { openTurnStartSeq: 0, lastTurn: turn },
          sandboxMode,
        },
      },
      signal: signal ?? new AbortController().signal,
    }
  }
  return { root, projectA, projectB, records, credentialCalls, tools, execution }
}

test('bundle exports the DSH Cordis contract and apply registers both defineTool definitions', async t => {
  const f = await fixture(t)
  assert.equal(name, 'dsh-plugin-memory')
  assert.deepEqual(inject, ['tools', 'credentials', 'sessionProjections', 'sandboxPolicy'])
  assert.deepEqual([...f.tools.keys()], ['memory', 'memory_credentials'])
  assert.equal(f.tools.get('memory').parameters.properties.action.enum.includes('observe_process'), true)
  assert.equal(f.tools.get('memory_credentials').parameters.properties.action.enum.includes('secret_status'), true)

  const read = await f.tools.get('memory').execute({ action: 'read' }, f.execution(f.projectA))
  assert.match(read.directory, /plugin-data[/\\]memory[/\\][a-f0-9]{64}$/)
  const observed = await f.tools.get('memory').execute(
    { action: 'observe_process', processId: 'test-suite' },
    f.execution(f.projectA, { turn: 7 }),
  )
  const duplicate = await f.tools.get('memory').execute(
    { action: 'observe_process', processId: 'test-suite' },
    f.execution(f.projectA, { turn: 7 }),
  )
  assert.equal(observed.occurrences, 1)
  assert.equal(duplicate.duplicate, true)
})

test('read-only policy permits reads and denies every memory and credential mutation', async t => {
  const f = await fixture(t)
  const readOnly = f.execution(f.projectA, { sandboxMode: 'read-only' })
  const memory = f.tools.get('memory')
  const credentials = f.tools.get('memory_credentials')
  const current = await memory.execute({ action: 'read' }, readOnly)
  assert.match(current.directory, /plugin-data[/\\]memory[/\\][a-f0-9]{64}$/)
  assert.deepEqual(
    await credentials.execute({ action: 'secret_status', key: 'API_KEY' }, readOnly),
    { key: 'API_KEY', configured: false },
  )

  for (const args of [
    { action: 'write', baseRevision: current.revision, content: '# Changed\n' },
    { action: 'forget', baseRevision: current.revision, content: '# Changed\n' },
    { action: 'observe_process', processId: 'release' },
  ]) {
    await assert.rejects(memory.execute(args, readOnly), { message: 'MEMORY_SANDBOX_DENIED' })
  }
  await assert.rejects(
    credentials.execute({ action: 'secret_set', key: 'API_KEY', value: 'never-stored' }, readOnly),
    { message: 'MEMORY_SANDBOX_DENIED' },
  )

  assert.equal((await memory.execute({ action: 'read' }, readOnly)).content, current.content)
  assert.equal(f.records.size, 0)
})

test('process observation requires an open host turn projection', async t => {
  const f = await fixture(t)
  const exec = f.execution(f.projectA)
  exec.agent.session.boundary = { openTurnStartSeq: null, lastTurn: 1 }
  await assert.rejects(
    f.tools.get('memory').execute({ action: 'observe_process', processId: 'release' }, exec),
    { message: 'MEMORY_RUN_REQUIRED' },
  )
})

test('credential set and status are project-namespaced and never retrieve or return values', async t => {
  const f = await fixture(t)
  const tool = f.tools.get('memory_credentials')
  const canary = 'canary-secret-$(echo-never)'
  const saved = await tool.execute(
    { action: 'secret_set', key: 'DEPLOY_TOKEN', value: canary },
    f.execution(f.projectA),
  )
  assert.deepEqual(saved, { saved: true, key: 'DEPLOY_TOKEN' })
  assert.equal(JSON.stringify(saved).includes(canary), false)
  assert.deepEqual(
    await tool.execute({ action: 'secret_status', key: 'DEPLOY_TOKEN' }, f.execution(f.projectA)),
    { key: 'DEPLOY_TOKEN', configured: true },
  )
  assert.deepEqual(
    await tool.execute({ action: 'secret_status', key: 'DEPLOY_TOKEN' }, f.execution(f.projectB)),
    { key: 'DEPLOY_TOKEN', configured: false },
  )
  assert.equal(f.records.size, 1)
  const [recordKey] = f.records.keys()
  assert.match(recordKey, /^dsh-plugin-memory\/project-[a-f0-9]{64}-[a-f0-9]{64}$/)
  assert.equal(f.records.get(recordKey).key, canary)
  assert.deepEqual(f.credentialCalls.map(call => call.method), [
    'modifyRecord',
    'describeRecord',
    'describeRecord',
  ])
})

test('credential rotation replaces the record and aborted calls do not write', async t => {
  const f = await fixture(t)
  const tool = f.tools.get('memory_credentials')
  const exec = f.execution(f.projectA)
  await tool.execute({ action: 'secret_set', key: 'API_KEY', value: 'first-value' }, exec)
  await tool.execute({ action: 'secret_set', key: 'API_KEY', value: 'second-value' }, exec)
  assert.equal(f.records.size, 1)
  assert.equal([...f.records.values()][0].key, 'second-value')

  const controller = new AbortController()
  controller.abort(new Error('cancelled credential call'))
  await assert.rejects(tool.execute(
    { action: 'secret_set', key: 'OTHER_KEY', value: 'never-written' },
    f.execution(f.projectA, { signal: controller.signal }),
  ), { message: 'cancelled credential call' })
  assert.equal(f.records.size, 1)
})

test('credential validation rejects retrieval-shaped actions, bad names, and invalid values', async t => {
  const f = await fixture(t)
  const tool = f.tools.get('memory_credentials')
  const exec = f.execution(f.projectA)
  await assert.rejects(tool.execute({ action: 'secret_get', key: 'API_KEY' }, exec), /must be one of/)
  await assert.rejects(tool.execute({ action: 'secret_set', key: '__proto__', value: 'value' }, exec), {
    message: 'MEMORY_INVALID_KEY',
  })
  await assert.rejects(tool.execute({ action: 'secret_set', key: 'API_KEY', value: '' }, exec), {
    message: 'MEMORY_INVALID_SECRET',
  })
  assert.equal(f.records.size, 0)
})
