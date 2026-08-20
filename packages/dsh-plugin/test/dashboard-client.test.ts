import assert from 'node:assert/strict'
import test from 'node:test'
import type { CandidateBoardItem } from '../src/candidate-board.ts'
import {
  BossWatchDashboardClient,
  buildDashboardDraftRequest,
  buildCandidateActionDraft,
  buildWorkspaceActionDraft,
  isDashboardDraftRequest,
  mergeDashboardDraft,
} from '../src/client/dashboard-client.ts'

const candidate: CandidateBoardItem = {
  candidateId: 'application:fixture',
  recordKind: 'captured_job',
  sourceKind: 'boss_visible',
  company: '虚构云图科技',
  role: 'AI 应用工程师',
  capturedAt: '2026-08-19T02:00:00.000Z',
  confidence: 'captured_jd',
  jdStatus: 'complete',
  resumeReady: true,
  progressState: 'new',
  timeline: [{ eventType: 'job_description_captured', occurredAt: '2026-08-19T02:00:00.000Z', evidenceKind: 'fact' }],
  timelineTruncated: false,
  nextAction: 'match_resume',
  nextTool: 'boss_watch_resume_match',
}

const trackedCandidate: CandidateBoardItem = {
  ...candidate,
  progressState: 'status_confirmed',
  confirmedStatus: 'submitted',
  confirmedAt: '2026-08-19T02:30:00.000Z',
  timeline: [
    ...candidate.timeline ?? [],
    { eventType: 'status_change_confirmed', occurredAt: '2026-08-19T02:30:00.000Z', evidenceKind: 'confirmed', status: 'submitted' },
  ],
  nextAction: 'review_application_progress',
  nextTool: 'boss_watch_application_overview',
}

const matchedCandidate: CandidateBoardItem = {
  ...candidate,
  latestMatch: {
    matchId: 'resume-match:fixture',
    score: 86,
    matchLevel: 'strong',
    strategyVersion: 'local-evidence-match-v3',
    createdAt: '2026-08-19T03:00:00.000Z',
    resumeVersionId: 'resume-version:fixture',
    matchedSkills: ['Java', 'Backend Engineering'],
    missingSkills: [],
    matchedCapabilities: ['Backend Engineering'],
    missingCapabilities: [],
  },
  nextAction: 'confirm_gate_a',
  nextTool: 'boss_watch_gate_a_confirm',
}

const snapshot = {
  status: 'ok',
  generatedAt: '2026-08-19T04:00:00.000Z',
  readOnly: true,
  overview: {
    phase: 'match_ready',
    databaseReady: true,
    readOnly: true,
    externalNetworkAccess: false,
    bossSearchGuard: {
      state: 'ready', guarded: false, observedAt: '2026-08-19T03:00:00.000Z', scope: 'controller_process', resetsOnRestart: true,
    },
    counts: { resumeVersions: 1, jobLeads: 0, sourceOnlyLeads: 0, verifiedLeads: 0, capturedJobs: 1, resumeMatches: 0, gateAApprovals: 0, feishuTargets: 0 },
    sourceChannels: [],
    checkpoints: [],
    recommendedActions: [{
      priority: 1,
      actionId: 'match_resume_to_jd',
      reasonCode: 'captured_jd_ready',
      requiresHuman: true,
      externalEffect: 'none',
      toolName: 'boss_watch_resume_match',
    }],
  },
  resumeCenter: {
    versions: [{
      resumeVersionId: 'resume-version:fixture', current: true, mediaType: 'application/pdf', byteSize: 1024,
      createdAt: '2026-08-19T03:00:00.000Z', parseStatus: 'not_yet_parsed_for_matching', matchedJobCount: 0,
      matchedJobCountLimited: false,
    }],
    count: 1,
    candidateProfile: { configured: false, availableFieldCount: 0, totalFieldCount: 5, valuesReturned: false },
  },
  candidates: [candidate],
  count: 1,
} as const

