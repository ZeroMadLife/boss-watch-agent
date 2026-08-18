import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { BossWatchBrowserController, BossWatchDataSource } from '../src/domain.ts'
import type { LocalInterviewNoteClient } from '../src/interview-note-client.ts'
import { registerBossWatchTools } from '../src/tools.ts'

const facts: BossWatchDataSource = {
  async listJobs() { return [] },
  async listApplicationOverviews() { return [] },
  async getApplicationOverview() { return undefined },
  async getJob() { return undefined },
  async listTimeline() { return [] },
}

test('exposes bounded browser discovery and capture tools', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  let captureCalls = 0
  let conversationCaptureCalls = 0
  const browser: BossWatchBrowserController = {
    async status() {
      return {
        status: 'ready',
        targetCount: 1,
        target: {
          pageKind: 'job_detail',
          title: '虚构岗位',
          url: 'https://www.zhipin.com/job_detail/fixture-tool-001.html',
        },
      }
    },
    async captureCurrentJob() {
      captureCalls += 1
      return {
        status: 'ok',
        applicationId: 'application-fixture-tool-001',
        eventId: 'event-fixture-tool-001',
        artifactId: 'artifact-fixture-tool-001',
        artifactRef: 'local-artifact://application/artifact-fixture-tool-001',
        contentHash: 'a'.repeat(64),
        savedAt: '2026-08-17T04:00:00.000Z',
        deduplicated: false,
        job: {
          externalJobId: 'fixture-tool-001',
          company: '示例科技',
          role: 'Agent 工程师',
          jobUrl: 'https://www.zhipin.com/job_detail/fixture-tool-001.html',
          pageRevision: 'b'.repeat(64),
        },
      }
    },
    async captureCurrentConversation(applicationId) {
      conversationCaptureCalls += 1
      assert.equal(applicationId, 'application-fixture-tool-001')
      return {
        status: 'ok',
        applicationId,
        eventId: 'event-conversation-tool-001',
        artifactId: 'artifact-conversation-tool-001',
        artifactRef: 'local-artifact://application/artifact-conversation-tool-001',
        contentHash: 'c'.repeat(64),
        savedAt: '2026-08-18T04:00:00.000Z',
        deduplicated: false,
        conversation: {
          conversationId: 'conversation-tool-001',
          messageId: 'message-tool-001',
          recruiterName: '招聘顾问',
          pageRevision: 'd'.repeat(64),
        },
      }
    },
    async discoverJobs() {
      return {
        status: 'ready',
        discoveryId: 'discovery-tool-001',
        targetCount: 1,
        target: {
          pageKind: 'job_list',
          title: 'BOSS 岗位列表',
          url: 'https://www.zhipin.com/web/geek/job?query=agent',
        },
        jobs: [{
          externalJobId: 'fixture-tool-001',
          role: 'Agent 工程师',
          company: '示例科技',
          salaryStatus: 'missing',
          jobUrl: 'https://www.zhipin.com/job_detail/fixture-tool-001.html',
        }],
      }
    },
    async captureDiscoveredJob(discoveryId, externalJobId) {
      assert.equal(discoveryId, 'discovery-tool-001')
      assert.equal(externalJobId, 'fixture-tool-001')
      return this.captureCurrentJob()
    },
    async pollJob() {
      return { status: 'environment_interrupted', reason: 'browser_disconnected', targetCount: 0 }
    },
  }
  const interviewNoteClient = {
    async preview(input: { applicationId: string; interviewId: string; stage: string; content: string }) {
      assert.equal(input.applicationId, 'application-fixture-tool-001')
      return {
        previewToken: 'interview-note-preview:tool-001',
        applicationId: input.applicationId,
        interviewId: input.interviewId,
        stage: input.stage,
        contentHash: 'e'.repeat(64),
        contentLength: input.content.length,
        expiresAt: '2026-08-18T04:15:00.000Z',
        requiresConfirmation: true as const,
      }
    },
    async apply(previewToken: string, confirmed: boolean) {
      assert.equal(previewToken, 'interview-note-preview:tool-001')
      assert.equal(confirmed, true)
      return {
        applicationId: 'application-fixture-tool-001',
        eventId: 'event-note-tool-001',
        artifactId: 'artifact-note-tool-001',
        artifactRef: 'local-artifact://application/artifact-note-tool-001',
        contentHash: 'e'.repeat(64),
        savedAt: '2026-08-18T04:00:00.000Z',
        deduplicated: false,
        interviewId: 'interview-tool-001',
        stage: 'first_interview',
      }
    },
  } as unknown as LocalInterviewNoteClient
  const dispose = registerBossWatchTools(context, facts, browser, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, interviewNoteClient)

  try {
    const status = await execute(context, 'boss_watch_browser_status', 'browser-status')
    const discovery = await execute(context, 'boss_watch_discover_jobs', 'browser-discovery')
    const discoveredCapture = await execute(
      context,
      'boss_watch_capture_discovered_job',
      'browser-discovered-capture',
      { discoveryId: 'discovery-tool-001', externalJobId: 'fixture-tool-001' },
    )
    const capture = await execute(context, 'boss_watch_capture_current_job', 'browser-capture')
    const conversationCapture = await execute(
      context,
      'boss_watch_capture_current_conversation',
      'browser-conversation-capture',
      { applicationId: 'application-fixture-tool-001' },
    )
    assert.deepEqual(status, {
      status: 'ready',
      targetCount: 1,
      target: {
        pageKind: 'job_detail',
        title: '虚构岗位',
        url: 'https://www.zhipin.com/job_detail/fixture-tool-001.html',
      },
    })
    assert.equal(discovery.status, 'ready')
    assert.equal((discovery.jobs as Array<{ externalJobId: string }>)[0]?.externalJobId, 'fixture-tool-001')
    assert.equal((discovery.jobs as Array<{ salaryStatus: string }>)[0]?.salaryStatus, 'missing')
    assert.equal(discoveredCapture.applicationId, 'application-fixture-tool-001')
    assert.equal(capture.status, 'ok')
    assert.equal(capture.applicationId, 'application-fixture-tool-001')
    assert.equal(captureCalls, 2)
    assert.equal(conversationCapture.status, 'ok')
    assert.equal(conversationCapture.applicationId, 'application-fixture-tool-001')
    assert.equal(conversationCaptureCalls, 1)
    const notePreview = await execute(
      context,
      'boss_watch_interview_note_preview',
      'interview-note-preview',
      {
        applicationId: 'application-fixture-tool-001',
        interviewId: 'interview-tool-001',
        stage: 'first_interview',
        content: '讨论了工程边界。',
      },
    )
    assert.equal(notePreview.status, 'ok')
    const noteApply = await execute(
      context,
      'boss_watch_interview_note_apply',
      'interview-note-apply',
      { previewToken: 'interview-note-preview:tool-001', confirmed: true },
    )
    assert.equal(noteApply.status, 'ok')
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})

async function execute(
  context: Context,
  name: string,
  callId: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await context.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId),
    name,
    arguments: args,
  })
  assert.equal(result.isError, false)
  const content = result.content[0]
  assert.equal(content?.type, 'text')
  if (content?.type !== 'text') throw new Error('expected_text_tool_result')
  return JSON.parse(content.text) as Record<string, unknown>
}
