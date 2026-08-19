import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LocalBossWatchBrowserController } from './browser-controller-client.js'
import type { Context } from '@deepseek-ai/cordis'
import { SqliteBatchApplicationStore } from './application-batch.js'
import { SqliteFollowUpStore } from './application-follow-up.js'
import { GankInterviewCampusAdapter, SqliteJobLeadStore } from './job-lead.js'
import { LocalClipboardLeadSourceImportService, LocalLeadSourceImportService } from './job-source-import.js'
import { LocalVisualLeadImportService } from './visual-lead-import.js'
import { LarkCliFeishuClient } from './feishu-client.js'
import { LocalFeishuProjectionService, SqliteFeishuTargetStore } from './feishu-projection.js'
import { LocalJobWatchService, SqliteJobWatchStore } from './job-watch.js'
import { LocalJobWatchScheduler } from './job-watch-scheduler.js'
import { LocalJobDescriptionDiffService } from './job-diff.js'
import { LocalApplicationPreviewService } from './application-preview.js'
import { LocalApplicationFormPreviewService } from './application-form-preview.js'
import { LocalResumeImportService, SqliteResumeVersionStore } from './resume-version.js'
import { LocalInterviewNoteClient } from './interview-note-client.js'
import { LocalProgressSignalClient } from './progress-signal-client.js'
import { LocalResumeMatchingService } from './resume-matching.js'
import { registerBossWatchTools } from './tools.js'
import { SqliteBossWatchDataSource } from './sqlite-source.js'
import { registerBossWatchSkill } from './skill.js'
import { LocalWorkspaceOverviewService } from './workspace-overview.js'
import { LocalCandidateBoardService } from './candidate-board.js'
import { LocalBossJobSearchService } from './boss-job-search.js'

export const name = 'boss-watch-dsh-plugin'
export const inject = ['tools', 'skills']

interface AttachmentReader {
  readImage(ref: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }): Promise<{ data: Uint8Array }>
}

export function apply(ctx: Context): void {
  const databasePath = process.env.BOSS_WATCH_DB_PATH
    ?? join(homedir(), 'Library', 'Application Support', 'BossWatchAgent', 'boss-watch.sqlite3')
  const databaseReady = existsSync(databasePath)
  const source = new SqliteBossWatchDataSource(databasePath)
  const browser = new LocalBossWatchBrowserController()
  const interviewNoteClient = new LocalInterviewNoteClient()
  const progressSignalClient = new LocalProgressSignalClient()
  const leadStore = databaseReady ? new SqliteJobLeadStore(databasePath) : undefined
  const batchStore = databaseReady ? new SqliteBatchApplicationStore(databasePath) : undefined
  const followUpStore = databaseReady ? new SqliteFollowUpStore(databasePath) : undefined
  const feishuStore = databaseReady ? new SqliteFeishuTargetStore(databasePath) : undefined
  const jobWatchStore = databaseReady ? new SqliteJobWatchStore(databasePath) : undefined
  const resumeStore = databaseReady ? new SqliteResumeVersionStore(databasePath) : undefined
  const jobWatch = jobWatchStore === undefined
    ? undefined
    : new LocalJobWatchService({ source, browser, store: jobWatchStore })
  const jobWatchScheduler = jobWatch === undefined
    ? undefined
    : new LocalJobWatchScheduler({ service: jobWatch })
  const jobDiff = new LocalJobDescriptionDiffService(source)
  const applicationPreview = leadStore === undefined || resumeStore === undefined
    ? undefined
    : new LocalApplicationPreviewService({ leads: leadStore, resumes: resumeStore })
  const resumeImport = resumeStore === undefined
    ? undefined
    : new LocalResumeImportService({
        resumeRoot: process.env.BOSS_WATCH_RESUME_DIR
          ?? join(homedir(), 'Library', 'Application Support', 'BossWatchAgent', 'resumes'),
        store: resumeStore,
      })
  const resumeMatching = resumeImport === undefined
    ? undefined
    : new LocalResumeMatchingService({ source, resumes: resumeImport })
  const applicationFormPreview = leadStore === undefined || resumeStore === undefined || resumeImport === undefined
    ? undefined
    : new LocalApplicationFormPreviewService({
        leads: leadStore,
        resumes: resumeStore,
        resumeImport,
        browser,
      })
  const importService = leadStore === undefined
    ? undefined
    : new LocalLeadSourceImportService({
        importRoot: process.env.BOSS_WATCH_IMPORT_DIR
          ?? join(homedir(), 'Library', 'Application Support', 'BossWatchAgent', 'imports'),
        store: leadStore,
      })
  const clipboardImportService = leadStore === undefined
    ? undefined
    : new LocalClipboardLeadSourceImportService({
        importRoot: process.env.BOSS_WATCH_IMPORT_DIR
          ?? join(homedir(), 'Library', 'Application Support', 'BossWatchAgent', 'imports'),
        store: leadStore,
      })
  const visualImportService = leadStore === undefined
    ? undefined
    : new LocalVisualLeadImportService({
        store: leadStore,
        readScreenshotHash: (reference: string) => {
          const attachmentReader = ctx.get('attachments') as unknown as AttachmentReader | undefined
          if (attachmentReader === undefined) throw new Error('visual_attachment_store_unavailable')
          return hashVisionAttachment(reference, attachmentReader)
        },
      })
  const gankToken = process.env.GANKINTERVIEW_API_KEY?.trim()
  const leadSource = leadStore !== undefined && gankToken !== undefined && gankToken.length > 0
    ? new GankInterviewCampusAdapter({
        token: gankToken,
        ...process.env.GANKINTERVIEW_API_BASE_URL === undefined
          ? {}
          : { baseUrl: process.env.GANKINTERVIEW_API_BASE_URL },
        store: leadStore,
      })
    : undefined
  const feishuProjection = feishuStore === undefined
    ? undefined
    : new LocalFeishuProjectionService({
        client: new LarkCliFeishuClient(),
        store: feishuStore,
        source,
      })
  const workspaceOverview = new LocalWorkspaceOverviewService({
    source,
    databaseReady,
    ...leadStore === undefined ? {} : { leads: leadStore },
    ...resumeStore === undefined ? {} : { resumes: resumeStore },
    ...feishuStore === undefined ? {} : { feishuTargets: feishuStore },
    sourceAvailability: {
      gankInterview: gankToken !== undefined && gankToken.length > 0,
      bossVisible: true,
      fileImport: importService !== undefined,
      clipboardImport: clipboardImportService !== undefined,
      visualImport: visualImportService !== undefined,
    },
  })
  const candidateBoard = leadStore === undefined
    ? undefined
    : new LocalCandidateBoardService({ source, leads: leadStore })
  const bossJobSearch = new LocalBossJobSearchService({ browser })
  ctx.effect(
    () => {
      const disposeTools = registerBossWatchTools(ctx, source, browser, leadSource, leadStore, batchStore, followUpStore, importService, clipboardImportService, visualImportService, feishuProjection, jobWatch, jobWatchScheduler, jobDiff, applicationPreview, resumeStore, resumeImport, interviewNoteClient, resumeMatching, applicationFormPreview, progressSignalClient, workspaceOverview, candidateBoard, bossJobSearch)
      const disposeSkill = registerBossWatchSkill(ctx)
      return () => {
        disposeSkill()
        disposeTools()
        followUpStore?.close()
        batchStore?.close()
        leadStore?.close()
        feishuStore?.close()
        jobWatchStore?.close()
        resumeStore?.close()
      }
    },
    'boss-watch-dsh-plugin.lifecycle()',
  )
}

