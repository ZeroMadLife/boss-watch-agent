import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type LeadSourceKind = 'gankinterview_campus' | 'tencent_smart_sheet' | 'boss_visible' | 'company_career_site'
export type LeadConfidence = 'source_only' | 'url_verified' | 'jd_verified' | 'human_confirmed'
export type LeadVerificationKind = 'candidate_url_confirmed' | 'jd_human_confirmed'
export type LeadObservationChangeKind = 'new' | 'unchanged' | 'changed'
export type LeadSourceSnapshotStatus = 'applied'

const LEAD_SOURCE_KINDS = new Set<LeadSourceKind>([
  'gankinterview_campus',
  'tencent_smart_sheet',
  'boss_visible',
  'company_career_site',
])

export interface JobLead {
  readonly leadId: string
  readonly sourceKind: LeadSourceKind
  readonly sourceRecordId: string
  readonly company: string
  readonly role: string
  readonly city?: string
  readonly cohort?: string
  readonly recruitmentType?: string
  readonly deadline?: string
  readonly channelUrl?: string
  readonly officialApplyUrl?: string
  readonly sourceUpdatedAt?: string
  readonly fetchedAt: string
  readonly rawRef: string
  readonly contentHash: string
  readonly confidence: LeadConfidence
}

export interface JobLeadVerification {
  readonly verificationId: string
  readonly leadId: string
  readonly contentHash: string
  readonly kind: LeadVerificationKind
  readonly officialApplyUrl: string
  readonly confirmedAt: string
}

export interface JobLeadConfirmation {
  readonly lead: JobLead
  readonly verification: JobLeadVerification
}

export interface JobLeadConfirmationInput {
  readonly leadId: string
  readonly expectedContentHash: string
  readonly confirmedAt?: string
}

export interface JobLeadObservation {
  readonly observationId: string
  readonly leadId: string
  readonly sourceKind: LeadSourceKind
  readonly sourceRecordId: string
  readonly company: string
  readonly role: string
  readonly city?: string
  readonly cohort?: string
  readonly recruitmentType?: string
  readonly deadline?: string
  readonly channelUrl?: string
  readonly sourceUpdatedAt?: string
  readonly observedAt: string
  readonly rawRef: string
  readonly contentHash: string
  readonly previousContentHash?: string
  readonly previousConfidence?: LeadConfidence
  readonly changeKind: LeadObservationChangeKind
  readonly verificationInvalidated: boolean
  readonly isCurrent: boolean
  readonly snapshotId?: string
}

export interface JobLeadSourceSnapshot {
  readonly snapshotId: string
  readonly sourceKind: LeadSourceKind
  readonly sourceRef: string
  readonly fileHash: string
  readonly mappingHash: string
  readonly sheetName: string
  readonly importedAt: string
  readonly rowCount: number
  readonly acceptedCount: number
  readonly rejectedCount: number
  readonly duplicateCount: number
  readonly newCount: number
  readonly changedCount: number
  readonly unchangedCount: number
  readonly status: LeadSourceSnapshotStatus
}

export interface JobLeadSourceSnapshotInput {
  readonly snapshot: JobLeadSourceSnapshot
  readonly leads: readonly JobLead[]
}

export interface JobLeadSummary {
  readonly total: number
  readonly sourceOnly: number
  readonly verified: number
}

export interface JobLeadStore {
  upsert(leads: readonly JobLead[]): void
  applySnapshot(input: JobLeadSourceSnapshotInput): void
  summarize(): JobLeadSummary
  list(options?: { limit?: number; sourceKind?: LeadSourceKind }): JobLead[]
  get(leadId: string): JobLead | undefined
  getBySource(sourceKind: LeadSourceKind, sourceRecordId: string): JobLead | undefined
  getLatestSnapshot(sourceKind: LeadSourceKind, sourceRef: string): JobLeadSourceSnapshot | undefined
  listSnapshots(options?: { limit?: number; sourceKind?: LeadSourceKind }): JobLeadSourceSnapshot[]
  listObservations(options?: { limit?: number; sourceKind?: LeadSourceKind; since?: string; includeUnchanged?: boolean }): JobLeadObservation[]
  confirmCandidateUrl(input: JobLeadConfirmationInput): JobLeadConfirmation
  confirmJd(input: JobLeadConfirmationInput): JobLeadConfirmation
  close(): void
}

