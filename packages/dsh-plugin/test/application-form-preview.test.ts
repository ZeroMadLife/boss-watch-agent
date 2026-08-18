import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalApplicationFormPreviewService } from '../src/application-form-preview.ts'
import type {
  BrowserApplicationFormField,
  BossWatchBrowserController,
  BossWatchDataSource,
} from '../src/domain.ts'
import type { JobLead, JobLeadStore } from '../src/job-lead.ts'
import type { ResumeVersion, ResumeVersionStore } from '../src/resume-version.ts'
import { registerBossWatchTools } from '../src/tools.ts'

const LEAD: JobLead = {
  leadId: 'lead:fixture:form-preview',
  sourceKind: 'company_career_site',
  sourceRecordId: 'form-preview',
  company: '虚构科技',
  role: 'Agent 平台工程师',
  officialApplyUrl: 'https://careers.example.invalid/jobs/agent?session=redacted',
  fetchedAt: '2026-08-18T04:00:00.000Z',
  rawRef: 'fixture://lead/form-preview',
  contentHash: 'a'.repeat(64),
  confidence: 'human_confirmed',
}

const RESUME: ResumeVersion = {
  resumeVersionId: `resume-version:${'b'.repeat(64)}`,
  displayName: '候选人简历 v1',
  localArtifactRef: `local-resume://sha256:${'b'.repeat(64)}`,
  contentHash: 'b'.repeat(64),
  mediaType: 'application/pdf',
  byteSize: 2048,
  createdAt: '2026-08-18T04:10:00.000Z',
}

function formField(
  ordinal: number,
  label: string,
  controlType: BrowserApplicationFormField['controlType'] = 'text',
  extra: Partial<BrowserApplicationFormField> = {},
): BrowserApplicationFormField {
  return {
    fieldId: `form-field:${String(ordinal).padStart(64, '0')}`,
    ordinal,
    controlType,
    inputType: controlType,
    label,
    required: true,
    disabled: false,
    readOnly: false,
    currentState: 'empty',
    metadataTrust: 'untrusted_page',
    ...extra,
  }
}

function browser(result: Awaited<ReturnType<BossWatchBrowserController['inspectApplicationForm']>>): BossWatchBrowserController {
  return {
    async status() { return { status: 'no_supported_tab', reason: 'no_boss_page', targetCount: 0 } },
    async captureCurrentJob() { return { status: 'no_supported_tab', reason: 'no_boss_page', targetCount: 0 } },
    async discoverJobs() { return { status: 'no_supported_tab', reason: 'no_boss_page', targetCount: 0 } },
    async captureDiscoveredJob() { return { status: 'invalid_request', reason: 'job_not_found', targetCount: 0 } },
    async pollJob() { return { status: 'invalid_request', reason: 'job_not_found', targetCount: 0 } },
    async inspectApplicationForm() { return result },
  }
}

const READY_FORM = {
  status: 'ready' as const,
  targetCount: 1 as const,
  page: {
    pageKind: 'application_form' as const,
    title: '虚构申请表',
    url: 'https://careers.example.invalid/jobs/agent/apply',
    hostname: 'careers.example.invalid',
    formHash: 'c'.repeat(64),
    metadataTrust: 'untrusted_page' as const,
  },
  fields: [
    formField(0, '姓名', 'text', { autocomplete: 'name' }),
    formField(1, '电子邮箱', 'email', { autocomplete: 'email' }),
    formField(2, '上传简历', 'file'),
    formField(3, '性别', 'select'),
    formField(4, '同意隐私条款', 'checkbox'),
    formField(5, '自定义问题', 'textarea'),
    formField(6, '申请岗位', 'text'),
  ],
}

function service(input: {
  form?: typeof READY_FORM | { status: 'human_required'; reason: 'verification'; targetCount: 1 }
  readText?: () => Promise<never>
} = {}): LocalApplicationFormPreviewService {
  return new LocalApplicationFormPreviewService({
    leads: { get: () => LEAD },
    resumes: { get: () => RESUME },
    resumeImport: {
      readText: input.readText ?? (async () => ({
        resumeVersion: RESUME,
        text: '姓名：候选人甲\n邮箱：private@example.invalid\n手机：[PHONE_REDACTED]\n示例大学 计算机技术 硕士 2027届\n专业技能 Java Python Redis',
        extractionStatus: 'text_extracted',
        characterCount: 92,
        sourceByteHash: RESUME.contentHash,
      })),
    },
    browser: browser(input.form ?? READY_FORM),
    now: () => new Date('2026-08-18T05:00:00.000Z'),
  })
}

