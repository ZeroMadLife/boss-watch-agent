import type { CandidateBoardItem, CandidateBoardLatestMatch } from './candidate-board.js'

export type DashboardView = 'jobs'
export type DashboardSort = 'updated' | 'deadline' | 'match'
export type DashboardMatchFilter = 'all' | CandidateBoardLatestMatch['matchLevel'] | 'pending'
export type CompanyCategory = 'state_owned' | 'private_tech' | 'other' | 'unclassified'
export type CompanyCategoryFilter = 'all' | 'state_owned' | 'private_tech' | 'other_or_unclassified'
export type RoleDirection = 'agent' | 'backend' | 'ai_fullstack' | 'other' | 'unclassified'
export type RoleDirectionFilter = 'all' | 'agent' | 'backend' | 'ai_fullstack' | 'other_or_unclassified'
export type WorthApplying = 'recommended' | 'review' | 'not_recommended' | 'pending'

export const JOB_BOARD_RULESET_VERSION = 'personal-job-board-v1' as const

export interface DashboardQueryState {
  readonly view: DashboardView
  readonly query: string
  readonly match: DashboardMatchFilter
  readonly companyCategory: CompanyCategoryFilter
  readonly roleDirection: RoleDirectionFilter
  readonly sort: DashboardSort
  readonly page: number
  readonly selected?: string
  readonly embedded: boolean
}

export interface JobDisplayProfile {
  readonly companyCategory: CompanyCategory
  readonly roleDirection: RoleDirection
  readonly worthApplying: WorthApplying
  readonly reason: string
  readonly ruleVersion: typeof JOB_BOARD_RULESET_VERSION
}

export interface JobBoardFilters {
  readonly query: string
  readonly match: DashboardMatchFilter
  readonly companyCategory: CompanyCategoryFilter
  readonly roleDirection: RoleDirectionFilter
}

export interface BatchSelectionAvailability {
  readonly selectable: boolean
  readonly reason: string
}

export type DashboardTaskSignal =
  | 'deadline_near'
  | 'source_binding'
  | 'jd_verification'
  | 'match'
  | 'gate_a'
  | 'manual_application'
  | 'status_confirmation'
  | 'feishu_sync'
  | 'follow_up'

export interface DashboardTask {
  readonly taskId: string
  readonly candidateId: string
  readonly company: string
  readonly role: string
  readonly signals: readonly DashboardTaskSignal[]
  readonly priority: number
  readonly whyNow: string
  readonly evidence: readonly string[]
  readonly missing: readonly string[]
  readonly nextStep: string
  readonly actionMode: 'draft_only' | 'verified_url'
  readonly verifiedUrl?: string
}

export interface SourceInboxItem {
  readonly candidate: CandidateBoardItem
  readonly gaps: readonly string[]
}

export type TimelineEvidenceKind = 'fact' | 'recommendation' | 'confirmation_pending' | 'confirmed'

export interface CandidateTimelineEntry {
  readonly stage: 'source' | 'jd' | 'application_event' | 'match' | 'gate_a' | 'status_proposal' | 'confirmed_status' | 'feishu'
  readonly kind: TimelineEvidenceKind
  readonly label: string
  readonly at?: string
}

export interface PrivacyBoundedMatchEvidence {
  readonly score: number
  readonly matchLevel: CandidateBoardLatestMatch['matchLevel']
  readonly strategyVersion: string
  readonly resumeVersionId: string
  readonly matchedSkills: readonly string[]
  readonly missingSkills: readonly string[]
  readonly matchedCapabilities: CandidateBoardLatestMatch['matchedCapabilities']
  readonly missingCapabilities: CandidateBoardLatestMatch['missingCapabilities']
}