interface LeadRow {
  lead_id: string
  source_kind: LeadSourceKind
  source_record_id: string
  company: string
  role: string
  city: string | null
  cohort: string | null
  recruitment_type: string | null
  deadline: string | null
  channel_url: string | null
  official_apply_url: string | null
  source_updated_at: string | null
  fetched_at: string
  raw_ref: string
  content_hash: string
  confidence: LeadConfidence
}

interface LeadVerificationRow {
  verification_id: string
  lead_id: string
  content_hash: string
  verification_kind: LeadVerificationKind
  official_apply_url: string
  confirmed_at: string
}

interface LeadObservationRow {
  observation_id: string
  lead_id: string
  source_kind: LeadSourceKind
  source_record_id: string
  company: string
  role: string
  city: string | null
  cohort: string | null
  recruitment_type: string | null
  deadline: string | null
  channel_url: string | null
  source_updated_at: string | null
  observed_at: string
  raw_ref: string
  content_hash: string
  previous_content_hash: string | null
  previous_confidence: LeadConfidence | null
  change_kind: LeadObservationChangeKind
  verification_invalidated: number
  is_current: number
  snapshot_id: string | null
}

interface SnapshotRow {
  snapshot_id: string
  source_kind: LeadSourceKind
  source_ref: string
  file_hash: string
  mapping_hash: string
  sheet_name: string
  imported_at: string
  row_count: number
  accepted_count: number
  rejected_count: number
  duplicate_count: number
  new_count: number
  changed_count: number
  unchanged_count: number
  status: LeadSourceSnapshotStatus
}

