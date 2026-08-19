import type { BossWatchDataSource, JobSummary } from './domain.js'
import type { JobLead, JobLeadStore, LeadSourceKind } from './job-lead.js'

export type CandidateBoardRecordKind = 'source_lead' | 'captured_job'
export type CandidateBoardConfidence = 'source_only' | 'url_verified' | 'jd_verified' | 'human_confirmed' | 'captured_jd'
export type CandidateBoardJdStatus = 'source_summary' | 'complete'
export type CandidateBoardNextAction = 'verify_official_jd' | 'match_resume' | 'prepare_application'

export interface CandidateBoardItem {
  readonly candidateId: string
  readonly recordKind: CandidateBoardRecordKind
  readonly sourceKind: LeadSourceKind | 'boss_visible'
  readonly company: string
  readonly role: string
  readonly city?: string
  readonly cohort?: string
  readonly recruitmentType?: string
  readonly channelUrl?: string
  readonly jobUrl?: string
  readonly capturedAt: string
  readonly confidence: CandidateBoardConfidence
  readonly jdStatus: CandidateBoardJdStatus
  readonly nextAction: CandidateBoardNextAction
}

interface CandidateBoardOptions {
  readonly source: BossWatchDataSource
  readonly leads: Pick<JobLeadStore, 'list'>
}

export class LocalCandidateBoardService {
  readonly #options: CandidateBoardOptions

  constructor(options: CandidateBoardOptions) {
    this.#options = options
  }

  async list(options: { readonly limit?: number } = {}): Promise<readonly CandidateBoardItem[]> {
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_candidate_board_limit')
    const [leads, jobs] = await Promise.all([
      Promise.resolve(this.#options.leads.list({ limit })),
      this.#options.source.listJobs(limit),
    ])
    return [...jobs.map(toCapturedJob), ...leads.map(toSourceLead)]
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || left.candidateId.localeCompare(right.candidateId))
      .slice(0, limit)
  }
}

function toCapturedJob(job: JobSummary): CandidateBoardItem {
  return {
    candidateId: job.applicationId,
    recordKind: 'captured_job',
    sourceKind: 'boss_visible',
    company: job.company,
    role: job.role,
    ...job.jobUrl === undefined ? {} : { jobUrl: job.jobUrl },
    capturedAt: job.capturedAt,
    confidence: 'captured_jd',
    jdStatus: 'complete',
    nextAction: 'match_resume',
  }
}

function toSourceLead(lead: JobLead): CandidateBoardItem {
  const nextAction = lead.confidence === 'human_confirmed' || lead.confidence === 'jd_verified'
    ? 'prepare_application'
    : 'verify_official_jd'
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
    capturedAt: lead.fetchedAt,
    confidence: lead.confidence,
    jdStatus: 'source_summary',
    nextAction,
  }
}
