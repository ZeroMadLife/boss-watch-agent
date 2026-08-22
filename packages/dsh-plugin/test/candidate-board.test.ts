import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApplicationOverview, BossWatchDataSource } from '../src/domain.ts'
import { SqliteJobLeadStore } from '../src/job-lead.ts'
import { LocalCandidateBoardService } from '../src/candidate-board.ts'
import type { ResumeMatchResult } from '../src/resume-matching.ts'
import type { FeishuProjection } from '../src/feishu-projection.ts'
import type { JobLead } from '../src/job-lead.ts'
import type { RecruitmentSource } from '../src/recruitment-source.ts'
import type { GateAApproval } from '../src/gate-a.ts'

const MATCH_RESULT: ResumeMatchResult = {
  matchId: 'resume-match:fixture',
  strategyVersion: 'local-evidence-match-v3',
  createdAt: '2026-08-19T01:03:00.000Z',
  applicationId: 'application:boss-fixture',
  jd: {
    company: '虚构云图科技',
    role: '后端工程师',
    capturedAt: '2026-08-19T01:00:00.000Z',
    contentHash: 'b'.repeat(64),
  },
  resume: {
    resumeVersionId: 'resume-version:fixture',
    contentHash: 'd'.repeat(64),
    mediaType: 'application/pdf',
  },
  extraction: { status: 'text_extracted', characterCount: 1200 },
  resumeSummary: {
    education: { highestLevel: '硕士', status: 'observed' },
    cohorts: ['2027'],
    locations: ['上海'],
    technologies: ['Java', 'Spring'],
    capabilities: ['Backend Engineering'],
    projects: { total: 2, directions: [{ label: 'Backend Engineering', count: 2 }], detection: 'section_blocks' },
  },
  hardConstraints: [],
  skills: {
    required: ['Java', 'Backend Engineering'],
    matched: ['Java', 'Backend Engineering'],
    missing: [],
    requiredTechnologies: ['Java'],
    matchedTechnologies: ['Java'],
    missingTechnologies: [],
    requiredCapabilities: ['Backend Engineering'],
    matchedCapabilities: ['Backend Engineering'],
    missingCapabilities: [],
  },
  score: 86,
  matchLevel: 'strong',
  evidence: [],
  gaps: [],
  risks: [],
  requiresGateA: true,
}

const GATE_A_APPROVAL: GateAApproval = {
  gateAId: 'gate-a:fixture',
  strategyVersion: 'gate-a-v1',
  matchId: MATCH_RESULT.matchId,
  applicationId: MATCH_RESULT.applicationId,
  resumeVersionId: MATCH_RESULT.resume.resumeVersionId,
  jdContentHash: MATCH_RESULT.jd.contentHash,
  resumeContentHash: MATCH_RESULT.resume.contentHash,
  matchStrategyVersion: MATCH_RESULT.strategyVersion,
  matchScore: MATCH_RESULT.score,
  matchLevel: MATCH_RESULT.matchLevel,
  approvedAt: '2026-08-19T01:04:00.000Z',
  decision: 'proceed',
  externalAction: 'not_authorized',
}

