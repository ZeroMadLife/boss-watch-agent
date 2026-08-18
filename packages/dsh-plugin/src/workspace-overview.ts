import type { BossWatchDataSource } from './domain.js'
import type { FeishuTargetStore } from './feishu-projection.js'
import type { JobLeadStore } from './job-lead.js'
import type { ResumeVersionStore } from './resume-version.js'

export type WorkspacePhase =
  | 'local_runtime_setup'
  | 'resume_setup'
  | 'lead_discovery'
  | 'lead_verification'
  | 'match_ready'
  | 'application_preparation'

export interface WorkspaceSourceAvailability {
  readonly gankInterview: boolean
  readonly bossVisible: boolean
  readonly fileImport: boolean
  readonly clipboardImport: boolean
  readonly visualImport: boolean
}

export interface WorkspaceSourceChannel {
  readonly sourceId: 'gankinterview' | 'boss_visible' | 'file_import' | 'clipboard_import' | 'visual_import'
  readonly state: 'ready' | 'setup_required'
  readonly refreshMode: 'request_only' | 'user_initiated_snapshot' | 'current_browser_page'
  readonly nextTool: string
}

export interface WorkspaceCheckpoint {
  readonly checkpointId: 'local_runtime' | 'resume' | 'job_leads' | 'official_jd' | 'captured_jd' | 'feishu_projection'
  readonly state: 'ready' | 'needs_action' | 'optional'
  readonly count: number
}

export interface WorkspaceRecommendedAction {
  readonly priority: number
  readonly actionId: string
  readonly reasonCode: string
  readonly requiresHuman: boolean
  readonly externalEffect: 'none'
  readonly toolName?: string
}

export interface WorkspaceOverview {
  readonly phase: WorkspacePhase
  readonly databaseReady: boolean
  readonly readOnly: true
  readonly externalNetworkAccess: false
  readonly counts: {
    readonly resumeVersions: number
    readonly jobLeads: number
    readonly sourceOnlyLeads: number
    readonly verifiedLeads: number
    readonly capturedJobs: number
    readonly feishuTargets: number
  }
  readonly sourceChannels: readonly WorkspaceSourceChannel[]
  readonly checkpoints: readonly WorkspaceCheckpoint[]
  readonly recommendedActions: readonly WorkspaceRecommendedAction[]
}

interface WorkspaceOverviewOptions {
  readonly source: BossWatchDataSource
  readonly databaseReady: boolean
  readonly leads?: Pick<JobLeadStore, 'summarize'>
  readonly resumes?: Pick<ResumeVersionStore, 'count'>
  readonly feishuTargets?: Pick<FeishuTargetStore, 'countTargets'>
  readonly sourceAvailability: WorkspaceSourceAvailability
}

const EMPTY_COUNTS: WorkspaceOverview['counts'] = {
  resumeVersions: 0,
  jobLeads: 0,
  sourceOnlyLeads: 0,
  verifiedLeads: 0,
  capturedJobs: 0,
  feishuTargets: 0,
}

export class LocalWorkspaceOverviewService {
  readonly #options: WorkspaceOverviewOptions

  constructor(options: WorkspaceOverviewOptions) {
    this.#options = options
  }

