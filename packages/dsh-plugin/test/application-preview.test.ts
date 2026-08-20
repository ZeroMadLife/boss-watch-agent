import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalApplicationPreviewService } from '../src/application-preview.ts'
import type { JobLead, JobLeadStore } from '../src/job-lead.ts'
import type { ResumeVersion, ResumeVersionStore } from '../src/resume-version.ts'
import type { BossWatchDataSource } from '../src/domain.ts'
import { registerBossWatchTools } from '../src/tools.ts'
import type { GateAApproval } from '../src/gate-a.ts'
import type { RecruitmentSource } from '../src/recruitment-source.ts'

const VERIFIED_LEAD: JobLead = {
  leadId: 'lead:fixture:application-preview',
  sourceKind: 'company_career_site',
  sourceRecordId: 'application-preview',
  company: '虚构科技',
  role: 'Agent 平台工程师',
  cohort: '2027届',
  recruitmentType: '秋招',
  officialApplyUrl: 'https://careers.example.invalid/jobs/agent#apply',
  fetchedAt: '2026-08-18T01:00:00.000Z',
  rawRef: 'fixture://lead/application-preview',
  contentHash: 'a'.repeat(64),
  confidence: 'human_confirmed',
}

const RESUME_VERSION: ResumeVersion = {
  resumeVersionId: `resume-version:${'b'.repeat(64)}`,
  displayName: '候选人简历 v1',
  localArtifactRef: `local-resume://sha256:${'b'.repeat(64)}`,
  contentHash: 'b'.repeat(64),
  mediaType: 'application/pdf',
  byteSize: 1024,
  createdAt: '2026-08-18T01:30:00.000Z',
}

const GATE_A_APPROVAL: GateAApproval = {
  gateAId: 'gate-a:application-preview',
  strategyVersion: 'gate-a-v1',
  matchId: 'resume-match:application-preview',
  applicationId: 'application:application-preview',
  resumeVersionId: RESUME_VERSION.resumeVersionId,
  jdContentHash: 'c'.repeat(64),
  resumeContentHash: RESUME_VERSION.contentHash,
  matchStrategyVersion: 'local-evidence-match-v3',
  matchScore: 86,
  matchLevel: 'strong',
  approvedAt: '2026-08-18T01:45:00.000Z',
  decision: 'proceed',
  externalAction: 'not_authorized',
}

const RECRUITMENT_SOURCE: RecruitmentSource = {
  sourceId: 'recruitment-source:application-preview',
  company: VERIFIED_LEAD.company,
  channelUrl: 'https://careers.example.invalid/referral/application-preview',
  sourceType: 'official_referral',
  rawArtifactHash: 'd'.repeat(64),
  capturedAt: '2026-08-18T00:30:00.000Z',
  status: 'jd_ready',
  boundLeadId: VERIFIED_LEAD.leadId,
  boundApplicationId: GATE_A_APPROVAL.applicationId,
  role: VERIFIED_LEAD.role,
  officialJobUrl: VERIFIED_LEAD.officialApplyUrl,
  jdContentHash: GATE_A_APPROVAL.jdContentHash,
}

function serviceFor(
  lead: JobLead | undefined,
  resume: ResumeVersion | null = RESUME_VERSION,
  approval: GateAApproval | null = GATE_A_APPROVAL,
  recruitmentSources: readonly RecruitmentSource[] = [RECRUITMENT_SOURCE],
): LocalApplicationPreviewService {
  return new LocalApplicationPreviewService({
    leads: { get: () => lead },
    resumes: { get: () => resume === null ? undefined : resume },
    approvals: { get: () => approval ?? undefined },
    recruitmentSources: { list: () => [...recruitmentSources] },
    now: () => new Date('2026-08-18T02:00:00.000Z'),
  })
}

test('builds a bounded official application preview without navigation or resume content reads', () => {
  const preview = serviceFor(VERIFIED_LEAD).preview({
    leadId: VERIFIED_LEAD.leadId,
    gateAId: GATE_A_APPROVAL.gateAId,
  })

  assert.equal(preview.strategyVersion, 'apply-preview-v2')
  assert.equal(preview.createdAt, '2026-08-18T02:00:00.000Z')
  assert.equal(preview.expiresAt, '2026-08-18T02:15:00.000Z')
  assert.equal(preview.page.url, 'https://careers.example.invalid/jobs/agent')
  assert.equal(preview.page.hostname, 'careers.example.invalid')
  assert.equal(preview.page.navigation, 'not_started')
  assert.deepEqual(preview.resume, RESUME_VERSION)
  assert.deepEqual(preview.gateA, {
    gateAId: GATE_A_APPROVAL.gateAId,
    matchId: GATE_A_APPROVAL.matchId,
    applicationId: GATE_A_APPROVAL.applicationId,
    approvedAt: GATE_A_APPROVAL.approvedAt,
    decision: 'proceed',
    externalAction: 'not_authorized',
  })
  assert.deepEqual(preview.knownFields, [
    { field: 'company', value: '虚构科技', source: 'job_lead' },
    { field: 'role', value: 'Agent 平台工程师', source: 'job_lead' },
    { field: 'cohort', value: '2027届', source: 'job_lead' },
    { field: 'recruitmentType', value: '秋招', source: 'job_lead' },
  ])
  assert.deepEqual(preview.form, { status: 'not_loaded', fields: [], missing: ['form_schema_not_loaded'] })
  assert.equal(preview.requiresHuman, true)
})