test('builds a bounded board from source leads and captured BOSS jobs without fuzzy merging', async () => {
  const applications: ApplicationOverview[] = [{
    applicationId: 'application:boss-fixture',
    company: '虚构云图科技',
    role: '后端工程师',
    jobUrl: 'https://www.zhipin.com/job_detail/fixture-board.html',
    capturedAt: '2026-08-19T01:00:00.000Z',
    contentHash: 'b'.repeat(64),
    progressState: 'status_proposed',
    eventCount: 3,
    recruiterMessageCount: 0,
    interviewNoteCount: 0,
    progressSignalCount: 1,
    latestEventType: 'application_status_proposed',
    latestEventAt: '2026-08-19T01:05:00.000Z',
    proposedStatus: 'interview',
  }]
  const source: BossWatchDataSource = {
    async listJobs() { throw new Error('board_should_read_application_overviews') },
    async listApplicationOverviews(limit) { return applications.slice(0, limit) },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const leads = new SqliteJobLeadStore(':memory:')
  leads.upsert([{
    leadId: 'lead:gankinterview_campus:fixture',
    sourceKind: 'gankinterview_campus',
    sourceRecordId: 'fixture',
    company: '虚构云图科技',
    role: '后端工程师',
    city: '上海',
    cohort: '2027届',
    recruitmentType: '秋招',
    deadline: '2026-09-30',
    channelUrl: 'https://careers.example.invalid/fixture',
    officialApplyUrl: 'https://careers.example.invalid/fixture/apply',
    sourceUpdatedAt: '2026-08-18T00:00:00.000Z',
    fetchedAt: '2026-08-19T00:00:00.000Z',
    rawRef: 'gankinterview://campus/fixture',
    contentHash: 'a'.repeat(64),
    confidence: 'source_only',
  }])

  try {
    const board = await new LocalCandidateBoardService({
      source,
      leads,
      resumes: { count() { return 1 } },
      matches: {
        list(options) {
          assert.deepEqual(options, { applicationId: 'application:boss-fixture', limit: 1 })
          return [MATCH_RESULT]
        },
      },
    }).list({ limit: 10 })
    assert.equal(board.length, 2)
    assert.deepEqual(board.map(item => item.candidateId), [
      'application:boss-fixture',
      'lead:gankinterview_campus:fixture',
    ])
    assert.deepEqual(board[0], {
      candidateId: 'application:boss-fixture',
      recordKind: 'captured_job',
      sourceKind: 'boss_visible',
      company: '虚构云图科技',
      role: '后端工程师',
      jobUrl: 'https://www.zhipin.com/job_detail/fixture-board.html',
      capturedAt: '2026-08-19T01:00:00.000Z',
      confidence: 'captured_jd',
      jdStatus: 'complete',
      resumeReady: true,
      progressState: 'status_proposed',
      latestEventType: 'application_status_proposed',
      latestEventAt: '2026-08-19T01:05:00.000Z',
      proposedStatus: 'interview',
      timeline: [],
      timelineTruncated: false,
      latestMatch: {
        matchId: 'resume-match:fixture',
        score: 86,
        matchLevel: 'strong',
        strategyVersion: 'local-evidence-match-v3',
        createdAt: '2026-08-19T01:03:00.000Z',
        resumeVersionId: 'resume-version:fixture',
        matchedSkills: ['Java'],
        missingSkills: [],
        matchedCapabilities: ['Backend Engineering'],
        missingCapabilities: [],
      },
      nextAction: 'review_application_progress',
      nextTool: 'boss_watch_application_overview',
    })
    assert.equal(board[1]?.jdStatus, 'source_summary')
    assert.equal(board[1]?.nextAction, 'verify_official_jd')
    assert.equal(board[1]?.resumeReady, true)
    assert.equal(board[1]?.officialApplyUrl, 'https://careers.example.invalid/fixture/apply')
    assert.equal(board[1]?.deadline, '2026-09-30')
    assert.equal(board[1]?.sourceUpdatedAt, '2026-08-18T00:00:00.000Z')
  } finally {
    leads.close()
  }
})

test('projects an unbound recruitment source into the source inbox without inventing a JobLead', async () => {
  const recruitmentSource: RecruitmentSource = {
    sourceId: 'recruitment-source:inbox-fixture',
    company: '虚构远航科技',
    channelUrl: 'https://careers.example.invalid/referral/inbox-fixture',
    referralCode: 'DEMO27',
    sourceType: 'official_referral',
    rawArtifactHash: '9'.repeat(64),
    capturedAt: '2026-08-19T00:30:00.000Z',
    status: 'source_only',
  }
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }

  const board = await new LocalCandidateBoardService({
    source,
    leads: { list() { return [] } },
    resumes: { count() { return 1 } },
    recruitmentSources: { list() { return [recruitmentSource] } },
  }).list()

  assert.deepEqual(board, [{
    candidateId: recruitmentSource.sourceId,
    recordKind: 'recruitment_source',
    sourceKind: 'manual_recruitment_source',
    company: recruitmentSource.company,
    role: '',
    recruitmentSourceId: recruitmentSource.sourceId,
    referralCode: recruitmentSource.referralCode,
    channelUrl: recruitmentSource.channelUrl,
    capturedAt: recruitmentSource.capturedAt,
    confidence: 'source_only',
    jdStatus: 'source_summary',
    resumeReady: true,
    nextAction: 'verify_official_jd',
    nextTool: 'boss_watch_recruitment_source_get',
  }])
  assert.equal(board[0]?.leadId, undefined)
})

