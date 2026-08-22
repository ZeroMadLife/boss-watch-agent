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
import { SqliteJobLeadStore } from '../src/job-lead.ts'
import { SqliteResumeVersionStore } from '../src/resume-version.ts'
import { SqliteApplicationStore } from '../../../src/storage/sqlite-application-store.ts'

test('registers bounded tools through a real Cordis Loader composition', async () => {
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
      'boss_watch_application_form_autofill',
      'boss_watch_application_form_fill_apply',
      'boss_watch_application_form_preview',
      'boss_watch_application_list',
      'boss_watch_application_overview',
      'boss_watch_application_status_apply',
      'boss_watch_application_status_preview',
      'boss_watch_application_timeline',
      'boss_watch_apply_batch_prepare',
      'boss_watch_apply_batch_resume',
      'boss_watch_apply_batch_status',
      'boss_watch_apply_preview',
      'boss_watch_boss_search_preview',
      'boss_watch_boss_search_run',
      'boss_watch_browser_status',
      'boss_watch_candidate_board',
      'boss_watch_candidate_profile_apply',
      'boss_watch_candidate_profile_get',
      'boss_watch_candidate_profile_preview',
      'boss_watch_capture_current_conversation',
      'boss_watch_capture_current_job',
      'boss_watch_capture_discovered_job',
      'boss_watch_discover_jobs',
      'boss_watch_feishu_preview',
      'boss_watch_feishu_reconcile_preview',
      'boss_watch_feishu_sync_apply',
      'boss_watch_feishu_sync_preview',
      'boss_watch_feishu_target_confirm',
      'boss_watch_feishu_target_preview',
      'boss_watch_follow_up_complete',
      'boss_watch_follow_up_list',
      'boss_watch_follow_up_schedule',
      'boss_watch_gate_a_confirm',
      'boss_watch_growth_plan_preview',
      'boss_watch_interview_feishu_apply',
      'boss_watch_interview_feishu_preview',
      'boss_watch_interview_knowledge_apply',
      'boss_watch_interview_knowledge_preview',
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
      'boss_watch_recruitment_jd_apply',
      'boss_watch_recruitment_jd_preview',
      'boss_watch_recruitment_source_apply',
      'boss_watch_recruitment_source_get',
      'boss_watch_recruitment_source_list',
      'boss_watch_recruitment_source_preview',
      'boss_watch_resume_get',
      'boss_watch_resume_import_apply',
      'boss_watch_resume_import_preview',
      'boss_watch_resume_list',
      'boss_watch_resume_match',
      'boss_watch_resume_match_list',
      'boss_watch_search_plan_preview',
      'boss_watch_source_refresh',
      'boss_watch_source_refresh_status',
      'boss_watch_source_status',
      'boss_watch_today_recommendations',
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
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_candidate_board/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_today_recommendations/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /今天推荐哪几个/u)
    assert.doesNotMatch((await context.skills.get('boss-watch-job-search'))?.content ?? '', /候选人面板|本地候选/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_discover_jobs/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_boss_search_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_boss_search_run/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_capture_discovered_job/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_capture_current_job/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_capture_current_conversation/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_interview_note_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_interview_knowledge_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_interview_feishu_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_apply_batch_prepare/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_apply_batch_status/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_apply_batch_resume/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_apply_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_application_form_autofill/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /fill_current_page/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_application_form_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_application_form_fill_apply/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_resume_import_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_resume_list/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_resume_match_list/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_follow_up_list/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_follow_up_schedule/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_follow_up_complete/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_application_status_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_application_status_apply/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_gate_a_confirm/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_import_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_import_apply/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_clipboard_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_clipboard_apply/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_visual_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_lead_visual_apply/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_recruitment_source_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_recruitment_jd_preview/u)
    assert.match((await context.skills.get('boss-watch-job-search'))?.content ?? '', /boss_watch_recruitment_jd_apply/u)
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

test('wires local resume readiness into the runtime candidate board', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-dsh-loader-board-'))
  const configPath = join(root, 'cordis.yml')
  const databasePath = join(root, 'boss-watch.sqlite3')
  const previousDatabasePath = process.env.BOSS_WATCH_DB_PATH
  process.env.BOSS_WATCH_DB_PATH = databasePath
  const applicationStore = new SqliteApplicationStore(databasePath)
  applicationStore.close()
  const leads = new SqliteJobLeadStore(databasePath)
  const resumes = new SqliteResumeVersionStore(databasePath)
  let context: Context | undefined

  try {
    leads.upsert([{
      leadId: 'lead:company_career_site:runtime-fixture',
      sourceKind: 'company_career_site',
      sourceRecordId: 'runtime-fixture',
      company: '虚构远航科技',
      role: '平台研发工程师',
      officialApplyUrl: 'https://careers.example.invalid/jobs/runtime-fixture',
      fetchedAt: '2026-08-19T04:00:00.000Z',
      rawRef: 'company-career-site://runtime-fixture',
      contentHash: 'a'.repeat(64),
      confidence: 'human_confirmed',
    }])
    resumes.save({
      resumeVersionId: `resume-version:${'b'.repeat(64)}`,
      displayName: '虚构候选人-平台方向',
      localArtifactRef: `local-resume://sha256:${'b'.repeat(64)}`,
      contentHash: 'b'.repeat(64),
      mediaType: 'application/pdf',
      byteSize: 2048,
      createdAt: '2026-08-19T04:05:00.000Z',
    })
    leads.close()
    resumes.close()
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
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('candidate-board-runtime'),
      name: 'boss_watch_candidate_board',
      arguments: {},
    })
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    assert.equal(result.isError, false)
    assert.match(text, /"resumeReady":true/u)
    assert.match(text, /"nextAction":"prepare_application"/u)

    const sourcePreviewResult = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('recruitment-source-preview'),
      name: 'boss_watch_recruitment_source_preview',
      arguments: {
        rawText: '虚构星河科技\n内推链接：https://careers.example.invalid/referral/fixture\n内推码：FIXTURE-27',
      },
    })
    const sourcePreview = JSON.parse(sourcePreviewResult.content.map(block => block.type === 'text' ? block.text : '').join('')) as {
      status: string
      preview: { previewToken: string; source: { company: string } }
    }
    assert.equal(sourcePreview.status, 'ok')
    assert.equal(sourcePreview.preview.source.company, '虚构星河科技')

    const sourceApplyResult = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('recruitment-source-apply'),
      name: 'boss_watch_recruitment_source_apply',
      arguments: {
        previewToken: sourcePreview.preview.previewToken,
        confirmation: '确认公司、链接、内推码和哈希',
      },
    })
    assert.match(
      sourceApplyResult.content.map(block => block.type === 'text' ? block.text : '').join(''),
      /"status":"source_only"/u,
    )
  } finally {
    await context?.fiber.dispose()
    if (previousDatabasePath === undefined) delete process.env.BOSS_WATCH_DB_PATH
    else process.env.BOSS_WATCH_DB_PATH = previousDatabasePath
    await rm(root, { recursive: true, force: true })
  }
})