test('fails closed when the lead is not verified or lacks an official URL', () => {
  assert.throws(
    () => serviceFor({ ...VERIFIED_LEAD, confidence: 'source_only' }).preview({ leadId: VERIFIED_LEAD.leadId, gateAId: GATE_A_APPROVAL.gateAId }),
    /apply_lead_not_verified/u,
  )
  assert.throws(
    () => serviceFor({ ...VERIFIED_LEAD, officialApplyUrl: undefined }).preview({ leadId: VERIFIED_LEAD.leadId, gateAId: GATE_A_APPROVAL.gateAId }),
    /apply_official_url_missing/u,
  )
})

test('rejects missing or stale Gate A evidence and non-HTTPS application URLs', () => {
  assert.throws(
    () => serviceFor(VERIFIED_LEAD, RESUME_VERSION, null).preview({ leadId: VERIFIED_LEAD.leadId, gateAId: GATE_A_APPROVAL.gateAId }),
    /apply_gate_a_not_found/u,
  )
  assert.throws(
    () => serviceFor(VERIFIED_LEAD, RESUME_VERSION, GATE_A_APPROVAL, []).preview({ leadId: VERIFIED_LEAD.leadId, gateAId: GATE_A_APPROVAL.gateAId }),
    /apply_gate_a_binding_missing/u,
  )
  assert.throws(
    () => serviceFor(VERIFIED_LEAD, { ...RESUME_VERSION, contentHash: 'e'.repeat(64) }).preview({ leadId: VERIFIED_LEAD.leadId, gateAId: GATE_A_APPROVAL.gateAId }),
    /apply_resume_snapshot_stale/u,
  )
  assert.throws(
    () => serviceFor({ ...VERIFIED_LEAD, officialApplyUrl: 'http://careers.example.invalid/jobs/agent' }).preview({ leadId: VERIFIED_LEAD.leadId, gateAId: GATE_A_APPROVAL.gateAId }),
    /apply_official_url_invalid/u,
  )
})

test('exposes the preview through the DSH tool and maps verification failures', async () => {
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
  const store = { get: () => VERIFIED_LEAD } as unknown as JobLeadStore
  const resumeStore = {
    get: (resumeVersionId: string) => {
      if (!/^resume-version:[a-f0-9]{64}$/u.test(resumeVersionId)) throw new Error('invalid_resume_version_id')
      return resumeVersionId === RESUME_VERSION.resumeVersionId ? RESUME_VERSION : undefined
    },
  } as unknown as ResumeVersionStore
  const previewService = new LocalApplicationPreviewService({
    leads: store,
    resumes: resumeStore,
    approvals: { get: (gateAId) => gateAId === GATE_A_APPROVAL.gateAId ? GATE_A_APPROVAL : undefined },
    recruitmentSources: { list: () => [RECRUITMENT_SOURCE] },
    now: () => new Date('2026-08-18T02:00:00.000Z'),
  })
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    previewService,
    resumeStore,
  )

  try {
    const execute = (name: string, args: Record<string, unknown>, suffix: string) => context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`application-preview-${suffix}`),
      name,
      arguments: args,
    })
    const ok = await execute('boss_watch_apply_preview', {
      leadId: VERIFIED_LEAD.leadId,
      gateAId: GATE_A_APPROVAL.gateAId,
    }, 'ok')
    const okText = ok.content[0]
    if (okText?.type !== 'text') throw new Error('expected_text_tool_result')
    const payload = JSON.parse(okText.text) as { status: string; preview: { page: { navigation: string }; requiresHuman: boolean } }
    assert.equal(payload.status, 'ok')
    assert.equal(payload.preview.page.navigation, 'not_started')
    assert.equal(payload.preview.requiresHuman, true)

    const rejected = await execute('boss_watch_apply_preview', {
      leadId: VERIFIED_LEAD.leadId,
      gateAId: 'gate-a:missing',
    }, 'invalid')
    const rejectedText = rejected.content[0]
    if (rejectedText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(rejectedText.text), { status: 'not_found', message: 'apply_gate_a_not_found' })
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})
