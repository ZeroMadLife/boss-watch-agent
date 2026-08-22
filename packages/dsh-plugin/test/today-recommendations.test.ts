import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { CandidateBoardItem } from '../src/candidate-board.ts'
import type { LocalCandidateBoardService } from '../src/candidate-board.ts'
import type { BossWatchDataSource } from '../src/domain.ts'
import {
  deriveTodayRecommendations,
  TODAY_RECOMMENDATION_STRATEGY_VERSION,
} from '../src/today-recommendations.ts'
import { registerBossWatchTools } from '../src/tools.ts'

const base: CandidateBoardItem = {
  candidateId: 'application:base',
  recordKind: 'captured_job',
  sourceKind: 'company_career_site',
  company: '虚构云图科技',
  role: 'Agent 平台工程师',
  capturedAt: '2026-08-20T02:00:00.000Z',
  confidence: 'captured_jd',
  jdStatus: 'complete',
  resumeReady: true,
  nextAction: 'confirm_gate_a',
  nextTool: 'boss_watch_gate_a_confirm',
}

function matched(
  candidateId: string,
  score: number,
  matchLevel: 'strong' | 'moderate' | 'weak' | 'insufficient_evidence',
  extra: Partial<CandidateBoardItem> = {},
): CandidateBoardItem {
  return {
    ...base,
    candidateId,
    latestMatch: {
      matchId: `match:${candidateId}`,
      score,
      matchLevel,
      strategyVersion: 'local-evidence-match-v3',
      createdAt: '2026-08-20T03:00:00.000Z',
      resumeVersionId: 'resume:fixture',
      matchedSkills: ['TypeScript', 'Agent'],
      missingSkills: ['Kubernetes'],
      matchedCapabilities: ['AI Application'],
      missingCapabilities: ['Distributed Systems'],
    },
    ...extra,
  }
}

test('returns a bounded deterministic shortlist without inventing weak or expired recommendations', () => {
  const candidates = [
    matched('application:ready', 91, 'strong', {
      company: '虚构星河科技',
      officialApplyUrl: 'https://careers.example.invalid/jobs/ready',
      deadline: '2026-08-25',
      gateA: {
        gateAId: 'gate-a:ready', matchId: 'match:application:ready', approvedAt: '2026-08-20T04:00:00.000Z',
        decision: 'proceed', externalAction: 'not_authorized',
      },
      nextAction: 'prepare_application',
      nextTool: 'boss_watch_apply_preview',
    }),
    matched('application:gate', 95, 'strong'),
    matched('application:consider', 78, 'moderate', { company: '虚构海川科技' }),
    matched('application:weak', 48, 'weak'),
    matched('application:expired', 93, 'strong', { deadline: '2026-08-01' }),
    matched('application:submitted', 96, 'strong', { confirmedStatus: 'submitted' }),
    { ...base, candidateId: 'application:no-match' },
  ]

  const result = deriveTodayRecommendations(candidates, {
    limit: 5,
    now: new Date('2026-08-22T04:00:00.000Z'),
  })

  assert.equal(result.strategyVersion, TODAY_RECOMMENDATION_STRATEGY_VERSION)
  assert.equal(result.readOnly, true)
  assert.deepEqual(result.items.map(item => item.candidateId), [
    'application:gate',
    'application:ready',
    'application:consider',
  ])
  assert.deepEqual(result.items.map(item => item.tier), ['recommended', 'recommended', 'consider'])
  assert.equal(result.items[0]?.readiness, 'gate_a_pending')
  assert.equal(result.items[1]?.readiness, 'ready_to_apply')
  assert.equal(result.items[1]?.action.mode, 'manual_open_verified_url')
  assert.equal(result.items[1]?.officialApplyUrl, 'https://careers.example.invalid/jobs/ready')
  assert.equal(result.recommendedCount, 2)
  assert.equal(result.considerCount, 1)
})

test('returns only privacy-bounded match evidence and never forces a fixed result count', () => {
  const candidate = matched('application:private', 89, 'strong') as CandidateBoardItem & {
    resumeText?: string
    phone?: string
    email?: string
    projects?: string[]
  }
  candidate.resumeText = '不应返回的简历正文'
  candidate.phone = '13800000000'
  candidate.email = 'private@example.invalid'
  candidate.projects = ['不应返回的项目原文']

  const result = deriveTodayRecommendations([candidate], {
    limit: 5,
    now: new Date('2026-08-22T04:00:00.000Z'),
  })

  assert.equal(result.items.length, 1)
  assert.deepEqual(result.items[0]?.matchedHighlights, ['TypeScript', 'Agent', 'AI Application'])
  assert.deepEqual(result.items[0]?.gaps, ['Kubernetes', 'Distributed Systems'])
  assert.doesNotMatch(JSON.stringify(result), /不应返回|13800000000|private@example\.invalid/u)
})

test('treats a date-only deadline as the end of that day', () => {
  const result = deriveTodayRecommendations([
    matched('application:today', 90, 'strong', { deadline: '2026-08-22' }),
  ], {
    now: new Date('2026-08-22T12:00:00.000Z'),
  })

  assert.equal(result.items.length, 1)
  assert.match(result.items[0]?.whyToday ?? '', /截止日期 2026-08-22 临近/u)
})

test('executes the DSH recommendation tool through the shared board derivation', async () => {
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
  const candidate = matched('application:tool', 92, 'strong', {
    company: '虚构工具科技',
    officialApplyUrl: 'https://careers.example.invalid/jobs/tool',
    gateA: {
      gateAId: 'gate-a:tool', matchId: 'match:application:tool', approvedAt: '2026-08-22T01:00:00.000Z',
      decision: 'proceed', externalAction: 'not_authorized',
    },
  })
  const candidateBoard = {
    async list(options: { readonly limit?: number }) {
      assert.deepEqual(options, { limit: 100 })
      return [candidate]
    },
  } as unknown as LocalCandidateBoardService
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    candidateBoard,
  )

  try {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('today-recommendations'),
      name: 'boss_watch_today_recommendations',
      arguments: { limit: 1 },
    })
    assert.equal(result.isError, false)
    const content = result.content[0]
    if (content?.type !== 'text') throw new Error('expected_text_tool_result')
    const payload = JSON.parse(content.text) as { status: string; recommendations: unknown[] }
    assert.equal(payload.status, 'ok')
    assert.deepEqual(payload.recommendations, [{
      rank: 1,
      candidateId: 'application:tool',
      company: '虚构工具科技',
      role: 'Agent 平台工程师',
      tier: 'recommended',
      readiness: 'ready_to_apply',
      score: 92,
      matchLevel: 'strong',
      matchStrategyVersion: 'local-evidence-match-v3',
      matchedHighlights: ['TypeScript', 'Agent', 'AI Application'],
      gaps: ['Kubernetes', 'Distributed Systems'],
      whyToday: '匹配与人工确认已就绪，今天可以进入官网投递',
      recommendationReason: '92 分，高匹配；已命中 TypeScript、Agent、AI Application',
      officialApplyUrl: 'https://careers.example.invalid/jobs/tool',
      action: {
        mode: 'manual_open_verified_url',
        label: '人工打开官网/ATS',
        nextTool: 'boss_watch_apply_preview',
        requiresHuman: true,
        externalEffect: 'none',
      },
    }])
    assert.doesNotMatch(content.text, /resumeText|phone|email|projects/u)
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})