export class SqliteJobLeadStore implements JobLeadStore {
  readonly #database: DatabaseSync
  #closed = false

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error('invalid_database_path')
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true })
    }
    this.#database = new DatabaseSync(path)
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS job_leads (
        lead_id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        company TEXT NOT NULL,
        role TEXT NOT NULL,
        city TEXT,
        cohort TEXT,
        recruitment_type TEXT,
        deadline TEXT,
        channel_url TEXT,
        official_apply_url TEXT,
        source_updated_at TEXT,
        fetched_at TEXT NOT NULL,
        raw_ref TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        confidence TEXT NOT NULL CHECK (confidence IN ('source_only', 'url_verified', 'jd_verified', 'human_confirmed')),
        UNIQUE (source_kind, source_record_id)
      );
      CREATE INDEX IF NOT EXISTS job_leads_fetched_at ON job_leads(fetched_at DESC, lead_id ASC);
      CREATE TABLE IF NOT EXISTS job_lead_verifications (
        verification_id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        verification_kind TEXT NOT NULL CHECK (verification_kind IN ('candidate_url_confirmed', 'jd_human_confirmed')),
        official_apply_url TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        UNIQUE (lead_id, content_hash, verification_kind)
      );
      CREATE INDEX IF NOT EXISTS job_lead_verifications_lead
        ON job_lead_verifications(lead_id, confirmed_at DESC);
      CREATE TABLE IF NOT EXISTS job_lead_observations (
        observation_id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        company TEXT NOT NULL,
        role TEXT NOT NULL,
        city TEXT,
        cohort TEXT,
        recruitment_type TEXT,
        deadline TEXT,
        channel_url TEXT,
        source_updated_at TEXT,
        observed_at TEXT NOT NULL,
        raw_ref TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        previous_content_hash TEXT CHECK (previous_content_hash IS NULL OR length(previous_content_hash) = 64),
        previous_confidence TEXT CHECK (previous_confidence IS NULL OR previous_confidence IN ('source_only', 'url_verified', 'jd_verified', 'human_confirmed')),
        change_kind TEXT NOT NULL CHECK (change_kind IN ('new', 'unchanged', 'changed')),
        verification_invalidated INTEGER NOT NULL CHECK (verification_invalidated IN (0, 1)),
        snapshot_id TEXT
      );
      CREATE INDEX IF NOT EXISTS job_lead_observations_time
        ON job_lead_observations(observed_at DESC, observation_id ASC);
      CREATE INDEX IF NOT EXISTS job_lead_observations_source
        ON job_lead_observations(source_kind, source_record_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS job_source_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        file_hash TEXT NOT NULL CHECK (length(file_hash) = 64),
        mapping_hash TEXT NOT NULL CHECK (length(mapping_hash) = 64),
        sheet_name TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0),
        rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
        duplicate_count INTEGER NOT NULL CHECK (duplicate_count >= 0),
        new_count INTEGER NOT NULL CHECK (new_count >= 0),
        changed_count INTEGER NOT NULL CHECK (changed_count >= 0),
        unchanged_count INTEGER NOT NULL CHECK (unchanged_count >= 0),
        status TEXT NOT NULL CHECK (status IN ('applied'))
      );
      CREATE INDEX IF NOT EXISTS job_source_snapshots_time
        ON job_source_snapshots(imported_at DESC, snapshot_id ASC);
    `)
    this.#ensureColumn('job_leads', 'recruitment_type', 'TEXT')
    this.#ensureColumn('job_lead_observations', 'recruitment_type', 'TEXT')
    this.#ensureColumn('job_lead_observations', 'snapshot_id', 'TEXT')
  }

  upsert(leads: readonly JobLead[]): void {
    this.#ensureOpen()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#upsertLeads(leads)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  applySnapshot(input: JobLeadSourceSnapshotInput): void {
    this.#ensureOpen()
    validateSnapshot(input.snapshot)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#database.prepare(`
        SELECT snapshot_id, source_kind, source_ref, file_hash, mapping_hash, sheet_name, imported_at,
               row_count, accepted_count, rejected_count, duplicate_count, new_count, changed_count,
               unchanged_count, status
        FROM job_source_snapshots
        WHERE snapshot_id = ?
      `).get(input.snapshot.snapshotId) as unknown as SnapshotRow | undefined
      if (existing !== undefined) {
        if (existing.file_hash !== input.snapshot.fileHash || existing.mapping_hash !== input.snapshot.mappingHash) {
          throw new Error('snapshot_id_conflict')
        }
        this.#database.exec('COMMIT')
        return
      }
      this.#database.prepare(`
        INSERT INTO job_source_snapshots (
          snapshot_id, source_kind, source_ref, file_hash, mapping_hash, sheet_name, imported_at,
          row_count, accepted_count, rejected_count, duplicate_count, new_count, changed_count,
          unchanged_count, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.snapshot.snapshotId,
        input.snapshot.sourceKind,
        input.snapshot.sourceRef,
        input.snapshot.fileHash,
        input.snapshot.mappingHash,
        input.snapshot.sheetName,
        input.snapshot.importedAt,
        input.snapshot.rowCount,
        input.snapshot.acceptedCount,
        input.snapshot.rejectedCount,
        input.snapshot.duplicateCount,
        input.snapshot.newCount,
        input.snapshot.changedCount,
        input.snapshot.unchangedCount,
        input.snapshot.status,
      )
      this.#upsertLeads(input.leads, input.snapshot.snapshotId)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #upsertLeads(leads: readonly JobLead[], snapshotId?: string): void {
    const statement = this.#database.prepare(`
      INSERT INTO job_leads (
        lead_id, source_kind, source_record_id, company, role, city, cohort, recruitment_type, deadline,
        channel_url, official_apply_url, source_updated_at, fetched_at, raw_ref, content_hash, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_kind, source_record_id) DO UPDATE SET
        lead_id = excluded.lead_id,
        company = excluded.company,
        role = excluded.role,
        city = excluded.city,
        cohort = excluded.cohort,
        recruitment_type = excluded.recruitment_type,
        deadline = excluded.deadline,
        channel_url = excluded.channel_url,
        official_apply_url = excluded.official_apply_url,
        source_updated_at = excluded.source_updated_at,
        fetched_at = excluded.fetched_at,
        raw_ref = excluded.raw_ref,
        content_hash = excluded.content_hash,
        confidence = excluded.confidence
    `)
    for (const lead of leads) {
      validateJobLead(lead)
      const existing = this.#getBySource(lead.sourceKind, lead.sourceRecordId)
      this.#recordObservation(lead, existing, snapshotId)
      const persisted = mergeObservedLead(existing, lead)
      statement.run(
        persisted.leadId,
        persisted.sourceKind,
        persisted.sourceRecordId,
        persisted.company,
        persisted.role,
        persisted.city ?? null,
        persisted.cohort ?? null,
        persisted.recruitmentType ?? null,
        persisted.deadline ?? null,
        persisted.channelUrl ?? null,
        persisted.officialApplyUrl ?? null,
        persisted.sourceUpdatedAt ?? null,
        persisted.fetchedAt,
        persisted.rawRef,
        persisted.contentHash,
        persisted.confidence,
      )
    }
  }

  summarize(): JobLeadSummary {
    this.#ensureOpen()
    const row = this.#database.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN confidence = 'source_only' THEN 1 ELSE 0 END), 0) AS source_only,
        COALESCE(SUM(CASE WHEN confidence IN ('jd_verified', 'human_confirmed') THEN 1 ELSE 0 END), 0) AS verified
      FROM job_leads
    `).get() as unknown as { total: number; source_only: number; verified: number }
    return { total: row.total, sourceOnly: row.source_only, verified: row.verified }
  }

  list(options: { limit?: number; sourceKind?: LeadSourceKind } = {}): JobLead[] {
    this.#ensureOpen()
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_lead_limit')
    const rows = options.sourceKind === undefined
      ? this.#database.prepare(`
          SELECT lead_id, source_kind, source_record_id, company, role, city, cohort, recruitment_type, deadline,
                 channel_url, official_apply_url, source_updated_at, fetched_at, raw_ref, content_hash, confidence
          FROM job_leads
          ORDER BY fetched_at DESC, lead_id ASC
          LIMIT ?
        `).all(limit) as unknown as LeadRow[]
      : this.#database.prepare(`
          SELECT lead_id, source_kind, source_record_id, company, role, city, cohort, recruitment_type, deadline,
                 channel_url, official_apply_url, source_updated_at, fetched_at, raw_ref, content_hash, confidence
          FROM job_leads
          WHERE source_kind = ?
          ORDER BY fetched_at DESC, lead_id ASC
          LIMIT ?
        `).all(options.sourceKind, limit) as unknown as LeadRow[]
    return rows.map(fromLeadRow)
  }

  get(leadId: string): JobLead | undefined {
    this.#ensureOpen()
    const normalized = leadId.trim()
    if (normalized.length === 0) throw new Error('invalid_lead_id')
    const row = this.#database.prepare(`
      SELECT lead_id, source_kind, source_record_id, company, role, city, cohort, recruitment_type, deadline,
             channel_url, official_apply_url, source_updated_at, fetched_at, raw_ref, content_hash, confidence
      FROM job_leads
      WHERE lead_id = ?
    `).get(normalized) as unknown as LeadRow | undefined
    return row === undefined ? undefined : fromLeadRow(row)
  }

  getBySource(sourceKind: LeadSourceKind, sourceRecordId: string): JobLead | undefined {
    this.#ensureOpen()
    if (!LEAD_SOURCE_KINDS.has(sourceKind) || sourceRecordId.trim().length === 0) throw new Error('invalid_lead_source')
    return this.#getBySource(sourceKind, sourceRecordId.trim())
  }

  getLatestSnapshot(sourceKind: LeadSourceKind, sourceRef: string): JobLeadSourceSnapshot | undefined {
    this.#ensureOpen()
    if (!LEAD_SOURCE_KINDS.has(sourceKind) || sourceRef.trim().length === 0) throw new Error('invalid_snapshot_source')
    const row = this.#database.prepare(`
      SELECT snapshot_id, source_kind, source_ref, file_hash, mapping_hash, sheet_name, imported_at,
             row_count, accepted_count, rejected_count, duplicate_count, new_count, changed_count,
             unchanged_count, status
      FROM job_source_snapshots
      WHERE source_kind = ? AND source_ref = ?
      ORDER BY imported_at DESC, snapshot_id DESC
      LIMIT 1
    `).get(sourceKind, sourceRef.trim()) as unknown as SnapshotRow | undefined
    return row === undefined ? undefined : fromSnapshotRow(row)
  }

  listSnapshots(options: { limit?: number; sourceKind?: LeadSourceKind } = {}): JobLeadSourceSnapshot[] {
    this.#ensureOpen()
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_snapshot_limit')
    if (options.sourceKind !== undefined && !LEAD_SOURCE_KINDS.has(options.sourceKind)) throw new Error('invalid_lead_source_kind')
    const rows = this.#database.prepare(`
      SELECT snapshot_id, source_kind, source_ref, file_hash, mapping_hash, sheet_name, imported_at,
             row_count, accepted_count, rejected_count, duplicate_count, new_count, changed_count,
             unchanged_count, status
      FROM job_source_snapshots
      WHERE (? IS NULL OR source_kind = ?)
      ORDER BY imported_at DESC, snapshot_id DESC
      LIMIT ?
    `).all(options.sourceKind ?? null, options.sourceKind ?? null, limit) as unknown as SnapshotRow[]
    return rows.map(fromSnapshotRow)
  }

  listObservations(options: { limit?: number; sourceKind?: LeadSourceKind; since?: string; includeUnchanged?: boolean } = {}): JobLeadObservation[] {
    this.#ensureOpen()
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_lead_observation_limit')
    if (options.sourceKind !== undefined && !LEAD_SOURCE_KINDS.has(options.sourceKind)) throw new Error('invalid_lead_source_kind')
    if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) throw new Error('invalid_lead_observation_since')
    const includeUnchanged = options.includeUnchanged === true ? 1 : 0
    const rows = this.#database.prepare(`
      SELECT observation.observation_id, observation.lead_id, observation.source_kind, observation.source_record_id,
             observation.company, observation.role, observation.city, observation.cohort, observation.recruitment_type, observation.deadline,
             observation.channel_url, observation.source_updated_at, observation.observed_at, observation.raw_ref,
             observation.content_hash, observation.previous_content_hash, observation.previous_confidence,
             observation.change_kind, observation.verification_invalidated, observation.snapshot_id,
             CASE WHEN current_lead.content_hash = observation.content_hash
                    AND observation.observed_at = (
                      SELECT MAX(latest.observed_at)
                      FROM job_lead_observations AS latest
                      WHERE latest.lead_id = observation.lead_id
                    )
                  THEN 1 ELSE 0 END AS is_current
      FROM job_lead_observations AS observation
      LEFT JOIN job_leads AS current_lead ON current_lead.lead_id = observation.lead_id
      WHERE (? IS NULL OR observation.source_kind = ?)
        AND (? = 1 OR observation.change_kind <> 'unchanged')
        AND (? IS NULL OR observation.observed_at >= ?)
      ORDER BY observation.observed_at DESC, observation.observation_id ASC
      LIMIT ?
    `).all(
      options.sourceKind ?? null,
      options.sourceKind ?? null,
      includeUnchanged,
      options.since ?? null,
      options.since ?? null,
      limit,
    ) as unknown as LeadObservationRow[]
    return rows.map(fromLeadObservationRow)
  }

  confirmCandidateUrl(input: JobLeadConfirmationInput): JobLeadConfirmation {
    return this.#confirm(input, 'candidate_url_confirmed')
  }

  confirmJd(input: JobLeadConfirmationInput): JobLeadConfirmation {
    return this.#confirm(input, 'jd_human_confirmed')
  }

  close(): void {
    if (this.#closed) return
    this.#database.close()
    this.#closed = true
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error('sqlite_lead_store_closed')
  }

  #ensureColumn(table: string, column: string, type: string): void {
    const columns = this.#database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((entry) => entry.name === column)) {
      this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }

  #getBySource(sourceKind: LeadSourceKind, sourceRecordId: string): JobLead | undefined {
    const row = this.#database.prepare(`
      SELECT lead_id, source_kind, source_record_id, company, role, city, cohort, recruitment_type, deadline,
             channel_url, official_apply_url, source_updated_at, fetched_at, raw_ref, content_hash, confidence
      FROM job_leads
      WHERE source_kind = ? AND source_record_id = ?
    `).get(sourceKind, sourceRecordId) as unknown as LeadRow | undefined
    return row === undefined ? undefined : fromLeadRow(row)
  }

  #recordObservation(observed: JobLead, existing: JobLead | undefined, snapshotId?: string): void {
    const changeKind: LeadObservationChangeKind = existing === undefined
      ? 'new'
      : existing.contentHash === observed.contentHash ? 'unchanged' : 'changed'
    const observationId = `lead-observation:${createHash('sha256')
      .update(`${observed.sourceKind}\u0000${observed.sourceRecordId}\u0000${observed.contentHash}\u0000${observed.fetchedAt}`, 'utf8')
      .digest('hex')}`
    this.#database.prepare(`
      INSERT OR IGNORE INTO job_lead_observations (
        observation_id, lead_id, source_kind, source_record_id, company, role, city, cohort, recruitment_type, deadline,
        channel_url, source_updated_at, observed_at, raw_ref, content_hash, previous_content_hash,
        previous_confidence, change_kind, verification_invalidated, snapshot_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observationId,
      existing?.leadId ?? observed.leadId,
      observed.sourceKind,
      observed.sourceRecordId,
      observed.company,
      observed.role,
      observed.city ?? null,
      observed.cohort ?? null,
      observed.recruitmentType ?? null,
      observed.deadline ?? null,
      observed.channelUrl ?? null,
      observed.sourceUpdatedAt ?? null,
      observed.fetchedAt,
      observed.rawRef,
      observed.contentHash,
      existing?.contentHash ?? null,
      existing?.confidence ?? null,
      changeKind,
      changeKind === 'changed' && existing !== undefined && hasVerifiedUrl(existing.confidence) ? 1 : 0,
      snapshotId ?? null,
    )
  }

  #confirm(input: JobLeadConfirmationInput, kind: LeadVerificationKind): JobLeadConfirmation {
    this.#ensureOpen()
    const leadId = input.leadId.trim()
    if (leadId.length === 0) throw new Error('invalid_lead_id')
    if (!/^[a-f0-9]{64}$/u.test(input.expectedContentHash)) throw new Error('invalid_job_lead_hash')
    const confirmedAt = input.confirmedAt ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(confirmedAt))) throw new Error('invalid_lead_confirmation_timestamp')

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.get(leadId)
      if (current === undefined) throw new Error('lead_not_found')
      if (current.contentHash !== input.expectedContentHash) throw new Error('lead_content_changed')
      if (kind === 'jd_human_confirmed' && !hasVerifiedUrl(current.confidence)) {
        throw new Error('lead_url_not_verified')
      }
      const officialApplyUrl = normalizeCandidateUrl(
        kind === 'candidate_url_confirmed' ? current.channelUrl : current.officialApplyUrl,
      )
      const confidence = kind === 'candidate_url_confirmed'
        ? maxConfidence(current.confidence, 'url_verified')
        : maxConfidence(current.confidence, 'human_confirmed')
      this.#database.prepare(`
        UPDATE job_leads
        SET official_apply_url = ?, confidence = ?
        WHERE lead_id = ? AND content_hash = ?
      `).run(officialApplyUrl, confidence, leadId, input.expectedContentHash)

      const verificationId = `lead-verification:${createHash('sha256')
        .update(`${leadId}\u0000${input.expectedContentHash}\u0000${kind}`, 'utf8')
        .digest('hex')}`
      this.#database.prepare(`
        INSERT OR IGNORE INTO job_lead_verifications (
          verification_id, lead_id, content_hash, verification_kind, official_apply_url, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(verificationId, leadId, input.expectedContentHash, kind, officialApplyUrl, confirmedAt)
      const row = this.#database.prepare(`
        SELECT verification_id, lead_id, content_hash, verification_kind, official_apply_url, confirmed_at
        FROM job_lead_verifications
        WHERE lead_id = ? AND content_hash = ? AND verification_kind = ?
      `).get(leadId, input.expectedContentHash, kind) as unknown as LeadVerificationRow | undefined
      const lead = this.get(leadId)
      if (row === undefined || lead === undefined) throw new Error('lead_confirmation_write_failed')
      this.#database.exec('COMMIT')
      return { lead, verification: fromLeadVerificationRow(row) }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }
}

export interface GankCampusSearch {
  readonly page?: number
  readonly limit?: number
  readonly keyword?: string
  readonly company?: string
  readonly location?: string
  readonly recruitmentType?: string
  readonly target?: string
}

export interface JobLeadSearchSource {
  search(query?: GankCampusSearch): Promise<JobLead[]>
}

interface GankInterviewCampusAdapterOptions {
  readonly token: string
  readonly baseUrl?: string
  readonly fetch?: typeof globalThis.fetch
  readonly store: JobLeadStore
  readonly now?: () => Date
}

export class GankInterviewCampusAdapter implements JobLeadSearchSource {
  readonly #token: string
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  readonly #store: JobLeadStore
  readonly #now: () => Date

  constructor(options: GankInterviewCampusAdapterOptions) {
    if (options.token.trim().length === 0) throw new Error('gankinterview_token_required')
    this.#token = options.token
    this.#baseUrl = options.baseUrl ?? 'https://www.gankinterview.cn/api/v1'
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#store = options.store
    this.#now = options.now ?? (() => new Date())
  }

  async search(query: GankCampusSearch = {}): Promise<JobLead[]> {
    const url = this.#buildUrl(query)
    const response = await this.#fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.#token}`,
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw gankHttpError(response.status)
    const body = await parseJsonResponse(response)
    const data = readData(body)
    const fetchedAt = this.#now().toISOString()
    const leads = data.map((record) => toJobLead(record, fetchedAt))
    this.#store.upsert(leads)
    return leads
  }

  #buildUrl(query: GankCampusSearch): string {
    const base = this.#baseUrl.endsWith('/') ? this.#baseUrl : `${this.#baseUrl}/`
    const url = new URL('campus', base)
    const page = query.page ?? 1
    const limit = query.limit ?? 20
    if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('invalid_campus_page')
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_campus_limit')
    url.searchParams.set('page', String(page))
    url.searchParams.set('pageSize', String(limit))
    addParam(url, 'keyword', query.keyword)
    addParam(url, 'company', query.company)
    addParam(url, 'location', query.location)
    addParam(url, 'recruitmentType', query.recruitmentType)
    addParam(url, 'target', query.target)
    return url.toString()
  }
}