/** Parse persistent workbench state while closing over unknown query values. */
export function parseDashboardQuery(search: string): DashboardQueryState {
  const params = new URLSearchParams(search)
  const view = 'jobs'
  const match = isOneOf(params.get('match'), ['all', 'strong', 'moderate', 'weak', 'insufficient_evidence', 'pending'] as const) ?? 'all'
  const companyCategory = isOneOf(params.get('company'), ['all', 'state_owned', 'private_tech', 'other_or_unclassified'] as const) ?? 'all'
  const roleDirection = isOneOf(params.get('direction'), ['all', 'agent', 'backend', 'ai_fullstack', 'other_or_unclassified'] as const) ?? 'all'
  const sort = isOneOf(params.get('sort'), ['updated', 'deadline', 'match'] as const) ?? 'match'
  const rawPage = Number(params.get('page'))
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= 999 ? rawPage : 1
  const rawQuery = params.get('q') ?? ''
  const query = rawQuery.length <= 120 ? rawQuery : rawQuery.slice(0, 120)
  const rawSelected = params.get('selected')
  const selected = rawSelected !== null && rawSelected.trim().length > 0 && rawSelected.length <= 240
    ? rawSelected
    : undefined
  return {
    view,
    query,
    match,
    companyCategory,
    roleDirection,
    sort,
    page,
    ...selected === undefined ? {} : { selected },
    embedded: params.get('embedded') === '1',
  }
}

/** Serialize in a stable order so refresh and browser history are deterministic. */
export function serializeDashboardQuery(state: DashboardQueryState): string {
  const params = new URLSearchParams()
  params.set('view', state.view)
  if (state.query !== '') params.set('q', state.query)
  if (state.match !== 'all') params.set('match', state.match)
  if (state.companyCategory !== 'all') params.set('company', state.companyCategory)
  if (state.roleDirection !== 'all') params.set('direction', state.roleDirection)
  if (state.sort !== 'match') params.set('sort', state.sort)
  if (state.page !== 1) params.set('page', String(state.page))
  if (state.selected !== undefined) params.set('selected', state.selected)
  if (state.embedded) params.set('embedded', '1')
  return `?${params.toString()}`
}

/** Derive scan labels from explicit fields and conservative versioned local rules. */
export function deriveJobDisplayProfile(candidate: CandidateBoardItem): JobDisplayProfile {
  const companyCategory = classifyCompany(candidate.company)
  const roleDirection = classifyRoleDirection(candidate)
  const worth = classifyWorthApplying(candidate)
  return {
    companyCategory,
    roleDirection,
    worthApplying: worth.value,
    reason: worth.reason,
    ruleVersion: JOB_BOARD_RULESET_VERSION,
  }
}

/** Filter the complete snapshot, including company leads that do not yet have a selected role. */
export function filterJobBoard(
  candidates: readonly CandidateBoardItem[],
  filters: JobBoardFilters,
): CandidateBoardItem[] {
  const query = filters.query.trim().toLowerCase()
  return candidates.filter((candidate) => {
    const profile = deriveJobDisplayProfile(candidate)
    const haystack = [candidate.company, candidate.role, candidate.city, candidate.cohort, candidate.recruitmentType]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase()
    const matchLevel = candidate.latestMatch?.matchLevel
    const matchesMatch = filters.match === 'all'
      || (filters.match === 'pending'
        ? matchLevel === undefined || matchLevel === 'insufficient_evidence'
        : matchLevel === filters.match)
    const matchesCompany = filters.companyCategory === 'all'
      || (filters.companyCategory === 'other_or_unclassified'
        ? profile.companyCategory === 'other' || profile.companyCategory === 'unclassified'
        : profile.companyCategory === filters.companyCategory)
    const matchesDirection = filters.roleDirection === 'all'
      || (filters.roleDirection === 'other_or_unclassified'
        ? profile.roleDirection === 'other' || profile.roleDirection === 'unclassified'
        : profile.roleDirection === filters.roleDirection)
    return (query === '' || haystack.includes(query)) && matchesMatch && matchesCompany && matchesDirection
  })
}

/** Keep "add to pending applications" bounded to jobs that are ready for a local preparation draft. */
export function batchSelectionAvailability(candidate: CandidateBoardItem): BatchSelectionAvailability {
  if (candidate.jdStatus !== 'complete') return { selectable: false, reason: '缺完整 JD' }
  if (candidate.latestMatch === undefined || candidate.latestMatch.matchLevel === 'insufficient_evidence') {
    return { selectable: false, reason: '待完成匹配' }
  }
  if (candidate.gateA === undefined || candidate.gateA.decision !== 'proceed') {
    return { selectable: false, reason: '待确认值得投' }
  }
  if (candidate.nextAction !== 'prepare_application') {
    return { selectable: false, reason: candidate.confirmedStatus === undefined ? '当前进度不可加入' : '已有投递进度' }
  }
  if (safeVerifiedUrl(candidate.officialApplyUrl) === undefined) return { selectable: false, reason: '缺投递入口' }
  return { selectable: true, reason: '可以加入待投递' }
}