test('asks DSH for explicit Gate A confirmation after matching', async () => {
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() {
      return [{
        applicationId: 'application:boss-fixture',
        company: '虚构云图科技',
        role: '后端工程师',
        capturedAt: '2026-08-19T01:00:00.000Z',
        contentHash: 'b'.repeat(64),
        progressState: 'new',
        eventCount: 1,
        recruiterMessageCount: 0,
        interviewNoteCount: 0,
        progressSignalCount: 0,
        latestEventType: 'job_description_captured',
        latestEventAt: '2026-08-19T01:00:00.000Z',
      }]
    },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const board = await new LocalCandidateBoardService({
    source,
    leads: { list() { return [] } },
    resumes: { count() { return 1 } },
    matches: { list() { return [MATCH_RESULT] } },
  }).list()

  assert.equal(board[0]?.nextAction, 'confirm_gate_a')
  assert.equal(board[0]?.nextTool, 'boss_watch_gate_a_confirm')
  assert.equal(board[0]?.latestMatch?.score, 86)
  assert.equal(board[0]?.gateA, undefined)
})

test('joins only explicitly bound recruitment source, application, match, and Feishu projection facts', async () => {
  const application: ApplicationOverview = {
    applicationId: 'application:boss-fixture',
    company: '虚构云图科技',
    role: '后端工程师',
    jobUrl: 'https://careers.example.invalid/jobs/backend-fixture',
    capturedAt: '2026-08-19T01:00:00.000Z',
    contentHash: 'b'.repeat(64),
    progressState: 'new',
    eventCount: 1,
    recruiterMessageCount: 0,
    interviewNoteCount: 0,
    progressSignalCount: 0,
    latestEventType: 'job_description_captured',
    latestEventAt: '2026-08-19T01:00:00.000Z',
  }
  const lead: JobLead = {
    leadId: 'lead:company_career_site:bound-fixture',
    sourceKind: 'company_career_site',
    sourceRecordId: 'bound-fixture',
    company: '虚构云图科技',
    role: '后端工程师',
    city: '上海',
    cohort: '2027届',
    recruitmentType: '秋招',
    deadline: '2026-09-30',
    officialApplyUrl: 'https://careers.example.invalid/jobs/backend-fixture',
    sourceUpdatedAt: '2026-08-18T00:00:00.000Z',
    fetchedAt: '2026-08-19T00:55:00.000Z',
    rawRef: 'company-career-site://bound-fixture',
    contentHash: 'e'.repeat(64),
    confidence: 'human_confirmed',
  }
  const recruitmentSource: RecruitmentSource = {
    sourceId: 'recruitment-source:bound-fixture',
    company: '虚构云图科技',
    channelUrl: 'https://careers.example.invalid/referral/fixture',
    referralCode: 'DEMO27',
    sourceType: 'official_referral',
    rawArtifactHash: 'f'.repeat(64),
    capturedAt: '2026-08-19T00:50:00.000Z',
    status: 'jd_ready',
    boundLeadId: lead.leadId,
    boundApplicationId: application.applicationId,
    role: lead.role,
    officialJobUrl: lead.officialApplyUrl,
    jdContentHash: application.contentHash,
  }
  const projection: FeishuProjection = {
    targetId: 'feishu-target:fixture',
    applicationId: application.applicationId,
    remoteRecordId: 'record-fixture',
    sourceHash: '1'.repeat(64),
    projectedHash: '2'.repeat(64),
    projectedAt: '2026-08-19T02:00:00.000Z',
    lastResult: 'created',
  }
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [application] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const board = await new LocalCandidateBoardService({
    source,
    leads: { list() { return [lead] } },
    resumes: { count() { return 1 } },
    matches: { list() { return [MATCH_RESULT] } },
    gateAApprovals: { getByMatchId() { return GATE_A_APPROVAL } },
    recruitmentSources: { list() { return [recruitmentSource] } },
    projections: {
      countTargets() { return 1 },
      listProjections(options) {
        assert.deepEqual(options, { applicationId: application.applicationId, limit: 10 })
        return [projection]
      },
    },
  }).list()

  assert.equal(board.length, 1)
  assert.equal(board[0]?.candidateId, application.applicationId)
  assert.equal(board[0]?.sourceKind, 'company_career_site')
  assert.equal(board[0]?.leadId, lead.leadId)
  assert.equal(board[0]?.recruitmentSourceId, recruitmentSource.sourceId)
  assert.equal(board[0]?.channelUrl, recruitmentSource.channelUrl)
  assert.equal(board[0]?.officialApplyUrl, lead.officialApplyUrl)
  assert.equal(board[0]?.city, lead.city)
  assert.equal(board[0]?.cohort, lead.cohort)
  assert.equal(board[0]?.recruitmentType, lead.recruitmentType)
  assert.equal(board[0]?.deadline, lead.deadline)
  assert.equal(board[0]?.sourceUpdatedAt, lead.sourceUpdatedAt)
  assert.equal(board[0]?.referralCode, 'DEMO27')
  assert.deepEqual(board[0]?.gateA, {
    gateAId: GATE_A_APPROVAL.gateAId,
    matchId: GATE_A_APPROVAL.matchId,
    approvedAt: GATE_A_APPROVAL.approvedAt,
    decision: 'proceed',
    externalAction: 'not_authorized',
  })
  assert.equal(board[0]?.nextAction, 'prepare_application')
  assert.equal(board[0]?.nextTool, 'boss_watch_apply_preview')
  assert.deepEqual(board[0]?.feishuProjections, [{
    targetId: projection.targetId,
    projectedAt: projection.projectedAt,
    lastResult: projection.lastResult,
  }])
})