function addParam(url: URL, name: string, value: string | undefined): void {
  if (value?.trim()) url.searchParams.set(name, value.trim())
}

function gankHttpError(status: number): Error {
  if (status === 401 || status === 403) return new Error('gankinterview_unauthorized')
  if (status === 429) return new Error('gankinterview_rate_limited')
  if (status >= 500) return new Error('gankinterview_unavailable')
  return new Error('gankinterview_request_failed')
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error('gankinterview_invalid_response')
  }
}

function readData(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error('gankinterview_invalid_response')
  if (!value.data.every(isRecord)) throw new Error('gankinterview_invalid_response')
  return value.data
}

function toJobLead(record: Record<string, unknown>, fetchedAt: string): JobLead {
  const sourceRecordId = stringField(record, 'id')
  const company = stringField(record, 'companyName')
  const role = stringField(record, 'positionText')
  if (sourceRecordId === undefined || company === undefined || role === undefined) {
    throw new Error('gankinterview_invalid_record')
  }
  const channelUrl = stringField(record, 'applyUrl') ?? stringField(record, 'announcementUrl')
  const lead: JobLead = {
    leadId: `lead:gankinterview_campus:${sourceRecordId}`,
    sourceKind: 'gankinterview_campus',
    sourceRecordId,
    company,
    role,
    ...optionalField(record, 'locationText', 'city'),
    ...optionalField(record, 'target', 'cohort'),
    ...optionalField(record, 'recruitmentType', 'recruitmentType'),
    ...optionalField(record, 'deadlineText', 'deadline'),
    ...channelUrl === undefined ? {} : { channelUrl },
    ...optionalField(record, 'sourceUpdatedAt', 'sourceUpdatedAt'),
    fetchedAt,
    rawRef: `gankinterview://campus/${encodeURIComponent(sourceRecordId)}`,
    contentHash: hashLeadContent({ sourceRecordId, company, role, channelUrl, location: record.locationText, target: record.target, recruitmentType: record.recruitmentType, deadline: record.deadlineText }),
    confidence: 'source_only',
  }
  validateJobLead(lead)
  return lead
}

