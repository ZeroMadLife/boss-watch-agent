import assert from 'node:assert/strict'
import test from 'node:test'
import type { CandidateBoardItem } from '../src/candidate-board.ts'
import {
  batchSelectionAvailability,
  classifySourceInbox,
  deriveJobDisplayProfile,
  deriveTodayTasks,
  filterJobBoard,
  JOB_BOARD_RULESET_VERSION,
  parseDashboardQuery,
  serializeDashboardQuery,
  summarizeMatchEvidence,
  timelineForCandidate,
  trackingCandidates,
} from '../src/dashboard-view-model.ts'

const baseCandidate: CandidateBoardItem = {
  candidateId: 'lead:fixture',
  recordKind: 'source_lead',
  sourceKind: 'gankinterview_campus',
  company: '虚构云图科技',
  role: 'AI 应用工程师',
  capturedAt: '2026-08-19T02:00:00.000Z',
  confidence: 'source_only',
  jdStatus: 'source_summary',
  resumeReady: true,
  nextAction: 'verify_official_jd',
  nextTool: 'boss_watch_lead_list',
}

test('derives a fact-bounded today queue with distinct urgency and workflow signals', () => {
  const candidates: CandidateBoardItem[] = [
    { ...baseCandidate, candidateId: 'lead:source', deadline: '2026-08-21' },
    { ...baseCandidate, candidateId: 'lead:jd', officialApplyUrl: 'https://careers.example.invalid/jobs/fixture' },
    {
      ...baseCandidate,
      candidateId: 'application:match',
      recordKind: 'captured_job',
      sourceKind: 'boss_visible',
      confidence: 'captured_jd',
      jdStatus: 'complete',
      nextAction: 'match_resume',
      nextTool: 'boss_watch_resume_match',
    },
    {
      ...baseCandidate,
      candidateId: 'application:gate-a',
      recordKind: 'captured_job',
      sourceKind: 'boss_visible',
      confidence: 'captured_jd',
      jdStatus: 'complete',
      nextAction: 'confirm_gate_a',
      nextTool: 'boss_watch_gate_a_confirm',
    },
    {
      ...baseCandidate,
      candidateId: 'application:manual',
      recordKind: 'captured_job',
      sourceKind: 'company_career_site',
      confidence: 'captured_jd',
      jdStatus: 'complete',
      officialApplyUrl: 'https://careers.example.invalid/jobs/manual',
      nextAction: 'prepare_application',
      nextTool: 'boss_watch_apply_preview',
    },
    {
      ...baseCandidate,
      candidateId: 'application:proposal',
      recordKind: 'captured_job',
      sourceKind: 'boss_visible',
      confidence: 'captured_jd',
      jdStatus: 'complete',
      progressState: 'status_proposed',
      proposedStatus: 'interview_scheduled',
      nextAction: 'review_application_progress',
      nextTool: 'boss_watch_application_overview',
    },
    {
      ...baseCandidate,
      candidateId: 'application:sync',
      recordKind: 'captured_job',
      sourceKind: 'boss_visible',
      confidence: 'captured_jd',
      jdStatus: 'complete',
      progressState: 'status_confirmed',
      confirmedStatus: 'submitted',
      nextAction: 'sync_feishu',
      nextTool: 'boss_watch_feishu_sync_preview',
    },
    {
      ...baseCandidate,
      candidateId: 'application:follow-up',
      recordKind: 'captured_job',
      sourceKind: 'boss_visible',
      confidence: 'captured_jd',
      jdStatus: 'complete',
      progressState: 'status_confirmed',
      confirmedStatus: 'submitted',
      nextAction: 'review_application_progress',
      nextTool: 'boss_watch_application_overview',
      followUps: [{ followUpId: 'follow-up:fixture', dueAt: '2026-08-20T07:00:00.000Z', reason: 'no_response' }],
    },
  ]

  const tasks = deriveTodayTasks(candidates, new Date('2026-08-19T08:00:00.000Z'))
  const signals = new Set(tasks.flatMap(task => task.signals))
  assert.deepEqual([...signals].sort(), [
    'deadline_near',
    'feishu_sync',
    'follow_up',
    'gate_a',
    'jd_verification',
    'manual_application',
    'match',
    'source_binding',
    'status_confirmation',
  ])
  assert.ok(tasks.every(task => task.whyNow.length > 0 && task.evidence.length > 0 && task.missing.length > 0 && task.nextStep.length > 0))
  assert.equal(tasks.find(task => task.candidateId === 'application:manual')?.actionMode, 'verified_url')
  assert.equal(tasks.find(task => task.candidateId === 'application:sync')?.actionMode, 'draft_only')
  assert.match(tasks.find(task => task.candidateId === 'application:follow-up')?.whyNow ?? '', /08-20|2026-08-20/u)
})

