import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteRecruitmentSourceStore, LocalRecruitmentSourceService } from '../src/recruitment-source.ts'

test('previews pasted recruitment source without writing a job lead', async () => {
  const store = new SqliteRecruitmentSourceStore(':memory:')
  const service = new LocalRecruitmentSourceService({ store, now: () => new Date('2026-08-19T05:00:00.000Z') })

  try {
    const preview = await service.preview({
      rawText: '虚构星舟科技\n内推链接：https://careers.example.invalid/referral/campus-27\n内推码：DEMO27',
    })

    assert.equal(preview.source.company, '虚构星舟科技')
    assert.equal(preview.source.channelUrl, 'https://careers.example.invalid/referral/campus-27')
    assert.equal(preview.source.referralCode, 'DEMO27')
    assert.equal(preview.source.sourceType, 'official_referral')
    assert.equal(preview.source.status, 'source_only')
    assert.equal(preview.source.rawArtifactHash.length, 64)
    assert.equal(store.list().length, 0)
  } finally {
    store.close()
  }
})

test('applies a confirmed source idempotently and keeps role/JD empty', async () => {
  const store = new SqliteRecruitmentSourceStore(':memory:')
  const service = new LocalRecruitmentSourceService({ store, now: () => new Date('2026-08-19T05:00:00.000Z') })

  try {
    const preview = await service.preview({
      rawText: '公司：虚构云图科技\n投递链接: https://careers.example.invalid/referral/abc\n推荐码: R-1234',
    })
    const applied = await service.apply(preview.previewToken)
    const replay = await service.apply(preview.previewToken)

    assert.deepEqual(replay, applied)
    assert.equal(applied.source.company, '虚构云图科技')
    assert.equal(applied.source.status, 'source_only')
    assert.equal(store.list().length, 1)
    assert.equal(store.get(applied.source.sourceId)?.channelUrl, 'https://careers.example.invalid/referral/abc')
  } finally {
    store.close()
  }
})

test('invalidates the JD binding when the raw source evidence changes', async () => {
  const store = new SqliteRecruitmentSourceStore(':memory:')
  const service = new LocalRecruitmentSourceService({ store, now: () => new Date('2026-08-19T05:00:00.000Z') })

  try {
    const initialPreview = await service.preview({
      rawText: '虚构云图科技\n投递链接: https://careers.example.invalid/referral/abc\n推荐码: R-1234',
    })
    const initial = await service.apply(initialPreview.previewToken)
    store.bindJd({
      sourceId: initial.source.sourceId,
      expectedRawArtifactHash: initial.source.rawArtifactHash,
      boundLeadId: 'lead:fictional-cloud-map:backend',
      boundApplicationId: 'application:fictional-cloud-map:backend',
      role: '后端开发工程师',
      officialJobUrl: 'https://careers.example.invalid/jobs/backend',
      jdContentHash: 'a'.repeat(64),
    })

    const changedPreview = await service.preview({
      rawText: '虚构云图科技\n投递链接: https://careers.example.invalid/referral/abc\n推荐码: R-1234\n截止日期: 2026-08-31',
    })
    const changed = await service.apply(changedPreview.previewToken)

    assert.equal(changed.source.sourceId, initial.source.sourceId)
    assert.notEqual(changed.source.rawArtifactHash, initial.source.rawArtifactHash)
    assert.equal(changed.source.status, 'source_only')
    assert.equal(changed.source.boundLeadId, undefined)
    assert.equal(changed.source.boundApplicationId, undefined)
    assert.equal(changed.source.role, undefined)
    assert.equal(changed.source.officialJobUrl, undefined)
    assert.equal(changed.source.jdContentHash, undefined)
  } finally {
    store.close()
  }
})

test('rejects an unscoped paste and unsafe channel URL', async () => {
  const store = new SqliteRecruitmentSourceStore(':memory:')
  const service = new LocalRecruitmentSourceService({ store })

  try {
    await assert.rejects(
      service.preview({ rawText: '内推码：ONLY-CODE' }),
      /https_channel_url_required/u,
    )
    await assert.rejects(
      service.preview({ rawText: '虚构公司\n投递链接：http://careers.example.invalid/job' }),
      /https_channel_url_required/u,
    )
    assert.equal(store.list().length, 0)
  } finally {
    store.close()
  }
})