function optionalField(record: Record<string, unknown>, source: string, target: string): Record<string, string> {
  const value = stringField(record, source)
  return value === undefined ? {} : { [target]: value }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function hashLeadContent(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function validateJobLead(lead: JobLead): void {
  if ([lead.leadId, lead.sourceKind, lead.sourceRecordId, lead.company, lead.role, lead.fetchedAt, lead.rawRef].some((value) => value.trim().length === 0)) {
    throw new Error('invalid_job_lead')
  }
  if (!/^[a-f0-9]{64}$/u.test(lead.contentHash)) throw new Error('invalid_job_lead_hash')
  if (!Number.isFinite(Date.parse(lead.fetchedAt))) throw new Error('invalid_job_lead_timestamp')
}

function mergeObservedLead(existing: JobLead | undefined, observed: JobLead): JobLead {
  if (existing === undefined) return observed
  if (existing.contentHash !== observed.contentHash) {
    const { officialApplyUrl: _discardedOfficialUrl, ...unverified } = observed
    return {
      ...unverified,
      leadId: existing.leadId,
      confidence: 'source_only',
    }
  }
  const officialApplyUrl = existing.officialApplyUrl ?? observed.officialApplyUrl
  return {
    ...observed,
    leadId: existing.leadId,
    confidence: maxConfidence(existing.confidence, observed.confidence),
    ...officialApplyUrl === undefined ? {} : { officialApplyUrl },
  }
}

function hasVerifiedUrl(confidence: LeadConfidence): boolean {
  return confidence === 'url_verified' || confidence === 'jd_verified' || confidence === 'human_confirmed'
}

function maxConfidence(left: LeadConfidence, right: LeadConfidence): LeadConfidence {
  const rank: Record<LeadConfidence, number> = {
    source_only: 0,
    url_verified: 1,
    jd_verified: 2,
    human_confirmed: 3,
  }
  return rank[left] >= rank[right] ? left : right
}

function normalizeCandidateUrl(value: string | undefined): string {
  if (value === undefined) throw new Error('lead_candidate_url_missing')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('lead_candidate_url_invalid')
  }
  if (url.protocol !== 'https:') throw new Error('lead_candidate_url_not_https')
  if (url.username.length > 0 || url.password.length > 0) throw new Error('lead_candidate_url_invalid')
  if (url.port.length > 0 && url.port !== '443') throw new Error('lead_candidate_url_invalid')
  const hostname = url.hostname.toLowerCase()
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || isIP(hostname) !== 0
  ) {
    throw new Error('lead_candidate_url_invalid')
  }
  url.hash = ''
  return url.toString()
}

