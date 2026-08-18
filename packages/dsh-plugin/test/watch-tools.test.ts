import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { BossWatchBrowserController, BossWatchDataSource, JobDetails } from '../src/domain.ts'
import { LocalJobWatchService, SqliteJobWatchStore } from '../src/job-watch.ts'
import { LocalJobWatchScheduler } from '../src/job-watch-scheduler.ts'
import { LocalJobDescriptionDiffService } from '../src/job-diff.ts'
import { registerBossWatchTools } from '../src/tools.ts'

test('exposes explicit local watch management and one bounded poll tool', async () => {
  const job: JobDetails = {
    applicationId: 'application-watch-tool-1',
    company: '虚构科技',
    role: 'Agent 工程师',
    jobUrl: 'https://www.zhipin.com/job_detail/fixture-watch-tool-1.html',
    capturedAt: '2026-08-18T01:00:00.000Z',
    contentHash: 'a'.repeat(64),
    description: '负责构建可审计的 Agent 工作流。',
    artifactRef: 'local-artifact://application/watch-tool-1',
  }
  const source: BossWatchDataSource = {
    async listJobs() { return [job] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob(applicationId) { return applicationId === job.applicationId ? job : undefined },
    async listJobRevisions(applicationId) {
      return applicationId === job.applicationId
        ? [
            { ...job, description: '旧要求', artifactRef: 'local-artifact://old-revision' },
            { ...job, description: '新要求', contentHash: 'b'.repeat(64), artifactRef: 'local-artifact://new-revision', capturedAt: '2026-08-18T03:00:00.000Z' },
          ]
        : []
    },
    async listTimeline() { return [] },
  }
  let pollCalls = 0
  const browser: BossWatchBrowserController = {
    async status() { return { status: 'no_supported_tab', reason: 'no_boss_page', targetCount: 0 } },
    async captureCurrentJob() { return this.status() },
    async discoverJobs() { return { status: 'no_supported_tab', reason: 'no_boss_page', targetCount: 0 } },
    async captureDiscoveredJob() { return { status: 'invalid_request', reason: 'job_not_found', targetCount: 0 } },
    async pollJob(applicationId) {
      pollCalls += 1
      return {
        status: 'ok',
        applicationId,
        eventId: 'event-watch-tool-1',
        artifactId: 'artifact-watch-tool-1',
        artifactRef: 'local-artifact://application/watch-tool-poll-1',
        contentHash: job.contentHash,
        savedAt: job.capturedAt,
        deduplicated: true,
        job: {
          externalJobId: 'fixture-watch-tool-1',
          company: job.company,
          role: job.role,
          jobUrl: job.jobUrl as string,
          pageRevision: 'b'.repeat(64),
        },
      }
    },
  }
  const store = new SqliteJobWatchStore(':memory:')
  let id = 0
  let now = new Date('2026-08-18T02:00:00.000Z')
  const service = new LocalJobWatchService({
    source,
    browser,
    store,
    now: () => new Date(now),
    idFactory: () => String(++id),
  })
  const scheduler = new LocalJobWatchScheduler({ service, now: () => new Date(now), idFactory: () => 'tool-run-1' })
  const jobDiff = new LocalJobDescriptionDiffService(source)
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const dispose = registerBossWatchTools(
    context,
    source,
    browser,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    service,
    scheduler,
    jobDiff,
  )

  try {
    const execute = (name: string, args: Record<string, unknown>, suffix: string) => context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`watch-${suffix}`),
      name,
      arguments: args,
    })
    const created = await read(await execute('boss_watch_watch_create', { applicationId: job.applicationId }, 'create')) as {
      status: string
      watch: { watchId: string; state: string }
    }
    assert.equal(created.status, 'ok')
    assert.equal(created.watch.state, 'active')
    assert.equal(pollCalls, 0)

    const diff = await read(await execute('boss_watch_jd_diff', { applicationId: job.applicationId }, 'jd-diff')) as {
      status: string
      diff: { changed: boolean; added: Array<{ text: string }>; removed: Array<{ text: string }> }
    }
    assert.equal(diff.status, 'ok')
    assert.equal(diff.diff.changed, true)
    assert.deepEqual(diff.diff.added.map((section) => section.text), ['新要求'])
    assert.deepEqual(diff.diff.removed.map((section) => section.text), ['旧要求'])

    const listed = await read(await execute('boss_watch_watch_list', {}, 'list')) as {
      status: string
      count: number
    }
    assert.deepEqual({ status: listed.status, count: listed.count }, { status: 'ok', count: 1 })

    const polled = await read(await execute('boss_watch_watch_poll', { watchId: created.watch.watchId }, 'poll')) as {
      status: string
      result: { result: string }
    }
    assert.equal(polled.status, 'ok')
    assert.equal(polled.result.result, 'unchanged')
    assert.equal(pollCalls, 1)

    now = new Date('2026-08-20T02:00:00.000Z')
    const dueRun = await read(await execute('boss_watch_watch_run_due', {}, 'run-due')) as {
      status: string
      run: { runId: string; status: string; attemptedCount: number; items: Array<{ watchId: string }> }
    }
    assert.equal(dueRun.status, 'ok')
    assert.equal(dueRun.run.runId, 'watch-scheduler:tool-run-1')
    assert.equal(dueRun.run.status, 'completed')
    assert.equal(dueRun.run.attemptedCount, 1)
    assert.equal(dueRun.run.items[0]?.watchId, created.watch.watchId)
    assert.equal(pollCalls, 2)

    const invalidRun = await read(await execute('boss_watch_watch_run_due', { limit: 6 }, 'run-due-invalid')) as {
      status: string
      message: string
    }
    assert.deepEqual(invalidRun, { status: 'invalid_request', message: 'invalid_watch_scheduler_limit' })

    const stopped = await read(await execute('boss_watch_watch_stop', { watchId: created.watch.watchId }, 'stop')) as {
      status: string
      watch: { state: string }
    }
    assert.equal(stopped.watch.state, 'stopped')
  } finally {
    dispose()
    await context.fiber.dispose()
    store.close()
  }
})

async function read(result: Awaited<ReturnType<Context['tools']['execute']>>): Promise<Record<string, unknown>> {
  assert.equal(result.isError, false)
  const content = result.content[0]
  if (content?.type !== 'text') throw new Error('expected_text_tool_result')
  return JSON.parse(content.text) as Record<string, unknown>
}