/** Build a scan-friendly action queue from fields already present in the dashboard contract. */
export function deriveTodayTasks(candidates: readonly CandidateBoardItem[], now = new Date()): DashboardTask[] {
  return candidates
    .map(candidate => deriveCandidateTask(candidate, now))
    .filter((task): task is DashboardTask => task !== undefined)
    .sort((left, right) => left.priority - right.priority || left.candidateId.localeCompare(right.candidateId))
}

/** Keep source-only records out of the ordinary job pool without inventing binding state. */
export function classifySourceInbox(candidates: readonly CandidateBoardItem[]): SourceInboxItem[] {
  return candidates
    .filter(candidate => candidate.recordKind === 'recruitment_source'
      || (candidate.recordKind === 'source_lead' && candidate.confidence === 'source_only'))
    .map(candidate => ({
      candidate,
      gaps: [
        ...candidate.role.trim().length === 0 ? ['缺确切岗位'] : [],
        ...candidate.officialApplyUrl === undefined ? ['缺确切岗位 URL'] : [],
        ...candidate.jdStatus === 'complete' ? [] : ['缺完整 JD'],
        '待人工核验',
      ],
    }))
}

/** Produce a white-listed match summary; extra object fields are intentionally ignored. */
export function summarizeMatchEvidence(match: CandidateBoardLatestMatch): PrivacyBoundedMatchEvidence {
  return {
    score: match.score,
    matchLevel: match.matchLevel,
    strategyVersion: match.strategyVersion,
    resumeVersionId: match.resumeVersionId,
    matchedSkills: [...match.matchedSkills],
    missingSkills: [...match.missingSkills],
    matchedCapabilities: [...match.matchedCapabilities],
    missingCapabilities: [...match.missingCapabilities],
  }
}

/** Timeline entries retain their evidence class so proposals cannot look confirmed. */
export function timelineForCandidate(candidate: CandidateBoardItem): CandidateTimelineEntry[] {
  const applicationEvents = (candidate.timeline ?? [])
    .filter(event => event.eventType !== 'job_description_captured')
    .map((event): CandidateTimelineEntry => ({
      stage: event.eventType === 'status_change_proposed'
        ? 'status_proposal'
        : event.eventType === 'status_change_confirmed' ? 'confirmed_status' : 'application_event',
      kind: event.evidenceKind === 'proposal'
        ? 'confirmation_pending'
        : event.evidenceKind === 'confirmed' ? 'confirmed' : 'fact',
      label: event.status === undefined ? event.eventType : `${event.eventType}: ${event.status}`,
      at: event.occurredAt,
    }))
  const hasProposalEvent = applicationEvents.some(entry => entry.stage === 'status_proposal')
  const hasConfirmedEvent = applicationEvents.some(entry => entry.stage === 'confirmed_status')
  return [
    {
      stage: 'source',
      kind: 'fact',
      label: candidate.confidence === 'source_only' ? '已记录来源摘要' : '已记录来源事实',
      at: candidate.sourceUpdatedAt ?? candidate.capturedAt,
    },
    candidate.jdStatus === 'complete'
      ? { stage: 'jd', kind: 'fact', label: '完整 JD 已进入本地事实账本', at: candidate.capturedAt }
      : { stage: 'jd', kind: 'recommendation', label: '建议补全并人工核验完整 JD' },
    ...applicationEvents,
    ...candidate.latestMatch === undefined ? [] : [{
      stage: 'match' as const,
      kind: 'recommendation' as const,
      label: `${candidate.latestMatch.score} 分 · ${candidate.latestMatch.strategyVersion}`,
      at: candidate.latestMatch.createdAt,
    }],
    ...candidate.gateA === undefined ? [] : [{
      stage: 'gate_a' as const,
      kind: 'confirmed' as const,
      label: 'Gate A 已由用户确认；不授权外部动作',
      at: candidate.gateA.approvedAt,
    }],
    ...candidate.proposedStatus === undefined || hasProposalEvent ? [] : [{
      stage: 'status_proposal' as const,
      kind: 'confirmation_pending' as const,
      label: `Agent 建议：${candidate.proposedStatus}，待人工确认`,
      ...candidate.latestEventAt === undefined ? {} : { at: candidate.latestEventAt },
    }],
    ...candidate.confirmedStatus === undefined || hasConfirmedEvent ? [] : [{
      stage: 'confirmed_status' as const,
      kind: 'confirmed' as const,
      label: `人工确认事实：${candidate.confirmedStatus}`,
      ...candidate.confirmedAt === undefined ? {} : { at: candidate.confirmedAt },
    }],
    ...(candidate.feishuProjections ?? []).map(projection => ({
      stage: 'feishu' as const,
      kind: 'fact' as const,
      label: `Feishu projection：${projection.lastResult}`,
      at: projection.projectedAt,
    })),
  ]
}