test('keeps source-only records in the inbox and reports only observable gaps', () => {
  const inbox = classifySourceInbox([
    {
      ...baseCandidate,
      candidateId: 'recruitment-source:fixture',
      recordKind: 'recruitment_source',
      sourceKind: 'manual_recruitment_source',
      role: '',
      recruitmentSourceId: 'recruitment-source:fixture',
    },
    baseCandidate,
    { ...baseCandidate, candidateId: 'lead:url', officialApplyUrl: 'https://careers.example.invalid/jobs/url' },
    { ...baseCandidate, candidateId: 'lead:verified', confidence: 'jd_verified', jdStatus: 'verified_summary' },
    { ...baseCandidate, candidateId: 'application:captured', recordKind: 'captured_job', confidence: 'captured_jd', jdStatus: 'complete' },
  ])

  assert.deepEqual(inbox.map(item => item.candidate.candidateId), ['recruitment-source:fixture', 'lead:fixture', 'lead:url'])
  assert.deepEqual(inbox[0]?.gaps, ['缺确切岗位', '缺确切岗位 URL', '缺完整 JD', '待人工核验'])
  assert.deepEqual(inbox[1]?.gaps, ['缺确切岗位 URL', '缺完整 JD', '待人工核验'])
  assert.deepEqual(inbox[2]?.gaps, ['缺完整 JD', '待人工核验'])
})

test('keeps an application with only a scheduled reminder in the tracking view', () => {
  const candidate: CandidateBoardItem = {
    ...baseCandidate,
    candidateId: 'application:follow-up-only',
    recordKind: 'captured_job',
    sourceKind: 'boss_visible',
    confidence: 'captured_jd',
    jdStatus: 'complete',
    progressState: 'new',
    nextAction: 'review_application_progress',
    nextTool: 'boss_watch_application_overview',
    followUps: [{ followUpId: 'follow-up:only', dueAt: '2026-08-20T07:00:00.000Z', reason: 'manual' }],
  }

  assert.deepEqual(trackingCandidates([candidate]), [candidate])
})

test('round-trips user-facing board filters through URL query and rejects unsafe values', () => {
  const parsed = parseDashboardQuery('?view=jobs&q=Agent&match=strong&company=state_owned&direction=agent&sort=match&page=3&selected=application%3Afixture&embedded=1')
  assert.deepEqual(parsed, {
    view: 'jobs', query: 'Agent', match: 'strong', companyCategory: 'state_owned', roleDirection: 'agent', sort: 'match', page: 3,
    selected: 'application:fixture', embedded: true,
  })
  assert.equal(serializeDashboardQuery(parsed), '?view=jobs&q=Agent&match=strong&company=state_owned&direction=agent&page=3&selected=application%3Afixture&embedded=1')
  assert.deepEqual(parseDashboardQuery('?view=today&match=perfect&company=guess&direction=magic&sort=salary&page=-1&selected=' + 'x'.repeat(300)), {
    view: 'jobs', query: '', match: 'all', companyCategory: 'all', roleDirection: 'all', sort: 'match', page: 1, embedded: false,
  })
  assert.equal(serializeDashboardQuery(parseDashboardQuery('')), '?view=jobs')
})

