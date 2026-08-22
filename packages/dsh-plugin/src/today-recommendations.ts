import type { CandidateBoardItem, CandidateBoardLatestMatch } from './candidate-board.js'

export const TODAY_RECOMMENDATION_STRATEGY_VERSION = 'today-recommendations-v1' as const

export type TodayRecommendationTier = 'recommended' | 'consider'
export type TodayRecommendationReadiness = 'ready_to_apply' | 'gate_a_pending' | 'verified_url_pending'

export interface TodayJobRecommendation {
  readonly rank: number
  readonly candidateId: string
  readonly company: string
  readonly role: string
  readonly city?: string
  readonly deadline?: string
  readonly tier: TodayRecommendationTier
  readonly readiness: TodayRecommendationReadiness
  readonly score: number
  readonly matchLevel: 'strong' | 'moderate'
  readonly matchStrategyVersion: string
  readonly matchedHighlights: readonly string[]
  readonly gaps: readonly string[]
  readonly whyToday: string
  readonly recommendationReason: string
  readonly officialApplyUrl?: string
  readonly action: {
    readonly mode: 'manual_open_verified_url' | 'draft_only'
    readonly label: '人工打开官网/ATS' | '确认值得投' | '补投递入口'
    readonly nextTool: 'boss_watch_apply_preview' | 'boss_watch_gate_a_confirm' | 'boss_watch_lead_list'
    readonly requiresHuman: true
    readonly externalEffect: 'none'
  }
}

export interface TodayRecommendations {
  readonly strategyVersion: typeof TODAY_RECOMMENDATION_STRATEGY_VERSION
  readonly generatedAt: string
  readonly readOnly: true
  readonly evaluatedCount: number
  readonly recommendedCount: number
  readonly considerCount: number
  readonly items: readonly TodayJobRecommendation[]
}

interface DeriveTodayRecommendationsOptions {
  readonly limit?: number
  readonly now?: Date
}

interface RankedCandidate {
  readonly candidate: CandidateBoardItem
  readonly match: CandidateBoardLatestMatch & { readonly matchLevel: 'strong' | 'moderate' }
  readonly tier: TodayRecommendationTier
  readonly readiness: TodayRecommendationReadiness
  readonly officialApplyUrl?: string
}

/** Build a small, deterministic shortlist from the same privacy-bounded board used by the dashboard. */
export function deriveTodayRecommendations(
  candidates: readonly CandidateBoardItem[],
  options: DeriveTodayRecommendationsOptions = {},
): TodayRecommendations {
  const limit = options.limit ?? 5
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('invalid_today_recommendation_limit')
  const now = options.now ?? new Date()
  const ranked = candidates
    .map(candidate => eligibleCandidate(candidate, now))
    .filter((candidate): candidate is RankedCandidate => candidate !== undefined)
    .sort(compareRankedCandidates)
  const items = ranked.slice(0, limit).map((entry, index) => toRecommendation(entry, index + 1, now))
  return {
    strategyVersion: TODAY_RECOMMENDATION_STRATEGY_VERSION,
    generatedAt: now.toISOString(),
    readOnly: true,
    evaluatedCount: candidates.length,
    recommendedCount: items.filter(item => item.tier === 'recommended').length,
    considerCount: items.filter(item => item.tier === 'consider').length,
    items,
  }
}

function eligibleCandidate(candidate: CandidateBoardItem, now: Date): RankedCandidate | undefined {
  if (candidate.recordKind !== 'captured_job' || candidate.jdStatus !== 'complete') return undefined
  if (candidate.confirmedStatus !== undefined) return undefined
  if (deadlineExpired(candidate.deadline, now)) return undefined
  const match = candidate.latestMatch
  if (match === undefined || (match.matchLevel !== 'strong' && match.matchLevel !== 'moderate')) return undefined
  const officialApplyUrl = safeVerifiedUrl(candidate.officialApplyUrl)
  const readiness = candidate.gateA?.decision === 'proceed'
    ? officialApplyUrl === undefined ? 'verified_url_pending' : 'ready_to_apply'
    : 'gate_a_pending'
  return {
    candidate,
    match: match as CandidateBoardLatestMatch & { readonly matchLevel: 'strong' | 'moderate' },
    tier: match.matchLevel === 'strong' ? 'recommended' : 'consider',
    readiness,
    ...officialApplyUrl === undefined ? {} : { officialApplyUrl },
  }
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  const quality = tierPriority(left.tier) - tierPriority(right.tier)
  if (quality !== 0) return quality
  const score = right.match.score - left.match.score
  if (score !== 0) return score
  const readiness = readinessPriority(left.readiness) - readinessPriority(right.readiness)
  if (readiness !== 0) return readiness
  const deadline = deadlineTimestamp(left.candidate.deadline) - deadlineTimestamp(right.candidate.deadline)
  if (deadline !== 0) return deadline
  const updated = right.match.createdAt.localeCompare(left.match.createdAt)
  return updated !== 0 ? updated : left.candidate.candidateId.localeCompare(right.candidate.candidateId)
}

