import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SqliteFollowUpStore } from '../src/application-follow-up.ts'
import type { BossWatchDataSource } from '../src/domain.ts'
import { registerBossWatchTools } from '../src/tools.ts'

test('exposes a fresh local follow-up inbox and local completion controls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-follow-up-tools-'))
  const store = new SqliteFollowUpStore(join(dir, 'boss-watch.sqlite3'))
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview(applicationId) {
      return applicationId === 'application-fixture-1' ? {
        applicationId,
        company: '虚构科技',
        role: 'Agent 工程师',
        capturedAt: '2026-08-17T08:00:00.000Z',
        contentHash: 'a'.repeat(64),
        progressState: 'conversation_active' as const,
        eventCount: 2,
        recruiterMessageCount: 1,
        interviewNoteCount: 0,
        progressSignalCount: 0,
        latestEventType: 'recruiter_message_captured',
        latestEventAt: '2026-08-17T08:30:00.000Z',
      } : undefined
    },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const dispose = registerBossWatchTools(context, source, undefined, undefined, undefined, undefined, store)
  const execute = (name: string, args: Record<string, unknown>, suffix: string) => context.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`follow-up-${suffix}`),
    name,
    arguments: args,
  })

  try {
    const scheduledResult = await execute('boss_watch_follow_up_schedule', {
      applicationId: 'application-fixture-1',
      dueAt: '2026-08-17T09:00:00.000Z',
      reason: 'no_response',
      note: '等待用户人工判断',
    }, 'schedule')
    const scheduledText = scheduledResult.content[0]
    if (scheduledText?.type !== 'text') throw new Error('expected_text_tool_result')
    const scheduled = JSON.parse(scheduledText.text) as { status: string; followUp: { followUpId: string } }
    assert.equal(scheduled.status, 'ok')

    const listResult = await execute('boss_watch_follow_up_list', { asOf: '2026-08-18T00:00:00.000Z' }, 'list')
    const listText = listResult.content[0]
    if (listText?.type !== 'text') throw new Error('expected_text_tool_result')
    const list = JSON.parse(listText.text) as { status: string; overdueCount: number; items: Array<Record<string, unknown>> }
    assert.equal(list.status, 'ok')
    assert.equal(list.overdueCount, 1)
    assert.deepEqual(list.items[0], {
      followUpId: scheduled.followUp.followUpId,
      applicationId: 'application-fixture-1',
      dueAt: '2026-08-17T09:00:00.000Z',
      reason: 'no_response',
      note: '等待用户人工判断',
      state: 'scheduled',
      createdAt: list.items[0]?.createdAt,
      urgency: 'overdue',
      nextAction: '人工判断是否需要跟进，不自动发送消息',
      applicationFound: true,
      company: '虚构科技',
      role: 'Agent 工程师',
      progressState: 'conversation_active',
      latestEventType: 'recruiter_message_captured',
      latestEventAt: '2026-08-17T08:30:00.000Z',
    })

    const completedResult = await execute('boss_watch_follow_up_complete', { followUpId: scheduled.followUp.followUpId }, 'complete')
    const completedText = completedResult.content[0]
    if (completedText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.equal((JSON.parse(completedText.text) as { status: string }).status, 'ok')

    const emptyResult = await execute('boss_watch_follow_up_list', { asOf: '2026-08-18T00:00:00.000Z' }, 'empty')
    const emptyText = emptyResult.content[0]
    if (emptyText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.equal((JSON.parse(emptyText.text) as { count: number }).count, 0)
  } finally {
    dispose()
    await context.fiber.dispose()
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