  async inspect(): Promise<WorkspaceOverview> {
    const counts = this.#options.databaseReady ? await this.#readCounts() : EMPTY_COUNTS
    return {
      phase: selectPhase(this.#options.databaseReady, counts),
      databaseReady: this.#options.databaseReady,
      readOnly: true,
      externalNetworkAccess: false,
      counts,
      sourceChannels: sourceChannels(this.#options.sourceAvailability),
      checkpoints: checkpoints(this.#options.databaseReady, counts),
      recommendedActions: recommendedActions(this.#options.databaseReady, counts, this.#options.sourceAvailability),
    }
  }

  async #readCounts(): Promise<WorkspaceOverview['counts']> {
    const leadSummary = this.#options.leads?.summarize() ?? { total: 0, sourceOnly: 0, verified: 0 }
    const capturedJobs = this.#options.source.countJobs === undefined
      ? (await this.#options.source.listJobs(50)).length
      : await this.#options.source.countJobs()
    return {
      resumeVersions: this.#options.resumes?.count() ?? 0,
      jobLeads: leadSummary.total,
      sourceOnlyLeads: leadSummary.sourceOnly,
      verifiedLeads: leadSummary.verified,
      capturedJobs,
      feishuTargets: this.#options.feishuTargets?.countTargets() ?? 0,
    }
  }
}

function selectPhase(databaseReady: boolean, counts: WorkspaceOverview['counts']): WorkspacePhase {
  if (!databaseReady) return 'local_runtime_setup'
  if (counts.resumeVersions === 0) return 'resume_setup'
  if (counts.verifiedLeads > 0) return 'application_preparation'
  if (counts.capturedJobs > 0) return 'match_ready'
  if (counts.jobLeads > 0) return 'lead_verification'
  return 'lead_discovery'
}

function sourceChannels(availability: WorkspaceSourceAvailability): WorkspaceSourceChannel[] {
  return [
    {
      sourceId: 'gankinterview',
      state: availability.gankInterview ? 'ready' : 'setup_required',
      refreshMode: 'request_only',
      nextTool: 'boss_watch_lead_search',
    },
    {
      sourceId: 'boss_visible',
      state: availability.bossVisible ? 'ready' : 'setup_required',
      refreshMode: 'current_browser_page',
      nextTool: 'boss_watch_discover_jobs',
    },
    {
      sourceId: 'file_import',
      state: availability.fileImport ? 'ready' : 'setup_required',
      refreshMode: 'user_initiated_snapshot',
      nextTool: 'boss_watch_lead_import_preview',
    },
    {
      sourceId: 'clipboard_import',
      state: availability.clipboardImport ? 'ready' : 'setup_required',
      refreshMode: 'user_initiated_snapshot',
      nextTool: 'boss_watch_lead_clipboard_preview',
    },
    {
      sourceId: 'visual_import',
      state: availability.visualImport ? 'ready' : 'setup_required',
      refreshMode: 'user_initiated_snapshot',
      nextTool: 'boss_watch_lead_visual_preview',
    },
  ]
}

function checkpoints(databaseReady: boolean, counts: WorkspaceOverview['counts']): WorkspaceCheckpoint[] {
  return [
    { checkpointId: 'local_runtime', state: databaseReady ? 'ready' : 'needs_action', count: databaseReady ? 1 : 0 },
    { checkpointId: 'resume', state: counts.resumeVersions > 0 ? 'ready' : 'needs_action', count: counts.resumeVersions },
    {
      checkpointId: 'job_leads',
      state: counts.jobLeads + counts.capturedJobs > 0 ? 'ready' : 'needs_action',
      count: counts.jobLeads + counts.capturedJobs,
    },
    { checkpointId: 'official_jd', state: counts.verifiedLeads > 0 ? 'ready' : 'needs_action', count: counts.verifiedLeads },
    { checkpointId: 'captured_jd', state: counts.capturedJobs > 0 ? 'ready' : 'optional', count: counts.capturedJobs },
    { checkpointId: 'feishu_projection', state: counts.feishuTargets > 0 ? 'ready' : 'optional', count: counts.feishuTargets },
  ]
}

function recommendedActions(
  databaseReady: boolean,
  counts: WorkspaceOverview['counts'],
  availability: WorkspaceSourceAvailability,
): WorkspaceRecommendedAction[] {
  if (!databaseReady) {
    return [{
      priority: 1,
      actionId: 'start_local_runtime',
      reasonCode: 'local_fact_database_missing',
      requiresHuman: true,
      externalEffect: 'none',
    }]
  }

  const actions: WorkspaceRecommendedAction[] = []
  if (counts.resumeVersions === 0) {
    actions.push(action(1, 'import_resume', 'resume_version_required', 'boss_watch_resume_import_preview'))
  }
  if (counts.jobLeads === 0 && counts.capturedJobs === 0) {
    if (availability.gankInterview) {
      actions.push(action(2, 'search_gankinterview', 'no_job_leads', 'boss_watch_lead_search'))
    } else {
      actions.push({
        priority: 2,
        actionId: 'configure_gankinterview',
        reasonCode: 'gankinterview_not_configured',
        requiresHuman: true,
        externalEffect: 'none',
      })
    }
    if (availability.bossVisible) {
      actions.push(action(3, 'discover_visible_boss_jobs', 'no_job_leads', 'boss_watch_discover_jobs'))
    }
    if (availability.fileImport) {
      actions.push(action(4, 'import_job_source_file', 'no_job_leads', 'boss_watch_lead_import_preview'))
    }
  }
  if (counts.sourceOnlyLeads > 0 && counts.verifiedLeads === 0) {
    actions.push(action(1, 'review_job_leads', 'official_jd_verification_required', 'boss_watch_lead_list'))
  }
  if (counts.capturedJobs > 0 && counts.resumeVersions > 0) {
    actions.push(action(1, 'match_resume_to_jd', 'captured_jd_ready', 'boss_watch_resume_match'))
  }
  if (counts.verifiedLeads > 0 && counts.resumeVersions > 0) {
    actions.push(action(2, 'prepare_official_application', 'verified_lead_ready', 'boss_watch_apply_preview'))
  }
  if (counts.feishuTargets === 0 && (counts.verifiedLeads > 0 || counts.capturedJobs > 0)) {
    actions.push(action(90, 'connect_feishu_target', 'feishu_projection_optional', 'boss_watch_feishu_target_preview'))
  }
  return actions.sort((left, right) => left.priority - right.priority).slice(0, 5)
}

function action(priority: number, actionId: string, reasonCode: string, toolName: string): WorkspaceRecommendedAction {
  return { priority, actionId, reasonCode, requiresHuman: true, externalEffect: 'none', toolName }
}
