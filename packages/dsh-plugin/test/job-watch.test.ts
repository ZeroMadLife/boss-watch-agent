import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BossWatchBrowserController,
  BossWatchDataSource,
  BrowserWatchPoll,
  JobDetails,
} from '../src/domain.ts'
import { LocalJobWatchService, SqliteJobWatchStore } from '../src/job-watch.ts'

const START = Date.parse('2026-08-18T02:00:00.000Z')

class MutableSource implements BossWatchDataSource {
  readonly jobs = new Map<string, JobDetails>()

  add(index: number): JobDetails {
    const applicationId = `application-watch-${index}`
    const externalJobId = `fixture-watch-${index}`
    const job: JobDetails = {
      applicationId,
      company: `示例科技${index}`,
      role: `Agent 工程师${index}`,
      jobUrl: `https://www.zhipin.com/job_detail/${externalJobId}.html`,
      capturedAt: '2026-08-18T01:00:00.000Z',
      contentHash: 'a'.repeat(64),
      description: `负责构建可审计的 Agent 工作流 ${index}`,
      artifactRef: `local-artifact://application/watch-${index}`,
    }
    this.jobs.set(applicationId, job)
    return job
  }

  async listJobs() { return [...this.jobs.values()] }
  async listApplicationOverviews() { return [] }
  async getApplicationOverview() { return undefined }
  async getJob(applicationId: string) { return this.jobs.get(applicationId) }
  async listTimeline() { return [] }
}

class FakeBrowser implements BossWatchBrowserController {
  pollCalls = 0
  result: BrowserWatchPoll | undefined
  onPoll: ((applicationId: string) => void) | undefined

  constructor(readonly source: MutableSource) {}

  async status() { return { status: 'no_supported_tab' as const, reason: 'no_boss_page' as const, targetCount: 0 as const } }
  async captureCurrentJob() { return this.status() }
  async discoverJobs() { return { status: 'no_supported_tab' as const, reason: 'no_boss_page' as const, targetCount: 0 as const } }
  async captureDiscoveredJob() { return { status: 'invalid_request' as const, reason: 'job_not_found' as const, targetCount: 0 as const } }

  async pollJob(applicationId: string): Promise<BrowserWatchPoll> {
    this.pollCalls += 1
    this.onPoll?.(applicationId)
    if (this.result !== undefined) return this.result
    const job = this.source.jobs.get(applicationId)
    if (job === undefined || job.jobUrl === undefined) {
      return { status: 'invalid_request', reason: 'job_not_found', targetCount: 0 }
    }
    const externalJobId = /\/job_detail\/([^/.]+)\.html/u.exec(job.jobUrl)?.[1] ?? 'missing'
    return {
      status: 'ok',
      applicationId,
      eventId: `event-watch-${this.pollCalls}`,
      artifactId: `artifact-watch-${this.pollCalls}`,
      artifactRef: `local-artifact://application/watch-poll-${this.pollCalls}`,
      contentHash: job.contentHash,
      savedAt: job.capturedAt,
      deduplicated: true,
      job: {
        externalJobId,
        company: job.company,
        role: job.role,
        jobUrl: job.jobUrl,
        pageRevision: 'b'.repeat(64),
      },
    }
  }
}

function setup(): {
  service: LocalJobWatchService
  store: SqliteJobWatchStore
  source: MutableSource
  browser: FakeBrowser
  setNow(value: number): void
} {
  const source = new MutableSource()
  source.add(1)
  const browser = new FakeBrowser(source)
  const store = new SqliteJobWatchStore(':memory:')
  let nowMs = START
  let id = 0
  const service = new LocalJobWatchService({
    source,
    browser,
    store,
    now: () => new Date(nowMs),
    idFactory: () => String(++id),
  })
  return { service, store, source, browser, setNow(value) { nowMs = value } }
}

test('creates one idempotent active watch only from a captured BOSS application', async () => {
  const { service, store, source } = setup()
  try {
    const created = await service.create('application-watch-1')
    const replay = await service.create('application-watch-1')
    assert.equal(replay.watchId, created.watchId)
    assert.equal(created.state, 'active')
    assert.equal(created.nextPollAt, '2026-08-18T02:00:00.000Z')
    assert.equal(created.baselineContentHash, 'a'.repeat(64))
    assert.equal(service.list().length, 1)

    source.jobs.set('application-watch-invalid', {
      ...source.jobs.get('application-watch-1') as JobDetails,
      applicationId: 'application-watch-invalid',
      jobUrl: 'https://example.invalid/jobs/1',
    })
    await assert.rejects(() => service.create('application-watch-invalid'), /watch_unsupported_job_url/u)
  } finally {
    store.close()
  }
})

