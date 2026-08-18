import assert from 'node:assert/strict'
import test from 'node:test'
import type { JobRevision } from '../src/domain.ts'
import { LocalJobDescriptionDiffService } from '../src/job-diff.ts'

const OLD_HASH = 'a'.repeat(64)
const NEW_HASH = 'b'.repeat(64)

function revision(input: Partial<JobRevision> & Pick<JobRevision, 'contentHash' | 'description'>): JobRevision {
  return {
    applicationId: 'application-diff-1',
    company: '虚构科技',
    role: 'Agent 工程师',
    jobUrl: 'https://www.zhipin.com/job_detail/diff-1.html',
    capturedAt: '2026-08-18T01:00:00.000Z',
    artifactRef: `local-artifact://${input.contentHash}`,
    ...input,
  }
}

test('compares the latest distinct local JD revisions into bounded added and removed sections', async () => {
  const source = {
    async listJobRevisions() {
      return [
        revision({ contentHash: OLD_HASH, description: '岗位职责\n负责 Agent 平台\n熟悉 TypeScript' }),
        revision({ contentHash: OLD_HASH, description: '岗位职责\n负责 Agent 平台\n熟悉 TypeScript', capturedAt: '2026-08-18T01:30:00.000Z' }),
        revision({ contentHash: NEW_HASH, description: '岗位职责\n负责 Agent 平台\n熟悉 TypeScript\n掌握 SQLite', capturedAt: '2026-08-18T02:00:00.000Z' }),
      ]
    },
  }
  const diff = await new LocalJobDescriptionDiffService(source).diff({ applicationId: 'application-diff-1' })

  assert.equal(diff.changed, true)
  assert.deepEqual(diff.from.contentHash, OLD_HASH)
  assert.deepEqual(diff.to.contentHash, NEW_HASH)
  assert.deepEqual(diff.added.map((section) => section.text), ['掌握 SQLite'])
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.summary, {
    addedSections: 1,
    removedSections: 0,
    addedCharacters: 9,
    removedCharacters: 0,
    truncated: false,
  })
})

test('uses the latest occurrence of a hash so A to B to A compares the rollback', async () => {
  const source = {
    async listJobRevisions() {
      return [
        revision({ contentHash: OLD_HASH, description: '旧版本', capturedAt: '2026-08-18T01:00:00.000Z' }),
        revision({ contentHash: NEW_HASH, description: '中间版本', capturedAt: '2026-08-18T02:00:00.000Z' }),
        revision({ contentHash: OLD_HASH, description: '旧版本', capturedAt: '2026-08-18T03:00:00.000Z' }),
      ]
    },
  }
  const diff = await new LocalJobDescriptionDiffService(source).diff({ applicationId: 'application-diff-1' })
  assert.equal(diff.from.contentHash, NEW_HASH)
  assert.equal(diff.to.contentHash, OLD_HASH)
  assert.deepEqual(diff.added.map((section) => section.text), ['旧版本'])
  assert.deepEqual(diff.removed.map((section) => section.text), ['中间版本'])
})

test('supports explicit hash-paired comparison and fails closed for missing baselines', async () => {
  const source = {
    async listJobRevisions() {
      return [
        revision({ contentHash: OLD_HASH, description: '旧要求' }),
        revision({ contentHash: NEW_HASH, description: '新要求' }),
      ]
    },
  }
  const service = new LocalJobDescriptionDiffService(source)
  const explicit = await service.diff({
    applicationId: 'application-diff-1',
    fromContentHash: OLD_HASH,
    toContentHash: NEW_HASH,
  })
  assert.deepEqual(explicit.removed.map((section) => section.text), ['旧要求'])
  assert.deepEqual(explicit.added.map((section) => section.text), ['新要求'])

  await assert.rejects(
    () => new LocalJobDescriptionDiffService({ async listJobRevisions() { return [revision({ contentHash: NEW_HASH, description: '只有一版' })] } }).diff({ applicationId: 'application-diff-1' }),
    /jd_diff_baseline_missing/u,
  )
  await assert.rejects(
    () => service.diff({ applicationId: 'application-diff-1', fromContentHash: 'not-a-hash' }),
    /invalid_jd_diff_from_content_hash/u,
  )
})