/** Exclude source-only leads from the evidence-backed job pool. */
export function jobPoolCandidates(candidates: readonly CandidateBoardItem[]): CandidateBoardItem[] {
  return candidates.filter(candidate => candidate.recordKind !== 'recruitment_source' && candidate.confidence !== 'source_only')
}

/** Include only applications with observed progress, proposal, confirmation, or projection facts. */
export function trackingCandidates(candidates: readonly CandidateBoardItem[]): CandidateBoardItem[] {
  return candidates.filter(candidate => candidate.recordKind === 'captured_job' && (
    (candidate.progressState !== undefined && candidate.progressState !== 'new')
    || candidate.proposedStatus !== undefined
    || candidate.confirmedStatus !== undefined
    || (candidate.feishuProjections?.length ?? 0) > 0
    || (candidate.followUps?.length ?? 0) > 0
  ))
}

function deriveCandidateTask(candidate: CandidateBoardItem, now: Date): DashboardTask | undefined {
  const workflowSignal = taskSignal(candidate)
  const followUp = dueFollowUp(candidate, now)
  if (workflowSignal === undefined && followUp === undefined) return undefined
  const primarySignal = followUp === undefined ? workflowSignal : 'follow_up'
  if (primarySignal === undefined) return undefined
  const deadlineSignal = deadlineNear(candidate.deadline, now) ? 'deadline_near' as const : undefined
  const signals = [
    ...deadlineSignal === undefined ? [] : [deadlineSignal],
    ...workflowSignal === undefined || workflowSignal === primarySignal ? [] : [workflowSignal],
    primarySignal,
  ]
  const verifiedUrl = primarySignal === 'manual_application' ? safeVerifiedUrl(candidate.officialApplyUrl) : undefined
  return {
    taskId: `task:${candidate.candidateId}:${primarySignal}`,
    candidateId: candidate.candidateId,
    company: candidate.company,
    role: candidate.role,
    signals,
    priority: taskPriority(signals),
    whyNow: whyNow(candidate, signals, followUp?.dueAt),
    evidence: candidateEvidence(candidate),
    missing: candidateMissing(candidate, primarySignal),
    nextStep: nextStep(primarySignal),
    actionMode: verifiedUrl === undefined ? 'draft_only' : 'verified_url',
    ...verifiedUrl === undefined ? {} : { verifiedUrl },
  }
}

function dueFollowUp(candidate: CandidateBoardItem, now: Date): NonNullable<CandidateBoardItem['followUps']>[number] | undefined {
  const cutoff = now.getTime() + 24 * 60 * 60 * 1000
  return candidate.followUps
    ?.filter((followUp) => {
      const dueAt = Date.parse(followUp.dueAt)
      return Number.isFinite(dueAt) && dueAt <= cutoff
    })
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.followUpId.localeCompare(right.followUpId))[0]
}