test('guides a newly confirmed application status into an explicit Feishu sync preview', async () => {
  const application: ApplicationOverview = {
    applicationId: 'application:boss-fixture',
    company: '虚构云图科技',
    role: '后端工程师',
    capturedAt: '2026-08-19T01:00:00.000Z',
    contentHash: 'b'.repeat(64),
    progressState: 'status_confirmed',
    eventCount: 2,
    recruiterMessageCount: 0,
    interviewNoteCount: 0,
    progressSignalCount: 0,
    latestEventType: 'status_change_confirmed',
    latestEventAt: '2026-08-19T03:00:00.000Z',
    confirmedStatus: 'submitted',
  }
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [application] },
    async getApplicationOverview() { return application },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const board = await new LocalCandidateBoardService({
    source,
    leads: { list() { return [] } },
    resumes: { count() { return 1 } },
    matches: { list() { return [MATCH_RESULT] } },
    gateAApprovals: { getByMatchId() { return GATE_A_APPROVAL } },
    projections: {
      countTargets() { return 1 },
      listProjections() {
        return [{
          targetId: 'feishu-target:fixture',
          applicationId: application.applicationId,
          remoteRecordId: 'record-fixture',
          sourceHash: '1'.repeat(64),
          projectedHash: '2'.repeat(64),
          projectedAt: '2026-08-19T02:00:00.000Z',
          lastResult: 'created',
        }]
      },
    },
  }).list()

  assert.equal(board[0]?.confirmedStatus, 'submitted')
  assert.equal(board[0]?.nextAction, 'sync_feishu')
  assert.equal(board[0]?.nextTool, 'boss_watch_feishu_sync_preview')
})

test('projects scheduled follow-ups without exposing their free-text notes', async () => {
  const application: ApplicationOverview = {
    applicationId: 'application:follow-up-fixture',
    company: '虚构星港科技',
    role: '后端工程师',
    capturedAt: '2026-08-19T01:00:00.000Z',
    contentHash: '8'.repeat(64),
    progressState: 'status_confirmed',
    eventCount: 2,
    recruiterMessageCount: 0,
    interviewNoteCount: 0,
    progressSignalCount: 0,
    latestEventType: 'status_change_confirmed',
    latestEventAt: '2026-08-19T02:00:00.000Z',
    confirmedStatus: 'submitted',
  }
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [application] },
    async getApplicationOverview() { return application },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const board = await new LocalCandidateBoardService({
    source,
    leads: { list() { return [] } },
    followUps: {
      listActive(options) {
        assert.deepEqual(options, { limit: 100 })
        return [{
          followUpId: 'follow-up:fixture',
          applicationId: application.applicationId,
          dueAt: '2026-08-20T01:00:00.000Z',
          reason: 'no_response',
          note: '不应进入 dashboard snapshot 的用户备注',
          state: 'scheduled',
          createdAt: '2026-08-19T02:10:00.000Z',
        }]
      },
    },
  }).list()

  assert.deepEqual(board[0]?.followUps, [{
    followUpId: 'follow-up:fixture',
    dueAt: '2026-08-20T01:00:00.000Z',
    reason: 'no_response',
  }])
  assert.doesNotMatch(JSON.stringify(board), /用户备注/u)
})

