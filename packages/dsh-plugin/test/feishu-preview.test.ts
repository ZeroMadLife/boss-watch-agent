import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { BossWatchDataSource } from '../src/domain.ts'
import { registerBossWatchTools } from '../src/tools.ts'

test('builds a Feishu preview without performing an external write', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const source: BossWatchDataSource = {
    async listJobs() {
      return []
    },
    async listApplicationOverviews() {
      return []
    },
    async getApplicationOverview() {
      return undefined
    },
    async getJob(applicationId) {
      return {
        applicationId,
        company: '示例公司',
        role: 'AI Agent 工程师',
        jobUrl: 'https://example.invalid/jobs/1',
        capturedAt: '2026-08-16T04:00:00.000Z',
        contentHash: 'a'.repeat(64),
        description: '负责构建可审计的 Agent 工作流。',
        artifactRef: 'local-artifact://application/example',
      }
    },
    async listTimeline(applicationId) {
      return [{
        sequence: 1,
        eventId: 'event-example-1',
        applicationId,
        type: 'job_description_captured',
        occurredAt: '2026-08-16T04:00:00.000Z',
        actor: 'human',
      }]
    },
  }
  const dispose = registerBossWatchTools(context, source)

  try {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('feishu-preview'),
      name: 'boss_watch_feishu_preview',
      arguments: { applicationId: 'application-example-1' },
    })
    assert.equal(result.isError, false)
    const content = result.content[0]
    assert.equal(content?.type, 'text')
    if (content?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(content.text), {
      status: 'ok',
      target: 'feishu_bitable_preview',
      fields: {
        applicationId: 'application-example-1',
        company: '示例公司',
        role: 'AI Agent 工程师',
        jobUrl: 'https://example.invalid/jobs/1',
        capturedAt: '2026-08-16T04:00:00.000Z',
        contentHash: 'a'.repeat(64),
        description: '负责构建可审计的 Agent 工作流。',
      },
      timelineEventCount: 1,
      requiresApproval: true,
    })
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})