function taskSignal(candidate: CandidateBoardItem): Exclude<DashboardTaskSignal, 'deadline_near'> | undefined {
  if (candidate.nextAction === 'verify_official_jd') {
    return candidate.officialApplyUrl === undefined ? 'source_binding' : 'jd_verification'
  }
  if (candidate.nextAction === 'import_resume' || candidate.nextAction === 'match_resume') return 'match'
  if (candidate.nextAction === 'confirm_gate_a') return 'gate_a'
  if (candidate.nextAction === 'prepare_application') return 'manual_application'
  if (candidate.nextAction === 'sync_feishu') return 'feishu_sync'
  if (candidate.proposedStatus !== undefined && candidate.confirmedStatus === undefined) return 'status_confirmation'
  return undefined
}

function deadlineNear(value: string | undefined, now: Date): boolean {
  if (value === undefined) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp - now.getTime() <= 7 * 24 * 60 * 60 * 1000
}

function taskPriority(signals: readonly DashboardTaskSignal[]): number {
  if (signals.includes('deadline_near')) return 0
  const primary = signals[signals.length - 1]
  return {
    status_confirmation: 1,
    follow_up: 1,
    feishu_sync: 2,
    manual_application: 3,
    gate_a: 4,
    match: 5,
    jd_verification: 6,
    source_binding: 7,
    deadline_near: 0,
  }[primary ?? 'source_binding']
}

function whyNow(candidate: CandidateBoardItem, signals: readonly DashboardTaskSignal[], followUpDueAt?: string): string {
  if (signals.includes('deadline_near')) return `已记录截止时间 ${candidate.deadline}，需优先人工核对是否仍开放`
  const signal = signals[signals.length - 1]
  return {
    source_binding: '当前只有来源摘要，尚未绑定确切岗位和可核验 URL',
    jd_verification: '已有岗位 URL，但完整 JD 尚未进入本地事实账本',
    match: candidate.resumeReady ? '完整 JD 与本地简历已就绪，尚无最新脱敏匹配' : '完整 JD 已就绪，本地还没有可选择的简历版本',
    gate_a: '已有脱敏匹配结果，等待用户决定是否进入材料准备',
    manual_application: 'Gate A 已完成且存在已核验官网入口，下一步仍需用户在官网处理',
    status_confirmation: '存在 Agent 状态建议，但尚未成为人工确认事实',
    feishu_sync: '本地已有人工确认状态，Feishu projection 缺失或落后',
    follow_up: `本地跟进提醒将于 ${followUpDueAt ?? '已记录时间'} 到期或已经到期`,
    deadline_near: '截止时间临近',
  }[signal ?? 'source_binding']
}

function candidateEvidence(candidate: CandidateBoardItem): string[] {
  return [
    `来源：${candidate.sourceKind}`,
    `JD：${candidate.jdStatus}`,
    ...candidate.latestMatch === undefined ? [] : [`匹配：${candidate.latestMatch.score} 分 / ${candidate.latestMatch.strategyVersion}`],
    ...candidate.gateA === undefined ? [] : [`Gate A：${candidate.gateA.approvedAt}`],
    ...candidate.confirmedStatus === undefined ? [] : [`人工确认状态：${candidate.confirmedStatus}`],
    ...(candidate.followUps ?? []).slice(0, 1).map(followUp => `本地跟进：${followUp.reason} / ${followUp.dueAt}`),
  ]
}

function candidateMissing(candidate: CandidateBoardItem, signal: DashboardTaskSignal): string[] {
  const bySignal: Record<DashboardTaskSignal, string> = {
    deadline_near: '人工核对截止状态',
    source_binding: candidate.officialApplyUrl === undefined ? '确切岗位 URL 与完整 JD' : '完整 JD',
    jd_verification: '完整 JD 与人工核验',
    match: candidate.resumeReady ? '最新脱敏匹配结果' : '本地简历版本',
    gate_a: '用户 Gate A 决定',
    manual_application: '用户登录、验证码、风控处理与最终提交',
    status_confirmation: '用户对精确 application、状态和时间的确认',
    feishu_sync: 'Feishu 字段差异预览与单独写入确认',
    follow_up: '用户核对最新进展并决定完成或重排提醒',
  }
  return [bySignal[signal]]
}

