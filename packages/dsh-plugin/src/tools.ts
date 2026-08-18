import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import {
  defineTool as dshDefineTool,
  type DefineToolOptions,
  type ParameterSchemaSpec,
  type ValueSchemaSpec,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import type { BossWatchBrowserController, BossWatchDataSource } from './domain.js'
import type { BatchApplicationStore } from './application-batch.js'
import type { FollowUpReason, FollowUpStore } from './application-follow-up.js'
import {
  LeadImportError,
  type ClipboardLeadSourceImportService,
  type ImportColumnMapping,
  type LeadSourceImportService,
} from './job-source-import.js'
import type {
  VisualLeadImportService,
  VisualLeadRowInput,
} from './visual-lead-import.js'
import type { JobLeadObservation, JobLeadSearchSource, JobLeadStore, LeadSourceKind } from './job-lead.js'
import type { LocalFeishuProjectionService } from './feishu-projection.js'
import type { LocalJobWatchService } from './job-watch.js'
import type { LocalJobWatchScheduler } from './job-watch-scheduler.js'
import type { LocalJobDescriptionDiffService } from './job-diff.js'
import type { LocalApplicationPreviewService } from './application-preview.js'
import type { LocalApplicationFormPreviewService } from './application-form-preview.js'
import type { LocalResumeImportService, ResumeVersionStore } from './resume-version.js'
import type { InterviewNoteStage, LocalInterviewNoteClient } from './interview-note-client.js'
import type {
  LocalProgressSignalClient,
  ProgressSignalOutcome,
  ProgressSignalPreviewInput,
  ProgressSignalSourceKind,
} from './progress-signal-client.js'
import type { LocalResumeMatchingService } from './resume-matching.js'

const unsafeDefineTool = dshDefineTool as unknown as (
  options: DefineToolOptions<ParameterSchemaSpec, ValueSchemaSpec>,
) => ToolDefinition

/**
 * NewAPI's OpenAI-compatible validator expects `required` to be an array even
 * when a tool has no required parameters. DSH omits the field in that case,
 * which is valid JSON Schema but is rejected by that gateway. Keep the
 * compatibility fix local to this plugin so the tool contract remains the
 * same and upstream DSH behavior is untouched.
 */
function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  // The upstream generic infers the full nested output schema here. The
  // wrapper only changes the transport-facing parameter object, so widening
  // this one call avoids a TypeScript instantiation-depth failure without
  // weakening the caller's contextual argument types above.
  const tool = unsafeDefineTool(options as never)
  const parameters = tool.parameters as Record<string, unknown>
  return {
    ...tool,
    parameters: {
      ...parameters,
      ...(Array.isArray(parameters.required) ? {} : { required: [] }),
    },
  }
}

const STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request'],
} as const

const JOB = {
  type: 'object',
  additionalProperties: false,
  properties: {
    applicationId: { type: 'string', required: true },
    company: { type: 'string', required: true },
    role: { type: 'string', required: true },
    jobUrl: { type: 'string' },
    capturedAt: { type: 'string', required: true },
    contentHash: { type: 'string', required: true },
  },
} as const

const JOB_DETAILS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...JOB.properties,
    description: { type: 'string', required: true },
    artifactRef: { type: 'string', required: true },
  },
} as const

const APPLICATION_OVERVIEW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...JOB.properties,
    progressState: {
      type: 'string',
      required: true,
      enum: ['new', 'conversation_active', 'interview_notes', 'signal_needs_review', 'status_proposed'],
    },
    eventCount: { type: 'integer', required: true },
    recruiterMessageCount: { type: 'integer', required: true },
    interviewNoteCount: { type: 'integer', required: true },
    progressSignalCount: { type: 'integer', required: true },
    latestEventType: { type: 'string', required: true },
    latestEventAt: { type: 'string', required: true },
    proposedStatus: { type: 'string' },
  },
} as const

const APPLICATION_LIST = {
  type: 'array',
  items: APPLICATION_OVERVIEW,
  required: true,
} as const

const FOLLOW_UP_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request'],
} as const

const FOLLOW_UP = {
  type: 'object',
  additionalProperties: false,
  properties: {
    followUpId: { type: 'string', required: true },
    applicationId: { type: 'string', required: true },
    dueAt: { type: 'string', required: true },
    reason: { type: 'string', required: true, enum: ['application_status', 'no_response', 'interview', 'manual'] },
    note: { type: 'string' },
    state: { type: 'string', required: true, enum: ['scheduled', 'completed'] },
    createdAt: { type: 'string', required: true },
    completedAt: { type: 'string' },
  },
} as const

const FOLLOW_UP_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FOLLOW_UP.properties,
    urgency: { type: 'string', required: true, enum: ['overdue', 'due', 'upcoming'] },
    nextAction: { type: 'string', required: true },
    applicationFound: { type: 'boolean', required: true },
    company: { type: 'string' },
    role: { type: 'string' },
    progressState: { type: 'string' },
    latestEventType: { type: 'string' },
    latestEventAt: { type: 'string' },
    proposedStatus: { type: 'string' },
  },
} as const

const BATCH_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

const LEAD_CONFIRMATION_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

const LEAD_IMPORT_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

const VISUAL_LEAD_IMPORT_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

const FEISHU_PROJECTION_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

const BATCH_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemId: { type: 'string', required: true },
    batchId: { type: 'string', required: true },
    leadId: { type: 'string', required: true },
    sequence: { type: 'integer', required: true },
    company: { type: 'string', required: true },
    role: { type: 'string', required: true },
    channelUrl: { type: 'string' },
    officialApplyUrl: { type: 'string' },
    leadContentHash: { type: 'string', required: true },
    leadConfidence: { type: 'string', required: true },
    itemState: { type: 'string', required: true },
    gateBRef: { type: 'string' },
    gateBContentHash: { type: 'string' },
    gateBExpiresAt: { type: 'string' },
    failure: { type: 'json' },
    checkpoint: { type: 'json' },
  },
} as const

const BATCH_RUN = {
  type: 'object',
  additionalProperties: false,
  properties: {
    batchId: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    strategyVersion: { type: 'string', required: true },
    batchState: { type: 'string', required: true },
    currentCursor: { type: 'integer', required: true },
    items: { type: 'array', items: BATCH_ITEM, required: true },
    lastResult: { type: 'string' },
    pausedReason: { type: 'string' },
    resumableAt: { type: 'string' },
    resumeCount: { type: 'integer', required: true },
  },
} as const

const LEAD = {
  type: 'object',
  additionalProperties: false,
  properties: {
    leadId: { type: 'string', required: true },
    sourceKind: { type: 'string', required: true },
    sourceRecordId: { type: 'string', required: true },
    company: { type: 'string', required: true },
    role: { type: 'string', required: true },
    city: { type: 'string' },
    cohort: { type: 'string' },
    recruitmentType: { type: 'string' },
    deadline: { type: 'string' },
    channelUrl: { type: 'string' },
    officialApplyUrl: { type: 'string' },
    sourceUpdatedAt: { type: 'string' },
    fetchedAt: { type: 'string', required: true },
    rawRef: { type: 'string', required: true },
    contentHash: { type: 'string', required: true },
    confidence: { type: 'string', required: true },
  },
} as const

const LEAD_OBSERVATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observationId: { type: 'string', required: true },
    leadId: { type: 'string', required: true },
    sourceKind: { type: 'string', required: true },
    sourceRecordId: { type: 'string', required: true },
    company: { type: 'string', required: true },
    role: { type: 'string', required: true },
    city: { type: 'string' },
    cohort: { type: 'string' },
    recruitmentType: { type: 'string' },
    deadline: { type: 'string' },
    channelUrl: { type: 'string' },
    sourceUpdatedAt: { type: 'string' },
    observedAt: { type: 'string', required: true },
    rawRef: { type: 'string', required: true },
    contentHash: { type: 'string', required: true },
    previousContentHash: { type: 'string' },
    previousConfidence: { type: 'string' },
    changeKind: { type: 'string', required: true, enum: ['new', 'unchanged', 'changed'] },
    verificationInvalidated: { type: 'boolean', required: true },
    isCurrent: { type: 'boolean', required: true },
    snapshotId: { type: 'string' },
  },
} as const

const LEAD_VERIFICATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verificationId: { type: 'string', required: true },
    leadId: { type: 'string', required: true },
    contentHash: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: ['candidate_url_confirmed', 'jd_human_confirmed'] },
    officialApplyUrl: { type: 'string', required: true },
    confirmedAt: { type: 'string', required: true },
  },
} as const

const EVENT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sequence: { type: 'integer', required: true },
    eventId: { type: 'string', required: true },
    applicationId: { type: 'string', required: true },
    type: { type: 'string', required: true },
    occurredAt: { type: 'string', required: true },
    actor: { type: 'string', required: true },
    payload: { type: 'json' },
  },
} as const

const FEISHU_FIELDS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    applicationId: { type: 'string', required: true },
    company: { type: 'string', required: true },
    role: { type: 'string', required: true },
    jobUrl: { type: 'string' },
    capturedAt: { type: 'string', required: true },
    contentHash: { type: 'string', required: true },
    description: { type: 'string', required: true },
  },
} as const

const BROWSER_STATUS = {
  type: 'string',
  required: true,
  enum: ['ready', 'no_supported_tab', 'target_ambiguous', 'human_required', 'environment_interrupted'],
} as const

const BROWSER_CAPTURE_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'no_supported_tab', 'target_ambiguous', 'human_required', 'page_adapter_mismatch', 'environment_interrupted'],
} as const

const BROWSER_CONVERSATION_CAPTURE_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'no_supported_tab', 'target_ambiguous', 'human_required', 'page_adapter_mismatch', 'environment_interrupted'],
} as const

const BROWSER_CONVERSATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: { type: 'string', required: true },
    messageId: { type: 'string', required: true },
    recruiterName: { type: 'string', required: true },
    pageRevision: { type: 'string', required: true },
  },
} as const

const INTERVIEW_NOTE_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'not_found', 'invalid_request', 'conflict', 'source_unavailable'],
} as const

