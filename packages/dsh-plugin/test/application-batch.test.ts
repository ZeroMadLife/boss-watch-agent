import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteBatchApplicationStore } from '../src/application-batch.ts'
import type { JobLead } from '../src/job-lead.ts'
import { SqliteJobLeadStore } from '../src/job-lead.ts'

test('prepares an ordered local batch only from verified leads and restores a handoff checkpoint safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-batch-'))
  const databasePath = join(dir, 'boss-watch.sqlite3')
  const leadStore = new SqliteJobLeadStore(databasePath)
  const batchStore = new SqliteBatchApplicationStore(databasePath)
  const first = fixtureLead('lead-verified-1', '虚构甲公司', 'Agent 工程师', 'jd_verified')
  const second = fixtureLead('lead-verified-2', '虚构乙公司', '平台工程师', 'human_confirmed')
  const sourceOnly = fixtureLead('lead-source-only', '虚构丙公司', '后端工程师', 'source_only')
  leadStore.upsert([first, second, sourceOnly])

  try {
    assert.throws(
      () => batchStore.prepare({ leadIds: [sourceOnly.leadId], now: '2026-08-17T09:00:00.000Z' }),
      /lead_not_verified/u,
    )
    assert.throws(
      () => batchStore.prepare({ leadIds: [first.leadId, first.leadId], now: '2026-08-17T09:00:00.000Z' }),
      /duplicate_lead_id/u,
    )

    const prepared = batchStore.prepare({
      leadIds: [second.leadId, first.leadId],
      sessionId: 'dsh-session-fixture',
      now: '2026-08-17T09:00:00.000Z',
    })
    assert.match(prepared.batchId, /^batch:/u)
    assert.equal(prepared.batchState, 'queued')
    assert.equal(prepared.currentCursor, 0)
    assert.deepEqual(prepared.items.map(({ leadId, sequence, company, itemState }) => ({ leadId, sequence, company, itemState })), [
      { leadId: second.leadId, sequence: 1, company: second.company, itemState: 'awaiting_gate_b' },
      { leadId: first.leadId, sequence: 2, company: first.company, itemState: 'awaiting_gate_b' },
    ])

    const item = prepared.items[0]
    if (item === undefined) throw new Error('missing_fixture_item')
    const authorized = batchStore.recordGateB(prepared.batchId, item.itemId, {
      authorizationRef: 'approval://fixture/1',
      contentHash: 'd'.repeat(64),
      expiresAt: '2026-08-17T10:00:00.000Z',
      now: '2026-08-17T09:01:00.000Z',
    })
    assert.equal(authorized.items[0]?.itemState, 'ready')
    const running = batchStore.start(prepared.batchId, item.itemId, '2026-08-17T09:02:00.000Z')
    assert.equal(running.batchState, 'running')
    assert.equal(running.items[0]?.itemState, 'in_progress')

    const paused = batchStore.markHandoff(prepared.batchId, item.itemId, {
      stage: 'official_form',
      code: 'captcha_required',
      pageKind: 'captcha',
      evidenceAt: '2026-08-17T09:03:00.000Z',
      retryCount: 0,
      suggestedAction: '用户完成验证码后明确恢复',
    }, '2026-08-17T09:03:00.000Z')
    assert.equal(paused.batchState, 'paused_handoff')
    assert.equal(paused.pausedReason, 'captcha_required')
    assert.equal(paused.items[0]?.itemState, 'handoff_required')
    assert.deepEqual(paused.items[0]?.checkpoint, {
      itemId: item.itemId,
      sequence: 1,
      stage: 'official_form',
      code: 'captcha_required',
      savedAt: '2026-08-17T09:03:00.000Z',
      retryCount: 0,
      nextAction: '用户完成验证码后明确恢复',
    })

    const reloaded = batchStore.get(prepared.batchId)
    assert.deepEqual(reloaded, paused)
    const resumed = batchStore.resume(prepared.batchId, '2026-08-17T09:10:00.000Z')
    assert.equal(resumed.batchState, 'queued')
    assert.equal(resumed.resumeCount, 1)
    assert.equal(resumed.items[0]?.itemState, 'awaiting_gate_b')
    assert.equal(resumed.items[0]?.checkpoint, undefined)
    assert.equal(resumed.items[0]?.gateBRef, undefined)
    assert.throws(() => batchStore.resume(prepared.batchId), /batch_not_paused/u)
  } finally {
    batchStore.close()
    leadStore.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('derives batch completion from submitted, failed and skipped item states', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-batch-state-'))
  const databasePath = join(dir, 'boss-watch.sqlite3')
  const leadStore = new SqliteJobLeadStore(databasePath)
  const batchStore = new SqliteBatchApplicationStore(databasePath)
  const first = fixtureLead('lead-state-1', '虚构丁公司', '数据工程师', 'jd_verified')
  const second = fixtureLead('lead-state-2', '虚构戊公司', '前端工程师', 'jd_verified')
  leadStore.upsert([first, second])

  try {
    let batch = batchStore.prepare({ leadIds: [first.leadId, second.leadId], now: '2026-08-17T09:00:00.000Z' })
    const firstItem = batch.items[0]
    const secondItem = batch.items[1]
    if (firstItem === undefined || secondItem === undefined) throw new Error('missing_fixture_item')
    batchStore.recordGateB(batch.batchId, firstItem.itemId, gateB('1'))
    batchStore.start(batch.batchId, firstItem.itemId, '2026-08-17T09:02:00.000Z')
    batch = batchStore.markSubmittedObserved(batch.batchId, firstItem.itemId, '2026-08-17T09:03:00.000Z')
    assert.equal(batch.currentCursor, 1)
    assert.equal(batch.items[0]?.itemState, 'submitted_observed')

    batchStore.recordGateB(batch.batchId, secondItem.itemId, gateB('2'))
    batchStore.start(batch.batchId, secondItem.itemId, '2026-08-17T09:04:00.000Z')
    batch = batchStore.markFailed(batch.batchId, secondItem.itemId, {
      stage: 'result_verification',
      code: 'submission_result_unknown',
      retryCount: 0,
      suggestedAction: '人工核对后选择跳过或重新授权',
    })
    assert.equal(batch.batchState, 'completed_with_failures')
    assert.equal(batch.items[1]?.itemState, 'failed')

    batch = batchStore.skip(batch.batchId, secondItem.itemId, '人工确认本轮跳过')
    assert.equal(batch.batchState, 'completed')
    assert.equal(batch.currentCursor, 2)
    assert.equal(batch.items[1]?.itemState, 'skipped')
  } finally {
    batchStore.close()
    leadStore.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects a batch item when its verified lead snapshot becomes stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-batch-stale-'))
  const databasePath = join(dir, 'boss-watch.sqlite3')
  const leadStore = new SqliteJobLeadStore(databasePath)
  const batchStore = new SqliteBatchApplicationStore(databasePath)
  const first = fixtureLead('lead-stale-1', '虚构己公司', '平台工程师', 'human_confirmed')
  leadStore.upsert([first])

  try {
    const prepared = batchStore.prepare({ leadIds: [first.leadId], now: '2026-08-17T09:00:00.000Z' })
    leadStore.upsert([{
      ...first,
      role: '平台工程师（更新版）',
      fetchedAt: '2026-08-17T09:01:00.000Z',
      contentHash: 'e'.repeat(64),
    }])
    assert.throws(
      () => batchStore.recordGateB(prepared.batchId, prepared.items[0]?.itemId ?? '', {
        authorizationRef: 'approval://fixture/stale',
        contentHash: 'f'.repeat(64),
        expiresAt: '2026-08-17T10:00:00.000Z',
        now: '2026-08-17T09:02:00.000Z',
      }),
      /lead_content_changed/u,
    )
    assert.equal(batchStore.get(prepared.batchId)?.items[0]?.itemState, 'awaiting_gate_b')

    const second = fixtureLead('lead-stale-2', '虚构庚公司', '前端工程师', 'jd_verified')
    leadStore.upsert([second])
    const readyBatch = batchStore.prepare({ leadIds: [second.leadId], now: '2026-08-17T09:03:00.000Z' })
    const readyItemId = readyBatch.items[0]?.itemId ?? ''
    batchStore.recordGateB(readyBatch.batchId, readyItemId, {
      authorizationRef: 'approval://fixture/stale-after-gate',
      contentHash: '1'.repeat(64),
      expiresAt: '2026-08-17T10:00:00.000Z',
      now: '2026-08-17T09:04:00.000Z',
    })
    leadStore.upsert([{
      ...second,
      role: '前端工程师（更新版）',
      fetchedAt: '2026-08-17T09:05:00.000Z',
      contentHash: '2'.repeat(64),
    }])
    assert.throws(
      () => batchStore.start(readyBatch.batchId, readyItemId, '2026-08-17T09:06:00.000Z'),
      /lead_content_changed/u,
    )
    assert.equal(batchStore.get(readyBatch.batchId)?.items[0]?.itemState, 'ready')
  } finally {
    batchStore.close()
    leadStore.close()
    await rm(dir, { recursive: true, force: true })
  }
})

function fixtureLead(id: string, company: string, role: string, confidence: JobLead['confidence']): JobLead {
  return {
    leadId: `lead:gankinterview_campus:${id}`,
    sourceKind: 'gankinterview_campus',
    sourceRecordId: id,
    company,
    role,
    channelUrl: `https://example.invalid/channel/${id}`,
    officialApplyUrl: `https://careers.example.invalid/jobs/${id}`,
    fetchedAt: '2026-08-17T08:00:00.000Z',
    rawRef: `gankinterview://campus/${id}`,
    contentHash: 'c'.repeat(64),
    confidence,
  }
}

function gateB(suffix: string): { authorizationRef: string; contentHash: string; expiresAt: string; now: string } {
  return {
    authorizationRef: `approval://fixture/${suffix}`,
    contentHash: suffix.repeat(64),
    expiresAt: '2026-08-17T10:00:00.000Z',
    now: '2026-08-17T09:01:00.000Z',
  }
}
