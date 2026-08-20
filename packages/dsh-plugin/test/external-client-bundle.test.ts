import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import config from '../tsdown.config.mjs'

test('build config is self-contained and emits the DSH closure-factory client artifact', async () => {
  const source = await readFile(new URL('../tsdown.config.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /deepseek-harness/u)

  assert.ok(Array.isArray(config))
  assert.equal(config.length, 2)
  const client = config.find(entry => entry.name === 'boss-watch-dsh-plugin/client')
  assert.ok(client)
  assert.equal(client.platform, 'browser')
  assert.equal(client.format, 'cjs')
  assert.equal(client.outputOptions?.entryFileNames, 'client.js')
  assert.match(String(client.outputOptions?.banner), /window\.__ModuleLoader__\.load/u)
  assert.match(String(client.outputOptions?.footer), /return module\.exports/u)
})

