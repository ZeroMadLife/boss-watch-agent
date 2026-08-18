import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as BossWatchPlugin from '../src/index.ts'

test('registers read-only tools through a real Cordis Loader composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-dsh-loader-'))
  const configPath = join(root, 'cordis.yml')
  const previousDatabasePath = process.env.BOSS_WATCH_DB_PATH
  process.env.BOSS_WATCH_DB_PATH = join(root, 'missing.sqlite3')
  let context: Context | undefined

  try {
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-skill'",
      '- name: boss-watch-dsh-plugin',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-skill', SkillRegistry],
      ['boss-watch-dsh-plugin', BossWatchPlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof context.loader.internal>

    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    assert.deepEqual(context.tools.schemas().map(schema => schema.name).sort(), [
      'boss_watch_application_form_preview',
      'boss_watch_application_list',
      'boss_watch_application_overview',
      'boss_watch_application_timeline',
      'boss_watch_apply_batch_prepare',
      'boss_watch_apply_batch_resume',
      'boss_watch_apply_batch_status',
      'boss_watch_apply_preview',
      'boss_watch_browser_status',
      'boss_watch_capture_current_conversation',
      'boss_watch_capture_current_job',
      'boss_watch_capture_discovered_job',
      'boss_watch_discover_jobs',
      'boss_watch_feishu_preview',
      'boss_watch_feishu_sync_apply',
      'boss_watch_feishu_sync_preview',
      'boss_watch_feishu_target_confirm',
      'boss_watch_feishu_target_preview',
      'boss_watch_follow_up_complete',
      'boss_watch_follow_up_list',
      'boss_watch_follow_up_schedule',
      'boss_watch_interview_note_apply',
      'boss_watch_interview_note_preview',
      'boss_watch_jd_diff',
      'boss_watch_job_get',
      'boss_watch_job_list',
      'boss_watch_lead_clipboard_apply',
      'boss_watch_lead_clipboard_preview',
      'boss_watch_lead_get',
      'boss_watch_lead_import_apply',
      'boss_watch_lead_import_preview',
      'boss_watch_lead_jd_confirm',
      'boss_watch_lead_list',
      'boss_watch_lead_observation_list',
      'boss_watch_lead_search',
      'boss_watch_lead_url_confirm',
      'boss_watch_lead_visual_apply',
      'boss_watch_lead_visual_preview',
      'boss_watch_progress_signal_apply',
      'boss_watch_progress_signal_preview',
      'boss_watch_resume_get',
      'boss_watch_resume_import_apply',
      'boss_watch_resume_import_preview',
      'boss_watch_resume_list',
      'boss_watch_resume_match',
      'boss_watch_source_status',
      'boss_watch_watch_create',
      'boss_watch_watch_list',
      'boss_watch_watch_poll',
      'boss_watch_watch_resume',
      'boss_watch_watch_run_due',
      'boss_watch_watch_stop',
      'boss_watch_workspace_overview',
    ])
    assert.deepEqual(
      context.tools.schemas().find(schema => schema.name === 'boss_watch_application_list')?.parameters,
      { type: 'object', properties: {}, required: [] },
    )
    assert.deepEqual((await context.skills.list()).map(skill => skill.name), ['boss-watch-job-search'])
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_job_list/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_workspace_overview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_discover_jobs/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_capture_discovered_job/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_capture_current_job/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_capture_current_conversation/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_interview_note_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_apply_batch_prepare/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_apply_batch_status/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_apply_batch_resume/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_apply_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_application_form_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_resume_import_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_resume_list/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_follow_up_list/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_follow_up_schedule/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_follow_up_complete/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_import_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_import_apply/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_clipboard_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_clipboard_apply/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_visual_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_visual_apply/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_feishu_target_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_feishu_target_confirm/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_feishu_sync_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_feishu_sync_apply/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_watch_create/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_watch_poll/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_watch_run_due/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_jd_diff/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /本地 Artifact 历史/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /不得自动轮询/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /单次最多 5 个/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /salaryStatus.*obfuscated.*不得猜测/u)
    const workspaceResult = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('workspace-overview'),
      name: 'boss_watch_workspace_overview',
      arguments: {},
    })
    assert.equal(workspaceResult.isError, false)
    assert.match(
      workspaceResult.content.map(block => block.type === 'text' ? block.text : '').join(''),
      /local_runtime_setup/u,
    )
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('missing-source'),
      name: 'boss_watch_job_list',
      arguments: {},
    })
    assert.equal(result.isError, false)
    assert.match(result.content.map(block => block.type === 'text' ? block.text : '').join(''), /source_unavailable/u)
  } finally {
    await context?.fiber.dispose()
    if (previousDatabasePath === undefined) delete process.env.BOSS_WATCH_DB_PATH
    else process.env.BOSS_WATCH_DB_PATH = previousDatabasePath
    await rm(root, { recursive: true, force: true })
  }
})
