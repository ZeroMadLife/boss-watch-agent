import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SqliteBatchApplicationStore } from '../src/application-batch.ts'
import type { BossWatchDataSource } from '../src/domain.ts'
import { SqliteJobLeadStore } from '../src/job-lead.ts'
import { registerBossWatchTools } from '../src/tools.ts'

test('exposes local-only batch prepare, status and explicit resume tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-batch-tools-'))
  const databasePath = join(dir, 'boss-watch.sqlite3')
  const leadStore = new SqliteJobLeadStore(databasePath)
  const batchStore = new SqliteBatchApplicationStore(databasePath)
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  leadStore.upsert([{
    leadId: 'lead:gankinterview_campus:verified-tool',
    sourceKind: 'gankinterview_campus',
    sourceRecordId: 'verified-tool',
    company: '虚构工具公司',
    role: 'Agent 工程师',
    officialApplyUrl: 'https://careers.example.invalid/jobs/verified-tool',
    fetchedAt: '2026-08-17T08:00:00.000Z',
    rawRef: 'gankinterview://campus/verified-tool',
    contentHash: 'a'.repeat(64),
    confidence: 'jd_verified',
  }])
  const dispose = registerBossWatchTools(context, source, undefined, undefined, leadStore, batchStore)

  try {
    const execute = (name: string, args: Record<string, unknown>, suffix: string) => context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`batch-${suffix}`),
      name,
      arguments: args,
    })
    const preparedResult = await execute('boss_watch_apply_batch_prepare', {
      leadIds: ['lead:gankinterview_campus:verified-tool'],
      sessionId: 'dsh-fixture-session',
    }, 'prepare')
    assert.equal(preparedResult.isError, false)
    const preparedText = preparedResult.content[0]
    if (preparedText?.type !== 'text') throw new Error('expected_text_tool_result')
    const prepared = JSON.parse(preparedText.text) as { status: string; batch: { batchId: string; items: Array<{ itemId: string; itemState: string }> } }
    assert.equal(prepared.status, 'ok')
    assert.equal(prepared.batch.items[0]?.itemState, 'awaiting_gate_b')

    const statusResult = await execute('boss_watch_apply_batch_status', { batchId: prepared.batch.batchId }, 'status')
    const statusText = statusResult.content[0]
    if (statusText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(statusText.text), prepared)

    const itemId = prepared.batch.items[0]?.itemId
    if (itemId === undefined) throw new Error('missing_fixture_item')
    batchStore.recordGateB(prepared.batch.batchId, itemId, {
      authorizationRef: 'approval://fixture/tool',
      contentHash: 'b'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
    })
    batchStore.start(prepared.batch.batchId, itemId)
    batchStore.markHandoff(prepared.batch.batchId, itemId, {
      stage: 'official_form',
      code: 'captcha_required',
      retryCount: 0,
      suggestedAction: '人工完成验证',
    })

    const resumedResult = await execute('boss_watch_apply_batch_resume', { batchId: prepared.batch.batchId }, 'resume')
    const resumedText = resumedResult.content[0]
    if (resumedText?.type !== 'text') throw new Error('expected_text_tool_result')
    const resumed = JSON.parse(resumedText.text) as { status: string; batch: { batchState: string; resumeCount: number; items: Array<{ itemState: string }> } }
    assert.equal(resumed.status, 'ok')
    assert.equal(resumed.batch.batchState, 'queued')
    assert.equal(resumed.batch.resumeCount, 1)
    assert.equal(resumed.batch.items[0]?.itemState, 'awaiting_gate_b')
  } finally {
    dispose()
    await context.fiber.dispose()
    batchStore.close()
    leadStore.close()
    await rm(dir, { recursive: true, force: true })
  }
})