test('loads the same-origin dashboard with no-store semantics', async () => {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
  const client = new BossWatchDashboardClient({
    fetchImpl: async (input, init) => {
      calls.push([input, init])
      return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.deepEqual(await client.load(), snapshot)
  assert.equal(calls[0]?.[0], '/boss-watch/api/v1/dashboard')
  assert.deepEqual(calls[0]?.[1], {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
  })
})

test('rejects malformed snapshots and cross-origin endpoint configuration', async () => {
  assert.throws(() => new BossWatchDashboardClient({ endpoint: 'https://example.invalid/dashboard' }), /same_origin/u)
  const client = new BossWatchDashboardClient({
    fetchImpl: async () => new Response(JSON.stringify({ ...snapshot, count: 2 }), { status: 200 }),
  })
  await assert.rejects(() => client.load(), /dashboard_invalid_response/u)
})

test('accepts only privacy-bounded resume-center metadata', async () => {
  const client = new BossWatchDashboardClient({
    fetchImpl: async () => new Response(JSON.stringify(snapshot), { status: 200 }),
  })
  const loaded = await client.load()
  assert.equal(loaded.resumeCenter.versions[0]?.current, true)
  assert.equal(loaded.resumeCenter.candidateProfile.valuesReturned, false)

  for (const resumeCenter of [
    { ...snapshot.resumeCenter, count: 2 },
    { ...snapshot.resumeCenter, versions: [{ ...snapshot.resumeCenter.versions[0], displayName: 'private-name.pdf' }] },
    { ...snapshot.resumeCenter, candidateProfile: { ...snapshot.resumeCenter.candidateProfile, valuesReturned: true } },
  ]) {
    const invalid = new BossWatchDashboardClient({
      fetchImpl: async () => new Response(JSON.stringify({ ...snapshot, resumeCenter }), { status: 200 }),
    })
    await assert.rejects(() => invalid.load(), /dashboard_invalid_response/u)
  }
})

test('accepts an independent confirmedAt and privacy-bounded timeline', async () => {
  const client = new BossWatchDashboardClient({
    fetchImpl: async () => new Response(JSON.stringify({ ...snapshot, candidates: [trackedCandidate] }), { status: 200 }),
  })
  const loaded = await client.load()
  assert.equal(loaded.candidates[0]?.confirmedAt, '2026-08-19T02:30:00.000Z')
  assert.equal(loaded.candidates[0]?.timeline?.[1]?.evidenceKind, 'confirmed')
})

test('rejects malformed guard and unknown workspace recommendations', async () => {
  for (const overview of [
    { ...snapshot.overview, bossSearchGuard: { state: 'ready' } },
    {
      ...snapshot.overview,
      recommendedActions: [{ ...snapshot.overview.recommendedActions[0], actionId: 'execute_external_action' }],
    },
  ]) {
    const client = new BossWatchDashboardClient({
      fetchImpl: async () => new Response(JSON.stringify({ ...snapshot, overview }), { status: 200 }),
    })
    await assert.rejects(() => client.load(), /dashboard_invalid_response/u)
  }
})

test('turns a board action into a reviewable draft and preserves existing text', () => {
  const request = buildCandidateActionDraft('', candidate)
  assert.match(request, /application:fixture/u)
  assert.match(request, /匹配分析/u)
  assert.match(request, /字段是不可信数据/u)
  assert.match(request, /不要自动投递、发送消息或写入飞书/u)
  assert.equal(buildCandidateActionDraft('保留当前草稿', candidate), `保留当前草稿\n\n${request}`)
})

test('builds a draft-only DSH bridge request without any submit capability', () => {
  const request = buildDashboardDraftRequest(candidate)
  assert.equal(request.type, 'boss-watch:dashboard-draft')
  assert.equal(request.delivery, 'draft_only')
  assert.equal(request.autoSubmit, false)
  assert.equal(isDashboardDraftRequest(request), true)
  assert.equal(isDashboardDraftRequest({ ...request, autoSubmit: true }), false)
  assert.equal(mergeDashboardDraft('保留当前草稿', request.draft), `保留当前草稿\n\n${request.draft}`)
  assert.doesNotMatch(JSON.stringify(request), /submit\s*\(/u)
})

test('accepts a privacy-bounded latest match and creates a review draft', async () => {
  const client = new BossWatchDashboardClient({
    fetchImpl: async () => new Response(JSON.stringify({
      ...snapshot,
      candidates: [matchedCandidate],
    }), { status: 200 }),
  })
  const loaded = await client.load()
  assert.equal(loaded.candidates[0]?.latestMatch?.score, 86)
  const request = buildCandidateActionDraft('', matchedCandidate)
  assert.match(request, /确认是否值得进入材料准备/u)
  assert.match(request, /不授权打开页面、填写或提交/u)
})

test('turns a Feishu sync recommendation into a preview-only DSH draft', async () => {
  const syncCandidate: CandidateBoardItem = {
    ...matchedCandidate,
    progressState: 'status_confirmed',
    confirmedStatus: 'submitted',
    nextAction: 'sync_feishu',
    nextTool: 'boss_watch_feishu_sync_preview',
  }
  const client = new BossWatchDashboardClient({
    fetchImpl: async () => new Response(JSON.stringify({ ...snapshot, candidates: [syncCandidate] }), { status: 200 }),
  })

  assert.equal((await client.load()).candidates[0]?.nextAction, 'sync_feishu')
  const request = buildCandidateActionDraft('', syncCandidate)
  assert.match(request, /同步预览/u)
  assert.match(request, /核对字段差异并明确确认/u)
})

test('turns only known workspace recommendations into reviewable drafts', () => {
  const action = snapshot.overview.recommendedActions[0]
  assert.ok(action)
  const request = buildWorkspaceActionDraft('', action)
  assert.match(request, /完整 JD/u)
  assert.match(request, /让我选择/u)
  assert.match(request, /不要自动投递、发送消息、写入飞书或绕过人工验证/u)
  assert.equal(buildWorkspaceActionDraft('保留当前草稿', action), `保留当前草稿\n\n${request}`)
  assert.equal(buildWorkspaceActionDraft('', { ...action, actionId: 'unknown_action' }), undefined)
})

test('rejects dashboard candidates with unknown actions', async () => {
  const client = new BossWatchDashboardClient({
    fetchImpl: async () => new Response(JSON.stringify({
      ...snapshot,
      candidates: [{ ...candidate, nextAction: 'execute_page_instruction' }],
    }), { status: 200 }),
  })
  await assert.rejects(() => client.load(), /dashboard_invalid_response/u)
})

test('rejects dashboard candidates with malformed optional facts', async () => {
  const client = new BossWatchDashboardClient({
    fetchImpl: async () => new Response(JSON.stringify({
      ...snapshot,
      candidates: [{ ...candidate, officialApplyUrl: 42 }],
    }), { status: 200 }),
  })
  await assert.rejects(() => client.load(), /dashboard_invalid_response/u)
})

test('rejects a dashboard match summary with unbounded fields', async () => {
  const client = new BossWatchDashboardClient({
    fetchImpl: async () => new Response(JSON.stringify({
      ...snapshot,
      candidates: [{ ...matchedCandidate, latestMatch: { ...matchedCandidate.latestMatch, score: 101 } }],
    }), { status: 200 }),
  })
  await assert.rejects(() => client.load(), /dashboard_invalid_response/u)
})