test('derives conservative versioned company, direction, and worth-applying labels', () => {
  const recommended = deriveJobDisplayProfile({
    ...baseCandidate,
    candidateId: 'application:agent',
    company: '虚构云图科技（央企）',
    role: '大模型 Agent 开发工程师',
    recordKind: 'captured_job',
    confidence: 'captured_jd',
    jdStatus: 'complete',
    latestMatch: {
      matchId: 'match:agent', score: 88, matchLevel: 'strong', strategyVersion: 'local-evidence-match-v3',
      createdAt: '2026-08-19T03:00:00.000Z', resumeVersionId: 'resume:fixture', matchedSkills: ['TypeScript'],
      missingSkills: [], matchedCapabilities: ['AI Application'], missingCapabilities: [],
    },
  })
  assert.deepEqual({
    companyCategory: recommended.companyCategory,
    roleDirection: recommended.roleDirection,
    worthApplying: recommended.worthApplying,
  }, { companyCategory: 'state_owned', roleDirection: 'agent', worthApplying: 'recommended' })
  assert.equal(recommended.ruleVersion, JOB_BOARD_RULESET_VERSION)
  assert.equal(recommended.reason, '88 分，匹配度高，可以优先考虑')

  const unclassified = deriveJobDisplayProfile({ ...baseCandidate, company: '虚构未标注组织', role: '工程师' })
  assert.equal(unclassified.companyCategory, 'unclassified')
  assert.equal(unclassified.roleDirection, 'unclassified')
  assert.equal(unclassified.worthApplying, 'pending')

  const conflicting = deriveJobDisplayProfile({
    ...baseCandidate,
    role: 'Agent 后端开发工程师',
    latestMatch: {
      matchId: 'match:conflicting', score: 78, matchLevel: 'moderate', strategyVersion: 'local-evidence-match-v3',
      createdAt: '2026-08-19T03:00:00.000Z', resumeVersionId: 'resume:fixture', matchedSkills: [], missingSkills: [],
      matchedCapabilities: ['AI Application', 'Backend Engineering'], missingCapabilities: [],
    },
  })
  assert.equal(conflicting.roleDirection, 'unclassified')

  const moderate = deriveJobDisplayProfile({
    ...baseCandidate,
    candidateId: 'application:moderate',
    recordKind: 'captured_job',
    confidence: 'captured_jd',
    jdStatus: 'complete',
    latestMatch: {
      matchId: 'match:moderate', score: 64, matchLevel: 'moderate', strategyVersion: 'local-evidence-match-v3',
      createdAt: '2026-08-19T03:00:00.000Z', resumeVersionId: 'resume:fixture', matchedSkills: [],
      missingSkills: ['SQL'], matchedCapabilities: [], missingCapabilities: [],
    },
  })
  assert.equal(moderate.worthApplying, 'review')
  assert.equal(moderate.reason, '64 分，匹配度中等，先查看缺口')

  const weak = deriveJobDisplayProfile({
    ...baseCandidate,
    candidateId: 'application:weak',
    recordKind: 'captured_job',
    confidence: 'captured_jd',
    jdStatus: 'complete',
    latestMatch: {
      matchId: 'match:weak', score: 31, matchLevel: 'weak', strategyVersion: 'local-evidence-match-v3',
      createdAt: '2026-08-19T03:00:00.000Z', resumeVersionId: 'resume:fixture', matchedSkills: [],
      missingSkills: [], matchedCapabilities: [], missingCapabilities: [],
    },
  })
  assert.equal(weak.worthApplying, 'not_recommended')
  assert.equal(weak.reason, '31 分，匹配度较低，暂不优先')
})

test('filters the full company and job board without dropping unbound sources', () => {
  const candidates: CandidateBoardItem[] = [
    {
      ...baseCandidate,
      candidateId: 'source:unbound',
      recordKind: 'recruitment_source',
      role: '',
      company: '虚构未分类组织',
      recruitmentSourceId: 'source:unbound',
    },
    {
      ...baseCandidate,
      candidateId: 'application:backend',
      company: '虚构星河科技（私企）',
      role: 'Java 后端工程师',
      recordKind: 'captured_job',
      confidence: 'captured_jd',
      jdStatus: 'complete',
      city: '上海',
      latestMatch: {
        matchId: 'match:backend', score: 72, matchLevel: 'moderate', strategyVersion: 'local-evidence-match-v3',
        createdAt: '2026-08-19T03:00:00.000Z', resumeVersionId: 'resume:fixture', matchedSkills: ['Java'],
        missingSkills: ['Redis'], matchedCapabilities: ['Backend Engineering'], missingCapabilities: [],
      },
    },
  ]

  assert.deepEqual(filterJobBoard(candidates, {
    query: '', match: 'all', companyCategory: 'all', roleDirection: 'all',
  }).map(candidate => candidate.candidateId), ['source:unbound', 'application:backend'])
  assert.deepEqual(filterJobBoard(candidates, {
    query: '上海', match: 'moderate', companyCategory: 'private_tech', roleDirection: 'backend',
  }).map(candidate => candidate.candidateId), ['application:backend'])
  assert.deepEqual(filterJobBoard(candidates, {
    query: '', match: 'pending', companyCategory: 'other_or_unclassified', roleDirection: 'other_or_unclassified',
  }).map(candidate => candidate.candidateId), ['source:unbound'])
})

