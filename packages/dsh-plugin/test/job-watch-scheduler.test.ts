import assert from 'node:assert/strict'
import test from 'node:test'
import type { JobWatch, JobWatchPollResult, JobWatchPollService } from '../src/job-watch.ts'
import { LocalJobWatchScheduler } from '../src/job-watch-scheduler.ts'

const NOW = '2026-08-18T02:00:00.000Z'

function watch(watchId: string, nextPollAt: string): JobWatch {
  return {
    watchId,
    applicationId: `application-${watchId}`,
    platform: 'boss',
    externalJobId: `external-${watchId}`,
    company: '虚构科技',
    role: 'Agent 工程师',
    jobUrl: `https://www.zhipin.com/job_detail/${watchId}.html`,
    state: 'active',
    createdAt: '2026-08-18T01:00:00.000Z',
    nextPollAt,
    baselineContentHash: 'a'.repeat(64),
    consecutiveUnchanged: 0,
    consecutiveFailures: 0,
    dailyPollCount: 0,
  }
}

function result(watchId: string, value: JobWatchPollResult['result']): JobWatchPollResult {
  const current = watch(watchId, '2026-08-19T02:00:00.000Z')
  return {
    result: value,
    watch: { ...current, lastResult: value },
    observation: {
      observationId: `observation-${watchId}`,
      watchId,
      observedAt: NOW,
      result: value,
      previousContentHash: current.baselineContentHash,
    },
    browserStatus: value === 'paused_human_required' ? 'human_required' : 'ok',
  }
}

class FakeWatchService implements JobWatchPollService {
  readonly watches: JobWatch[]
  readonly calls: string[] = []
  readonly responses = new Map<string, JobWatchPollResult | Error | Promise<JobWatchPollResult>>()

  constructor(watches: JobWatch[]) {
    this.watches = watches
  }

  list(): readonly JobWatch[] {
    return this.watches
  }

  async poll(watchId: string): Promise<JobWatchPollResult> {
    this.calls.push(watchId)
    const response = this.responses.get(watchId) ?? result(watchId, 'unchanged')
    if (response instanceof Error) throw response
    return await response
  }
}

test('runs due watches in order, respects the batch limit, and leaves future watches untouched', async () => {
  const service = new FakeWatchService([
    watch('watch-later', '2026-08-18T03:00:00.000Z'),
    watch('watch-third', '2026-08-18T01:45:00.000Z'),
    watch('watch-second', '2026-08-18T01:30:00.000Z'),
    watch('watch-first', '2026-08-18T01:00:00.000Z'),
  ])
  const scheduler = new LocalJobWatchScheduler({ service, now: () => new Date(NOW), idFactory: () => 'run-1' })

  const run = await scheduler.runDue({ limit: 2 })

  assert.equal(run.status, 'completed')
  assert.equal(run.runId, 'watch-scheduler:run-1')
  assert.equal(run.dueCount, 3)
  assert.equal(run.attemptedCount, 2)
  assert.equal(run.remainingDueCount, 1)
  assert.deepEqual(service.calls, ['watch-first', 'watch-second'])
  assert.deepEqual(run.items.map((item) => item.result), ['unchanged', 'unchanged'])
})

test('stops a run after human handoff or transient failure without retrying later watches', async () => {
  const service = new FakeWatchService([
    watch('watch-first', '2026-08-18T01:00:00.000Z'),
    watch('watch-second', '2026-08-18T01:01:00.000Z'),
  ])
  service.responses.set('watch-first', result('watch-first', 'paused_human_required'))
  const scheduler = new LocalJobWatchScheduler({ service, now: () => new Date(NOW), idFactory: () => 'run-2' })

  const run = await scheduler.runDue()

  assert.equal(run.status, 'stopped_handoff')
  assert.equal(run.stopReason, 'paused_human_required')
  assert.equal(run.attemptedCount, 1)
  assert.equal(run.remainingDueCount, 1)
  assert.deepEqual(service.calls, ['watch-first'])
})

test('supports cooperative cancellation and rejects overlapping scheduler runs', async () => {
  const service = new FakeWatchService([watch('watch-first', '2026-08-18T01:00:00.000Z')])
  let release: (() => void) | undefined
  service.responses.set('watch-first', new Promise<JobWatchPollResult>((resolve) => {
    release = () => resolve(result('watch-first', 'unchanged'))
  }))
  const scheduler = new LocalJobWatchScheduler({ service, now: () => new Date(NOW), idFactory: () => 'run-3' })

  const controller = new AbortController()
  const runPromise = scheduler.runDue({ signal: controller.signal })
  await assert.rejects(() => scheduler.runDue(), /watch_scheduler_in_progress/u)
  controller.abort()
  release?.()
  const run = await runPromise

  assert.equal(run.status, 'cancelled')
  assert.equal(run.attemptedCount, 1)
})
