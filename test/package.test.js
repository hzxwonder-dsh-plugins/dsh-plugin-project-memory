import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('package is a public DSH bundle pinned to the inspected release candidate', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-plugin-project-memory')
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'LGPL-3.0-or-later')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal('codex' in manifest, false)
  for (const group of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [dependency, version] of Object.entries(manifest[group])) {
      if (dependency.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '0.1.5-rc.2')
    }
  }
})

test('bundle patch inserts the package under its stable id', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^- insert:\n    - id: dsh-plugin-project-memory\n      name: dsh-plugin-project-memory\n+$/)
})