test('keeps multiple explicit recruitment bindings separate instead of choosing a referral source', async () => {
  const application: ApplicationOverview = {
    applicationId: 'application:ambiguous-binding',
    company: '虚构星海科技',
    role: '平台工程师',
    capturedAt: '2026-08-19T03:00:00.000Z',
    contentHash: '3'.repeat(64),
    progressState: 'new',
    eventCount: 1,
    recruiterMessageCount: 0,
    interviewNoteCount: 0,
    progressSignalCount: 0,
    latestEventType: 'job_description_captured',
    latestEventAt: '2026-08-19T03:00:00.000Z',
  }
  const leads: JobLead[] = ['a', 'b'].map((suffix) => ({
    leadId: `lead:company_career_site:ambiguous-${suffix}`,
    sourceKind: 'company_career_site',
    sourceRecordId: `ambiguous-${suffix}`,
    company: '虚构星海科技',
    role: '平台工程师',
    officialApplyUrl: `https://careers.example.invalid/jobs/ambiguous-${suffix}`,
    fetchedAt: `2026-08-19T02:0${suffix === 'a' ? '1' : '2'}:00.000Z`,
    rawRef: `company-career-site://ambiguous-${suffix}`,
    contentHash: suffix === 'a' ? '4'.repeat(64) : '5'.repeat(64),
    confidence: 'human_confirmed',
  }))
  const sources: RecruitmentSource[] = leads.map((lead, index) => ({
    sourceId: `recruitment-source:ambiguous-${index}`,
    company: lead.company,
    channelUrl: `https://careers.example.invalid/referral/ambiguous-${index}`,
    referralCode: `DEMO-${index}`,
    sourceType: 'official_referral',
    rawArtifactHash: index === 0 ? '6'.repeat(64) : '7'.repeat(64),
    capturedAt: `2026-08-19T02:1${index}:00.000Z`,
    status: 'jd_ready',
    boundLeadId: lead.leadId,
    boundApplicationId: application.applicationId,
    role: lead.role,
    officialJobUrl: lead.officialApplyUrl,
    jdContentHash: application.contentHash,
  }))
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [application] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const board = await new LocalCandidateBoardService({
    source,
    leads: { list() { return leads } },
    resumes: { count() { return 1 } },
    recruitmentSources: { list() { return sources } },
  }).list()

  assert.equal(board.length, 3)
  const applicationItem = board.find((item) => item.candidateId === application.applicationId)
  assert.equal(applicationItem?.sourceKind, 'boss_visible')
  assert.equal(applicationItem?.leadId, undefined)
  assert.equal(applicationItem?.referralCode, undefined)
  assert.equal(board.filter((item) => item.recordKind === 'source_lead').length, 2)
})

test('keeps tracked applications in a bounded board when newer source leads exceed the limit', async () => {
  const application: ApplicationOverview = {
    applicationId: 'application:tracked-old-fixture',
    company: '虚构长河科技',
    role: '平台工程师',
    capturedAt: '2026-08-01T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
    progressState: 'status_confirmed',
    eventCount: 2,
    recruiterMessageCount: 0,
    interviewNoteCount: 0,
    progressSignalCount: 0,
    latestEventType: 'status_change_confirmed',
    latestEventAt: '2026-08-02T00:00:00.000Z',
    confirmedStatus: 'submitted',
  }
  const leads: JobLead[] = Array.from({ length: 60 }, (_, index) => ({
    leadId: `lead:gankinterview_campus:newer-${index}`,
    sourceKind: 'gankinterview_campus',
    sourceRecordId: `newer-${index}`,
    company: `虚构来源公司 ${index}`,
    role: '软件工程师',
    fetchedAt: `2026-08-19T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
    rawRef: `gankinterview://campus/newer-${index}`,
    contentHash: index.toString(16).padStart(64, '0'),
    confidence: 'source_only',
  }))
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [application] },
    async getApplicationOverview() { return application },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }

  const board = await new LocalCandidateBoardService({
    source,
    leads: { list(options) { assert.deepEqual(options, { limit: 100 }); return leads } },
    followUps: { listActive() {
      return [{
        followUpId: 'follow-up:tracked-old-fixture',
        applicationId: application.applicationId,
        dueAt: '2026-08-20T00:00:00.000Z',
        reason: 'no_response',
        state: 'scheduled',
        createdAt: '2026-08-19T00:00:00.000Z',
      }]
    } },
  }).list({ limit: 50 })

  assert.equal(board.length, 50)
  assert.ok(board.some((candidate) => candidate.candidateId === application.applicationId))
  assert.equal(board[0]?.candidateId, application.applicationId)
})