export { SqliteBossWatchDataSource } from './sqlite-source.js'
export { SqliteBatchApplicationStore } from './application-batch.js'
export { SqliteFollowUpStore } from './application-follow-up.js'
export { GankInterviewCampusAdapter, SqliteJobLeadStore } from './job-lead.js'
export { LocalLeadSourceImportService } from './job-source-import.js'
export { LocalClipboardLeadSourceImportService } from './job-source-import.js'
export { LocalVisualLeadImportService } from './visual-lead-import.js'
export { LarkCliFeishuClient } from './feishu-client.js'
export { LocalFeishuProjectionService, SqliteFeishuTargetStore } from './feishu-projection.js'
export { LocalJobWatchService, SqliteJobWatchStore } from './job-watch.js'
export { LocalJobWatchScheduler } from './job-watch-scheduler.js'
export { LocalJobDescriptionDiffService } from './job-diff.js'
export { LocalApplicationPreviewService } from './application-preview.js'
export { LocalApplicationFormPreviewService } from './application-form-preview.js'
export { LocalResumeImportService, SqliteResumeVersionStore } from './resume-version.js'
export { LocalInterviewNoteClient } from './interview-note-client.js'
export { LocalProgressSignalClient } from './progress-signal-client.js'
export { LocalResumeMatchingService } from './resume-matching.js'
export { LocalWorkspaceOverviewService } from './workspace-overview.js'
export { LocalCandidateBoardService } from './candidate-board.js'
export { LocalBossJobSearchService } from './boss-job-search.js'
export { evaluateResumeMatchGold } from './resume-match-eval.js'
export { BOSS_WATCH_SKILL } from './skill.js'
export type * from './domain.js'
export type * from './application-batch.js'
export type * from './application-follow-up.js'
export type * from './job-lead.js'
export type * from './job-source-import.js'
export type * from './visual-lead-import.js'
export type * from './job-watch.js'
export type * from './job-diff.js'
export type * from './application-preview.js'
export type * from './application-form-preview.js'
export type * from './resume-version.js'
export type * from './resume-matching.js'
export type * from './progress-signal-client.js'
export type * from './resume-match-eval.js'
export type * from './workspace-overview.js'

async function hashVisionAttachment(reference: string, attachments: AttachmentReader): Promise<string> {
  const parsed = decodeVisionAttachmentReference(reference)
  if (parsed === undefined) throw new Error('invalid_visual_source')
  const stored = await attachments.readImage(parsed)
  return createHash('sha256').update(stored.data).digest('hex')
}

function decodeVisionAttachmentReference(reference: string): Parameters<AttachmentReader['readImage']>[0] | undefined {
  try {
    const url = new URL(reference)
    if (url.protocol !== 'vision-subagent:') return undefined
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length !== 3 || segments[0] !== 'v1') return undefined
    const attachmentId = decodeURIComponent(segments[2] ?? '')
    const mediaType = url.searchParams.get('media') ?? ''
    const bytes = Number(url.searchParams.get('bytes'))
    const width = Number(url.searchParams.get('width'))
    const height = Number(url.searchParams.get('height'))
    const name = url.searchParams.get('name') ?? undefined
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(attachmentId)
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)
      || ![bytes, width, height].every((value) => Number.isSafeInteger(value) && value > 0)
    ) return undefined
    return {
      attachmentId,
      mediaType,
      bytes,
      width,
      height,
      ...name === undefined ? {} : { name },
    }
  } catch {
    return undefined
  }
}
