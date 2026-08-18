import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { BossWatchDataSource } from '../src/domain.ts'
import type { LocalProgressSignalClient } from '../src/progress-signal-client.ts'
import { registerBossWatchTools } from '../src/tools.ts'

const source: BossWatchDataSource = {
  async listJobs() { return [] },
  async listApplicationOverviews() { return [] },
  async getApplicationOverview() { return undefined },
  async getJob() { return undefined },
  async listTimeline() { return [] },
}

test('keeps progress-signal writes behind preview and explicit apply confirmation', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const calls: unknown[] = []
  const client = {
    async preview(input: unknown) {
      calls.push({ kind: 'preview', input })
      return {
        previewToken: 'progress-signal-preview:fixture',
        applicationId: 'application-001',
        sourceKind: 'recruitment_email' as const,
        sourceMode: 'pasted_text' as const,
        outcome: 'rejected' as const,
        classifierVersion: 'progress-signal-rules-v1',
        confidence: 0.91,
        reasonCodes: ['rejection_regret'],
        proposedStatus: 'rejected',
        contentHash: 'a'.repeat(64),
        sourceHash: 'a'.repeat(64),
        contentLength: 20,
        observedAt: '2026-08-18T03:00:00.000Z',
        expiresAt: '2026-08-18T03:15:00.000Z',
        requiresConfirmation: true as const,
      }
    },
    async apply(previewToken: string, confirmed: boolean) {
      calls.push({ kind: 'apply', previewToken, confirmed })
      return {
        applicationId: 'application-001',
        signalEventId: 'event-signal-001',
        proposalEventId: 'event-proposal-001',
        artifactId: 'artifact-signal-001',
        artifactRef: 'local-artifact://application/artifact-signal-001',
        contentHash: 'a'.repeat(64),
        savedAt: '2026-08-18T03:00:00.000Z',
        outcome: 'rejected' as const,
        proposedStatus: 'rejected',
        deduplicated: false,
      }
    },
  } as unknown as LocalProgressSignalClient
  const dispose = registerBossWatchTools(
    context,
    source,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    client,
  )

  try {
    const previewResult = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('progress-preview'),
      name: 'boss_watch_progress_signal_preview',
      arguments: {
        applicationId: 'application-001',
        sourceKind: 'recruitment_email',
        content: 'fixture rejection notice',
      },
    })
    assert.equal(previewResult.isError, false)
    const previewText = previewResult.content[0]
    if (previewText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.equal(JSON.parse(previewText.text).preview.requiresConfirmation, true)
    assert.deepEqual(calls, [{
      kind: 'preview',
      input: {
        applicationId: 'application-001',
        sourceKind: 'recruitment_email',
        content: 'fixture rejection notice',
      },
    }])

    const applyResult = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('progress-apply'),
      name: 'boss_watch_progress_signal_apply',
      arguments: { previewToken: 'progress-signal-preview:fixture', confirmed: true },
    })
    assert.equal(applyResult.isError, false)
    assert.deepEqual(calls.at(-1), {
      kind: 'apply',
      previewToken: 'progress-signal-preview:fixture',
      confirmed: true,
    })
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})