test('classifies a visible form without exposing resume or current field values', async () => {
  const outcome = await service().preview({ leadId: LEAD.leadId, resumeVersionId: RESUME.resumeVersionId })
  assert.equal(outcome.status, 'ready')
  if (outcome.status !== 'ready') throw new Error('expected_ready_preview')
  assert.equal(outcome.preview.strategyVersion, 'application-form-preview-v1')
  assert.equal(outcome.preview.readOnly, true)
  assert.equal(outcome.preview.externalAction, 'not_started')
  assert.equal(outcome.preview.requiresGateB, true)
  assert.equal(outcome.preview.lead.officialApplyUrl, 'https://careers.example.invalid/jobs/agent')
  assert.deepEqual(outcome.preview.fields.map((field) => [field.semantic, field.category, field.source]), [
    ['full_name', 'resume_available', 'resume'],
    ['email', 'sensitive', 'resume'],
    ['resume_file', 'resume_available', 'resume'],
    ['gender', 'sensitive', 'none'],
    ['consent', 'needs_user_input', 'none'],
    ['unknown', 'unknown', 'none'],
    ['target_role', 'resume_available', 'job_lead'],
  ])
  assert.deepEqual(outcome.preview.summary, {
    fieldCount: 7,
    resumeAvailableCount: 3,
    needsUserInputCount: 1,
    sensitiveCount: 2,
    unknownCount: 1,
    alreadyPresentCount: 0,
  })
  const serialized = JSON.stringify(outcome)
  assert.equal(serialized.includes('private@example.invalid'), false)
  assert.equal(serialized.includes('[PHONE_REDACTED]'), false)
  assert.equal(serialized.includes('候选人甲'), false)
  assert.equal(serialized.includes('session=redacted'), false)
})

test('returns handoff without reading the resume when the page needs verification', async () => {
  let read = false
  const outcome = await service({
    form: { status: 'human_required', reason: 'verification', targetCount: 1 },
    readText: async () => {
      read = true
      throw new Error('must_not_read')
    },
  }).preview({ leadId: LEAD.leadId, resumeVersionId: RESUME.resumeVersionId })

  assert.deepEqual(outcome, {
    status: 'handoff_required',
    reason: 'verification',
    browserStatus: 'human_required',
    targetCount: 1,
    detail: 'verification',
  })
  assert.equal(read, false)
})

test('exposes the read-only preview through a dedicated DSH tool', async () => {
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
  const controller = browser(READY_FORM)
  const formPreview = service()
  const dispose = registerBossWatchTools(
    context,
    source,
    controller,
    undefined,
    { get: () => LEAD } as unknown as JobLeadStore,
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
    { get: () => RESUME } as unknown as ResumeVersionStore,
    undefined,
    undefined,
    undefined,
    formPreview,
  )
  try {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('application-form-preview-tool'),
      name: 'boss_watch_application_form_preview',
      arguments: { leadId: LEAD.leadId, resumeVersionId: RESUME.resumeVersionId },
    })
    const content = result.content[0]
    if (content?.type !== 'text') throw new Error('expected_text_tool_result')
    const payload = JSON.parse(content.text) as { status: string; preview: { strategyVersion: string } }
    assert.equal(payload.status, 'ok')
    assert.equal(payload.preview.strategyVersion, 'application-form-preview-v1')
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})

test('does not expose unexpected local error details through the DSH tool', async () => {
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
  const formPreview = service({
    readText: async () => {
      throw new Error('/private/local/resumes/candidate.pdf')
    },
  })
  const dispose = registerBossWatchTools(
    context,
    source,
    browser(READY_FORM),
    undefined,
    { get: () => LEAD } as unknown as JobLeadStore,
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
    { get: () => RESUME } as unknown as ResumeVersionStore,
    undefined,
    undefined,
    undefined,
    formPreview,
  )
  try {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('application-form-preview-redacted-error'),
      name: 'boss_watch_application_form_preview',
      arguments: { leadId: LEAD.leadId, resumeVersionId: RESUME.resumeVersionId },
    })
    const content = result.content[0]
    if (content?.type !== 'text') throw new Error('expected_text_tool_result')
    const payload = JSON.parse(content.text) as { status: string; message: string }
    assert.deepEqual(payload, {
      status: 'source_unavailable',
      message: 'application_form_preview_failed',
    })
    assert.equal(content.text.includes('/private/local'), false)
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})
