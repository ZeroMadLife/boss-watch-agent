import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteJobLeadStore } from '../src/job-lead.ts'
import { LocalVisualLeadImportService } from '../src/visual-lead-import.ts'

const SCREENSHOT_HASH = 'a'.repeat(64)

test('does not deduplicate distinct rows by a vision-truncated channel URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-visual-truncated-url-'))
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  const service = new LocalVisualLeadImportService({ store })

  try {
    const preview = await service.preview({
      sourceRef: 'tencent-view-only-truncated-url',
      screenshotRef: 'attachment://screenshot-truncated-url',
      screenshotHash: SCREENSHOT_HASH,
      rows: [
        {
          company: '虚构潮汐科技',
          role: '后端工程师',
          cohort: '2027届',
          channelUrl: 'https://app.mokahr.com/m/...',
        },
        {
          company: '虚构远山科技',
          role: '数据工程师',
          cohort: '2027届',
          channelUrl: 'https://app.mokahr.com/m/...',
        },
      ],
    })

    assert.equal(preview.acceptedCount, 2)
    assert.equal(preview.duplicateCount, 0)
    assert.ok(preview.warnings.includes('row:2:truncated_channel_url'))
    assert.ok(preview.warnings.includes('row:3:truncated_channel_url'))
    const applied = await service.apply(preview.previewToken)
    assert.equal(applied.snapshot.acceptedCount, 2)
    assert.equal(store.list({ limit: 10 }).length, 2)
    assert.equal(store.list({ limit: 10 }).some((lead) => lead.channelUrl !== undefined), false)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('previews structured screenshot rows without writing facts, then applies accepted rows atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-visual-import-'))
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  const service = new LocalVisualLeadImportService({
    store,
    now: () => new Date('2026-08-17T12:00:00.000Z'),
  })

  try {
    const preview = await service.preview({
      sourceRef: 'tencent-view-only-27-campus',
      screenshotRef: 'attachment://screenshot-1',
      screenshotHash: SCREENSHOT_HASH,
      headers: ['招聘企业', '招聘岗位', '工作地点'],
      rows: [
        { rowNumber: 2, company: '虚构星河科技', role: '后端工程师', city: '上海', confidence: 0.98 },
        { rowNumber: 3, company: '', role: '测试工程师', confidence: 0.99 },
        { rowNumber: 4, company: '虚构低置信科技', role: '平台工程师', confidence: 0.4 },
      ],
    })

    assert.equal(preview.acceptedCount, 1)
    assert.equal(preview.rejectedCount, 2)
    assert.equal(preview.lowConfidenceCount, 1)
    assert.equal(preview.screenshotHash, SCREENSHOT_HASH)
    assert.deepEqual(store.list({ limit: 10 }), [])
    assert.deepEqual(store.listSnapshots({ limit: 10 }), [])

    const applied = await service.apply(preview.previewToken)
    assert.equal(applied.reused, false)
    assert.equal(applied.snapshot.sourceKind, 'tencent_smart_sheet')
    assert.equal(applied.snapshot.acceptedCount, 1)
    assert.equal(store.list({ limit: 10 })[0]?.company, '虚构星河科技')
    assert.equal(store.list({ limit: 10 })[0]?.confidence, 'source_only')
    assert.equal(store.list({ limit: 10 })[0]?.officialApplyUrl, undefined)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a visual apply when the screenshot reference hash changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-visual-stale-'))
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  let currentHash = SCREENSHOT_HASH
  const service = new LocalVisualLeadImportService({
    store,
    readScreenshotHash: async () => currentHash,
  })

  try {
    const preview = await service.preview({
      sourceRef: 'tencent-view-only-stale',
      screenshotRef: 'attachment://screenshot-2',
      rows: [{ company: '虚构云杉科技', role: 'Agent 工程师' }],
    })
    assert.equal(preview.screenshotHash, SCREENSHOT_HASH)
    currentHash = 'b'.repeat(64)
    await assert.rejects(() => service.apply(preview.previewToken), /visual_source_changed/u)
    assert.deepEqual(store.list({ limit: 10 }), [])
    assert.deepEqual(store.listSnapshots({ limit: 10 }), [])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('expires visual preview tokens and makes repeated apply idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-visual-token-'))
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  let now = new Date('2026-08-17T12:00:00.000Z')
  const service = new LocalVisualLeadImportService({ store, now: () => now })

  try {
    const preview = await service.preview({
      sourceRef: 'tencent-view-only-idempotent',
      screenshotRef: 'attachment://screenshot-3',
      screenshotHash: SCREENSHOT_HASH,
      rows: [{ company: '虚构远山科技', role: '数据工程师', channelUrl: 'https://careers.example.invalid/jobs/visual-stable' }],
    })
    const applied = await service.apply(preview.previewToken)
    assert.deepEqual(await service.apply(preview.previewToken), applied)

    const changedExtraction = await service.preview({
      sourceRef: 'tencent-view-only-idempotent',
      screenshotRef: 'attachment://screenshot-3',
      screenshotHash: SCREENSHOT_HASH,
      rows: [{ company: '虚构远山科技', role: '平台工程师', channelUrl: 'https://careers.example.invalid/jobs/visual-stable' }],
    })
    const changedApplied = await service.apply(changedExtraction.previewToken)
    assert.equal(changedApplied.reused, false)
    assert.equal(changedApplied.snapshot.changedCount, 1)

    const second = await service.preview({
      sourceRef: 'tencent-view-only-expired',
      screenshotRef: 'attachment://screenshot-4',
      screenshotHash: SCREENSHOT_HASH,
      rows: [{ company: '虚构青峦科技', role: '后端工程师' }],
    })
    now = new Date('2026-08-17T12:16:00.000Z')
    await assert.rejects(() => service.apply(second.previewToken), /visual_preview_stale/u)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects malformed screenshot references and hashes before preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-visual-invalid-'))
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  const service = new LocalVisualLeadImportService({ store })

  try {
    await assert.rejects(
      () => service.preview({
        sourceRef: 'tencent-view-only-invalid',
        screenshotRef: 'https://example.invalid/image.png',
        screenshotHash: 'not-a-sha256',
        rows: [{ company: '虚构公司', role: '工程师' }],
      }),
      /invalid_visual_source/u,
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