test('polls once, records a changed hash, and restores the 12 hour interval', async () => {
  const { service, store, source, browser } = setup()
  try {
    const watch = await service.create('application-watch-1')
    browser.onPoll = (applicationId) => {
      const previous = source.jobs.get(applicationId) as JobDetails
      source.jobs.set(applicationId, {
        ...previous,
        capturedAt: '2026-08-18T02:00:00.000Z',
        contentHash: 'c'.repeat(64),
        description: '负责构建可审计的 Agent 工作流，并新增评测要求。',
      })
    }

    const result = await service.poll(watch.watchId)
    assert.equal(result.result, 'changed')
    assert.equal(result.watch.baselineContentHash, 'c'.repeat(64))
    assert.equal(result.watch.nextPollAt, '2026-08-18T14:00:00.000Z')
    assert.equal(result.observation.previousContentHash, 'a'.repeat(64))
    assert.equal(result.observation.currentContentHash, 'c'.repeat(64))
    assert.equal(browser.pollCalls, 1)
  } finally {
    store.close()
  }
})

test('backs off unchanged watches and rejects a poll before nextPollAt', async () => {
  const { service, store, browser } = setup()
  try {
    const watch = await service.create('application-watch-1')
    const result = await service.poll(watch.watchId)
    assert.equal(result.result, 'unchanged')
    assert.equal(result.watch.consecutiveUnchanged, 1)
    assert.equal(result.watch.nextPollAt, '2026-08-19T02:00:00.000Z')
    await assert.rejects(() => service.poll(watch.watchId), /watch_not_due/u)
    assert.equal(browser.pollCalls, 1)
  } finally {
    store.close()
  }
})

test('pauses on a human handoff and resumes only through an explicit local action', async () => {
  const { service, store, browser } = setup()
  try {
    browser.result = { status: 'human_required', reason: 'verification', targetCount: 1 }
    const watch = await service.create('application-watch-1')
    const result = await service.poll(watch.watchId)
    assert.equal(result.result, 'paused_human_required')
    assert.equal(result.watch.state, 'paused_human_required')
    assert.equal(result.watch.pausedReason, 'verification')
    await assert.rejects(() => service.poll(watch.watchId), /watch_paused/u)

    const resumed = service.resume(watch.watchId)
    assert.equal(resumed.state, 'active')
    assert.equal(resumed.nextPollAt, '2026-08-18T02:00:00.000Z')
  } finally {
    store.close()
  }
})

test('enforces the shared daily detail-page budget before browser navigation', async () => {
  const { service, store, source, browser } = setup()
  try {
    for (let index = 1; index <= 21; index += 1) {
      if (index > 1) source.add(index)
      const watch = await service.create(`application-watch-${index}`)
      if (index <= 20) await service.poll(watch.watchId)
      else await assert.rejects(() => service.poll(watch.watchId), /watch_daily_budget_exhausted/u)
    }
    assert.equal(browser.pollCalls, 20)
  } finally {
    store.close()
  }
})

test('serializes polls across different watches on the same browser profile', async () => {
  const { service, store, source } = setup()
  try {
    source.add(2)
    const first = await service.create('application-watch-1')
    const second = await service.create('application-watch-2')
    store.beginPoll({
      watchId: first.watchId,
      now: new Date(START).toISOString(),
      dayKey: '2026-08-18',
      dailyBudget: 20,
    })

    assert.throws(
      () => store.beginPoll({
        watchId: second.watchId,
        now: new Date(START).toISOString(),
        dayKey: '2026-08-18',
        dailyBudget: 20,
      }),
      /watch_profile_busy/u,
    )
  } finally {
    store.close()
  }
})

test('stops a watch locally and never polls it again', async () => {
  const { service, store, browser } = setup()
  try {
    const watch = await service.create('application-watch-1')
    const stopped = service.stop(watch.watchId)
    assert.equal(stopped.state, 'stopped')
    await assert.rejects(() => service.poll(watch.watchId), /watch_stopped/u)
    assert.equal(browser.pollCalls, 0)
  } finally {
    store.close()
  }
})
