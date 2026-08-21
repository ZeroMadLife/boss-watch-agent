import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalJobSourceRefreshScheduler } from '../src/job-source-refresh-scheduler.ts'

test('runs one structured source refresh and keeps a bounded status snapshot', async () => {
  const calls: unknown[] = []
  const scheduler = new LocalJobSourceRefreshScheduler({
    source: { async search(query) { calls.push(query); return [{ leadId: 'lead:1' }, { leadId: 'lead:2' }] as never } },
    now: () => new Date('2026-08-21T00:00:00.000Z'),
    idFactory: () => 'run-1',
    intervalMinutes: 120,
  })
  const run = await scheduler.runNow()
  assert.equal(run.status, 'completed')
  assert.equal(run.leadCount, 2)
  assert.deepEqual(run.leadIds, ['lead:1', 'lead:2'])
  assert.deepEqual(calls, [{ limit: 50 }])
  assert.equal(scheduler.status().enabled, false)
  assert.equal(scheduler.status().lastRun?.runId, 'job-source-refresh:run-1')
})

test('does not allow concurrent refreshes', async () => {
  let resolveSearch: (() => void) | undefined
  const searchStarted = new Promise<void>((resolve) => { resolveSearch = resolve })
  const scheduler = new LocalJobSourceRefreshScheduler({ source: { async search() { await searchStarted; return [] } } })
  const first = scheduler.runNow()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await assert.rejects(scheduler.runNow(), /job_source_refresh_in_progress/u)
  resolveSearch?.()
  await first
})

test('validates the low-frequency interval boundary', () => {
  assert.throws(() => new LocalJobSourceRefreshScheduler({ source: { search: async () => [] }, intervalMinutes: 30 }), /invalid_job_source_refresh_interval/u)
  assert.throws(() => new LocalJobSourceRefreshScheduler({ source: { search: async () => [] }, intervalMinutes: 181 }), /invalid_job_source_refresh_interval/u)
})