test('allows batch selection only after JD, match, worth-it confirmation, and a verified application entry are ready', () => {
  const ready: CandidateBoardItem = {
    ...baseCandidate,
    candidateId: 'application:ready-for-preparation',
    recordKind: 'captured_job',
    confidence: 'captured_jd',
    jdStatus: 'complete',
    officialApplyUrl: 'https://careers.example.invalid/jobs/ready',
    nextAction: 'prepare_application',
    nextTool: 'boss_watch_apply_preview',
    latestMatch: {
      matchId: 'match:ready', score: 86, matchLevel: 'strong', strategyVersion: 'local-evidence-match-v3',
      createdAt: '2026-08-19T03:00:00.000Z', resumeVersionId: 'resume:fixture', matchedSkills: ['Java'],
      missingSkills: [], matchedCapabilities: ['Backend Engineering'], missingCapabilities: [],
    },
    gateA: {
      gateAId: 'gate-a:ready', matchId: 'match:ready', approvedAt: '2026-08-19T04:00:00.000Z',
      decision: 'proceed', externalAction: 'not_authorized',
    },
  }

  assert.deepEqual(batchSelectionAvailability(ready), { selectable: true, reason: '可以加入待投递' })
  assert.deepEqual(batchSelectionAvailability({ ...ready, jdStatus: 'verified_summary' }), { selectable: false, reason: '缺完整 JD' })
  assert.deepEqual(batchSelectionAvailability({ ...ready, latestMatch: undefined }), { selectable: false, reason: '待完成匹配' })
  assert.deepEqual(batchSelectionAvailability({ ...ready, gateA: undefined }), { selectable: false, reason: '待确认值得投' })
  assert.deepEqual(batchSelectionAvailability({ ...ready, officialApplyUrl: undefined }), { selectable: false, reason: '缺投递入口' })
  assert.deepEqual(batchSelectionAvailability({ ...ready, nextAction: 'sync_feishu', confirmedStatus: 'submitted' }), {
    selectable: false,
    reason: '已有投递进度',
  })
})

test('keeps facts, recommendations, pending confirmation, and confirmed status visually distinct', () => {
  const entries = timelineForCandidate({
    ...baseCandidate,
    candidateId: 'application:timeline',
    recordKind: 'captured_job',
    confidence: 'captured_jd',
    jdStatus: 'complete',
    latestMatch: {
      matchId: 'match:fixture', score: 82, matchLevel: 'strong', strategyVersion: 'local-evidence-match-v3',
      createdAt: '2026-08-19T03:00:00.000Z', resumeVersionId: 'resume:fixture', matchedSkills: ['Java'],
      missingSkills: ['Redis'], matchedCapabilities: ['Backend Engineering'], missingCapabilities: [],
    },
    gateA: {
      gateAId: 'gate-a:fixture', matchId: 'match:fixture', approvedAt: '2026-08-19T04:00:00.000Z',
      decision: 'proceed', externalAction: 'not_authorized',
    },
    proposedStatus: 'interview_scheduled',
    confirmedStatus: 'submitted',
    confirmedAt: '2026-08-19T05:00:00.000Z',
    timeline: [
      { eventType: 'status_change_confirmed', occurredAt: '2026-08-19T05:00:00.000Z', evidenceKind: 'confirmed', status: 'submitted' },
      { eventType: 'interview_note_recorded', occurredAt: '2026-08-19T06:00:00.000Z', evidenceKind: 'fact' },
    ],
    timelineTruncated: false,
  })
  assert.ok(entries.some(entry => entry.kind === 'fact' && entry.stage === 'jd'))
  assert.ok(entries.some(entry => entry.kind === 'recommendation' && entry.stage === 'match'))
  assert.ok(entries.some(entry => entry.kind === 'confirmation_pending' && entry.stage === 'status_proposal'))
  assert.ok(entries.some(entry => entry.kind === 'confirmed' && entry.stage === 'confirmed_status'))
  assert.equal(entries.find(entry => entry.stage === 'confirmed_status')?.at, '2026-08-19T05:00:00.000Z')
  assert.ok(entries.some(entry => entry.stage === 'application_event' && entry.label === 'interview_note_recorded'))
  assert.notEqual(entries.find(entry => entry.stage === 'status_proposal')?.label, entries.find(entry => entry.stage === 'confirmed_status')?.label)
})

test('exposes only privacy-bounded match fields even if an input object carries extra data', () => {
  const summary = summarizeMatchEvidence({
    matchId: 'match:fixture', score: 82, matchLevel: 'strong', strategyVersion: 'local-evidence-match-v3',
    createdAt: '2026-08-19T03:00:00.000Z', resumeVersionId: 'resume:fixture', matchedSkills: ['Java'],
    missingSkills: ['Redis'], matchedCapabilities: ['Backend Engineering'], missingCapabilities: [],
    resumeText: '姓名：不应泄漏', phone: '13800000000', projects: ['不应泄漏项目原文'],
  } as never)
  const serialized = JSON.stringify(summary)
  assert.deepEqual(Object.keys(summary).sort(), [
    'matchLevel', 'matchedCapabilities', 'matchedSkills', 'missingCapabilities', 'missingSkills',
    'resumeVersionId', 'score', 'strategyVersion',
  ])
  assert.doesNotMatch(serialized, /姓名|13800000000|项目原文/u)
})
