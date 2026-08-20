import type { CandidateBoardItem } from './candidate-board.js'
import type { WorkspaceOverview } from './workspace-overview.js'

/** Privacy-bounded payload rendered by the DSH job-search dashboard. */
export interface BossWatchDashboardSnapshot {
  readonly status: 'ok'
  readonly generatedAt: string
  readonly readOnly: true
  readonly overview: WorkspaceOverview
  readonly candidates: readonly CandidateBoardItem[]
  readonly count: number
}