function fromLeadRow(row: LeadRow): JobLead {
  return {
    leadId: row.lead_id,
    sourceKind: row.source_kind,
    sourceRecordId: row.source_record_id,
    company: row.company,
    role: row.role,
    ...nullableField(row.city, 'city'),
    ...nullableField(row.cohort, 'cohort'),
    ...nullableField(row.recruitment_type, 'recruitmentType'),
    ...nullableField(row.deadline, 'deadline'),
    ...nullableField(row.channel_url, 'channelUrl'),
    ...nullableField(row.official_apply_url, 'officialApplyUrl'),
    ...nullableField(row.source_updated_at, 'sourceUpdatedAt'),
    fetchedAt: row.fetched_at,
    rawRef: row.raw_ref,
    contentHash: row.content_hash,
    confidence: row.confidence,
  }
}

function nullableField(value: string | null, key: string): Record<string, string> {
  return value === null ? {} : { [key]: value }
}

function fromLeadVerificationRow(row: LeadVerificationRow): JobLeadVerification {
  return {
    verificationId: row.verification_id,
    leadId: row.lead_id,
    contentHash: row.content_hash,
    kind: row.verification_kind,
    officialApplyUrl: row.official_apply_url,
    confirmedAt: row.confirmed_at,
  }
}

function fromLeadObservationRow(row: LeadObservationRow): JobLeadObservation {
  return {
    observationId: row.observation_id,
    leadId: row.lead_id,
    sourceKind: row.source_kind,
    sourceRecordId: row.source_record_id,
    company: row.company,
    role: row.role,
    ...nullableField(row.city, 'city'),
    ...nullableField(row.cohort, 'cohort'),
    ...nullableField(row.recruitment_type, 'recruitmentType'),
    ...nullableField(row.deadline, 'deadline'),
    ...nullableField(row.channel_url, 'channelUrl'),
    ...nullableField(row.source_updated_at, 'sourceUpdatedAt'),
    observedAt: row.observed_at,
    rawRef: row.raw_ref,
    contentHash: row.content_hash,
    ...nullableField(row.previous_content_hash, 'previousContentHash'),
    ...nullableField(row.previous_confidence, 'previousConfidence'),
    changeKind: row.change_kind,
    verificationInvalidated: row.verification_invalidated === 1,
    isCurrent: row.is_current === 1,
    ...nullableField(row.snapshot_id, 'snapshotId'),
  }
}