function toRecommendation(entry: RankedCandidate, rank: number, now: Date): TodayJobRecommendation {
  const matchedHighlights = unique([
    ...entry.match.matchedSkills,
    ...entry.match.matchedCapabilities,
  ]).slice(0, 5)
  const gaps = unique([
    ...entry.match.missingSkills,
    ...entry.match.missingCapabilities,
  ]).slice(0, 5)
  return {
    rank,
    candidateId: entry.candidate.candidateId,
    company: entry.candidate.company,
    role: entry.candidate.role,
    ...entry.candidate.city === undefined ? {} : { city: entry.candidate.city },
    ...entry.candidate.deadline === undefined ? {} : { deadline: entry.candidate.deadline },
    tier: entry.tier,
    readiness: entry.readiness,
    score: entry.match.score,
    matchLevel: entry.match.matchLevel,
    matchStrategyVersion: entry.match.strategyVersion,
    matchedHighlights,
    gaps,
    whyToday: whyToday(entry, now),
    recommendationReason: recommendationReason(entry),
    ...entry.officialApplyUrl === undefined ? {} : { officialApplyUrl: entry.officialApplyUrl },
    action: actionFor(entry),
  }
}

function whyToday(entry: RankedCandidate, now: Date): string {
  if (deadlineNear(entry.candidate.deadline, now)) return `截止日期 ${entry.candidate.deadline} 临近，建议今天处理`
  if (entry.readiness === 'ready_to_apply') return '匹配与人工确认已就绪，今天可以进入官网投递'
  if (entry.readiness === 'gate_a_pending') return '已有完整 JD 和脱敏匹配，等待你决定是否进入投递准备'
  return '匹配与人工确认已就绪，但还缺已核验的官网投递入口'
}

function recommendationReason(entry: RankedCandidate): string {
  const quality = entry.tier === 'recommended' ? '高匹配' : '中匹配'
  const matched = unique([...entry.match.matchedSkills, ...entry.match.matchedCapabilities]).slice(0, 3)
  return `${entry.match.score} 分，${quality}${matched.length === 0 ? '' : `；已命中 ${matched.join('、')}`}`
}

function actionFor(entry: RankedCandidate): TodayJobRecommendation['action'] {
  if (entry.readiness === 'ready_to_apply') {
    return { mode: 'manual_open_verified_url', label: '人工打开官网/ATS', nextTool: 'boss_watch_apply_preview', requiresHuman: true, externalEffect: 'none' }
  }
  if (entry.readiness === 'gate_a_pending') {
    return { mode: 'draft_only', label: '确认值得投', nextTool: 'boss_watch_gate_a_confirm', requiresHuman: true, externalEffect: 'none' }
  }
  return { mode: 'draft_only', label: '补投递入口', nextTool: 'boss_watch_lead_list', requiresHuman: true, externalEffect: 'none' }
}

function safeVerifiedUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : undefined
  } catch {
    return undefined
  }
}

function deadlineExpired(value: string | undefined, now: Date): boolean {
  if (value === undefined) return false
  const timestamp = deadlineTimestamp(value)
  return timestamp !== Number.MAX_SAFE_INTEGER && timestamp < now.getTime()
}

function deadlineNear(value: string | undefined, now: Date): boolean {
  if (value === undefined) return false
  const timestamp = deadlineTimestamp(value)
  return Number.isFinite(timestamp) && timestamp >= now.getTime() && timestamp - now.getTime() <= 7 * 24 * 60 * 60 * 1000
}

function deadlineTimestamp(value: string | undefined): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return Number.MAX_SAFE_INTEGER
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? timestamp + 24 * 60 * 60 * 1000 - 1 : timestamp
}

function tierPriority(tier: TodayRecommendationTier): number {
  return tier === 'recommended' ? 0 : 1
}

function readinessPriority(readiness: TodayRecommendationReadiness): number {
  if (readiness === 'ready_to_apply') return 0
  if (readiness === 'gate_a_pending') return 1
  return 2
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}
