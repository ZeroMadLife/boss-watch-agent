import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { BossWatchDataSource } from '../src/domain.ts'
import { SqliteJobLeadStore } from '../src/job-lead.ts'
import { registerBossWatchTools } from '../src/tools.ts'
import { LocalVisualLeadImportService } from '../src/visual-lead-import.ts'

test('exposes visual preview and requires explicit confirmation before local apply', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const store = new SqliteJobLeadStore(':memory:')
  const visualImport = new LocalVisualLeadImportService({
    store,
    now: () => new Date('2026-08-17T12:00:00.000Z'),
  })
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const dispose = registerBossWatchTools(
    context,
    source,
    undefined,
    undefined,
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    visualImport,
  )
  const execute = (name: string, args: Record<string, unknown>, suffix: string) => context.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`visual-${suffix}`),
    name,
    arguments: args,
  })

  try {
    const previewResult = await execute('boss_watch_lead_visual_preview', {
      sourceRef: 'tencent-view-only-tool',
      screenshotRef: 'attachment://tool-screenshot',
      screenshotHash: 'c'.repeat(64),
      headers: ['company', 'role'],
      rows: [{ company: '虚构潮汐科技', role: '后端工程师', confidence: 0.97 }],
    }, 'preview')
    const previewText = previewResult.content[0]
    if (previewText?.type !== 'text') throw new Error('expected_text_tool_result')
    const previewBody = JSON.parse(previewText.text) as { status: string; preview: { previewToken: string } }
    assert.equal(previewBody.status, 'ok')
    assert.deepEqual(store.list({ limit: 10 }), [])

    const unconfirmedResult = await execute('boss_watch_lead_visual_apply', {
      previewToken: previewBody.preview.previewToken,
      confirmation: '',
    }, 'unconfirmed')
    const unconfirmedText = unconfirmedResult.content[0]
    if (unconfirmedText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(unconfirmedText.text), {
      status: 'invalid_request',
      message: 'visual_import_confirmation_required',
    })
    assert.deepEqual(store.list({ limit: 10 }), [])

    const appliedResult = await execute('boss_watch_lead_visual_apply', {
      previewToken: previewBody.preview.previewToken,
      confirmation: '确认来源、1 条接受、0 条拒绝、0 条低置信度',
    }, 'apply')
    const appliedText = appliedResult.content[0]
    if (appliedText?.type !== 'text') throw new Error('expected_text_tool_result')
    const appliedBody = JSON.parse(appliedText.text) as { status: string; snapshot: { acceptedCount: number } }
    assert.equal(appliedBody.status, 'ok')
    assert.equal(appliedBody.snapshot.acceptedCount, 1)
    assert.equal(store.list({ limit: 10 })[0]?.confidence, 'source_only')
  } finally {
    dispose()
    store.close()
    await context.fiber.dispose()
  }
})
