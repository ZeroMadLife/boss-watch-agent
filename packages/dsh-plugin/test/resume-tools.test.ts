import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { BossWatchDataSource } from '../src/domain.ts'
import { LocalResumeImportService, SqliteResumeVersionStore } from '../src/resume-version.ts'
import { registerBossWatchTools } from '../src/tools.ts'

test('exposes resume import preview/apply and metadata-only list/get tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-resume-tools-'))
  const store = new SqliteResumeVersionStore(':memory:')
  const importService = new LocalResumeImportService({ resumeRoot: root, store })
  await writeFile(join(root, 'candidate.md'), '# fictional resume')
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
    store,
    importService,
  )

  try {
    const execute = (name: string, args: Record<string, unknown>, suffix: string) => context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`resume-tool-${suffix}`),
      name,
      arguments: args,
    })
    const previewResult = await execute('boss_watch_resume_import_preview', { fileName: 'candidate.md' }, 'preview')
    const previewText = previewResult.content[0]
    if (previewText?.type !== 'text') throw new Error('expected_text_tool_result')
    const preview = JSON.parse(previewText.text) as { status: string; preview: { previewToken: string; contentHash: string } }
    assert.equal(preview.status, 'ok')

    const missingConfirmation = await execute('boss_watch_resume_import_apply', { previewToken: preview.preview.previewToken, confirmed: false }, 'reject')
    const missingText = missingConfirmation.content[0]
    if (missingText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(missingText.text), { status: 'invalid_request', message: 'resume_import_confirmation_required' })

    const appliedResult = await execute('boss_watch_resume_import_apply', { previewToken: preview.preview.previewToken, confirmed: true }, 'apply')
    const appliedText = appliedResult.content[0]
    if (appliedText?.type !== 'text') throw new Error('expected_text_tool_result')
    const applied = JSON.parse(appliedText.text) as { status: string; resumeVersion: { resumeVersionId: string; contentHash: string; localArtifactRef: string }; reused: boolean }
    assert.equal(applied.status, 'ok')
    assert.equal(applied.resumeVersion.contentHash, preview.preview.contentHash)
    assert.equal(applied.resumeVersion.localArtifactRef, `local-resume://sha256:${preview.preview.contentHash}`)
    assert.equal(applied.reused, false)

    const listResult = await execute('boss_watch_resume_list', {}, 'list')
    const listText = listResult.content[0]
    if (listText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(listText.text), {
      status: 'ok',
      versions: [applied.resumeVersion],
      count: 1,
    })

    const getResult = await execute('boss_watch_resume_get', { resumeVersionId: applied.resumeVersion.resumeVersionId }, 'get')
    const getText = getResult.content[0]
    if (getText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(getText.text), { status: 'ok', resumeVersion: applied.resumeVersion })
  } finally {
    dispose()
    await context.fiber.dispose()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
