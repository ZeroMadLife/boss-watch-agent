import type { ApplicationOverview, BossWatchDataSource, TimelineEvent } from './domain.js'
import type { FeishuProjection, FeishuTargetStore } from './feishu-projection.js'
import type { JobLead, JobLeadStore, LeadSourceKind } from './job-lead.js'
import type { RecruitmentSource, RecruitmentSourceStore } from './recruitment-source.js'
import type { ResumeCapabilityLabel, ResumeMatchLevel, ResumeMatchResult, ResumeMatchStore } from './resume-matching.js'
import type { ResumeVersionStore } from './resume-version.js'
import type { GateAApproval, GateAStore } from './gate-a.js'
import type { ApplicationFollowUp, FollowUpReason, FollowUpStore } from './application-follow-up.js'

export type CandidateBoardRecordKind = 'recruitment_source' | 'source_lead' | 'captured_job'
export type CandidateBoardSourceKind = LeadSourceKind | 'boss_visible' | 'manual_recruitment_source'
export type CandidateBoardConfidence = 'source_only' | 'url_verified' | 'jd_verified' | 'human_confirmed' | 'captured_jd'
export type CandidateBoardJdStatus = 'source_summary' | 'verified_summary' | 'complete'
export type CandidateBoardNextAction = 'verify_official_jd' | 'import_resume' | 'match_resume' | 'review_match' | 'confirm_gate_a' | 'prepare_application' | 'sync_feishu' | 'review_application_progress'

export interface CandidateBoardLatestMatch {
  readonly matchId: string
  readonly score: number
  readonly matchLevel: ResumeMatchLevel
  readonly strategyVersion: string
  readonly createdAt: string
  readonly resumeVersionId: string
  readonly matchedSkills: string[]
  readonly missingSkills: string[]
  readonly matchedCapabilities: ResumeCapabilityLabel[]
  readonly missingCapabilities: ResumeCapabilityLabel[]
}

export interface CandidateBoardFeishuProjection {
  readonly targetId: string
  readonly projectedAt: string
  readonly lastResult: FeishuProjection['lastResult']
}

export interface CandidateBoardFollowUp {
  readonly followUpId: string
  readonly dueAt: string
  readonly reason: FollowUpReason
}

export type CandidateBoardTimelineEventType =
  | 'job_description_captured'
  | 'recruiter_message_captured'
  | 'interview_note_recorded'
  | 'progress_signal_recorded'
  | 'status_change_proposed'
  | 'status_change_confirmed'

export interface CandidateBoardTimelineEvent {
  readonly eventType: CandidateBoardTimelineEventType
  readonly occurredAt: string
  readonly evidenceKind: 'fact' | 'proposal' | 'confirmed'
  readonly status?: string
}

export interface CandidateBoardGateA {
  readonly gateAId: string
  readonly matchId: string
  readonly approvedAt: string
  readonly decision: GateAApproval['decision']
  readonly externalAction: GateAApproval['externalAction']
}

export interface CandidateBoardItem {
  readonly candidateId: string
  readonly recordKind: CandidateBoardRecordKind
  readonly sourceKind: CandidateBoardSourceKind
  readonly company: string
  readonly role: string
  readonly city?: string
  readonly cohort?: string
  readonly recruitmentType?: string
  readonly leadId?: string
  readonly recruitmentSourceId?: string
  readonly referralCode?: string
  readonly channelUrl?: string
  readonly jobUrl?: string
  readonly officialApplyUrl?: string
  readonly deadline?: string
  readonly sourceUpdatedAt?: string
  readonly capturedAt: string
  readonly confidence: CandidateBoardConfidence
  readonly jdStatus: CandidateBoardJdStatus
  readonly resumeReady: boolean
  readonly progressState?: ApplicationOverview['progressState']
  readonly latestEventType?: string
  readonly latestEventAt?: string
  readonly proposedStatus?: string
  readonly confirmedStatus?: string
  readonly confirmedAt?: string
  readonly timeline?: CandidateBoardTimelineEvent[]
  readonly timelineTruncated?: boolean
  readonly latestMatch?: CandidateBoardLatestMatch
  readonly gateA?: CandidateBoardGateA
  readonly feishuProjections?: CandidateBoardFeishuProjection[]
  readonly followUps?: CandidateBoardFollowUp[]
  readonly nextAction: CandidateBoardNextAction
  readonly nextTool: string
}

