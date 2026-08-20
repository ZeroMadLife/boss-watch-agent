import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalApplicationFormPreviewService } from '../src/application-form-preview.ts'
import type { GateAApproval, GateAStore } from '../src/gate-a.ts'
import type {
  BrowserApplicationFormField,
  BossWatchBrowserController,
  BossWatchDataSource,
} from '../src/domain.ts'
import type { JobLead, JobLeadStore } from '../src/job-lead.ts'
import type { ResumeVersion, ResumeVersionStore } from '../src/resume-version.ts'
import type { RecruitmentSourceStore } from '../src/recruitment-source.ts'
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

const GATE_A: GateAApproval = {
  gateAId: `gate-a:${'d'.repeat(64)}`,
  matchId: `resume-match:${'e'.repeat(64)}`,
  applicationId: 'application-fixture-form-preview',
  resumeVersionId: RESUME.resumeVersionId,
  jdContentHash: 'f'.repeat(64),
  resumeContentHash: RESUME.contentHash,
  matchStrategyVersion: 'local-evidence-match-v3',
  approvedAt: '2026-08-18T04:30:00.000Z',
  decision: 'proceed_to_material_preparation',
  externalAction: 'not_authorized',
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
    async fillApplicationForm(input) {
      return {
        status: 'filled',
        targetCount: 1,
        page: READY_FORM.page,
        formHash: READY_FORM.page.formHash,
        filledFieldIds: input.fields.map((field) => field.fieldId),
        filledCount: input.fields.length,
        requiresHumanReview: true,
        submitted: false,
      }
    },
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
        text: '姓名：候选人甲\n邮箱：private@example.invalid\n手机：13800000000\n现居地：上海\n示例大学 计算机技术 硕士 2027届\n专业技能 Java Python Redis',
        extractionStatus: 'text_extracted',
        characterCount: 112,
        sourceByteHash: RESUME.contentHash,
      })),
    },
    browser: browser(input.form ?? READY_FORM),
    approvals: { get: () => GATE_A } as Pick<GateAStore, 'get'>,
    recruitmentSources: {
      list: () => [{
        sourceId: 'recruitment-source:fixture-form-preview',
        company: LEAD.company,
        channelUrl: LEAD.officialApplyUrl,
        rawTextHash: '1'.repeat(64),
        rawTextLength: 80,
        capturedAt: '2026-08-18T04:00:00.000Z',
        status: 'jd_ready',
        boundLeadId: LEAD.leadId,
        boundApplicationId: GATE_A.applicationId,
        jdContentHash: GATE_A.jdContentHash,
      }],
    } as unknown as Pick<RecruitmentSourceStore, 'list'>,
    now: () => new Date('2026-08-18T05:00:00.000Z'),
  })
}

