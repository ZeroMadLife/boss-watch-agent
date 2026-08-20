import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalKnowledgeGrowthService } from '../src/knowledge-growth.ts'

test('builds a read-only growth plan from note names without returning note bodies or absolute paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-knowledge-'))
  try {
    await mkdir(join(root, '02_面试准备'), { recursive: true })
    await writeFile(join(root, '02_面试准备', 'Flink学习卡.md'), 'PRIVATE BODY SHOULD NOT LEAK')
    const service = new LocalKnowledgeGrowthService({ vaultRoot: root })
    const preview = await service.preview({ missingSkills: ['Flink'], targetRoles: ['后端'] })
    assert.equal(preview.readOnly, true)
    assert.equal(preview.vaultAvailable, true)
    assert.deepEqual(preview.notes, [{
      relativePath: '02_面试准备/Flink学习卡.md',
      title: 'Flink学习卡',
      matchedTerms: ['Flink'],
    }])
    assert.doesNotMatch(JSON.stringify(preview), /PRIVATE BODY|boss-watch-knowledge-/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