interface CandidateBoardOptions {
  readonly source: BossWatchDataSource
  readonly leads: Pick<JobLeadStore, 'list'>
  readonly resumes?: Pick<ResumeVersionStore, 'count'>
  readonly matches?: Pick<ResumeMatchStore, 'list'>
  readonly gateAApprovals?: Pick<GateAStore, 'getByMatchId'>
  readonly recruitmentSources?: Pick<RecruitmentSourceStore, 'list'>
  readonly projections?: Pick<FeishuTargetStore, 'countTargets' | 'listProjections'>
  readonly followUps?: Pick<FollowUpStore, 'listActive'>
}

export class LocalCandidateBoardService {
  readonly #options: CandidateBoardOptions

  constructor(options: CandidateBoardOptions) {
    this.#options = options
  }

  async list(options: { readonly limit?: number } = {}): Promise<readonly CandidateBoardItem[]> {
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_candidate_board_limit')
    const [leads, applications, recruitmentSources, followUps] = await Promise.all([
      Promise.resolve(this.#options.leads.list({ limit: 100 })),
      this.#options.source.listApplicationOverviews(Math.min(limit, 50)),
      Promise.resolve(this.#options.recruitmentSources?.list({ limit: 100 }) ?? []),
      Promise.resolve(this.#options.followUps?.listActive({ limit: 100 }) ?? []),
    ])
    const timelines = new Map(await Promise.all(applications.map(async (application) => [
      application.applicationId,
      await this.#options.source.listTimeline(application.applicationId),
    ] as const)))
    const resumeReady = (this.#options.resumes?.count() ?? 0) > 0
    const feishuTargetCount = this.#options.projections?.countTargets() ?? 0
    const leadsById = new Map(leads.map((lead) => [lead.leadId, lead]))
    const applicationIds = new Set(applications.map((application) => application.applicationId))
    const followUpsByApplication = groupFollowUps(followUps)
    const bindingsByApplication = new Map<string, Array<{ source: RecruitmentSource; lead: JobLead }>>()
    const joinedLeadIds = new Set<string>()
    const joinedSourceIds = new Set<string>()
    for (const recruitmentSource of recruitmentSources) {
      if (recruitmentSource.boundApplicationId === undefined || recruitmentSource.boundLeadId === undefined) continue
      if (!applicationIds.has(recruitmentSource.boundApplicationId)) continue
      const lead = leadsById.get(recruitmentSource.boundLeadId)
      if (lead === undefined) continue
      const bindings = bindingsByApplication.get(recruitmentSource.boundApplicationId) ?? []
      bindings.push({ source: recruitmentSource, lead })
      bindingsByApplication.set(recruitmentSource.boundApplicationId, bindings)
    }
    const bindingByApplication = new Map<string, { source: RecruitmentSource; lead: JobLead }>()
    for (const [applicationId, bindings] of bindingsByApplication) {
      if (bindings.length !== 1) continue
      const binding = bindings[0]
      if (binding === undefined) continue
      bindingByApplication.set(applicationId, binding)
      joinedLeadIds.add(binding.lead.leadId)
      joinedSourceIds.add(binding.source.sourceId)
    }
    return [
      ...applications.map((application) => {
        const match = this.#options.matches?.list({ applicationId: application.applicationId, limit: 1 })[0]
        return toCapturedJob(
          application,
          resumeReady,
          match,
          match === undefined ? undefined : this.#options.gateAApprovals?.getByMatchId(match.matchId),
          bindingByApplication.get(application.applicationId),
          this.#options.projections?.listProjections({ applicationId: application.applicationId, limit: 10 }) ?? [],
          feishuTargetCount,
          followUpsByApplication.get(application.applicationId) ?? [],
          timelines.get(application.applicationId) ?? [],
        )
      }),
      ...recruitmentSources
        .filter((recruitmentSource) => recruitmentSource.status !== 'jd_ready' && !joinedSourceIds.has(recruitmentSource.sourceId))
        .map((recruitmentSource) => toRecruitmentSourceInbox(recruitmentSource, resumeReady)),
      ...leads.filter((lead) => !joinedLeadIds.has(lead.leadId)).map((lead) => toSourceLead(lead, resumeReady)),
    ]
      .sort((left, right) => candidatePriority(left) - candidatePriority(right)
        || right.capturedAt.localeCompare(left.capturedAt)
        || left.candidateId.localeCompare(right.candidateId))
      .slice(0, limit)
  }
}

function candidatePriority(candidate: CandidateBoardItem): number {
  if ((candidate.followUps?.length ?? 0) > 0) return 0
  if (candidate.recordKind === 'captured_job') return 1
  if (candidate.recordKind === 'recruitment_source') return 2
  return 3
}

function toRecruitmentSourceInbox(source: RecruitmentSource, resumeReady: boolean): CandidateBoardItem {
  const roleSelected = source.status === 'role_selected'
  return {
    candidateId: source.sourceId,
    recordKind: 'recruitment_source',
    sourceKind: 'manual_recruitment_source',
    company: source.company,
    role: source.role ?? '',
    recruitmentSourceId: source.sourceId,
    ...source.referralCode === undefined ? {} : { referralCode: source.referralCode },
    channelUrl: source.channelUrl,
    ...source.officialJobUrl === undefined ? {} : { officialApplyUrl: source.officialJobUrl },
    capturedAt: source.capturedAt,
    confidence: roleSelected ? 'url_verified' : 'source_only',
    jdStatus: roleSelected ? 'verified_summary' : 'source_summary',
    resumeReady,
    nextAction: 'verify_official_jd',
    nextTool: roleSelected ? 'boss_watch_recruitment_jd_preview' : 'boss_watch_recruitment_source_get',
  }
}

function toCapturedJob(
  job: ApplicationOverview,
  resumeReady: boolean,
  match?: ResumeMatchResult,
  gateA?: GateAApproval,
  binding?: { source: RecruitmentSource; lead: JobLead },
  projections: readonly FeishuProjection[] = [],
  feishuTargetCount = 0,
  followUps: readonly ApplicationFollowUp[] = [],
  timelineEvents: readonly TimelineEvent[] = [],
): CandidateBoardItem {
  const hasProgress = job.progressState !== 'new'
    || job.latestEventType !== 'job_description_captured'
  const hasOfficialApplication = binding !== undefined
    && (binding.lead.officialApplyUrl !== undefined || binding.source.officialJobUrl !== undefined)
  const shouldSyncFeishu = job.confirmedStatus !== undefined
    && feishuTargetCount > 0
    && (projections.length < feishuTargetCount || projections.some((projection) => projection.projectedAt < job.latestEventAt))
  const nextAction = shouldSyncFeishu
    ? 'sync_feishu'
    : hasProgress
    ? 'review_application_progress'
    : match === undefined ? (resumeReady ? 'match_resume' : 'import_resume')
    : gateA === undefined ? 'confirm_gate_a'
    : hasOfficialApplication ? 'prepare_application' : 'review_match'
  const timeline = summarizeTimeline(timelineEvents)
  return {
    candidateId: job.applicationId,
    recordKind: 'captured_job',
    sourceKind: binding?.lead.sourceKind ?? 'boss_visible',
    company: job.company,
    role: job.role,
    ...binding === undefined ? {} : {
      leadId: binding.lead.leadId,
      recruitmentSourceId: binding.source.sourceId,
      channelUrl: binding.source.channelUrl,
      officialApplyUrl: binding.lead.officialApplyUrl ?? binding.source.officialJobUrl,
      ...binding.lead.city === undefined ? {} : { city: binding.lead.city },
      ...binding.lead.cohort === undefined ? {} : { cohort: binding.lead.cohort },
      ...binding.lead.recruitmentType === undefined ? {} : { recruitmentType: binding.lead.recruitmentType },
      ...binding.lead.deadline === undefined ? {} : { deadline: binding.lead.deadline },
      ...binding.lead.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: binding.lead.sourceUpdatedAt },
      ...binding.source.referralCode === undefined ? {} : { referralCode: binding.source.referralCode },
    },
    ...job.jobUrl === undefined ? {} : { jobUrl: job.jobUrl },
    capturedAt: job.capturedAt,
    confidence: 'captured_jd',
    jdStatus: 'complete',
    resumeReady,
    progressState: job.progressState,
    ...hasProgress ? {
      latestEventType: job.latestEventType,
      latestEventAt: job.latestEventAt,
      ...job.proposedStatus === undefined ? {} : { proposedStatus: job.proposedStatus },
      ...job.confirmedStatus === undefined ? {} : { confirmedStatus: job.confirmedStatus },
      ...job.confirmedAt === undefined ? {} : { confirmedAt: job.confirmedAt },
    } : {},
    timeline: timeline.events,
    timelineTruncated: timeline.truncated,
    ...match === undefined ? {} : { latestMatch: toLatestMatch(match) },
    ...gateA === undefined ? {} : { gateA: toGateA(gateA) },
    ...projections.length === 0 ? {} : { feishuProjections: projections.map(toFeishuProjection) },
    ...followUps.length === 0 ? {} : { followUps: followUps.map(toFollowUp) },
    nextAction,
    nextTool: nextAction === 'sync_feishu'
      ? 'boss_watch_feishu_sync_preview'
      : nextAction === 'review_application_progress'
      ? 'boss_watch_application_overview'
      : nextAction === 'confirm_gate_a' ? 'boss_watch_gate_a_confirm'
      : nextAction === 'prepare_application' ? 'boss_watch_apply_preview'
      : nextAction === 'review_match' ? 'boss_watch_resume_match_list'
      : nextAction === 'match_resume' ? 'boss_watch_resume_match' : 'boss_watch_resume_import_preview',
  }
}

const TIMELINE_LIMIT = 20
const TIMELINE_FACT_TYPES = new Set<CandidateBoardTimelineEventType>([
  'job_description_captured',
  'recruiter_message_captured',
  'interview_note_recorded',
  'progress_signal_recorded',
])
const CONFIRMED_TIMELINE_STATUSES = new Set([
  'submitted',
  'assessment_scheduled',
  'assessment_completed',
  'interview_scheduled',
  'rejected',
  'offer',
  'closed',
])
const PROPOSED_TIMELINE_STATUSES = new Set([
  'discovered',
  'scored',
  'gate_a_approved',
  'material_prepared',
  'awaiting_gate_b',
  'submitted',
  'assessment_scheduled',
  'assessment_completed',
  'recruiter_replied',
  'interview_scheduled',
  'rejected',
  'offer',
  'no_response',
  'closed',
])

function summarizeTimeline(events: readonly TimelineEvent[]): {
  readonly events: CandidateBoardTimelineEvent[]
  readonly truncated: boolean
} {
  const summaries: CandidateBoardTimelineEvent[] = []
  for (const event of events) {
    if (!Number.isFinite(Date.parse(event.occurredAt))) continue
    if (TIMELINE_FACT_TYPES.has(event.type as CandidateBoardTimelineEventType)) {
      summaries.push({
        eventType: event.type as CandidateBoardTimelineEventType,
        occurredAt: event.occurredAt,
        evidenceKind: 'fact',
      })
      continue
    }
    if (event.type === 'status_change_proposed') {
      const status = timelineStatus(event)
      if (status === undefined || !PROPOSED_TIMELINE_STATUSES.has(status)) continue
      summaries.push({
        eventType: event.type,
        occurredAt: event.occurredAt,
        evidenceKind: 'proposal',
        status,
      })
      continue
    }
    if (event.type === 'status_change_confirmed') {
      if (event.actor !== 'human' || !isRecord(event.payload) || event.payload.source !== 'user_manual_confirmation') continue
      const status = timelineStatus(event)
      if (status === undefined || !CONFIRMED_TIMELINE_STATUSES.has(status)) continue
      summaries.push({ eventType: event.type, occurredAt: event.occurredAt, evidenceKind: 'confirmed', status })
    }
  }
  return { events: summaries.slice(-TIMELINE_LIMIT), truncated: summaries.length > TIMELINE_LIMIT }
}

function timelineStatus(event: TimelineEvent): string | undefined {
  if (!isRecord(event.payload) || typeof event.payload.to !== 'string') return undefined
  const status = event.payload.to.trim()
  return status.length > 0 && status.length <= 64 ? status : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function groupFollowUps(followUps: readonly ApplicationFollowUp[]): Map<string, ApplicationFollowUp[]> {
  const grouped = new Map<string, ApplicationFollowUp[]>()
  for (const followUp of followUps) {
    const applicationFollowUps = grouped.get(followUp.applicationId) ?? []
    applicationFollowUps.push(followUp)
    grouped.set(followUp.applicationId, applicationFollowUps)
  }
  return grouped
}

function toFollowUp(followUp: ApplicationFollowUp): CandidateBoardFollowUp {
  return {
    followUpId: followUp.followUpId,
    dueAt: followUp.dueAt,
    reason: followUp.reason,
  }
}

function toGateA(approval: GateAApproval): CandidateBoardGateA {
  return {
    gateAId: approval.gateAId,
    matchId: approval.matchId,
    approvedAt: approval.approvedAt,
    decision: approval.decision,
    externalAction: approval.externalAction,
  }
}

function toFeishuProjection(projection: FeishuProjection): CandidateBoardFeishuProjection {
  return {
    targetId: projection.targetId,
    projectedAt: projection.projectedAt,
    lastResult: projection.lastResult,
  }
}

function toLatestMatch(match: ResumeMatchResult): CandidateBoardLatestMatch {
  return {
    matchId: match.matchId,
    score: match.score,
    matchLevel: match.matchLevel,
    strategyVersion: match.strategyVersion,
    createdAt: match.createdAt,
    resumeVersionId: match.resume.resumeVersionId,
    matchedSkills: [...(match.skills.matchedTechnologies ?? match.skills.matched)],
    missingSkills: [...(match.skills.missingTechnologies ?? match.skills.missing)],
    matchedCapabilities: [...(match.skills.matchedCapabilities ?? [])],
    missingCapabilities: [...(match.skills.missingCapabilities ?? [])],
  }
}

function toSourceLead(lead: JobLead, resumeReady: boolean): CandidateBoardItem {
  const verified = lead.confidence === 'human_confirmed' || lead.confidence === 'jd_verified'
  const nextAction = !verified ? 'verify_official_jd' : resumeReady ? 'prepare_application' : 'import_resume'
  return {
    candidateId: lead.leadId,
    recordKind: 'source_lead',
    sourceKind: lead.sourceKind,
    company: lead.company,
    role: lead.role,
    ...lead.city === undefined ? {} : { city: lead.city },
    ...lead.cohort === undefined ? {} : { cohort: lead.cohort },
    ...lead.recruitmentType === undefined ? {} : { recruitmentType: lead.recruitmentType },
    ...lead.channelUrl === undefined ? {} : { channelUrl: lead.channelUrl },
    ...lead.officialApplyUrl === undefined ? {} : { officialApplyUrl: lead.officialApplyUrl },
    ...lead.deadline === undefined ? {} : { deadline: lead.deadline },
    ...lead.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: lead.sourceUpdatedAt },
    capturedAt: lead.fetchedAt,
    confidence: lead.confidence,
    jdStatus: verified ? 'verified_summary' : 'source_summary',
    resumeReady,
    nextAction,
    nextTool: nextAction === 'verify_official_jd'
      ? 'boss_watch_lead_list'
      : nextAction === 'prepare_application' ? 'boss_watch_apply_preview' : 'boss_watch_resume_import_preview',
  }
}