test('builds a Gate A bound reusable prefill plan without exposing profile values', async () => {
  const outcome = await service().preview({
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    sessionId: 'dsh-session-fixture',
  })
  assert.equal(outcome.status, 'ready')
  if (outcome.status !== 'ready') throw new Error('expected_ready_preview')
  assert.equal(outcome.preview.strategyVersion, 'application-form-prefill-v1')
  assert.equal(outcome.preview.readOnly, true)
  assert.equal(outcome.preview.externalAction, 'not_started')
  assert.equal(outcome.preview.requiresOneShotApproval, true)
  assert.equal(outcome.preview.gateA.gateAId, GATE_A.gateAId)
  assert.equal(outcome.preview.resume.resumeVersionId, GATE_A.resumeVersionId)
  assert.deepEqual({
    fillStrategy: outcome.preview.profile.fillStrategy,
    modelCalls: outcome.preview.profile.modelCalls,
    browserCallsAfterApproval: outcome.preview.profile.browserCallsAfterApproval,
  }, {
    fillStrategy: 'local_batch_plan',
    modelCalls: 0,
    browserCallsAfterApproval: 1,
  })
  assert.deepEqual(outcome.preview.profile.availableSemantics, [
    'full_name',
    'email',
    'phone',
    'location',
    'school',
    'major',
    'education',
    'graduation_year',
    'skills',
  ])
  assert.equal(outcome.preview.lead.officialApplyUrl, 'https://careers.example.invalid/jobs/agent')
  assert.deepEqual(outcome.preview.fields.map((field) => [field.semantic, field.category, field.source, field.plannedAction]), [
    ['full_name', 'resume_available', 'resume', 'fill'],
    ['email', 'sensitive', 'resume', 'manual'],
    ['resume_file', 'resume_available', 'resume', 'manual'],
    ['gender', 'sensitive', 'none', 'manual'],
    ['consent', 'needs_user_input', 'none', 'manual'],
    ['unknown', 'unknown', 'none', 'manual'],
    ['target_role', 'resume_available', 'job_lead', 'fill'],
  ])
  assert.deepEqual(outcome.preview.summary, {
    fieldCount: 7,
    resumeAvailableCount: 3,
    needsUserInputCount: 1,
    sensitiveCount: 2,
    unknownCount: 1,
    alreadyPresentCount: 0,
    fillableCount: 2,
    manualCount: 5,
  })
  const serialized = JSON.stringify(outcome)
  assert.equal(serialized.includes('private@example.invalid'), false)
  assert.equal(serialized.includes('[PHONE_REDACTED]'), false)
  assert.equal(serialized.includes('候选人甲'), false)
  assert.equal(serialized.includes('13800000000'), false)
  assert.equal(serialized.includes('session=redacted'), false)
})

test('fills only the exact previewed fields and rejects a different DSH session', async () => {
  const formService = service()
  const outcome = await formService.preview({
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    sessionId: 'dsh-session-fixture',
  })
  assert.equal(outcome.status, 'ready')
  if (outcome.status !== 'ready') throw new Error('expected_ready_preview')

  await assert.rejects(
    formService.apply({
      previewToken: outcome.preview.previewToken,
      sessionId: 'other-session',
    }),
    /application_form_preview_session_mismatch/u,
  )
  const applied = await formService.apply({
    previewToken: outcome.preview.previewToken,
    sessionId: 'dsh-session-fixture',
  })
  assert.deepEqual(applied, {
    status: 'filled',
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    formHash: READY_FORM.page.formHash,
    filledFieldIds: READY_FORM.fields
      .filter((field) => [0, 6].includes(field.ordinal))
      .map((field) => field.fieldId),
    filledCount: 2,
    manualReviewRequired: true,
    submitted: false,
  })
  assert.equal(JSON.stringify(applied).includes('private@example.invalid'), false)
  await assert.rejects(
    formService.apply({
      previewToken: outcome.preview.previewToken,
      sessionId: 'dsh-session-fixture',
    }),
    /application_form_preview_consumed/u,
  )
})

test('returns handoff without reading the resume when the page needs verification', async () => {
  let read = false
  const outcome = await service({
    form: { status: 'human_required', reason: 'verification', targetCount: 1 },
    readText: async () => {
      read = true
      throw new Error('must_not_read')
    },
  }).preview({ leadId: LEAD.leadId, gateAId: GATE_A.gateAId, sessionId: 'dsh-session-fixture' })

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
      arguments: { leadId: LEAD.leadId, gateAId: GATE_A.gateAId },
      agent: { id: 'dsh-session-fixture' } as never,
    })
    const content = result.content[0]
    if (content?.type !== 'text') throw new Error('expected_text_tool_result')
    const payload = JSON.parse(content.text) as { status: string; preview: { strategyVersion: string } }
    assert.equal(payload.status, 'ok')
    assert.equal(payload.preview.strategyVersion, 'application-form-prefill-v1')
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
      arguments: { leadId: LEAD.leadId, gateAId: GATE_A.gateAId },
      agent: { id: 'dsh-session-fixture' } as never,
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
