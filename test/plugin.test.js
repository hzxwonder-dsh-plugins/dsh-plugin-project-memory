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
  const prompt = { sections: new Map(), contexts: new Map() }
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
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['systemPrompt'])
      callback({
        systemPrompt: {
          section(value) {
            assert.equal(prompt.sections.has(value.name), false)
            prompt.sections.set(value.name, value)
          },
          context(value) {
            assert.equal(prompt.contexts.has(value.name), false)
            prompt.contexts.set(value.name, value)
          },
        },
      })
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
  return { root, projectA, projectB, records, credentialCalls, tools, prompt, execution }
}

test('bundle exports the DSH Cordis contract and apply registers both defineTool definitions', async t => {
  const f = await fixture(t)
  assert.equal(name, 'dsh-plugin-project-memory')
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
  assert.match(recordKey, /^dsh-plugin-project-memory\/project-[a-f0-9]{64}-[a-f0-9]{64}$/)
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

test('prompt contributions carry the standing policy and a per-project context', async t => {
  const f = await fixture(t)
  assert.deepEqual([...f.prompt.sections.keys()], ['tool:memory'])
  const section = f.prompt.sections.get('tool:memory')
  assert.equal(section.order, 2950)
  assert.equal(typeof section.text, 'string')
  for (const expected of ['action: read', 'action: write', 'nothing durable changed', 'forget', 'observe_process', 'memory_credentials', 'maintenanceRevision']) {
    assert.match(section.text, new RegExp(expected))
  }
  assert.equal(section.complete, undefined)

  assert.deepEqual([...f.prompt.contexts.keys()], ['memory:project'])
  const context = f.prompt.contexts.get('memory:project')
  assert.equal(context.order, 130)
  assert.equal(context.text({}), '')
  assert.equal(context.text({ agent: { session: {} } }), '')
  assert.equal(context.text({ agent: { session: { header: { cwd: f.projectA } } } }), '')
})

test('prompt context reports stored knowledge and escalates twice-observed procedures', async t => {
  const f = await fixture(t)
  const context = f.prompt.contexts.get('memory:project')
  const agent = { agent: { session: { header: { cwd: f.projectA } } } }
  const memory = f.tools.get('memory')

  const first = await memory.execute({ action: 'read' }, f.execution(f.projectA))
  await memory.execute(
    { action: 'write', baseRevision: first.revision, content: '# Project memory\n\n## Facts\n- tests: npm test\n' },
    f.execution(f.projectA),
  )
  const status = context.text(agent)
  assert.match(status, /holds \d+ bytes at revision [a-f0-9]{64}/)
  assert.doesNotMatch(status, /Memory maintenance is due/)
  assert.equal(status.includes('npm test'), false)

  for (const turn of [1, 2]) {
    await memory.execute(
      { action: 'observe_process', processId: 'release: publish' },
      f.execution(f.projectA, { turn }),
    )
  }
  const pending = context.text(agent)
  assert.match(pending, /Memory maintenance is due/)
  assert.match(pending, /"release: publish"/)

  const current = await memory.execute({ action: 'read' }, f.execution(f.projectA))
  assert.deepEqual(current.maintenance.pendingProcesses.map(entry => entry.processId), ['release: publish'])
  assert.match(pending, new RegExp(current.maintenance.revision))

  await memory.execute({
    action: 'write',
    baseRevision: current.revision,
    content: '# Project memory\n\n## Facts\n- tests: npm test\n\n## Procedures\n1. release: publish\n',
    maintenanceRevision: current.maintenance.revision,
    acknowledgedProcesses: ['release: publish'],
  }, f.execution(f.projectA, { turn: 3 }))
  const cleared = context.text(agent)
  assert.doesNotMatch(cleared, /Memory maintenance is due/)
  assert.match(cleared, /holds \d+ bytes at revision [a-f0-9]{64}/)
})

test('apply stays usable when the systemPrompt service is absent', () => {
  const tools = new Map()
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    credentials: {},
    sessionProjections: {},
    sandboxPolicy: {},
  }
  assert.doesNotThrow(() => apply(ctx, { dshHome: join(tmpdir(), 'dsh-memory-without-prompt') }))
  assert.deepEqual([...tools.keys()], ['memory', 'memory_credentials'])
})