const INTERVIEW_NOTE_PREVIEW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previewToken: { type: 'string', required: true },
    applicationId: { type: 'string', required: true },
    interviewId: { type: 'string', required: true },
    stage: { type: 'string', required: true, enum: ['screening', 'first_interview', 'second_interview', 'final_interview', 'other'] },
    contentHash: { type: 'string', required: true },
    contentLength: { type: 'integer', required: true },
    expiresAt: { type: 'string', required: true },
    requiresConfirmation: { type: 'boolean', required: true },
  },
} as const

const PROGRESS_SIGNAL_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'not_found', 'invalid_request', 'conflict', 'source_unavailable'],
} as const

const PROGRESS_SIGNAL_PREVIEW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previewToken: { type: 'string', required: true },
    applicationId: { type: 'string', required: true },
    sourceKind: {
      type: 'string',
      required: true,
      enum: ['recruitment_email', 'interview_invitation', 'recruiter_message', 'manual_update'],
    },
    sourceMode: { type: 'string', required: true, enum: ['pasted_text', 'staged_file'] },
    outcome: { type: 'string', required: true, enum: ['interview', 'rejected', 'offer', 'needs_review'] },
    classifierVersion: { type: 'string', required: true },
    confidence: { type: 'number', required: true },
    reasonCodes: { type: 'array', required: true, items: { type: 'string' } },
    proposedStatus: { type: 'string' },
    contentHash: { type: 'string', required: true },
    sourceHash: { type: 'string', required: true },
    contentLength: { type: 'integer', required: true },
    observedAt: { type: 'string', required: true },
    expiresAt: { type: 'string', required: true },
    requiresConfirmation: { type: 'boolean', required: true },
  },
} as const

const BROWSER_TARGET = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pageKind: { type: 'string', required: true, enum: ['job_detail'] },
    title: { type: 'string' },
    url: { type: 'string', required: true },
  },
} as const

const BROWSER_DISCOVERY_STATUS = {
  type: 'string',
  required: true,
  enum: ['ready', 'no_supported_tab', 'target_ambiguous', 'human_required', 'environment_interrupted'],
} as const

const BROWSER_DISCOVERY_TARGET = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pageKind: { type: 'string', required: true, enum: ['job_list'] },
    title: { type: 'string' },
    url: { type: 'string', required: true },
  },
} as const

const BROWSER_JOB_SUMMARY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    externalJobId: { type: 'string', required: true },
    role: { type: 'string', required: true },
    company: { type: 'string' },
    salary: { type: 'string' },
    salaryStatus: {
      type: 'string',
      required: true,
      enum: ['available', 'obfuscated', 'missing'],
    },
    experience: { type: 'string' },
    education: { type: 'string' },
    location: { type: 'string' },
    jobUrl: { type: 'string', required: true },
  },
} as const

const BROWSER_DISCOVERED_CAPTURE_STATUS = {
  type: 'string',
  required: true,
  enum: [
    'ok',
    'invalid_request',
    'no_supported_tab',
    'target_ambiguous',
    'human_required',
    'page_adapter_mismatch',
    'environment_interrupted',
  ],
} as const

const WATCH_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

const WATCH = {
  type: 'object',
  additionalProperties: false,
  properties: {
    watchId: { type: 'string', required: true },
    applicationId: { type: 'string', required: true },
    platform: { type: 'string', required: true, enum: ['boss'] },
    externalJobId: { type: 'string', required: true },
    company: { type: 'string', required: true },
    role: { type: 'string', required: true },
    jobUrl: { type: 'string', required: true },
    state: { type: 'string', required: true, enum: ['active', 'polling', 'paused_human_required', 'stopped'] },
    createdAt: { type: 'string', required: true },
    lastPolledAt: { type: 'string' },
    nextPollAt: { type: 'string' },
    baselineContentHash: { type: 'string', required: true },
    consecutiveUnchanged: { type: 'integer', required: true },
    consecutiveFailures: { type: 'integer', required: true },
    dailyPollCount: { type: 'integer', required: true },
    lastResult: { type: 'string', enum: ['unchanged', 'changed', 'transient_failure', 'paused_human_required'] },
    pausedReason: { type: 'string' },
  },
} as const

const APPLY_PREVIEW_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

const RESUME_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

const RESUME_MATCH_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

