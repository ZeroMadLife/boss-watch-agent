import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type {
  ApplicationOverview,
  BossWatchDataSource,
  JobDetails,
  JobRevision,
  JobSummary,
  JsonValue,
  ProgressState,
  TimelineEvent,
} from './domain.js'

interface JobRow {
  application_id: string
  event_json: string
  content: string
  content_hash: string
  artifact_ref: string
  created_at: string
}

interface TimelineRow {
  sequence: number
  event_id: string
  application_id: string
  event_type: string
  occurred_at: string
  actor: string
  event_json: string
}

interface CapturedJobEvent {
  payload?: JsonValue
}

export class SqliteBossWatchDataSource implements BossWatchDataSource {
  readonly #databasePath: string

  constructor(databasePath: string) {
    if (databasePath.trim().length === 0) throw new Error('invalid_database_path')
    this.#databasePath = databasePath
  }

  async countJobs(): Promise<number> {
    return this.#withDatabase((database) => {
      const row = database.prepare(`
        SELECT COUNT(DISTINCT application_id) AS count
        FROM application_events
        WHERE event_type = 'job_description_captured'
      `).get() as unknown as { count: number }
      return row.count
    })
  }

  async listJobs(limit: number): Promise<JobSummary[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_job_limit')
    return this.#withDatabase((database) => {
      const rows = database
        .prepare(
          `SELECT application_id, event_json, content, content_hash, artifact_ref, created_at
           FROM (
             SELECT e.application_id, e.event_json, a.content, a.content_hash, a.artifact_ref, a.created_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY e.application_id
                      ORDER BY e.sequence DESC, a.created_at DESC, e.event_id DESC
                    ) AS application_rank
             FROM application_events e
             JOIN application_artifacts a ON a.artifact_id = e.artifact_id
             WHERE e.event_type = 'job_description_captured'
           )
           WHERE application_rank = 1
           ORDER BY created_at DESC, application_id ASC
           LIMIT ?`,
        )
        .all(limit) as unknown as JobRow[]
      return rows.map(toJobSummary)
    })
  }

  async listApplicationOverviews(limit: number): Promise<ApplicationOverview[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_job_limit')
    const jobs = await this.listJobs(limit)
    const seen = new Set<string>()
    const overviews: ApplicationOverview[] = []
    for (const job of jobs) {
      if (seen.has(job.applicationId)) continue
      seen.add(job.applicationId)
      const timeline = await this.listTimeline(job.applicationId)
      overviews.push(toApplicationOverview(job, timeline))
    }
    return overviews
  }

  async getApplicationOverview(applicationId: string): Promise<ApplicationOverview | undefined> {
    const job = await this.getJob(applicationId)
    if (job === undefined) return undefined
    const summary: JobSummary = {
      applicationId: job.applicationId,
      company: job.company,
      role: job.role,
      ...job.jobUrl === undefined ? {} : { jobUrl: job.jobUrl },
      capturedAt: job.capturedAt,
      contentHash: job.contentHash,
    }
    return toApplicationOverview(summary, await this.listTimeline(job.applicationId))
  }

  async getJob(applicationId: string): Promise<JobDetails | undefined> {
    const normalized = applicationId.trim()
    if (normalized.length === 0) throw new Error('invalid_application_id')
    return this.#withDatabase((database) => {
      const row = database
        .prepare(
          `SELECT e.application_id, e.event_json, a.content, a.content_hash, a.artifact_ref, a.created_at
           FROM application_events e
           JOIN application_artifacts a ON a.artifact_id = e.artifact_id
           WHERE e.application_id = ? AND e.event_type = 'job_description_captured'
           ORDER BY e.sequence DESC, a.created_at DESC
           LIMIT 1`,
        )
        .get(normalized) as unknown as JobRow | undefined
      if (row === undefined) return undefined
      const summary = toJobSummary(row)
      return { ...summary, description: row.content, artifactRef: row.artifact_ref }
    })
  }

  async listJobRevisions(applicationId: string): Promise<readonly JobRevision[]> {
    const normalized = applicationId.trim()
    if (normalized.length === 0) throw new Error('invalid_application_id')
    return this.#withDatabase((database) => {
      const rows = database
        .prepare(
          `SELECT e.application_id, e.event_json, a.content, a.content_hash, a.artifact_ref, a.created_at
           FROM application_events e
           JOIN application_artifacts a ON a.artifact_id = e.artifact_id
           WHERE e.application_id = ? AND e.event_type = 'job_description_captured'
           ORDER BY e.sequence ASC, a.created_at ASC, e.event_id ASC`,
        )
        .all(normalized) as unknown as JobRow[]
      return rows.map((row) => {
        const summary = toJobSummary(row)
        return { ...summary, description: row.content, artifactRef: row.artifact_ref }
      })
    })
  }

  async listTimeline(applicationId: string): Promise<TimelineEvent[]> {
    const normalized = applicationId.trim()
    if (normalized.length === 0) throw new Error('invalid_application_id')
    return this.#withDatabase((database) => {
      const rows = database
        .prepare(
          `SELECT sequence, event_id, application_id, event_type, occurred_at, actor, event_json
           FROM application_events
           WHERE application_id = ?
           ORDER BY sequence ASC`,
        )
        .all(normalized) as unknown as TimelineRow[]
      return rows.map((row) => {
        const event = parseEvent(row.event_json)
        return {
        sequence: row.sequence,
        eventId: row.event_id,
        applicationId: row.application_id,
        type: row.event_type,
        occurredAt: row.occurred_at,
        actor: row.actor,
        ...event.payload === undefined ? {} : { payload: event.payload },
        }
      })
    })
  }

  #withDatabase<T>(operation: (database: DatabaseSync) => T): T {
    if (!existsSync(this.#databasePath)) throw new Error('source_unavailable')
    const database = new DatabaseSync(this.#databasePath, { readOnly: true })
    try {
      return operation(database)
    } finally {
      database.close()
    }
  }
}

function toJobSummary(row: JobRow): JobSummary {
  const event = parseEvent(row.event_json)
  const payload = isRecord(event.payload) ? event.payload : {}
  const company = stringValue(payload.company, '未命名公司') ?? '未命名公司'
  const role = stringValue(payload.role, '未命名岗位') ?? '未命名岗位'
  const jobUrl = stringValue(payload.jobUrl)
  return {
    applicationId: row.application_id,
    company,
    role,
    ...jobUrl === undefined ? {} : { jobUrl },
    capturedAt: row.created_at,
    contentHash: row.content_hash,
  }
}

function toApplicationOverview(job: JobSummary, timeline: TimelineEvent[]): ApplicationOverview {
  const recruiterMessageCount = timeline.filter((event) => event.type === 'recruiter_message_captured').length
  const interviewNoteCount = timeline.filter((event) => event.type === 'interview_note_recorded').length
  const progressSignalCount = timeline.filter((event) => event.type === 'progress_signal_recorded').length
  const latestProposal = [...timeline].reverse().find((event) => event.type === 'status_change_proposed')
  const progressState: ProgressState = latestProposal !== undefined
    ? 'status_proposed'
    : progressSignalCount > 0
      ? 'signal_needs_review'
      : interviewNoteCount > 0
        ? 'interview_notes'
        : recruiterMessageCount > 0
          ? 'conversation_active'
          : 'new'
  const latestEvent = timeline.at(-1)
  return {
    ...job,
    progressState,
    eventCount: timeline.length,
    recruiterMessageCount,
    interviewNoteCount,
    progressSignalCount,
    latestEventType: latestEvent?.type ?? 'job_description_captured',
    latestEventAt: latestEvent?.occurredAt ?? job.capturedAt,
    ...statusProposal(latestProposal),
  }
}

function statusProposal(event: TimelineEvent | undefined): { proposedStatus?: string } {
  if (event === undefined || !isRecord(event.payload)) return {}
  const proposedStatus = event.payload.to
  return typeof proposedStatus === 'string' && proposedStatus.trim().length > 0
    ? { proposedStatus }
    : {}
}

function parseEvent(value: string): CapturedJobEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('source_corrupt_event')
  }
  if (!isRecord(parsed)) throw new Error('source_corrupt_event')
  const payload = parsed.payload
  return isJsonValue(payload) ? { payload } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

function stringValue(value: unknown, fallback?: string): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value
  return fallback
}
