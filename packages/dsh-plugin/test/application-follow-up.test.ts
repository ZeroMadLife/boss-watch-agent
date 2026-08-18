import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteFollowUpStore } from '../src/application-follow-up.ts'

test('persists local follow-up reminders, deduplicates retries, and completes them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-follow-up-'))
  const path = join(dir, 'boss-watch.sqlite3')
  const store = new SqliteFollowUpStore(path)
  try {
    const first = store.schedule({
      applicationId: 'application-fixture-1',
      dueAt: '2026-08-18T09:00:00.000Z',
      reason: 'no_response',
      note: '仅作本地提醒',
      now: '2026-08-17T09:00:00.000Z',
    })
    const replay = store.schedule({
      applicationId: 'application-fixture-1',
      dueAt: '2026-08-18T09:00:00.000Z',
      reason: 'no_response',
      note: '重试不新增提醒',
      now: '2026-08-17T09:01:00.000Z',
    })
    assert.deepEqual(replay, first)
    assert.deepEqual(store.listActive({ asOf: '2026-08-19T00:00:00.000Z' }), [first])

    const completed = store.complete(first.followUpId, '2026-08-19T01:00:00.000Z')
    assert.deepEqual(completed, { ...first, state: 'completed', completedAt: '2026-08-19T01:00:00.000Z' })
    assert.deepEqual(store.listActive(), [])
    assert.deepEqual(store.complete(first.followUpId), completed)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects malformed reminder input and unknown reminders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-follow-up-invalid-'))
  const path = join(dir, 'boss-watch.sqlite3')
  const store = new SqliteFollowUpStore(path)
  try {
    assert.throws(() => store.schedule({
      applicationId: 'application-fixture-1',
      dueAt: 'not-a-date',
      reason: 'manual',
    }), /invalid_follow_up_due_at/u)
    assert.throws(() => store.schedule({
      applicationId: 'application-fixture-1',
      dueAt: '2026-08-18T09:00:00.000Z',
      reason: 'other' as never,
    }), /invalid_follow_up_reason/u)
    assert.throws(() => store.complete('missing-follow-up'), /follow_up_not_found/u)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