const APPLICATION_FORM_PREVIEW_STATUS = {
  type: 'string',
  required: true,
  enum: ['ok', 'handoff_required', 'source_unavailable', 'not_found', 'invalid_request', 'conflict'],
} as const

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function registerBossWatchTools(
  ctx: Context,
  source: BossWatchDataSource,
  browser?: BossWatchBrowserController,
  leadSource?: JobLeadSearchSource,
  leadStore?: JobLeadStore,
  batchStore?: BatchApplicationStore,
  followUpStore?: FollowUpStore,
  leadImport?: LeadSourceImportService,
  clipboardImport?: ClipboardLeadSourceImportService,
  visualImport?: VisualLeadImportService,
  feishuProjection?: LocalFeishuProjectionService,
  jobWatch?: LocalJobWatchService,
  jobWatchScheduler?: LocalJobWatchScheduler,
  jobDiff?: LocalJobDescriptionDiffService,
  applicationPreview?: LocalApplicationPreviewService,
  resumeStore?: ResumeVersionStore,
  resumeImport?: LocalResumeImportService,
  interviewNoteClient?: LocalInterviewNoteClient,
  resumeMatching?: LocalResumeMatchingService,
  applicationFormPreview?: LocalApplicationFormPreviewService,
  progressSignalClient?: LocalProgressSignalClient,
): () => void {
  const disposers = [
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_discover_jobs',
        description: 'Read visible BOSS job cards from the current page. Read-only; never clicks, navigates, sends, or applies.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: BROWSER_DISCOVERY_STATUS,
              discoveryId: { type: 'string' },
              reason: { type: 'string' },
              targetCount: { type: 'integer', required: true },
              target: BROWSER_DISCOVERY_TARGET,
              jobs: { type: 'array', items: BROWSER_JOB_SUMMARY },
            },
          },
          render: renderJson,
        },
        async execute() {
          if (browser === undefined) {
            return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          }
          try {
            const result = await browser.discoverJobs()
            return result.status === 'ready' ? { ...result, jobs: [...result.jobs] } : result
          } catch {
            return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_import_preview',
        description: 'Preview a user-selected local Tencent CSV/XLSX export. Local read only; never contacts Tencent Docs or writes JobLead facts.',
        parameters: {
          sourceRef: { type: 'string', required: true, description: 'Configured source reference for the exported table.' },
          fileName: { type: 'string', required: true, description: 'File name inside the configured local import directory; never an arbitrary path.' },
          sheetName: { type: 'string', description: 'XLSX worksheet name. Required when the workbook has multiple sheets.' },
          columnMapping: { type: 'json', description: 'Optional explicit standard field to source column mapping.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: LEAD_IMPORT_STATUS,
              preview: { type: 'json' },
              message: { type: 'string' },
              details: { type: 'array', items: { type: 'string' } },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (leadImport === undefined) return { status: 'source_unavailable' as const, message: 'lead_import_not_configured' }
          try {
            const columnMapping = isRecord(args.columnMapping)
              ? normalizeImportColumnMapping(args.columnMapping)
              : undefined
            const preview = await leadImport.preview({
              sourceRef: args.sourceRef,
              fileName: args.fileName,
              ...typeof args.sheetName === 'string' ? { sheetName: args.sheetName } : {},
              ...columnMapping === undefined ? {} : { columnMapping },
            })
            return { status: 'ok' as const, preview: preview as unknown as JsonValue }
          } catch (error: unknown) {
            return leadImportError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_import_apply',
        description: 'Apply a previously previewed local Tencent CSV/XLSX import after explicit user confirmation. Writes only local SQLite facts.',
        parameters: {
          previewToken: { type: 'string', required: true, description: 'Short-lived token returned by boss_watch_lead_import_preview.' },
          confirmation: { type: 'string', required: true, description: 'Explicit confirmation of the displayed source, worksheet and import counts.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: LEAD_IMPORT_STATUS,
              snapshot: { type: 'json' },
              verificationInvalidatedCount: { type: 'integer' },
              reused: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (leadImport === undefined) return { status: 'source_unavailable' as const, message: 'lead_import_not_configured' }
          if (typeof args.confirmation !== 'string' || args.confirmation.trim().length === 0) {
            return { status: 'invalid_request' as const, message: 'import_confirmation_required' }
          }
          try {
            const result = await leadImport.apply(args.previewToken)
            return {
              status: 'ok' as const,
              snapshot: result.snapshot as unknown as JsonValue,
              verificationInvalidatedCount: result.verificationInvalidatedCount,
              reused: result.reused,
            }
          } catch (error: unknown) {
            return leadImportError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_clipboard_preview',
        description: 'Preview rows the user copied from a visible Tencent Docs table. Reads the local system clipboard only; never contacts Tencent Docs or writes JobLead facts.',
        parameters: {
          sourceRef: { type: 'string', required: true, description: 'Stable user-provided reference for the Tencent table/view.' },
          columnMapping: { type: 'json', description: 'Optional explicit standard field to source column mapping.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: LEAD_IMPORT_STATUS,
              preview: { type: 'json' },
              message: { type: 'string' },
              details: { type: 'array', items: { type: 'string' } },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (clipboardImport === undefined) return { status: 'source_unavailable' as const, message: 'lead_import_not_configured' }
          try {
            const columnMapping = isRecord(args.columnMapping)
              ? normalizeImportColumnMapping(args.columnMapping)
              : undefined
            const preview = await clipboardImport.preview({
              sourceRef: args.sourceRef,
              ...columnMapping === undefined ? {} : { columnMapping },
            })
            return { status: 'ok' as const, preview: preview as unknown as JsonValue }
          } catch (error: unknown) {
            return leadImportError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_clipboard_apply',
        description: 'Apply a previously previewed clipboard snapshot after explicit user confirmation. Writes only local SQLite facts and rejects if the clipboard changed.',
        parameters: {
          previewToken: { type: 'string', required: true, description: 'Short-lived token returned by boss_watch_lead_clipboard_preview.' },
          confirmation: { type: 'string', required: true, description: 'Explicit confirmation of the displayed source and import counts.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: LEAD_IMPORT_STATUS,
              snapshot: { type: 'json' },
              verificationInvalidatedCount: { type: 'integer' },
              reused: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (clipboardImport === undefined) return { status: 'source_unavailable' as const, message: 'lead_import_not_configured' }
          if (typeof args.confirmation !== 'string' || args.confirmation.trim().length === 0) {
            return { status: 'invalid_request' as const, message: 'import_confirmation_required' }
          }
          try {
            const result = await clipboardImport.apply(args.previewToken)
            return {
              status: 'ok' as const,
              snapshot: result.snapshot as unknown as JsonValue,
              verificationInvalidatedCount: result.verificationInvalidatedCount,
              reused: result.reused,
            }
          } catch (error: unknown) {
            return leadImportError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_visual_preview',
        description: 'Preview structured job rows extracted from a user-provided screenshot. Validates only; never contacts Tencent Docs or writes SQLite.',
        parameters: {
          sourceRef: { type: 'string', required: true, description: 'Stable reference for the visible source/table.' },
          screenshotRef: { type: 'string', required: true, description: 'Temporary local attachment reference; remote URLs are not accepted.' },
          screenshotHash: { type: 'string', description: 'Optional SHA-256 assertion. The host recomputes it from the durable DSH attachment.' },
          sourceKind: { type: 'string', enum: ['gankinterview_campus', 'tencent_smart_sheet', 'boss_visible', 'company_career_site'] },
          sheetName: { type: 'string', description: 'Viewport or worksheet label.' },
          headers: { type: 'json', description: 'Headers recognized by the vision model.' },
          columnMapping: { type: 'json', description: 'Optional canonical field to recognized header mapping.' },
          rows: { type: 'json', required: true, description: 'Structured rows from the vision model; each row needs company and role.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: VISUAL_LEAD_IMPORT_STATUS,
              preview: { type: 'json' },
              message: { type: 'string' },
              details: { type: 'array', items: { type: 'string' } },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (visualImport === undefined) return { status: 'source_unavailable' as const, message: 'visual_lead_import_not_configured' }
          const rows = normalizeVisualRows(args.rows)
          if (rows === undefined) return { status: 'invalid_request' as const, message: 'visual_rows_required' }
          const headers = normalizeStringArray(args.headers)
          if (args.headers !== undefined && headers === undefined) return { status: 'invalid_request' as const, message: 'visual_headers_invalid' }
          try {
            const columnMapping = isRecord(args.columnMapping)
              ? normalizeImportColumnMapping(args.columnMapping)
              : undefined
            const preview = await visualImport.preview({
              sourceRef: args.sourceRef,
              screenshotRef: args.screenshotRef,
              ...typeof args.screenshotHash === 'string' ? { screenshotHash: args.screenshotHash } : {},
              ...typeof args.sourceKind === 'string' ? { sourceKind: args.sourceKind as LeadSourceKind } : {},
              ...typeof args.sheetName === 'string' ? { sheetName: args.sheetName } : {},
              ...headers === undefined ? {} : { headers },
              ...columnMapping === undefined ? {} : { columnMapping },
              rows,
            })
            return { status: 'ok' as const, preview: preview as unknown as JsonValue }
          } catch (error: unknown) {
            return visualLeadImportError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_visual_apply',
        description: 'Apply a previously previewed screenshot result after explicit confirmation of source, row counts, and low-confidence warnings. Writes only local SQLite facts.',
        parameters: {
          previewToken: { type: 'string', required: true, description: 'Short-lived token returned by boss_watch_lead_visual_preview.' },
          confirmation: { type: 'string', required: true, description: 'Explicit confirmation of the displayed source, accepted rows, rejected rows and low-confidence rows.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: VISUAL_LEAD_IMPORT_STATUS,
              snapshot: { type: 'json' },
              verificationInvalidatedCount: { type: 'integer' },
              reused: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (visualImport === undefined) return { status: 'source_unavailable' as const, message: 'visual_lead_import_not_configured' }
          if (typeof args.confirmation !== 'string' || args.confirmation.trim().length === 0) {
            return { status: 'invalid_request' as const, message: 'visual_import_confirmation_required' }
          }
          try {
            const result = await visualImport.apply(args.previewToken)
            return {
              status: 'ok' as const,
              snapshot: result.snapshot as unknown as JsonValue,
              verificationInvalidatedCount: result.verificationInvalidatedCount,
              reused: result.reused,
            }
          } catch (error: unknown) {
            return visualLeadImportError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_application_list',
        description: 'Read the local application tracker with current progress summaries. Read-only; refreshes from SQLite on every call.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              applications: APPLICATION_LIST,
              count: { type: 'integer', required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute() {
          try {
            const applications = await source.listApplicationOverviews(50)
            return { status: 'ok' as const, applications, count: applications.length }
          } catch (error: unknown) {
            return { status: 'source_unavailable' as const, applications: [], count: 0, message: stableError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_application_overview',
        description: 'Read a local application progress overview. Read-only; never changes status or visits an external site.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Local application id.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              overview: APPLICATION_OVERVIEW,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          try {
            const overview = await source.getApplicationOverview(args.applicationId)
            return overview === undefined
              ? { status: 'not_found' as const, message: 'application_not_found' }
              : { status: 'ok' as const, overview }
          } catch (error: unknown) {
            return { status: 'source_unavailable' as const, message: stableError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_follow_up_list',
        description: 'Read the current local follow-up inbox and merge each reminder with the latest SQLite application timeline. Read-only; never contacts a recruiter or visits an external site.',
        parameters: {
          asOf: { type: 'string', description: 'Optional ISO timestamp used as the local comparison time.' },
          limit: { type: 'integer', description: 'Maximum active reminders to return, from 1 to 100.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: FOLLOW_UP_STATUS,
              asOf: { type: 'string', required: true },
              items: { type: 'array', items: FOLLOW_UP_ITEM, required: true },
              count: { type: 'integer', required: true },
              overdueCount: { type: 'integer', required: true },
              dueCount: { type: 'integer', required: true },
              upcomingCount: { type: 'integer', required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (followUpStore === undefined) {
            return { status: 'source_unavailable' as const, asOf: new Date().toISOString(), items: [], count: 0, overdueCount: 0, dueCount: 0, upcomingCount: 0, message: 'follow_up_store_unavailable' }
          }
          const asOf = typeof args.asOf === 'string' && args.asOf.trim().length > 0
            ? args.asOf
            : new Date().toISOString()
          try {
            const records = followUpStore.listActive({ asOf, ...numberField(args.limit, 'limit') })
            const items = await Promise.all(records.map(async (record) => {
              const application = await source.getApplicationOverview(record.applicationId)
              const urgency = followUpUrgency(record.dueAt, asOf)
              return {
                ...record,
                urgency,
                nextAction: followUpNextAction(record.reason),
                applicationFound: application !== undefined,
                ...application === undefined ? {} : {
                  company: application.company,
                  role: application.role,
                  progressState: application.progressState,
                  latestEventType: application.latestEventType,
                  latestEventAt: application.latestEventAt,
                  ...application.proposedStatus === undefined ? {} : { proposedStatus: application.proposedStatus },
                },
              }
            }))
            return {
              status: 'ok' as const,
              asOf,
              items,
              count: items.length,
              overdueCount: items.filter(({ urgency }) => urgency === 'overdue').length,
              dueCount: items.filter(({ urgency }) => urgency === 'due').length,
              upcomingCount: items.filter(({ urgency }) => urgency === 'upcoming').length,
            }
          } catch (error: unknown) {
            return {
              status: followUpInputError(error) ? 'invalid_request' as const : 'source_unavailable' as const,
              asOf,
              items: [],
              count: 0,
              overdueCount: 0,
              dueCount: 0,
              upcomingCount: 0,
              message: followUpError(error),
            }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_follow_up_schedule',
        description: 'Schedule a local follow-up reminder for an existing application. Local SQLite write only; does not send a message, change BOSS state, or write Feishu.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Local application id.' },
          dueAt: { type: 'string', required: true, description: 'ISO timestamp when the reminder should become due.' },
          reason: { type: 'string', required: true, enum: ['application_status', 'no_response', 'interview', 'manual'] },
          note: { type: 'string', description: 'Short local note, without credentials or full recruiter messages.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: FOLLOW_UP_STATUS,
              followUp: FOLLOW_UP,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (followUpStore === undefined) return { status: 'source_unavailable' as const, message: 'follow_up_store_unavailable' }
          const applicationId = typeof args.applicationId === 'string' ? args.applicationId : ''
          try {
            const application = await source.getApplicationOverview(applicationId)
            if (application === undefined) return { status: 'not_found' as const, message: 'application_not_found' }
            if (!isFollowUpReason(args.reason)) return { status: 'invalid_request' as const, message: 'invalid_follow_up_reason' }
            if (typeof args.dueAt !== 'string') return { status: 'invalid_request' as const, message: 'invalid_follow_up_due_at' }
            const followUp = followUpStore.schedule({
              applicationId,
              dueAt: args.dueAt,
              reason: args.reason,
              ...typeof args.note === 'string' ? { note: args.note } : {},
            })
            return { status: 'ok' as const, followUp }
          } catch (error: unknown) {
            return {
              status: followUpInputError(error) ? 'invalid_request' as const : 'source_unavailable' as const,
              message: followUpError(error),
            }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_follow_up_complete',
        description: 'Mark one local follow-up reminder complete. Local SQLite write only; this does not claim that an external action succeeded.',
        parameters: {
          followUpId: { type: 'string', required: true, description: 'Follow-up id returned by boss_watch_follow_up_list or schedule.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: FOLLOW_UP_STATUS,
              followUp: FOLLOW_UP,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (followUpStore === undefined) return { status: 'source_unavailable' as const, message: 'follow_up_store_unavailable' }
          try {
            return { status: 'ok' as const, followUp: followUpStore.complete(args.followUpId) }
          } catch (error: unknown) {
            return error instanceof Error && error.message === 'follow_up_not_found'
              ? { status: 'not_found' as const, message: error.message }
              : { status: 'invalid_request' as const, message: followUpError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_search',
        description: 'Search the configured GankInterview campus source and save a local JobLead snapshot. External read only; does not validate a JD or apply.',
        parameters: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          keyword: { type: 'string' },
          company: { type: 'string' },
          location: { type: 'string' },
          recruitmentType: { type: 'string' },
          target: { type: 'string' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              leads: { type: 'array', items: LEAD, required: true },
              count: { type: 'integer', required: true },
              persistedLocally: { type: 'boolean', required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (leadSource === undefined) {
            return { status: 'source_unavailable' as const, leads: [], count: 0, persistedLocally: false, message: 'gankinterview_not_configured' }
          }
          try {
            const leads = await leadSource.search({
              ...numberField(args.page, 'page'),
              ...numberField(args.limit, 'limit'),
              ...stringField(args.keyword, 'keyword'),
              ...stringField(args.company, 'company'),
              ...stringField(args.location, 'location'),
              ...stringField(args.recruitmentType, 'recruitmentType'),
              ...stringField(args.target, 'target'),
            })
            return { status: 'ok' as const, leads, count: leads.length, persistedLocally: true }
          } catch (error: unknown) {
            return { status: 'source_unavailable' as const, leads: [], count: 0, persistedLocally: false, message: stableError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_list',
        description: 'Read locally persisted JobLead snapshots. Read-only; does not contact a source or open an external page.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              leads: { type: 'array', items: LEAD, required: true },
              count: { type: 'integer', required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute() {
          if (leadStore === undefined) return { status: 'source_unavailable' as const, leads: [], count: 0, message: 'job_lead_store_unavailable' }
          try {
            const leads = leadStore.list({ limit: 50 })
            return { status: 'ok' as const, leads, count: leads.length }
          } catch (error: unknown) {
            return { status: 'source_unavailable' as const, leads: [], count: 0, message: stableError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_get',
        description: 'Read one locally persisted JobLead and its source/verification fields. Read-only; does not navigate.',
        parameters: {
          leadId: { type: 'string', required: true, description: 'Local JobLead id.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              lead: LEAD,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (leadStore === undefined) return { status: 'source_unavailable' as const, message: 'job_lead_store_unavailable' }
          try {
            const lead = leadStore.get(args.leadId)
            return lead === undefined
              ? { status: 'not_found' as const, message: 'lead_not_found' }
              : { status: 'ok' as const, lead }
          } catch (error: unknown) {
            return { status: 'source_unavailable' as const, message: stableError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_observation_list',
        description: 'Read append-only local source observations for JobLead snapshots. Read-only; never contacts GankInterview or Tencent Docs, opens a page, or changes a lead.',
        parameters: {
          limit: { type: 'integer', description: 'Maximum observations to return, from 1 to 100.' },
          sourceKind: { type: 'string', enum: ['gankinterview_campus', 'tencent_smart_sheet', 'boss_visible', 'company_career_site'] },
          since: { type: 'string', description: 'Optional ISO timestamp; includes observations at or after this time.' },
          includeUnchanged: { type: 'boolean', description: 'Include unchanged refreshes; default false returns only new/changed observations.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              observations: { type: 'array', items: LEAD_OBSERVATION, required: true },
              count: { type: 'integer', required: true },
              newCount: { type: 'integer', required: true },
              changedCount: { type: 'integer', required: true },
              unchangedCount: { type: 'integer', required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (leadStore === undefined) return { status: 'source_unavailable' as const, observations: [], count: 0, newCount: 0, changedCount: 0, unchangedCount: 0, message: 'job_lead_store_unavailable' }
          try {
            const options: Parameters<JobLeadStore['listObservations']>[0] = {
              ...numberField(args.limit, 'limit'),
              ...typeof args.sourceKind === 'string' ? { sourceKind: args.sourceKind as LeadSourceKind } : {},
              ...typeof args.since === 'string' ? { since: args.since } : {},
              ...args.includeUnchanged === true ? { includeUnchanged: true } : {},
            }
            const observations = leadStore.listObservations(options)
            return {
              status: 'ok' as const,
              observations,
              count: observations.length,
              newCount: countObservationKind(observations, 'new'),
              changedCount: countObservationKind(observations, 'changed'),
              unchangedCount: countObservationKind(observations, 'unchanged'),
            }
          } catch (error: unknown) {
            return leadObservationError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_source_status',
        description: 'Read recent local source snapshot status. Read-only; never refreshes GankInterview, Tencent Docs, BOSS, or an ATS.',
        parameters: {
          sourceKind: { type: 'string', enum: ['gankinterview_campus', 'tencent_smart_sheet', 'boss_visible', 'company_career_site'] },
          limit: { type: 'integer', description: 'Maximum source snapshots to return, from 1 to 100.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              snapshots: { type: 'json' },
              count: { type: 'integer', required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (leadStore === undefined) return { status: 'source_unavailable' as const, snapshots: [], count: 0, message: 'job_lead_store_unavailable' }
          try {
            const snapshots = leadStore.listSnapshots({
              ...numberField(args.limit, 'limit'),
              ...typeof args.sourceKind === 'string' ? { sourceKind: args.sourceKind as LeadSourceKind } : {},
            })
            return { status: 'ok' as const, snapshots: snapshots as unknown as JsonValue, count: snapshots.length }
          } catch (error: unknown) {
            return { status: 'source_unavailable' as const, snapshots: [], count: 0, message: stableError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_url_confirm',
        description: 'Confirm that the current lead\'s saved candidate link is the reviewed HTTPS official/ATS URL. Local SQLite write only; accepts no arbitrary URL and does not navigate or apply.',
        parameters: {
          leadId: { type: 'string', required: true, description: 'Local JobLead id returned by boss_watch_lead_get.' },
          contentHash: { type: 'string', required: true, description: 'Exact current lead content hash shown to the user.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: LEAD_CONFIRMATION_STATUS,
              lead: LEAD,
              verification: LEAD_VERIFICATION,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (leadStore === undefined) return { status: 'source_unavailable' as const, message: 'job_lead_store_unavailable' }
          if (hasUnexpectedKeys(args, ['leadId', 'contentHash'])) {
            return { status: 'invalid_request' as const, message: 'unexpected_lead_confirmation_parameter' }
          }
          try {
            const confirmation = leadStore.confirmCandidateUrl({
              leadId: args.leadId,
              expectedContentHash: args.contentHash,
            })
            return { status: 'ok' as const, ...confirmation }
          } catch (error: unknown) {
            return leadConfirmationError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_lead_jd_confirm',
        description: 'Record explicit human confirmation that the already URL-verified page matches this company, role, and current JD. Local SQLite write only; does not navigate, fill, send, or apply.',
        parameters: {
          leadId: { type: 'string', required: true, description: 'Local JobLead id returned by boss_watch_lead_get.' },
          contentHash: { type: 'string', required: true, description: 'Exact current lead content hash shown to the user.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: LEAD_CONFIRMATION_STATUS,
              lead: LEAD,
              verification: LEAD_VERIFICATION,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (leadStore === undefined) return { status: 'source_unavailable' as const, message: 'job_lead_store_unavailable' }
          if (hasUnexpectedKeys(args, ['leadId', 'contentHash'])) {
            return { status: 'invalid_request' as const, message: 'unexpected_lead_confirmation_parameter' }
          }
          try {
            const confirmation = leadStore.confirmJd({
              leadId: args.leadId,
              expectedContentHash: args.contentHash,
            })
            return { status: 'ok' as const, ...confirmation }
          } catch (error: unknown) {
            return leadConfirmationError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_apply_batch_prepare',
        description: 'Create a local ordered application plan from JD-verified or human-confirmed leads. Local state only; does not open a page, fill a form, send, or apply.',
        parameters: {
          leadIds: { type: 'array', items: { type: 'string' }, required: true, description: 'Lead ids in the exact user-confirmed order.' },
          sessionId: { type: 'string', description: 'Optional local planning session label.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: BATCH_STATUS,
              batch: BATCH_RUN,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (batchStore === undefined) return { status: 'source_unavailable' as const, message: 'batch_store_unavailable' }
          if (!Array.isArray(args.leadIds) || !args.leadIds.every((leadId): leadId is string => typeof leadId === 'string')) {
            return { status: 'invalid_request' as const, message: 'lead_ids_required' }
          }
          try {
            const batch = batchStore.prepare({
              leadIds: args.leadIds,
              ...stringField(args.sessionId, 'sessionId'),
            })
            return { status: 'ok' as const, batch: materializeBatch(batch) }
          } catch (error: unknown) {
            return batchError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_apply_batch_status',
        description: 'Read the latest local batch application plan, item states, failure reason and handoff checkpoint. Read-only.',
        parameters: {
          batchId: { type: 'string', required: true, description: 'Local batch id returned by boss_watch_apply_batch_prepare.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: BATCH_STATUS,
              batch: BATCH_RUN,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (batchStore === undefined) return { status: 'source_unavailable' as const, message: 'batch_store_unavailable' }
          try {
            const batch = batchStore.get(args.batchId)
            return batch === undefined
              ? { status: 'not_found' as const, message: 'batch_not_found' }
              : { status: 'ok' as const, batch: materializeBatch(batch) }
          } catch (error: unknown) {
            return batchError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_apply_batch_resume',
        description: 'Resume a paused local batch after the user has handled a platform handoff. Clears the stale checkpoint and returns the item to awaiting_gate_b; never retries or submits an external action.',
        parameters: {
          batchId: { type: 'string', required: true, description: 'Paused local batch id.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: BATCH_STATUS,
              batch: BATCH_RUN,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (batchStore === undefined) return { status: 'source_unavailable' as const, message: 'batch_store_unavailable' }
          try {
            return { status: 'ok' as const, batch: materializeBatch(batchStore.resume(args.batchId)) }
          } catch (error: unknown) {
            return batchError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_resume_import_preview',
        description: 'Preview one local PDF, DOCX, Markdown or TXT resume from the controlled resume directory. Reads bytes only to hash them; never returns resume content or writes SQLite.',
        parameters: {
          fileName: { type: 'string', required: true, description: 'File name inside the configured local resume directory; absolute paths and traversal are rejected.' },
          displayName: { type: 'string', description: 'Optional local display name for this resume version.' },
          supersedesResumeVersionId: { type: 'string', description: 'Optional existing resume version that this version supersedes.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: RESUME_STATUS,
              preview: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (resumeImport === undefined) return { status: 'source_unavailable' as const, message: 'resume_import_unavailable' }
          try {
            return {
              status: 'ok' as const,
              preview: await resumeImport.preview({
                fileName: args.fileName,
                ...typeof args.displayName === 'string' ? { displayName: args.displayName } : {},
                ...typeof args.supersedesResumeVersionId === 'string' ? { supersedesResumeVersionId: args.supersedesResumeVersionId } : {},
              }) as unknown as JsonValue,
            }
          } catch (error: unknown) {
            return resumeImportError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_resume_import_apply',
        description: 'Apply one resume import preview after explicit confirmation. Rechecks the file hash and writes only version metadata plus a content-addressed local artifact.',
        parameters: {
          previewToken: { type: 'string', required: true, description: 'Short-lived token returned by boss_watch_resume_import_preview.' },
          confirmed: { type: 'boolean', required: true, description: 'Must be true after the user confirms the file name, hash, size and version relationship.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: RESUME_STATUS,
              resumeVersion: { type: 'json' },
              reused: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (resumeImport === undefined) return { status: 'source_unavailable' as const, message: 'resume_import_unavailable' }
          if (args.confirmed !== true) return { status: 'invalid_request' as const, message: 'resume_import_confirmation_required' }
          try {
            const result = await resumeImport.apply(args.previewToken)
            return { status: 'ok' as const, resumeVersion: result.resumeVersion as unknown as JsonValue, reused: result.reused }
          } catch (error: unknown) {
            return resumeImportError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_resume_list',
        description: 'List local resume version metadata. Read-only; never returns resume content or absolute paths.',
        parameters: {
          limit: { type: 'integer', description: 'Maximum versions to return, from 1 to 100. Defaults to 20.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: RESUME_STATUS,
              versions: { type: 'json' },
              count: { type: 'integer', required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (resumeStore === undefined) return { status: 'source_unavailable' as const, versions: [], count: 0, message: 'resume_store_unavailable' }
          try {
            const versions = resumeStore.list(numberField(args.limit, 'limit'))
            return { status: 'ok' as const, versions: versions as unknown as JsonValue, count: versions.length }
          } catch (error: unknown) {
            return { ...resumeStoreError(error), versions: [], count: 0 }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_resume_get',
        description: 'Read one local resume version metadata record. Read-only; never returns resume content or absolute paths.',
        parameters: {
          resumeVersionId: { type: 'string', required: true, description: 'Resume version id returned by boss_watch_resume_list or import apply.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: RESUME_STATUS,
              resumeVersion: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (resumeStore === undefined) return { status: 'source_unavailable' as const, message: 'resume_store_unavailable' }
          try {
            const resumeVersion = resumeStore.get(args.resumeVersionId)
            return resumeVersion === undefined
              ? { status: 'not_found' as const, message: 'resume_version_not_found' }
              : { status: 'ok' as const, resumeVersion: resumeVersion as unknown as JsonValue }
          } catch (error: unknown) {
            return resumeStoreError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_apply_preview',
        description: 'Preview an official application page for one verified local lead and an existing local resume version. Read-only and local: never opens the page, reads the resume, fills fields, sends, or submits.',
        parameters: {
          leadId: { type: 'string', required: true, description: 'Local JobLead id returned by boss_watch_lead_get.' },
          resumeVersionId: { type: 'string', required: true, description: 'Existing local resume version id returned by boss_watch_resume_list or resume import apply.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: APPLY_PREVIEW_STATUS,
              preview: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (applicationPreview === undefined) return { status: 'source_unavailable' as const, message: 'application_preview_unavailable' }
          try {
            return { status: 'ok' as const, preview: applicationPreview.preview({ leadId: args.leadId, resumeVersionId: args.resumeVersionId }) as unknown as JsonValue }
          } catch (error: unknown) {
            return applicationPreviewError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_resume_match',
        description: 'Match one registered local resume against one locally captured BOSS JD. The plugin extracts and analyzes the resume locally, then returns only hashes, constraints, skill labels, score, gaps and risks; it never returns resume text or calls a model.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Application id whose full JD was already captured locally.' },
          resumeVersionId: { type: 'string', required: true, description: 'Existing local resume version id returned by boss_watch_resume_list or resume import apply.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: RESUME_MATCH_STATUS,
              match: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (resumeMatching === undefined) return { status: 'source_unavailable' as const, message: 'resume_match_unavailable' }
          try {
            return {
              status: 'ok' as const,
              match: await resumeMatching.match({
                applicationId: args.applicationId,
                resumeVersionId: args.resumeVersionId,
              }) as unknown as JsonValue,
            }
          } catch (error: unknown) {
            return resumeMatchError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_application_form_preview',
        description: 'Inspect the already-opened official/ATS form for one verified lead and classify visible fields against a registered local resume. Read-only: never navigates, returns contact values, writes DOM, uploads a resume, or submits.',
        parameters: {
          leadId: { type: 'string', required: true, description: 'Verified local JobLead id whose stored officialApplyUrl identifies the allowed page origin.' },
          resumeVersionId: { type: 'string', required: true, description: 'Existing local resume version id. Text stays inside the plugin process.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: APPLICATION_FORM_PREVIEW_STATUS,
              preview: { type: 'json' },
              handoff: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (applicationFormPreview === undefined) {
            return { status: 'source_unavailable' as const, message: 'application_form_preview_unavailable' }
          }
          try {
            const outcome = await applicationFormPreview.preview({
              leadId: args.leadId,
              resumeVersionId: args.resumeVersionId,
            })
            return outcome.status === 'ready'
              ? { status: 'ok' as const, preview: outcome.preview as unknown as JsonValue }
              : { status: 'handoff_required' as const, handoff: outcome as unknown as JsonValue }
          } catch (error: unknown) {
            return applicationFormPreviewError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_jd_diff',
        description: 'Compare two locally captured JD revisions for one application. Read-only; never opens a page, calls a model, or writes facts.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Local application id with at least two captured JD revisions.' },
          fromContentHash: { type: 'string', description: 'Optional SHA-256 hash of the older locally captured revision.' },
          toContentHash: { type: 'string', description: 'Optional SHA-256 hash of the newer locally captured revision.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              diff: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (jobDiff === undefined) return { status: 'source_unavailable' as const, message: 'jd_diff_unavailable' }
          try {
            return { status: 'ok' as const, diff: await jobDiff.diff(args) as unknown as JsonValue }
          } catch (error: unknown) {
            return jobDiffError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_watch_create',
        description: 'Create a local low-frequency JD watch from an already captured BOSS application. Does not poll immediately or open a page.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Existing local application id with a captured BOSS JD.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: WATCH_STATUS,
              watch: WATCH,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (jobWatch === undefined) return { status: 'source_unavailable' as const, message: 'job_watch_store_unavailable' }
          try {
            return { status: 'ok' as const, watch: await jobWatch.create(args.applicationId) }
          } catch (error: unknown) {
            return jobWatchError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_watch_list',
        description: 'List locally configured JD watches. Read-only; does not poll or open a browser page.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: WATCH_STATUS,
              watches: { type: 'array', items: WATCH, required: true },
              count: { type: 'integer', required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute() {
          if (jobWatch === undefined) return { status: 'source_unavailable' as const, watches: [], count: 0, message: 'job_watch_store_unavailable' }
          try {
            const watches = [...jobWatch.list()]
            return { status: 'ok' as const, watches: [...watches], count: watches.length }
          } catch (error: unknown) {
            return { ...jobWatchError(error), watches: [], count: 0 }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_watch_poll',
        description: 'Poll one due local JD watch through the fixed stored BOSS URL. Applies interval, daily budget, and human handoff guards.',
        parameters: {
          watchId: { type: 'string', required: true, description: 'Local watch id returned by boss_watch_watch_create.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: WATCH_STATUS,
              result: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (jobWatch === undefined) return { status: 'source_unavailable' as const, message: 'job_watch_store_unavailable' }
          try {
            return { status: 'ok' as const, result: await jobWatch.poll(args.watchId) as unknown as JsonValue }
          } catch (error: unknown) {
            return jobWatchError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_watch_run_due',
        description: 'Run one explicit bounded pass over due local JD watches. Never starts a background loop; stops on handoff, transient failure, shared budget, or cancellation.',
        parameters: {
          limit: { type: 'integer', description: 'Maximum due watches in this pass. Defaults to 5 and cannot exceed 5.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: WATCH_STATUS,
              run: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args, exec) {
          if (jobWatchScheduler === undefined) return { status: 'source_unavailable' as const, message: 'job_watch_scheduler_unavailable' }
          if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5)) {
            return { status: 'invalid_request' as const, message: 'invalid_watch_scheduler_limit' }
          }
          try {
            return {
              status: 'ok' as const,
              run: await jobWatchScheduler.runDue({
                ...args.limit === undefined ? {} : { limit: args.limit },
                signal: exec.signal,
              }) as unknown as JsonValue,
            }
          } catch (error: unknown) {
            return jobWatchError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_watch_stop',
        description: 'Stop a local JD watch. This only changes local watch state and never opens a page.',
        parameters: {
          watchId: { type: 'string', required: true, description: 'Local watch id.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: WATCH_STATUS,
              watch: WATCH,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (jobWatch === undefined) return { status: 'source_unavailable' as const, message: 'job_watch_store_unavailable' }
          try {
            return { status: 'ok' as const, watch: jobWatch.stop(args.watchId) }
          } catch (error: unknown) {
            return jobWatchError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_watch_resume',
        description: 'Resume a paused local JD watch after the user handles login, verification, risk, or adapter handoff. Does not poll automatically.',
        parameters: {
          watchId: { type: 'string', required: true, description: 'Paused local watch id.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: WATCH_STATUS,
              watch: WATCH,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (jobWatch === undefined) return { status: 'source_unavailable' as const, message: 'job_watch_store_unavailable' }
          try {
            return { status: 'ok' as const, watch: jobWatch.resume(args.watchId) }
          } catch (error: unknown) {
            return jobWatchError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_job_list',
        description: 'List locally captured job descriptions. Read-only; never visits or applies to an external site.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              jobs: { type: 'array', items: JOB, required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute() {
          try {
            return { status: 'ok' as const, jobs: await source.listJobs(20) }
          } catch (error: unknown) {
            return { status: 'source_unavailable' as const, jobs: [], message: stableError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_job_get',
        description: 'Read one locally captured job description by application id. Read-only.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Local application id.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              job: JOB_DETAILS,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          try {
            const job = await source.getJob(args.applicationId)
            return job === undefined
              ? { status: 'not_found' as const, message: 'application_not_found' }
              : { status: 'ok' as const, job }
          } catch (error: unknown) {
            return { status: 'source_unavailable' as const, message: stableError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_application_timeline',
        description: 'Read the append-only local application timeline. Read-only; does not change status.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Local application id.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              events: { type: 'array', items: EVENT, required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          try {
            return { status: 'ok' as const, events: await source.listTimeline(args.applicationId) }
          } catch (error: unknown) {
            return { status: 'source_unavailable' as const, events: [], message: stableError(error) }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_feishu_preview',
        description: 'Build a read-only Feishu Bitable field preview from local facts. Never writes to Feishu and always requires separate approval.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Local application id.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: STATUS,
              target: { type: 'string', required: true },
              fields: FEISHU_FIELDS,
              timelineEventCount: { type: 'integer', required: true },
              requiresApproval: { type: 'boolean', required: true },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          try {
            const job = await source.getJob(args.applicationId)
            if (job === undefined) {
              return {
                status: 'not_found' as const,
                target: 'feishu_bitable_preview',
                timelineEventCount: 0,
                requiresApproval: true,
                message: 'application_not_found',
              }
            }
            const events = await source.listTimeline(args.applicationId)
            return {
              status: 'ok' as const,
              target: 'feishu_bitable_preview',
              fields: {
                applicationId: job.applicationId,
                company: job.company,
                role: job.role,
                ...job.jobUrl === undefined ? {} : { jobUrl: job.jobUrl },
                capturedAt: job.capturedAt,
                contentHash: job.contentHash,
                description: job.description,
              },
              timelineEventCount: events.length,
              requiresApproval: true,
            }
          } catch (error: unknown) {
            return {
              status: 'source_unavailable' as const,
              target: 'feishu_bitable_preview',
              timelineEventCount: 0,
              requiresApproval: true,
              message: stableError(error),
            }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_feishu_target_preview',
        description: 'Resolve a Feishu Base link and preview its table, view, fields, and automatic mapping. Read-only; never writes Feishu.',
        parameters: {
          url: { type: 'string', required: true, description: 'Feishu Base or Wiki URL supplied by the user.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: FEISHU_PROJECTION_STATUS,
              preview: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (feishuProjection === undefined) return { status: 'source_unavailable' as const, message: 'feishu_projection_unavailable' }
          try {
            return { status: 'ok' as const, preview: await feishuProjection.targetPreview(args.url) as unknown as JsonValue }
          } catch (error: unknown) {
            return feishuProjectionError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_feishu_target_confirm',
        description: 'Persist a previously previewed Feishu target and field mapping locally after explicit confirmation. Does not write Feishu records.',
        parameters: {
          previewToken: { type: 'string', required: true, description: 'Short-lived token returned by boss_watch_feishu_target_preview.' },
          confirmed: { type: 'boolean', required: true, description: 'Must be true after the user confirms the target and mapping.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: FEISHU_PROJECTION_STATUS,
              target: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (feishuProjection === undefined) return { status: 'source_unavailable' as const, message: 'feishu_projection_unavailable' }
          try {
            const confirmed = feishuProjection.confirmTarget(args.previewToken, args.confirmed)
            return { status: 'ok' as const, target: confirmed.target as unknown as JsonValue }
          } catch (error: unknown) {
            return feishuProjectionError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_feishu_sync_preview',
        description: 'Compare local applications with a confirmed Feishu target and preview create/update/unchanged/conflict changes. Read-only.',
        parameters: {
          targetId: { type: 'string', required: true, description: 'Local Feishu target id returned by target confirmation.' },
          applicationIds: { type: 'array', items: { type: 'string' }, required: true, description: 'Local application ids to project, in user-confirmed order.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: FEISHU_PROJECTION_STATUS,
              preview: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (feishuProjection === undefined) return { status: 'source_unavailable' as const, message: 'feishu_projection_unavailable' }
          try {
            return { status: 'ok' as const, preview: await feishuProjection.syncPreview(args.targetId, args.applicationIds) as unknown as JsonValue }
          } catch (error: unknown) {
            return feishuProjectionError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_feishu_sync_apply',
        description: 'Apply one exact Feishu sync preview after explicit confirmation. Writes only the previewed records and fields.',
        parameters: {
          previewToken: { type: 'string', required: true, description: 'Short-lived token returned by boss_watch_feishu_sync_preview.' },
          confirmed: { type: 'boolean', required: true, description: 'Must be true after the user confirms the exact create/update counts and fields.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: FEISHU_PROJECTION_STATUS,
              result: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (feishuProjection === undefined) return { status: 'source_unavailable' as const, message: 'feishu_projection_unavailable' }
          try {
            return { status: 'ok' as const, result: await feishuProjection.syncApply(args.previewToken, args.confirmed) as unknown as JsonValue }
          } catch (error: unknown) {
            return feishuProjectionError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_capture_discovered_job',
        description: 'Open and capture one exact BOSS job returned by boss_watch_discover_jobs. Read-only navigation; never sends or applies.',
        parameters: {
          discoveryId: { type: 'string', required: true, description: 'Short-lived id returned by boss_watch_discover_jobs.' },
          externalJobId: { type: 'string', required: true, description: 'Exact external job id returned in the selected discovery result.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: BROWSER_DISCOVERED_CAPTURE_STATUS,
              reason: { type: 'string' },
              targetCount: { type: 'integer' },
              applicationId: { type: 'string' },
              eventId: { type: 'string' },
              artifactId: { type: 'string' },
              artifactRef: { type: 'string' },
              contentHash: { type: 'string' },
              savedAt: { type: 'string' },
              deduplicated: { type: 'boolean' },
              job: { type: 'json' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (browser === undefined) {
            return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          }
          try {
            return await browser.captureDiscoveredJob(args.discoveryId, args.externalJobId)
          } catch {
            return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_browser_status',
        description: 'Check the local BossHunter browser runtime and supported BOSS job tab. Read-only; never clicks, navigates, or sends.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: BROWSER_STATUS,
              reason: { type: 'string' },
              targetCount: { type: 'integer', required: true },
              target: BROWSER_TARGET,
            },
          },
          render: renderJson,
        },
        async execute() {
          if (browser === undefined) return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          try {
            return await browser.status()
          } catch {
            return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_capture_current_job',
        description: 'Capture the currently open unique BOSS job detail page through the local Controller. It never clicks, navigates, sends, or applies.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: BROWSER_CAPTURE_STATUS,
              reason: { type: 'string' },
              targetCount: { type: 'integer' },
              applicationId: { type: 'string' },
              eventId: { type: 'string' },
              artifactId: { type: 'string' },
              artifactRef: { type: 'string' },
              contentHash: { type: 'string' },
              savedAt: { type: 'string' },
              deduplicated: { type: 'boolean' },
              job: { type: 'json' },
            },
          },
          render: renderJson,
        },
        async execute() {
          if (browser === undefined) return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          try {
            return await browser.captureCurrentJob()
          } catch {
            return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_capture_current_conversation',
        description: 'Capture the latest visible recruiter message from the unique selected BOSS conversation. Read-only; never replies, clicks, or sends.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Existing local application id that this conversation belongs to.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: BROWSER_CONVERSATION_CAPTURE_STATUS,
              reason: { type: 'string' },
              targetCount: { type: 'integer' },
              applicationId: { type: 'string' },
              eventId: { type: 'string' },
              artifactId: { type: 'string' },
              artifactRef: { type: 'string' },
              contentHash: { type: 'string' },
              savedAt: { type: 'string' },
              deduplicated: { type: 'boolean' },
              conversation: BROWSER_CONVERSATION,
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (browser?.captureCurrentConversation === undefined) {
            return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          }
          try {
            return await browser.captureCurrentConversation(args.applicationId)
          } catch {
            return { status: 'environment_interrupted' as const, reason: 'controller_unavailable', targetCount: 0 }
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_progress_signal_preview',
        description: 'Classify pasted recruiting text or a staged .eml/.txt file locally. Returns hashes and a status proposal without writing SQLite or Feishu.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Existing local application id.' },
          sourceKind: {
            type: 'string',
            required: true,
            enum: ['recruitment_email', 'interview_invitation', 'recruiter_message', 'manual_update'],
            description: 'Observed signal source. manual_update requires a human-declared outcome.',
          },
          content: { type: 'string', description: 'Pasted recruiting evidence. Mutually exclusive with stagedFileName.' },
          stagedFileName: { type: 'string', description: 'Controlled staged .eml/.txt file name returned by the DSH import button.' },
          sourceHash: { type: 'string', description: 'SHA-256 returned by the DSH import button; required with stagedFileName.' },
          declaredOutcome: {
            type: 'string',
            enum: ['interview', 'rejected', 'offer', 'needs_review'],
            description: 'Only for a user-explicit manual_update; never infer or fill this from page content.',
          },
          observedAt: { type: 'string', description: 'Optional ISO timestamp for when the signal was observed.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: PROGRESS_SIGNAL_STATUS,
              preview: PROGRESS_SIGNAL_PREVIEW,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (progressSignalClient === undefined) {
            return { status: 'source_unavailable' as const, message: 'progress_signal_client_unavailable' }
          }
          const common = {
            applicationId: args.applicationId,
            sourceKind: args.sourceKind as ProgressSignalSourceKind,
            ...typeof args.observedAt === 'string' ? { observedAt: args.observedAt } : {},
            ...typeof args.declaredOutcome === 'string'
              ? { declaredOutcome: args.declaredOutcome as ProgressSignalOutcome }
              : {},
          }
          let input: ProgressSignalPreviewInput
          if (typeof args.content === 'string') {
            input = { ...common, content: args.content }
          } else if (typeof args.stagedFileName === 'string' && typeof args.sourceHash === 'string') {
            input = { ...common, stagedFileName: args.stagedFileName, sourceHash: args.sourceHash }
          } else {
            return { status: 'invalid_request' as const, message: 'progress_signal_source_required' }
          }
          try {
            return { status: 'ok' as const, preview: await progressSignalClient.preview(input) }
          } catch (error: unknown) {
            return progressSignalError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_progress_signal_apply',
        description: 'Record exactly one previewed progress signal after explicit confirmation. Appends local evidence and, when supported, a status proposal; never writes Feishu or performs an external action.',
        parameters: {
          previewToken: { type: 'string', required: true, description: 'Short-lived token returned by boss_watch_progress_signal_preview.' },
          confirmed: { type: 'boolean', required: true, description: 'Must be true after the user confirms application, source, hash and proposed outcome.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: PROGRESS_SIGNAL_STATUS,
              result: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (progressSignalClient === undefined) {
            return { status: 'source_unavailable' as const, message: 'progress_signal_client_unavailable' }
          }
          try {
            return {
              status: 'ok' as const,
              result: await progressSignalClient.apply(args.previewToken, args.confirmed) as unknown as JsonValue,
            }
          } catch (error: unknown) {
            return progressSignalError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_interview_note_preview',
        description: 'Preview a manually entered interview note for one existing application. Does not write SQLite until the matching apply call is confirmed.',
        parameters: {
          applicationId: { type: 'string', required: true, description: 'Existing local application id.' },
          interviewId: { type: 'string', required: true, description: 'User-defined stable interview identifier.' },
          stage: { type: 'string', required: true, enum: ['screening', 'first_interview', 'second_interview', 'final_interview', 'other'] },
          content: { type: 'string', required: true, description: 'Interview notes entered by the user.' },
          occurredAt: { type: 'string', description: 'Optional ISO time of the interview or note.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: INTERVIEW_NOTE_STATUS,
              preview: INTERVIEW_NOTE_PREVIEW,
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (interviewNoteClient === undefined) return { status: 'source_unavailable' as const, message: 'interview_note_client_unavailable' }
          try {
            const preview = await interviewNoteClient.preview({
              applicationId: args.applicationId,
              interviewId: args.interviewId,
              stage: args.stage as InterviewNoteStage,
              content: args.content,
              ...typeof args.occurredAt === 'string' ? { occurredAt: args.occurredAt } : {},
            })
            return { status: 'ok' as const, preview }
          } catch (error: unknown) {
            return interviewNoteError(error)
          }
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'boss_watch_interview_note_apply',
        description: 'Apply exactly one interview-note preview after the user confirms the application, interview id, stage and hash. Writes only the previewed local evidence.',
        parameters: {
          previewToken: { type: 'string', required: true, description: 'Short-lived token returned by boss_watch_interview_note_preview.' },
          confirmed: { type: 'boolean', required: true, description: 'Must be true after explicit user confirmation.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: INTERVIEW_NOTE_STATUS,
              result: { type: 'json' },
              message: { type: 'string' },
            },
          },
          render: renderJson,
        },
        async execute(args) {
          if (interviewNoteClient === undefined) return { status: 'source_unavailable' as const, message: 'interview_note_client_unavailable' }
          try {
            return {
              status: 'ok' as const,
              result: await interviewNoteClient.apply(args.previewToken, args.confirmed) as unknown as JsonValue,
            }
          } catch (error: unknown) {
            return interviewNoteError(error)
          }
        },
      }),
    ),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}

function stableError(error: unknown): string {
  if (error instanceof Error && error.message === 'source_unavailable') return 'boss_watch_source_unavailable'
  if (error instanceof Error && error.message === 'source_corrupt_event') return 'boss_watch_source_corrupt'
  if (error instanceof Error && error.message === 'gankinterview_unauthorized') return 'gankinterview_unauthorized'
  if (error instanceof Error && error.message === 'gankinterview_rate_limited') return 'gankinterview_rate_limited'
  if (error instanceof Error && error.message === 'gankinterview_unavailable') return 'gankinterview_unavailable'
  if (error instanceof Error && error.message === 'gankinterview_invalid_response') return 'gankinterview_invalid_response'
  return 'boss_watch_read_failed'
}

function interviewNoteError(error: unknown): {
  status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'
  message: string
} {
  const message = error instanceof Error ? error.message : 'interview_note_failed'
  if (message === 'application_not_found' || message === 'interview_note_preview_not_found') {
    return { status: 'not_found', message }
  }
  if (message === 'confirmation_required' || message === 'interview_note_timestamp') {
    return { status: 'conflict', message }
  }
  if (message.startsWith('invalid_interview_note')) return { status: 'invalid_request', message }
  return { status: 'source_unavailable', message: message === 'controller_unavailable' ? message : 'interview_note_unavailable' }
}

function progressSignalError(error: unknown): {
  status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'
  message: string
} {
  const message = error instanceof Error ? error.message : 'progress_signal_failed'
  if (message === 'application_not_found' || message === 'progress_signal_preview_not_found' || message === 'progress_signal_file_not_found') {
    return { status: 'not_found', message }
  }
  if (message === 'confirmation_required' || message === 'progress_signal_file_hash_mismatch') {
    return { status: 'conflict', message }
  }
  if (
    message.startsWith('invalid_progress_signal')
    || message.startsWith('progress_signal_source')
    || message.startsWith('progress_signal_email')
  ) {
    return { status: 'invalid_request', message }
  }
  return { status: 'source_unavailable', message: message === 'controller_unavailable' ? message : 'progress_signal_unavailable' }
}

function leadImportError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string; details?: string[] } {
  const message = error instanceof Error ? error.message : 'lead_import_failed'
  const notFound = new Set(['preview_not_found', 'import_file_not_found', 'sheet_not_found'])
  const conflict = new Set(['preview_stale', 'import_in_progress', 'snapshot_id_conflict', 'clipboard_changed_since_preview'])
  const invalid = new Set([
    'invalid_source_ref',
    'file_outside_import_root',
    'file_too_large',
    'unsupported_file_type',
    'empty_workbook',
    'sheet_selection_required',
    'row_limit_exceeded',
    'header_row_missing',
    'duplicate_header',
    'mapping_required',
    'mapping_conflict',
    'clipboard_empty',
  ])
  const status = notFound.has(message)
    ? 'not_found' as const
    : conflict.has(message)
      ? 'conflict' as const
      : invalid.has(message)
        ? 'invalid_request' as const
        : 'source_unavailable' as const
  return {
    status,
    message,
    ...error instanceof LeadImportError && error.details !== undefined ? { details: [...error.details] } : {},
  }
}

function visualLeadImportError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string } {
  const message = error instanceof Error ? error.message : 'visual_lead_import_failed'
  const notFound = new Set(['visual_preview_not_found'])
  const conflict = new Set(['visual_preview_stale', 'visual_source_changed', 'visual_import_in_progress'])
  const invalid = new Set(['invalid_visual_source', 'invalid_visual_rows', 'invalid_visual_headers'])
  return {
    status: notFound.has(message)
      ? 'not_found'
      : conflict.has(message)
        ? 'conflict'
        : invalid.has(message)
          ? 'invalid_request'
          : 'source_unavailable',
    message,
  }
}

function feishuProjectionError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string } {
  const message = error instanceof Error ? error.message : 'feishu_projection_failed'
  const notFound = new Set(['feishu_target_not_found', 'feishu_preview_not_found', 'feishu_table_not_found'])
  const conflict = new Set([
    'feishu_schema_changed',
    'feishu_preview_stale',
    'feishu_confirmation_required',
    'feishu_preview_kind_mismatch',
    'feishu_record_conflict:job_url',
    'feishu_record_conflict:company_role',
    'feishu_mapping_incomplete',
  ])
  const invalid = new Set([
    'feishu_url_unresolvable',
    'invalid_target_id',
    'invalid_preview_token',
    'invalid_application_id',
    'invalid_application_ids',
    'duplicate_application_id',
    'feishu_table_required',
    'feishu_mapping_incomplete',
  ])
  if (notFound.has(message)) return { status: 'not_found', message }
  if (conflict.has(message)) return { status: 'conflict', message }
  if (invalid.has(message)) return { status: 'invalid_request', message }
  return { status: 'source_unavailable', message }
}

function jobWatchError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string } {
  const message = error instanceof Error ? error.message : 'job_watch_failed'
  const notFound = new Set(['watch_not_found', 'watch_application_not_found'])
  const conflict = new Set([
    'watch_stopped',
    'watch_paused',
    'watch_not_paused',
    'watch_poll_in_progress',
    'watch_profile_busy',
    'watch_poll_not_started',
    'watch_not_due',
    'watch_daily_budget_exhausted',
    'watch_scheduler_in_progress',
  ])
  const invalid = new Set([
    'watch_job_url_missing',
    'watch_unsupported_job_url',
    'invalid_watch_id',
    'invalid_application_id',
    'invalid_watch_scheduler_limit',
  ])
  if (notFound.has(message)) return { status: 'not_found', message }
  if (conflict.has(message)) return { status: 'conflict', message }
  if (invalid.has(message)) return { status: 'invalid_request', message }
  return { status: 'source_unavailable', message }
}

function jobDiffError(error: unknown): { status: 'invalid_request' | 'not_found' | 'source_unavailable'; message: string } {
  const message = error instanceof Error ? error.message : 'jd_diff_failed'
  const notFound = new Set(['jd_diff_baseline_missing', 'jd_diff_revision_not_found'])
  const invalid = new Set(['invalid_application_id', 'invalid_jd_diff_from_content_hash', 'invalid_jd_diff_to_content_hash'])
  if (notFound.has(message)) return { status: 'not_found', message }
  if (invalid.has(message)) return { status: 'invalid_request', message }
  return { status: 'source_unavailable', message }
}

function applicationPreviewError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string } {
  const message = error instanceof Error ? error.message : 'application_preview_failed'
  if (message === 'apply_lead_not_found' || message === 'apply_resume_not_found') return { status: 'not_found', message }
  if (message === 'apply_lead_not_verified') return { status: 'conflict', message }
  if (new Set(['apply_official_url_missing', 'apply_official_url_invalid', 'invalid_resume_version_id', 'invalid_lead_id']).has(message)) {
    return { status: 'invalid_request', message }
  }
  return { status: 'source_unavailable', message }
}

function applicationFormPreviewError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string } {
  const message = error instanceof Error ? error.message : 'application_form_preview_failed'
  const notFound = new Set([
    'application_form_lead_not_found',
    'application_form_resume_not_found',
    'resume_version_not_found',
    'resume_artifact_not_found',
  ])
  const conflict = new Set([
    'application_form_lead_not_verified',
    'application_form_resume_identity_mismatch',
    'resume_artifact_hash_mismatch',
    'resume_artifact_path_invalid',
    'resume_text_empty',
  ])
  const invalid = new Set([
    'invalid_lead_id',
    'invalid_resume_version_id',
    'application_form_official_url_missing',
    'application_form_official_url_invalid',
  ])
  const unavailable = new Set([
    'controller_unavailable',
    'resume_text_extraction_unavailable',
    'resume_text_extraction_failed',
    'unsupported_resume_text_type',
    'sqlite_resume_store_closed',
  ])
  if (notFound.has(message)) return { status: 'not_found', message }
  if (conflict.has(message)) return { status: 'conflict', message }
  if (invalid.has(message)) return { status: 'invalid_request', message }
  if (unavailable.has(message)) return { status: 'source_unavailable', message }
  return { status: 'source_unavailable', message: 'application_form_preview_failed' }
}

function resumeImportError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string } {
  const message = error instanceof Error ? error.message : 'resume_import_failed'
  const notFound = new Set(['resume_preview_not_found', 'resume_file_not_found', 'resume_supersedes_not_found'])
  const conflict = new Set(['resume_preview_stale', 'resume_import_in_progress', 'resume_artifact_hash_conflict'])
  const invalid = new Set([
    'invalid_resume_file_name',
    'unsupported_resume_file_type',
    'file_outside_resume_root',
    'resume_file_symlink_not_allowed',
    'resume_file_empty',
    'resume_file_too_large',
    'invalid_resume_display_name',
    'invalid_resume_version_id',
    'resume_import_confirmation_required',
  ])
  if (notFound.has(message)) return { status: 'not_found', message }
  if (conflict.has(message)) return { status: 'conflict', message }
  if (invalid.has(message)) return { status: 'invalid_request', message }
  return { status: 'source_unavailable', message }
}

function resumeStoreError(error: unknown): { status: 'invalid_request' | 'source_unavailable'; message: string } {
  const message = error instanceof Error ? error.message : 'resume_store_failed'
  if (message === 'invalid_resume_version_id' || message === 'invalid_resume_version_limit') {
    return { status: 'invalid_request', message }
  }
  return { status: 'source_unavailable', message }
}

function resumeMatchError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string } {
  const message = error instanceof Error ? error.message : 'resume_match_failed'
  const notFound = new Set(['resume_match_job_not_found', 'resume_version_not_found', 'resume_artifact_not_found'])
  const conflict = new Set(['resume_artifact_hash_mismatch', 'resume_artifact_path_invalid', 'resume_text_empty'])
  const invalid = new Set(['invalid_application_id', 'invalid_resume_version_id'])
  if (notFound.has(message)) return { status: 'not_found', message }
  if (conflict.has(message)) return { status: 'conflict', message }
  if (invalid.has(message)) return { status: 'invalid_request', message }
  return { status: 'source_unavailable', message }
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined
  return value.map((entry) => entry.trim()).filter(Boolean)
}

function normalizeVisualRows(value: unknown): VisualLeadRowInput[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows: VisualLeadRowInput[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    if (
      ('rowNumber' in entry && typeof entry.rowNumber !== 'number')
      || ('company' in entry && typeof entry.company !== 'string')
      || ('role' in entry && typeof entry.role !== 'string')
      || ('city' in entry && typeof entry.city !== 'string')
      || ('cohort' in entry && typeof entry.cohort !== 'string')
      || ('recruitmentType' in entry && typeof entry.recruitmentType !== 'string')
      || ('deadline' in entry && typeof entry.deadline !== 'string')
      || ('channelUrl' in entry && typeof entry.channelUrl !== 'string')
      || ('sourceUpdatedAt' in entry && typeof entry.sourceUpdatedAt !== 'string')
      || ('confidence' in entry
        && typeof entry.confidence !== 'number'
        && entry.confidence !== 'high'
        && entry.confidence !== 'medium'
        && entry.confidence !== 'low')
    ) return undefined
    const row: VisualLeadRowInput = {
      ...typeof entry.rowNumber === 'number' ? { rowNumber: entry.rowNumber } : {},
      ...typeof entry.company === 'string' ? { company: entry.company } : {},
      ...typeof entry.role === 'string' ? { role: entry.role } : {},
      ...typeof entry.city === 'string' ? { city: entry.city } : {},
      ...typeof entry.cohort === 'string' ? { cohort: entry.cohort } : {},
      ...typeof entry.recruitmentType === 'string' ? { recruitmentType: entry.recruitmentType } : {},
      ...typeof entry.deadline === 'string' ? { deadline: entry.deadline } : {},
      ...typeof entry.channelUrl === 'string' ? { channelUrl: entry.channelUrl } : {},
      ...typeof entry.sourceUpdatedAt === 'string' ? { sourceUpdatedAt: entry.sourceUpdatedAt } : {},
      ...typeof entry.confidence === 'number' || entry.confidence === 'high' || entry.confidence === 'medium' || entry.confidence === 'low'
        ? { confidence: entry.confidence }
        : {},
    }
    rows.push(row)
  }
  return rows
}

function normalizeImportColumnMapping(value: Record<string, unknown>): ImportColumnMapping {
  const allowed = new Set(['company', 'role', 'city', 'cohort', 'recruitmentType', 'deadline', 'channelUrl', 'sourceUpdatedAt'])
  const mapping: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key) || typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error('mapping_conflict')
    }
    mapping[key] = entry.trim()
  }
  return mapping as ImportColumnMapping
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function batchError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string } {
  if (!(error instanceof Error)) return { status: 'source_unavailable', message: 'boss_watch_batch_read_failed' }
  if (error.message === 'lead_not_found' || error.message === 'batch_not_found' || error.message === 'batch_item_not_found') {
    return { status: 'not_found', message: error.message }
  }
  if (error.message === 'lead_not_verified' || error.message === 'lead_content_changed' || error.message === 'batch_not_paused' || error.message === 'checkpoint_not_resumable' || error.message === 'invalid_item_transition') {
    return { status: 'conflict', message: error.message }
  }
  if (error.message.startsWith('sqlite_batch_store_') || error.message === 'source_corrupt_batch_json') {
    return { status: 'source_unavailable', message: error.message }
  }
  return { status: 'invalid_request', message: error.message }
}

function leadConfirmationError(error: unknown): { status: 'invalid_request' | 'not_found' | 'conflict' | 'source_unavailable'; message: string } {
  if (!(error instanceof Error)) return { status: 'source_unavailable', message: 'boss_watch_lead_confirmation_failed' }
  if (error.message === 'lead_not_found') return { status: 'not_found', message: error.message }
  if (error.message === 'lead_content_changed' || error.message === 'lead_url_not_verified') {
    return { status: 'conflict', message: error.message }
  }
  if (error.message === 'sqlite_lead_store_closed' || error.message === 'lead_confirmation_write_failed') {
    return { status: 'source_unavailable', message: error.message }
  }
  const invalid = new Set([
    'invalid_lead_id',
    'invalid_job_lead_hash',
    'invalid_lead_confirmation_timestamp',
    'lead_candidate_url_missing',
    'lead_candidate_url_invalid',
    'lead_candidate_url_not_https',
  ])
  return invalid.has(error.message)
    ? { status: 'invalid_request', message: error.message }
    : { status: 'source_unavailable', message: 'boss_watch_lead_confirmation_failed' }
}

function leadObservationError(error: unknown): { status: 'invalid_request' | 'source_unavailable'; observations: JobLeadObservation[]; count: number; newCount: number; changedCount: number; unchangedCount: number; message: string } {
  const message = error instanceof Error ? error.message : 'boss_watch_lead_observation_failed'
  const invalid = new Set(['invalid_lead_observation_limit', 'invalid_lead_source_kind', 'invalid_lead_observation_since'])
  return {
    status: invalid.has(message) ? 'invalid_request' : 'source_unavailable',
    observations: [],
    count: 0,
    newCount: 0,
    changedCount: 0,
    unchangedCount: 0,
    message: invalid.has(message) ? message : 'boss_watch_lead_observation_failed',
  }
}

function countObservationKind(observations: readonly JobLeadObservation[], kind: JobLeadObservation['changeKind']): number {
  return observations.filter((observation) => observation.changeKind === kind).length
}

function isFollowUpReason(value: unknown): value is FollowUpReason {
  return value === 'application_status' || value === 'no_response' || value === 'interview' || value === 'manual'
}

function followUpUrgency(dueAt: string, asOf: string): 'overdue' | 'due' | 'upcoming' {
  const due = Date.parse(dueAt)
  const reference = Date.parse(asOf)
  if (!Number.isFinite(due) || !Number.isFinite(reference)) throw new Error('invalid_follow_up_timestamp')
  if (due < reference) return 'overdue'
  if (due === reference) return 'due'
  return 'upcoming'
}

function followUpNextAction(reason: FollowUpReason): string {
  switch (reason) {
    case 'application_status': return '核对本地投递状态和最近事件'
    case 'no_response': return '人工判断是否需要跟进，不自动发送消息'
    case 'interview': return '核对面试时间并准备面试，不自动接受邀请'
    case 'manual': return '按本地备注处理'
  }
}

function followUpError(error: unknown): string {
  if (error instanceof Error) {
    const allowed = new Set([
      'invalid_application_id',
      'invalid_follow_up_due_at',
      'invalid_follow_up_timestamp',
      'invalid_follow_up_reason',
      'invalid_follow_up_note',
      'invalid_follow_up_limit',
      'invalid_follow_up_id',
      'follow_up_not_found',
    ])
    if (allowed.has(error.message)) return error.message
  }
  return 'boss_watch_follow_up_failed'
}

function followUpInputError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return new Set([
    'invalid_application_id',
    'invalid_follow_up_due_at',
    'invalid_follow_up_timestamp',
    'invalid_follow_up_reason',
    'invalid_follow_up_note',
    'invalid_follow_up_limit',
    'invalid_follow_up_id',
  ]).has(error.message)
}

function materializeBatch(batch: import('./application-batch.js').BatchApplicationRun): import('./application-batch.js').BatchApplicationRun {
  return { ...batch, items: [...batch.items] }
}

function stringField(value: unknown, key: string): Record<string, string> {
  return typeof value === 'string' && value.trim().length > 0 ? { [key]: value } : {}
}

function numberField(value: unknown, key: string): Record<string, number> {
  return typeof value === 'number' && Number.isInteger(value) ? { [key]: value } : {}
}

function hasUnexpectedKeys(value: object, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).some((key) => !allowedKeys.has(key))
}