test('keeps an independent confirmation time and exposes only bounded timeline summaries', async () => {
  const confirmedAt = '2026-08-19T08:00:00.000Z'
  const latestEventAt = '2026-08-19T09:00:00.000Z'
  const application: ApplicationOverview = {
    applicationId: 'application:timeline-fixture',
    company: '虚构时序科技',
    role: '平台工程师',
    capturedAt: '2026-08-19T07:00:00.000Z',
    contentHash: 'd'.repeat(64),
    progressState: 'status_confirmed',
    eventCount: 4,
    recruiterMessageCount: 0,
    interviewNoteCount: 1,
    progressSignalCount: 0,
    latestEventType: 'interview_note_recorded',
    latestEventAt,
    confirmedStatus: 'submitted',
    confirmedAt,
  }
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [application] },
    async getApplicationOverview() { return application },
    async getJob() { return undefined },
    async listTimeline() {
      return [
        { sequence: 1, eventId: 'event:jd', applicationId: application.applicationId, type: 'job_description_captured', occurredAt: application.capturedAt, actor: 'human' },
        { sequence: 2, eventId: 'event:confirmed', applicationId: application.applicationId, type: 'status_change_confirmed', occurredAt: confirmedAt, actor: 'human', payload: { to: 'submitted', source: 'user_manual_confirmation' } },
        { sequence: 3, eventId: 'event:note', applicationId: application.applicationId, type: 'interview_note_recorded', occurredAt: latestEventAt, actor: 'human' },
        { sequence: 4, eventId: 'event:invalid-confirmed', applicationId: application.applicationId, type: 'status_change_confirmed', occurredAt: '2026-08-19T10:00:00.000Z', actor: 'agent', payload: { to: 'offer', source: 'user_manual_confirmation' } },
      ]
    },
  }

  const candidate = (await new LocalCandidateBoardService({ source, leads: { list() { return [] } } }).list({ limit: 10 }))[0]
  assert.equal(candidate?.confirmedAt, confirmedAt)
  assert.deepEqual(candidate?.timeline, [
    { eventType: 'job_description_captured', occurredAt: application.capturedAt, evidenceKind: 'fact' },
    { eventType: 'status_change_confirmed', occurredAt: confirmedAt, evidenceKind: 'confirmed', status: 'submitted' },
    { eventType: 'interview_note_recorded', occurredAt: latestEventAt, evidenceKind: 'fact' },
  ])
  assert.equal(candidate?.timelineTruncated, false)
  assert.doesNotMatch(JSON.stringify(candidate), /event:invalid-confirmed|offer/u)
})

test('rejects an invalid board limit before reading local facts', async () => {
  let reads = 0
  const source: BossWatchDataSource = {
    async listJobs() { reads += 1; return [] },
    async listApplicationOverviews() { reads += 1; return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const leads = { list() { reads += 1; return [] } }
  const service = new LocalCandidateBoardService({ source, leads })
  await assert.rejects(() => service.list({ limit: 0 }), /invalid_candidate_board_limit/u)
  await assert.rejects(() => service.list({ limit: 101 }), /invalid_candidate_board_limit/u)
  assert.equal(reads, 0)
})

test('distinguishes a verified summary from a complete JD and asks for a resume before preparation', async () => {
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const leads = new SqliteJobLeadStore(':memory:')
  leads.upsert([{
    leadId: 'lead:company_career_site:verified-fixture',
    sourceKind: 'company_career_site',
    sourceRecordId: 'verified-fixture',
    company: '虚构星河科技',
    role: '平台研发工程师',
    officialApplyUrl: 'https://careers.example.invalid/jobs/verified-fixture',
    fetchedAt: '2026-08-19T02:00:00.000Z',
    rawRef: 'company-career-site://verified-fixture',
    contentHash: 'c'.repeat(64),
    confidence: 'human_confirmed',
  }])

  try {
    const board = await new LocalCandidateBoardService({
      source,
      leads,
      resumes: { count() { return 0 } },
    }).list()
    assert.deepEqual(board[0], {
      candidateId: 'lead:company_career_site:verified-fixture',
      recordKind: 'source_lead',
      sourceKind: 'company_career_site',
      company: '虚构星河科技',
      role: '平台研发工程师',
      officialApplyUrl: 'https://careers.example.invalid/jobs/verified-fixture',
      capturedAt: '2026-08-19T02:00:00.000Z',
      confidence: 'human_confirmed',
      jdStatus: 'verified_summary',
      resumeReady: false,
      nextAction: 'import_resume',
      nextTool: 'boss_watch_resume_import_preview',
    })
  } finally {
    leads.close()
  }
})
