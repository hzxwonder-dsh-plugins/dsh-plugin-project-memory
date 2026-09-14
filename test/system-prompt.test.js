import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

// Integration check against the real DSH prompt registry. The prompt packages
// are peers of the host rather than dependencies of this plugin, so a clean
// `npm ci` may not have them: the test skips instead of failing there.
async function dshPrompt() {
  try {
    const [cordis, prompt] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-system-prompt'),
    ])
    return {
      Context: cordis.Context,
      SystemPrompt: prompt.default,
      renderPrompt: prompt.renderPrompt,
      renderContextSnapshot: prompt.renderContextSnapshot,
    }
  } catch {
    return null
  }
}

test('the real system prompt registry carries the policy and the project state', async t => {
  const dsh = await dshPrompt()
  if (dsh === null) {
    t.skip('DSH prompt packages are not installed')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-prompt-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)

  const ctx = new dsh.Context()
  new dsh.SystemPrompt(ctx, {})
  const tools = new Map()
  ctx.tools = { register(tool) { tools.set(tool.name, tool) } }
  ctx.credentials = {}
  ctx.sessionProjections = { stateOf: session => session.boundary }
  ctx.sandboxPolicy = { resolve: () => ({ mode: 'workspace-write' }) }
  apply(ctx, { dshHome: join(root, 'dsh-home') })
  // Cordis runs inject callbacks as effects, so registration lands a tick later.
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual([...tools.keys()], ['memory', 'memory_credentials'])

  const agent = { agent: { session: { header: { cwd: project } } } }
  function execution(turn) {
    return {
      agent: {
        session: {
          id: 'session-a',
          header: { cwd: project },
          boundary: { openTurnStartSeq: 0, lastTurn: turn },
        },
      },
      signal: new AbortController().signal,
    }
  }

  const policy = dsh.renderPrompt(await ctx.systemPrompt.assemble(agent))
  assert.match(policy, /Project memory \(`memory`/)
  assert.match(policy, /observe_process/)
  assert.match(policy, /maintenanceRevision/)
  assert.equal(dsh.renderContextSnapshot(await ctx.systemPrompt.assemble(agent)), '')

  const memory = tools.get('memory')
  const read = await memory.execute({ action: 'read' }, execution(1))
  await memory.execute({
    action: 'write',
    baseRevision: read.revision,
    content: '# Project memory\n\n## Facts\n- tests: npm test\n',
  }, execution(1))
  const documented = dsh.renderContextSnapshot(await ctx.systemPrompt.assemble(agent))
  assert.match(documented, /holds \d+ bytes at revision [a-f0-9]{64}/)
  assert.equal(documented.includes('npm test'), false)

  for (const turn of [1, 2]) {
    await memory.execute({ action: 'observe_process', processId: 'release: publish' }, execution(turn))
  }
  const pending = dsh.renderContextSnapshot(await ctx.systemPrompt.assemble(agent))
  assert.match(pending, /Memory maintenance is due/)
  assert.match(pending, /"release: publish"/)
})
