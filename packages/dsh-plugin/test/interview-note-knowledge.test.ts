import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalInterviewKnowledgeService } from '../src/interview-note-knowledge.ts'

test('previews and idempotently writes a bounded Obsidian interview note', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-interview-knowledge-'))
  try {
    const service = new LocalInterviewKnowledgeService({ vaultRoot: root })
    const preview = service.preview({
      applicationId: 'application-fixture',
      company: '示例科技/研发',
      role: '后端工程师',
      interviewId: 'round-1',
      stage: 'first_interview',
      content: '讨论了缓存一致性和故障恢复。',
      occurredAt: '2026-08-20T02:30:00.000Z',
    })

    assert.equal(preview.contentHash.length, 64)
    assert.match(preview.relativePath, /^求职\/面经\/示例科技_研发\//u)
    assert.equal(Object.hasOwn(preview, 'content'), false)
    await assert.rejects(() => service.apply(preview.previewToken, false), /knowledge_confirmation_required/u)

    const applied = await service.apply(preview.previewToken, true)
    assert.equal(applied.deduplicated, false)
    const content = await readFile(join(root, applied.relativePath), 'utf8')
    assert.match(content, /contentHash:/u)
    assert.match(content, /缓存一致性和故障恢复/u)

    const repeated = await service.apply(preview.previewToken, true)
    assert.deepEqual(repeated, applied)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a vault root that would permit writing the filesystem root', () => {
  assert.throws(() => new LocalInterviewKnowledgeService({ vaultRoot: '/' }), /invalid_knowledge_vault/u)
})