function nextStep(signal: DashboardTaskSignal): string {
  return {
    deadline_near: '先核对岗位是否仍开放，再处理当前工作流步骤',
    source_binding: '生成 DSH 草稿，选择确切岗位并补充完整 JD',
    jd_verification: '生成 DSH 草稿，核验 URL 并补充完整 JD',
    match: '生成 DSH 草稿，选择本地简历并运行脱敏匹配',
    gate_a: '生成 DSH 草稿，审查匹配证据并确认 Gate A',
    manual_application: '人工打开官网/ATS；最终提交由用户处理',
    status_confirmation: '生成 DSH 草稿，预览并人工确认状态事实',
    feishu_sync: '生成 Feishu 同步预览草稿；写入仍需单独确认',
    follow_up: '生成 DSH 草稿，读取最新进展和跟进收件箱；完成提醒仍需明确操作',
  }[signal]
}

function safeVerifiedUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

const STATE_OWNED_COMPANY_ALIASES = [
  '国家电网', '中国移动', '中国电信', '中国联通', '中国邮政', '中国航天科技', '中国电子科技', '中国石油', '中国石化',
] as const

const PRIVATE_TECH_COMPANY_ALIASES = [
  '字节跳动', '腾讯', '阿里巴巴', '美团', '百度', '京东', '小米', '快手', '哔哩哔哩', '小红书', '滴滴', '华为',
] as const

function classifyCompany(company: string): CompanyCategory {
  const normalized = company.trim().toLowerCase()
  if (normalized === '') return 'unclassified'
  if (containsAny(normalized, ['央企', '国企', '国有', ...STATE_OWNED_COMPANY_ALIASES])) return 'state_owned'
  if (containsAny(normalized, ['私企', '民营', ...PRIVATE_TECH_COMPANY_ALIASES])) return 'private_tech'
  if (containsAny(normalized, ['大学', '研究所', '事业单位', '社会组织'])) return 'other'
  return 'unclassified'
}

function classifyRoleDirection(candidate: CandidateBoardItem): RoleDirection {
  const role = candidate.role.trim().toLowerCase()
  const isAi = containsAny(role, ['ai', '人工智能', '大模型', 'llm'])
  const isAiFullstack = isAi && containsAny(role, ['全栈', 'full stack', 'full-stack', 'fullstack'])
  const directions = new Set<RoleDirection>()
  if (isAiFullstack) directions.add('ai_fullstack')
  if (!isAiFullstack && containsAny(role, ['agent', '智能体', '大模型应用', 'llm 应用', 'llm应用', 'ai 应用', 'ai应用'])) directions.add('agent')
  if (containsAny(role, ['后端', '服务端', 'java', 'golang', 'go 开发', 'go开发', 'python 后端', 'python后端', 'node.js'])) directions.add('backend')
  if (containsAny(role, ['前端', '测试', '算法', '产品', '运营', '设计', '数据分析'])) directions.add('other')

  const capabilities = new Set(candidate.latestMatch?.matchedCapabilities ?? [])
  if (capabilities.has('AI Application') && capabilities.has('Full-stack Delivery')) directions.add('ai_fullstack')
  else if (capabilities.has('AI Application')) directions.add('agent')
  if (capabilities.has('Backend Engineering')) directions.add('backend')
  return directions.size === 1 ? [...directions][0] ?? 'unclassified' : 'unclassified'
}

function classifyWorthApplying(candidate: CandidateBoardItem): { value: WorthApplying, reason: string } {
  if (candidate.jdStatus !== 'complete') return { value: 'pending', reason: '职位描述待补全，暂不能判断' }
  const match = candidate.latestMatch
  if (match === undefined || match.matchLevel === 'insufficient_evidence') {
    return { value: 'pending', reason: '匹配证据不足，暂不能判断' }
  }
  if (match.matchLevel === 'strong') return { value: 'recommended', reason: `${match.score} 分，匹配度高，可以优先考虑` }
  if (match.matchLevel === 'moderate') return { value: 'review', reason: `${match.score} 分，匹配度中等，先查看缺口` }
  return { value: 'not_recommended', reason: `${match.score} 分，匹配度较低，暂不优先` }
}

function containsAny(value: string, keywords: readonly string[]): boolean {
  return keywords.some(keyword => value.includes(keyword.toLowerCase()))
}

function isOneOf<const Values extends readonly string[]>(value: string | null, values: Values): Values[number] | undefined {
  return value !== null && values.includes(value) ? value as Values[number] : undefined
}
