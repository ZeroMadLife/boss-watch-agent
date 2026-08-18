import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { BossWatchDataSource } from '../src/domain.ts'
import { registerBossWatchTools } from '../src/tools.ts'

test('returns a read-only progress overview from the local fact source', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const overview = {
    applicationId: 'application-example-1',
    company: '示例公司',
    role: 'AI Agent 工程师',
    jobUrl: 'https://example.invalid/jobs/1',
    capturedAt: '2026-08-16T04:00:00.000Z',
    contentHash: 'a'.repeat(64),
    progressState: 'status_proposed' as const,
    eventCount: 3,
    recruiterMessageCount: 1,
    interviewNoteCount: 0,
    progressSignalCount: 0,
    latestEventType: 'status_change_proposed',
    latestEventAt: '2026-08-16T04:05:00.000Z',
    proposedStatus: 'awaiting_gate_b',
  }
  const source: BossWatchDataSource = {
    async listJobs() {
      return []
    },
    async listApplicationOverviews() {
      return [overview]
    },
    async getApplicationOverview(applicationId) {
      return applicationId === overview.applicationId ? overview : undefined
    },
    async getJob() {
      return undefined
    },
    async listTimeline() {
      return []
    },
  }
  const dispose = registerBossWatchTools(context, source)

  try {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('application-overview'),
      name: 'boss_watch_application_overview',
      arguments: { applicationId: overview.applicationId },
    })
    assert.equal(result.isError, false)
    const content = result.content[0]
    assert.equal(content?.type, 'text')
    if (content?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(content.text), { status: 'ok', overview })
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})

test('lists the local application tracker from a fresh source read on every call', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  let reads = 0
  const first = {
    applicationId: 'application-live-1',
    company: '示例公司',
    role: '平台工程师',
    capturedAt: '2026-08-17T04:00:00.000Z',
    contentHash: 'b'.repeat(64),
    progressState: 'new' as const,
    eventCount: 1,
    recruiterMessageCount: 0,
    interviewNoteCount: 0,
    progressSignalCount: 0,
    latestEventType: 'job_description_captured',
    latestEventAt: '2026-08-17T04:00:00.000Z',
  }
  const second = {
    ...first,
    progressState: 'conversation_active' as const,
    eventCount: 2,
    recruiterMessageCount: 1,
    latestEventType: 'recruiter_message_captured',
    latestEventAt: '2026-08-17T04:05:00.000Z',
  }
  const source: BossWatchDataSource = {
    async listJobs() {
      return []
    },
    async listApplicationOverviews() {
      reads += 1
      return [reads === 1 ? first : second]
    },
    async getApplicationOverview() {
      return undefined
    },
    async getJob() {
      return undefined
    },
    async listTimeline() {
      return []
    },
  }
  const dispose = registerBossWatchTools(context, source)

  try {
    const execute = () => context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`application-list-${reads}`),
      name: 'boss_watch_application_list',
      arguments: {},
    })
    const firstResult = await execute()
    const secondResult = await execute()
    assert.equal(firstResult.isError, false)
    assert.equal(secondResult.isError, false)
    const firstText = firstResult.content[0]
    const secondText = secondResult.content[0]
    if (firstText?.type !== 'text' || secondText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(firstText.text), { status: 'ok', applications: [first], count: 1 })
    assert.deepEqual(JSON.parse(secondText.text), { status: 'ok', applications: [second], count: 1 })
    assert.equal(reads, 2)
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})
