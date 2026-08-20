import type { CandidateBoardItem } from './candidate-board.js'
import type { WorkspaceOverview } from './workspace-overview.js'

export type DashboardResumeParseStatus = 'parsed_for_matching' | 'not_yet_parsed_for_matching'

/** Resume metadata safe to show in the workbench. Names, paths, hashes and text stay private. */
export interface DashboardResumeVersionSummary {
  readonly resumeVersionId: string
  readonly current: boolean
  readonly mediaType: string
  readonly byteSize: number
  readonly createdAt: string
  readonly parseStatus: DashboardResumeParseStatus
  readonly matchedJobCount: number
  readonly matchedJobCountLimited: boolean
}

export interface DashboardCandidateProfileSummary {
  readonly configured: boolean
  readonly availableFieldCount: number
  readonly totalFieldCount: number
  readonly valuesReturned: false
  readonly updatedAt?: string
}

export interface DashboardResumeCenter {
  readonly versions: readonly DashboardResumeVersionSummary[]
  readonly count: number
  readonly candidateProfile: DashboardCandidateProfileSummary
}

/** Privacy-bounded payload rendered by the DSH job-search dashboard. */
export interface BossWatchDashboardSnapshot {
  readonly status: 'ok'
  readonly generatedAt: string
  readonly readOnly: true
  readonly overview: WorkspaceOverview
  readonly candidates: readonly CandidateBoardItem[]
  readonly resumeCenter: DashboardResumeCenter
  readonly count: number
}