function fromSnapshotRow(row: SnapshotRow): JobLeadSourceSnapshot {
  return {
    snapshotId: row.snapshot_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    fileHash: row.file_hash,
    mappingHash: row.mapping_hash,
    sheetName: row.sheet_name,
    importedAt: row.imported_at,
    rowCount: row.row_count,
    acceptedCount: row.accepted_count,
    rejectedCount: row.rejected_count,
    duplicateCount: row.duplicate_count,
    newCount: row.new_count,
    changedCount: row.changed_count,
    unchangedCount: row.unchanged_count,
    status: row.status,
  }
}

function validateSnapshot(snapshot: JobLeadSourceSnapshot): void {
  if ([snapshot.snapshotId, snapshot.sourceRef, snapshot.sheetName].some((value) => value.trim().length === 0)) {
    throw new Error('invalid_source_snapshot')
  }
  if (!LEAD_SOURCE_KINDS.has(snapshot.sourceKind)) throw new Error('invalid_lead_source_kind')
  if (!/^[a-f0-9]{64}$/u.test(snapshot.fileHash) || !/^[a-f0-9]{64}$/u.test(snapshot.mappingHash)) {
    throw new Error('invalid_source_snapshot_hash')
  }
  if (!Number.isFinite(Date.parse(snapshot.importedAt))) throw new Error('invalid_source_snapshot_timestamp')
  const counts = [
    snapshot.rowCount,
    snapshot.acceptedCount,
    snapshot.rejectedCount,
    snapshot.duplicateCount,
    snapshot.newCount,
    snapshot.changedCount,
    snapshot.unchangedCount,
  ]
  if (!counts.every((value) => Number.isInteger(value) && value >= 0)) throw new Error('invalid_source_snapshot_count')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
