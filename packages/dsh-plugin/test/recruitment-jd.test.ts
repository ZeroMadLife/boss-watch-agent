import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLocalApiServer } from '../../../src/server/local-api-server.ts'
import { SqliteJobLeadStore } from '../src/job-lead.ts'
import { LocalOfficialJobCaptureClient } from '../src/official-job-client.ts'
import {
  LocalRecruitmentJdService,
  type OfficialJobCaptureClient,
  type OfficialJobCaptureInput,
} from '../src/recruitment-jd.ts'
import { LocalRecruitmentSourceService, SqliteRecruitmentSourceStore } from '../src/recruitment-source.ts'
import { SqliteBossWatchDataSource } from '../src/sqlite-source.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'boss-watch-recruitment-jd-'))
  const path = join(directory, 'boss-watch.sqlite3')
  const sourceStore = new SqliteRecruitmentSourceStore(path)
  const leadStore = new SqliteJobLeadStore(path)
  const sourceService = new LocalRecruitmentSourceService({
    store: sourceStore,
    now: () => new Date('2026-08-19T06:00:00.000Z'),
  })
  const sourcePreview = await sourceService.preview({
    rawText: '虚构星舟科技\n内推链接：https://careers.example.invalid/referral/campus-27\n内推码：DEMO27',
  })
  const source = (await sourceService.apply(sourcePreview.previewToken)).source
  return {
    directory,
    source,
    sourceStore,
    leadStore,
    close: async () => {
      leadStore.close()
      sourceStore.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

class FakeOfficialJobCaptureClient implements OfficialJobCaptureClient {
  readonly calls: OfficialJobCaptureInput[] = []

  async capture(input: OfficialJobCaptureInput) {
    this.calls.push(input)
    return {
      applicationId: 'application-official-fixture-001',
      eventId: 'event-official-fixture-001',
      artifactId: 'artifact-official-fixture-001',
      artifactRef: 'artifact://sha256/fixture',
      contentHash: createHash('sha256').update(input.jdText).digest('hex'),
      savedAt: input.capturedAt,
      deduplicated: this.calls.length > 1,
    }
  }
}

const jdText = '岗位职责：使用 TypeScript、Node.js 和 SQL 构建 Agent 平台。任职要求：本科及以上，2027 届。'

test('previews an exact official JD without writing or returning its raw text', async () => {
  const data = await fixture()
  const capture = new FakeOfficialJobCaptureClient()
  const service = new LocalRecruitmentJdService({
    sources: data.sourceStore,
    leads: data.leadStore,
    capture,
    now: () => new Date('2026-08-19T06:10:00.000Z'),
  })

  try {
    const preview = await service.preview({
      sourceId: data.source.sourceId,
      role: 'Agent 平台开发工程师',
      officialJobUrl: 'https://careers.example.invalid/jobs/agent-platform',
      jdText,
      city: '深圳',
      cohort: '2027 届',
    })

    assert.equal(preview.company, '虚构星舟科技')
    assert.equal(preview.role, 'Agent 平台开发工程师')
    assert.equal(preview.jdContentHash, createHash('sha256').update(jdText).digest('hex'))
    assert.equal(preview.jdLength, jdText.length)
    assert.equal(preview.requiresConfirmation, true)
    assert.equal(JSON.stringify(preview).includes(jdText), false)
    assert.equal(capture.calls.length, 0)
    assert.equal(data.leadStore.list().length, 0)
    assert.equal(data.sourceStore.get(data.source.sourceId)?.status, 'source_only')
  } finally {
    await data.close()
  }
})

test('rejects an unknown source and an unsafe official job URL', async () => {
  const data = await fixture()
  const service = new LocalRecruitmentJdService({
    sources: data.sourceStore,
    leads: data.leadStore,
    capture: new FakeOfficialJobCaptureClient(),
  })

  try {
    await assert.rejects(service.preview({
      sourceId: 'recruitment-source:missing',
      role: 'Agent 工程师',
      officialJobUrl: 'https://careers.example.invalid/jobs/agent',
      jdText,
    }), /recruitment_source_not_found/u)
    await assert.rejects(service.preview({
      sourceId: data.source.sourceId,
      role: 'Agent 工程师',
      officialJobUrl: 'https://127.0.0.1/private',
      jdText,
    }), /official_job_url_invalid/u)
    assert.equal(data.leadStore.list().length, 0)
  } finally {
    await data.close()
  }
})

test('binds the confirmed JD to one verified lead and application idempotently', async () => {
  const data = await fixture()
  const capture = new FakeOfficialJobCaptureClient()
  const service = new LocalRecruitmentJdService({
    sources: data.sourceStore,
    leads: data.leadStore,
    capture,
    now: () => new Date('2026-08-19T06:10:00.000Z'),
  })

  try {
    const preview = await service.preview({
      sourceId: data.source.sourceId,
      role: 'Agent 平台开发工程师',
      officialJobUrl: 'https://careers.example.invalid/jobs/agent-platform',
      jdText,
      city: '深圳',
      cohort: '2027 届',
      recruitmentType: '秋招',
      deadline: '招满为止',
    })
    const applied = await service.apply(preview.previewToken)
    const replay = await service.apply(preview.previewToken)

    assert.deepEqual(replay, applied)
    assert.equal(capture.calls.length, 1)
    assert.equal(applied.applicationId, 'application-official-fixture-001')
    assert.equal(applied.contentHash, preview.jdContentHash)
    assert.equal(applied.lead.company, data.source.company)
    assert.equal(applied.lead.role, 'Agent 平台开发工程师')
    assert.equal(applied.lead.confidence, 'human_confirmed')
    assert.equal(applied.lead.officialApplyUrl, 'https://careers.example.invalid/jobs/agent-platform')
    assert.equal(data.leadStore.list().length, 1)
    assert.deepEqual(data.sourceStore.get(data.source.sourceId), applied.source)
    assert.equal(applied.source.status, 'jd_ready')
    assert.equal(applied.source.boundLeadId, applied.lead.leadId)
    assert.equal(applied.source.boundApplicationId, applied.applicationId)
    assert.equal(applied.source.jdContentHash, preview.jdContentHash)
    assert.equal(JSON.stringify(applied).includes(jdText), false)
  } finally {
    await data.close()
  }
})

test('rejects a preview after the recruitment source evidence changes', async () => {
  const data = await fixture()
  const capture = new FakeOfficialJobCaptureClient()
  const service = new LocalRecruitmentJdService({
    sources: data.sourceStore,
    leads: data.leadStore,
    capture,
    now: () => new Date('2026-08-19T06:10:00.000Z'),
  })

  try {
    const preview = await service.preview({
      sourceId: data.source.sourceId,
      role: 'Agent 平台开发工程师',
      officialJobUrl: 'https://careers.example.invalid/jobs/agent-platform',
      jdText,
    })
    data.sourceStore.save({
      ...data.source,
      rawArtifactHash: 'f'.repeat(64),
      capturedAt: '2026-08-19T06:11:00.000Z',
    })

    await assert.rejects(service.apply(preview.previewToken), /recruitment_jd_preview_stale/u)
    assert.equal(capture.calls.length, 0)
    assert.equal(data.leadStore.list().length, 0)
  } finally {
    await data.close()
  }
})

test('persists an official JD through the real loopback API for immediate match consumption', async () => {
  const data = await fixture()
  const token = 'service-token-recruitment-jd-e2e-1234567890'
  const tokenPath = join(data.directory, 'dsh-service-token')
  await writeFile(tokenPath, token, 'utf8')
  const server = createLocalApiServer({
    databasePath: join(data.directory, 'boss-watch.sqlite3'),
    pairingCode: '123456',
    runtimeMode: 'baseline_ready',
    serviceToken: token,
    now: () => new Date('2026-08-19T06:10:00.000Z'),
  })

  try {
    const address = await server.start({ port: 0 })
    const service = new LocalRecruitmentJdService({
      sources: data.sourceStore,
      leads: data.leadStore,
      capture: new LocalOfficialJobCaptureClient(address.origin, tokenPath),
      now: () => new Date('2026-08-19T06:10:00.000Z'),
    })
    const preview = await service.preview({
      sourceId: data.source.sourceId,
      role: 'Agent 平台开发工程师',
      officialJobUrl: 'https://careers.example.invalid/jobs/agent-platform',
      jdText,
    })
    const result = await service.apply(preview.previewToken)
    const source = new SqliteBossWatchDataSource(join(data.directory, 'boss-watch.sqlite3'))
    const job = await source.getJob(result.applicationId)

    assert.equal(job?.company, '虚构星舟科技')
    assert.equal(job?.role, 'Agent 平台开发工程师')
    assert.equal(job?.description, jdText)
    assert.equal(job?.contentHash, preview.jdContentHash)
  } finally {
    await server.close()
    await data.close()
  }
})
