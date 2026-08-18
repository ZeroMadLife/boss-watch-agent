import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JobLead, LeadConfidence } from './job-lead.js'

export type BatchState = 'queued' | 'running' | 'paused_handoff' | 'completed' | 'canceled' | 'completed_with_failures'
export type BatchItemState = 'queued' | 'awaiting_gate_b' | 'ready' | 'in_progress' | 'submitted_observed' | 'failed' | 'handoff_required' | 'skipped' | 'canceled'
type BatchJson = null | boolean | number | string | BatchJson[] | { readonly [key: string]: BatchJson }

export interface BatchFailure {
  readonly [key: string]: BatchJson
  readonly stage: string
  readonly code: string
  readonly pageKind?: string
  readonly evidenceAt?: string
  readonly retryCount: number
  readonly suggestedAction: string
}

export interface BatchCheckpoint {
  readonly [key: string]: BatchJson
  readonly itemId: string
  readonly sequence: number
  readonly stage: string
  readonly code: string
  readonly savedAt: string
  readonly retryCount: number
  readonly nextAction: string
}

export interface BatchApplicationItem {
  readonly itemId: string
  readonly batchId: string
  readonly leadId: string
  readonly sequence: number
  readonly company: string
  readonly role: string
  readonly channelUrl?: string
  readonly officialApplyUrl?: string
  readonly leadContentHash: string
  readonly leadConfidence: LeadConfidence
  readonly itemState: BatchItemState
  readonly gateBRef?: string
  readonly gateBContentHash?: string
  readonly gateBExpiresAt?: string
  readonly failure?: BatchFailure
  readonly checkpoint?: BatchCheckpoint
}

export interface BatchApplicationRun {
  readonly batchId: string
  readonly sessionId: string
  readonly createdAt: string
  readonly strategyVersion: string
  readonly batchState: BatchState
  readonly currentCursor: number
  readonly items: BatchApplicationItem[]
  readonly lastResult?: string
  readonly pausedReason?: string
  readonly resumableAt?: string
  readonly resumeCount: number
}

export interface BatchApplicationStore {
  prepare(input: { readonly leadIds: readonly string[]; readonly sessionId?: string; readonly now?: string }): BatchApplicationRun
  get(batchId: string): BatchApplicationRun | undefined
  recordGateB(batchId: string, itemId: string, input: { readonly authorizationRef: string; readonly contentHash: string; readonly expiresAt: string; readonly now?: string }): BatchApplicationRun
  start(batchId: string, itemId: string, now?: string): BatchApplicationRun
  markSubmittedObserved(batchId: string, itemId: string, evidenceAt?: string): BatchApplicationRun
  markHandoff(batchId: string, itemId: string, failure: BatchFailure, now?: string): BatchApplicationRun
  markFailed(batchId: string, itemId: string, failure: BatchFailure): BatchApplicationRun
  skip(batchId: string, itemId: string, reason: string): BatchApplicationRun
  resume(batchId: string, now?: string): BatchApplicationRun
  close(): void
}

interface RunRow {
  batch_id: string
  session_id: string
  created_at: string
  strategy_version: string
  batch_state: BatchState
  current_cursor: number
  last_result: string | null
  paused_reason: string | null
  resumable_at: string | null
  resume_count: number
}

interface ItemRow {
  item_id: string
  batch_id: string
  lead_id: string
  sequence: number
  company: string
  role: string
  channel_url: string | null
  official_apply_url: string | null
  lead_content_hash: string
  lead_confidence: LeadConfidence
  item_state: BatchItemState
  gate_b_ref: string | null
  gate_b_content_hash: string | null
  gate_b_expires_at: string | null
  failure_json: string | null
  checkpoint_json: string | null
}

const VERIFIED_CONFIDENCE = new Set<LeadConfidence>(['jd_verified', 'human_confirmed'])
const ITEM_STATES = new Set<BatchItemState>([
  'queued', 'awaiting_gate_b', 'ready', 'in_progress', 'submitted_observed', 'failed',
  'handoff_required', 'skipped', 'canceled',
])

export class SqliteBatchApplicationStore implements BatchApplicationStore {
  readonly #database: DatabaseSync
  #closed = false

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error('invalid_database_path')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS batch_application_runs (
          batch_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          strategy_version TEXT NOT NULL,
          batch_state TEXT NOT NULL CHECK (batch_state IN ('queued', 'running', 'paused_handoff', 'completed', 'canceled', 'completed_with_failures')),
          current_cursor INTEGER NOT NULL CHECK (current_cursor >= 0),
          last_result TEXT,
          paused_reason TEXT,
          resumable_at TEXT,
          resume_count INTEGER NOT NULL DEFAULT 0 CHECK (resume_count >= 0)
        );
        CREATE TABLE IF NOT EXISTS batch_application_items (
          item_id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          company TEXT NOT NULL,
          role TEXT NOT NULL,
          channel_url TEXT,
          official_apply_url TEXT,
          lead_content_hash TEXT NOT NULL CHECK (length(lead_content_hash) = 64),
          lead_confidence TEXT NOT NULL CHECK (lead_confidence IN ('source_only', 'url_verified', 'jd_verified', 'human_confirmed')),
          item_state TEXT NOT NULL CHECK (item_state IN ('queued', 'awaiting_gate_b', 'ready', 'in_progress', 'submitted_observed', 'failed', 'handoff_required', 'skipped', 'canceled')),
          gate_b_ref TEXT,
          gate_b_content_hash TEXT,
          gate_b_expires_at TEXT,
          failure_json TEXT,
          checkpoint_json TEXT,
          UNIQUE (batch_id, sequence),
          UNIQUE (batch_id, lead_id),
          FOREIGN KEY (batch_id) REFERENCES batch_application_runs(batch_id)
        );
        CREATE INDEX IF NOT EXISTS batch_application_items_batch_sequence
          ON batch_application_items(batch_id, sequence);
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  prepare(input: { readonly leadIds: readonly string[]; readonly sessionId?: string; readonly now?: string }): BatchApplicationRun {
    this.#ensureOpen()
    const leadIds = normalizeLeadIds(input.leadIds)
    const createdAt = input.now ?? new Date().toISOString()
    assertTimestamp(createdAt, 'invalid_batch_timestamp')
    const sessionId = input.sessionId?.trim() || `local-session:${randomUUID()}`
    if (sessionId.length > 200) throw new Error('invalid_session_id')
    return this.#transaction(() => {
      const leads = leadIds.map((leadId) => this.#loadLead(leadId))
      for (const lead of leads) {
        if (lead === undefined) throw new Error('lead_not_found')
        if (!VERIFIED_CONFIDENCE.has(lead.confidence)) throw new Error('lead_not_verified')
      }
      const batchId = `batch:${randomUUID()}`
      this.#database.prepare(`
        INSERT INTO batch_application_runs (
          batch_id, session_id, created_at, strategy_version, batch_state, current_cursor, resume_count
        ) VALUES (?, ?, ?, ?, 'queued', 0, 0)
      `).run(batchId, sessionId, createdAt, 'mvp-1.0-local-plan')
      const statement = this.#database.prepare(`
        INSERT INTO batch_application_items (
          item_id, batch_id, lead_id, sequence, company, role, channel_url, official_apply_url,
          lead_content_hash, lead_confidence, item_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_gate_b')
      `)
      leads.forEach((lead, index) => {
        if (lead === undefined) throw new Error('lead_not_found')
        statement.run(
          `batch-item:${randomUUID()}`,
          batchId,
          lead.leadId,
          index + 1,
          lead.company,
          lead.role,
          lead.channelUrl ?? null,
          lead.officialApplyUrl ?? null,
          lead.contentHash,
          lead.confidence,
        )
      })
      return this.#getUnsafe(batchId) as BatchApplicationRun
    })
  }

  get(batchId: string): BatchApplicationRun | undefined {
    this.#ensureOpen()
    const normalized = normalizeId(batchId, 'invalid_batch_id')
    return this.#getUnsafe(normalized)
  }

  recordGateB(batchId: string, itemId: string, input: { readonly authorizationRef: string; readonly contentHash: string; readonly expiresAt: string; readonly now?: string }): BatchApplicationRun {
    this.#ensureOpen()
    const normalizedBatchId = normalizeId(batchId, 'invalid_batch_id')
    const normalizedItemId = normalizeId(itemId, 'invalid_item_id')
    const authorizationRef = normalizeId(input.authorizationRef, 'invalid_gate_b_ref')
    if (!/^[a-f0-9]{64}$/u.test(input.contentHash)) throw new Error('invalid_gate_b_content_hash')
    const now = input.now ?? new Date().toISOString()
    assertTimestamp(now, 'invalid_batch_timestamp')
    assertTimestamp(input.expiresAt, 'invalid_gate_b_expiry')
    if (Date.parse(input.expiresAt) <= Date.parse(now)) throw new Error('gate_b_expired')
    return this.#transaction(() => {
      const item = this.#findItem(normalizedBatchId, normalizedItemId)
      if (item === undefined) throw new Error('batch_item_not_found')
      if (item.itemState !== 'awaiting_gate_b') throw new Error('invalid_item_transition')
      this.#assertLeadSnapshotCurrent(item)
      this.#database.prepare(`
        UPDATE batch_application_items
        SET item_state = 'ready', gate_b_ref = ?, gate_b_content_hash = ?, gate_b_expires_at = ?,
            failure_json = NULL, checkpoint_json = NULL
        WHERE batch_id = ? AND item_id = ?
      `).run(authorizationRef, input.contentHash, input.expiresAt, normalizedBatchId, normalizedItemId)
      this.#refreshBatchState(normalizedBatchId)
      return this.#getUnsafe(normalizedBatchId) as BatchApplicationRun
    })
  }

  start(batchId: string, itemId: string, now = new Date().toISOString()): BatchApplicationRun {
    this.#ensureOpen()
    assertTimestamp(now, 'invalid_batch_timestamp')
    const normalizedBatchId = normalizeId(batchId, 'invalid_batch_id')
    const normalizedItemId = normalizeId(itemId, 'invalid_item_id')
    return this.#transaction(() => {
      const run = this.#findRun(normalizedBatchId)
      const item = this.#findItem(normalizedBatchId, normalizedItemId)
      if (run === undefined) throw new Error('batch_not_found')
      if (item === undefined) throw new Error('batch_item_not_found')
      if (item.itemState !== 'ready' || item.sequence - 1 !== run.current_cursor) throw new Error('invalid_item_transition')
      if (item.gateBRef === undefined || item.gateBContentHash === undefined || item.gateBExpiresAt === undefined) throw new Error('gate_b_required')
      if (Date.parse(item.gateBExpiresAt) <= Date.parse(now)) throw new Error('gate_b_expired')
      this.#assertLeadSnapshotCurrent(item)
      this.#database.prepare(`UPDATE batch_application_items SET item_state = 'in_progress' WHERE batch_id = ? AND item_id = ?`).run(normalizedBatchId, normalizedItemId)
      this.#database.prepare(`UPDATE batch_application_runs SET batch_state = 'running', current_cursor = ? WHERE batch_id = ?`).run(item.sequence - 1, normalizedBatchId)
      return this.#getUnsafe(normalizedBatchId) as BatchApplicationRun
    })
  }

  markSubmittedObserved(batchId: string, itemId: string, evidenceAt = new Date().toISOString()): BatchApplicationRun {
    this.#ensureOpen()
    assertTimestamp(evidenceAt, 'invalid_batch_timestamp')
    const normalizedBatchId = normalizeId(batchId, 'invalid_batch_id')
    const normalizedItemId = normalizeId(itemId, 'invalid_item_id')
    return this.#transaction(() => {
      const item = this.#findItem(normalizedBatchId, normalizedItemId)
      if (item === undefined) throw new Error('batch_item_not_found')
      if (item.itemState !== 'in_progress') throw new Error('invalid_item_transition')
      this.#database.prepare(`
        UPDATE batch_application_items SET item_state = 'submitted_observed', checkpoint_json = NULL
        WHERE batch_id = ? AND item_id = ?
      `).run(normalizedBatchId, normalizedItemId)
      this.#database.prepare(`
        UPDATE batch_application_runs SET current_cursor = ?, last_result = ? WHERE batch_id = ?
      `).run(item.sequence, `submitted_observed:${evidenceAt}`, normalizedBatchId)
      this.#refreshBatchState(normalizedBatchId)
      return this.#getUnsafe(normalizedBatchId) as BatchApplicationRun
    })
  }

  markHandoff(batchId: string, itemId: string, failure: BatchFailure, now = new Date().toISOString()): BatchApplicationRun {
    assertFailure(failure)
    assertTimestamp(now, 'invalid_batch_timestamp')
    return this.#transition(batchId, itemId, 'handoff_required', failure, now)
  }

  markFailed(batchId: string, itemId: string, failure: BatchFailure): BatchApplicationRun {
    assertFailure(failure)
    return this.#transition(batchId, itemId, 'failed', failure)
  }

  skip(batchId: string, itemId: string, reason: string): BatchApplicationRun {
    const normalizedReason = reason.trim()
    if (normalizedReason.length === 0 || normalizedReason.length > 500) throw new Error('skip_reason_required')
    this.#ensureOpen()
    const normalizedBatchId = normalizeId(batchId, 'invalid_batch_id')
    const normalizedItemId = normalizeId(itemId, 'invalid_item_id')
    return this.#transaction(() => {
      const run = this.#findRun(normalizedBatchId)
      const item = this.#findItem(normalizedBatchId, normalizedItemId)
      if (run === undefined) throw new Error('batch_not_found')
      if (item === undefined) throw new Error('batch_item_not_found')
      if (!['queued', 'awaiting_gate_b', 'failed', 'handoff_required'].includes(item.itemState)) {
        throw new Error('invalid_item_transition')
      }
      this.#database.prepare(`
        UPDATE batch_application_items
        SET item_state = 'skipped', failure_json = ?, checkpoint_json = NULL
        WHERE batch_id = ? AND item_id = ?
      `).run(JSON.stringify({ stage: 'local_plan', code: 'skipped', suggestedAction: normalizedReason, retryCount: 0 }), normalizedBatchId, normalizedItemId)
      this.#database.prepare(`UPDATE batch_application_runs SET last_result = 'skipped' WHERE batch_id = ?`).run(normalizedBatchId)
      if (item.sequence - 1 === run.current_cursor) {
        this.#database.prepare(`UPDATE batch_application_runs SET current_cursor = ? WHERE batch_id = ?`).run(item.sequence, normalizedBatchId)
      }
      this.#refreshBatchState(normalizedBatchId)
      return this.#getUnsafe(normalizedBatchId) as BatchApplicationRun
    })
  }

  resume(batchId: string, now = new Date().toISOString()): BatchApplicationRun {
    this.#ensureOpen()
    assertTimestamp(now, 'invalid_batch_timestamp')
    const normalizedBatchId = normalizeId(batchId, 'invalid_batch_id')
    return this.#transaction(() => {
      const run = this.#findRun(normalizedBatchId)
      if (run === undefined) throw new Error('batch_not_found')
      if (run.batch_state !== 'paused_handoff') throw new Error('batch_not_paused')
      const item = this.#findCurrentItem(normalizedBatchId, run.current_cursor)
      if (item === undefined || item.itemState !== 'handoff_required') throw new Error('checkpoint_not_resumable')
      this.#database.prepare(`
        UPDATE batch_application_items
        SET item_state = 'awaiting_gate_b', failure_json = NULL, checkpoint_json = NULL,
            gate_b_ref = NULL, gate_b_content_hash = NULL, gate_b_expires_at = NULL
        WHERE batch_id = ? AND item_id = ?
      `).run(normalizedBatchId, item.itemId)
      this.#database.prepare(`
        UPDATE batch_application_runs
        SET batch_state = 'queued', paused_reason = NULL, resumable_at = NULL, last_result = ?, resume_count = resume_count + 1
        WHERE batch_id = ?
      `).run(`resumed:${now}`, normalizedBatchId)
      return this.#getUnsafe(normalizedBatchId) as BatchApplicationRun
    })
  }

  close(): void {
    if (this.#closed) return
    this.#database.close()
    this.#closed = true
  }

  #transition(batchId: string, itemId: string, state: 'failed' | 'handoff_required', failure: BatchFailure, now?: string): BatchApplicationRun {
    this.#ensureOpen()
    const normalizedBatchId = normalizeId(batchId, 'invalid_batch_id')
    const normalizedItemId = normalizeId(itemId, 'invalid_item_id')
    return this.#transaction(() => {
      const run = this.#findRun(normalizedBatchId)
      const item = this.#findItem(normalizedBatchId, normalizedItemId)
      if (run === undefined) throw new Error('batch_not_found')
      if (item === undefined) throw new Error('batch_item_not_found')
      if (item.itemState !== 'ready' && item.itemState !== 'in_progress' && item.itemState !== 'failed') {
        throw new Error('invalid_item_transition')
      }
      const checkpoint = state === 'handoff_required' ? {
        itemId: item.itemId,
        sequence: item.sequence,
        stage: failure.stage,
        code: failure.code,
        savedAt: now ?? new Date().toISOString(),
        retryCount: failure.retryCount,
        nextAction: failure.suggestedAction,
      } satisfies BatchCheckpoint : undefined
      this.#database.prepare(`
        UPDATE batch_application_items
        SET item_state = ?, failure_json = ?, checkpoint_json = ?
        WHERE batch_id = ? AND item_id = ?
      `).run(state, JSON.stringify(failure), checkpoint === undefined ? null : JSON.stringify(checkpoint), normalizedBatchId, normalizedItemId)
      if (state === 'handoff_required') {
        this.#database.prepare(`
          UPDATE batch_application_runs
          SET batch_state = 'paused_handoff', paused_reason = ?, resumable_at = ?, current_cursor = ?, last_result = ?
          WHERE batch_id = ?
        `).run(failure.code, now ?? new Date().toISOString(), item.sequence - 1, `handoff_required:${failure.code}`, normalizedBatchId)
      } else {
        this.#database.prepare(`UPDATE batch_application_runs SET last_result = ? WHERE batch_id = ?`).run(`failed:${failure.code}`, normalizedBatchId)
        this.#refreshBatchState(normalizedBatchId)
      }
      return this.#getUnsafe(normalizedBatchId) as BatchApplicationRun
    })
  }

  #refreshBatchState(batchId: string): void {
    const states = this.#database.prepare(`SELECT item_state FROM batch_application_items WHERE batch_id = ? ORDER BY sequence ASC`).all(batchId) as unknown as Array<{ item_state: BatchItemState }>
    const run = this.#findRun(batchId)
    if (run === undefined) throw new Error('batch_not_found')
    const hasActive = states.some(({ item_state }) => ['queued', 'awaiting_gate_b', 'ready', 'in_progress'].includes(item_state))
    const hasFailure = states.some(({ item_state }) => item_state === 'failed' || item_state === 'handoff_required')
    const hasInProgress = states.some(({ item_state }) => item_state === 'in_progress')
    const nextState: BatchState = hasInProgress ? 'running' : hasActive ? 'queued' : hasFailure ? 'completed_with_failures' : 'completed'
    this.#database.prepare(`UPDATE batch_application_runs SET batch_state = ? WHERE batch_id = ?`).run(nextState, batchId)
  }

  #getUnsafe(batchId: string): BatchApplicationRun | undefined {
    const run = this.#findRun(batchId)
    if (run === undefined) return undefined
    const rows = this.#database.prepare(`
      SELECT item_id, batch_id, lead_id, sequence, company, role, channel_url, official_apply_url,
             lead_content_hash, lead_confidence, item_state, gate_b_ref, gate_b_content_hash,
             gate_b_expires_at, failure_json, checkpoint_json
      FROM batch_application_items
      WHERE batch_id = ?
      ORDER BY sequence ASC
    `).all(batchId) as unknown as ItemRow[]
    return {
      batchId: run.batch_id,
      sessionId: run.session_id,
      createdAt: run.created_at,
      strategyVersion: run.strategy_version,
      batchState: run.batch_state,
      currentCursor: run.current_cursor,
      items: rows.map(toItem),
      ...run.last_result === null ? {} : { lastResult: run.last_result },
      ...run.paused_reason === null ? {} : { pausedReason: run.paused_reason },
      ...run.resumable_at === null ? {} : { resumableAt: run.resumable_at },
      resumeCount: run.resume_count,
    }
  }

  #loadLead(leadId: string): JobLead | undefined {
    const row = this.#database.prepare(`
      SELECT lead_id, source_kind, source_record_id, company, role, city, cohort, deadline,
             channel_url, official_apply_url, source_updated_at, fetched_at, raw_ref, content_hash, confidence
      FROM job_leads WHERE lead_id = ?
    `).get(leadId) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      leadId: String(row.lead_id),
      sourceKind: row.source_kind as JobLead['sourceKind'],
      sourceRecordId: String(row.source_record_id),
      company: String(row.company),
      role: String(row.role),
      ...nullableString(row.city, 'city'),
      ...nullableString(row.cohort, 'cohort'),
      ...nullableString(row.deadline, 'deadline'),
      ...nullableString(row.channel_url, 'channelUrl'),
      ...nullableString(row.official_apply_url, 'officialApplyUrl'),
      ...nullableString(row.source_updated_at, 'sourceUpdatedAt'),
      fetchedAt: String(row.fetched_at),
      rawRef: String(row.raw_ref),
      contentHash: String(row.content_hash),
      confidence: row.confidence as LeadConfidence,
    }
  }

  #assertLeadSnapshotCurrent(item: BatchApplicationItem): void {
    const lead = this.#loadLead(item.leadId)
    if (lead === undefined) throw new Error('lead_not_found')
    if (lead.contentHash !== item.leadContentHash) throw new Error('lead_content_changed')
    if (!VERIFIED_CONFIDENCE.has(lead.confidence)) throw new Error('lead_not_verified')
  }

  #findRun(batchId: string): RunRow | undefined {
    return this.#database.prepare(`
      SELECT batch_id, session_id, created_at, strategy_version, batch_state, current_cursor,
             last_result, paused_reason, resumable_at, resume_count
      FROM batch_application_runs WHERE batch_id = ?
    `).get(batchId) as unknown as RunRow | undefined
  }

  #findItem(batchId: string, itemId: string): BatchApplicationItem | undefined {
    const row = this.#database.prepare(`
      SELECT item_id, batch_id, lead_id, sequence, company, role, channel_url, official_apply_url,
             lead_content_hash, lead_confidence, item_state, gate_b_ref, gate_b_content_hash,
             gate_b_expires_at, failure_json, checkpoint_json
      FROM batch_application_items WHERE batch_id = ? AND item_id = ?
    `).get(batchId, itemId) as unknown as ItemRow | undefined
    return row === undefined ? undefined : toItem(row)
  }

  #findCurrentItem(batchId: string, cursor: number): BatchApplicationItem | undefined {
    const row = this.#database.prepare(`
      SELECT item_id, batch_id, lead_id, sequence, company, role, channel_url, official_apply_url,
             lead_content_hash, lead_confidence, item_state, gate_b_ref, gate_b_content_hash,
             gate_b_expires_at, failure_json, checkpoint_json
      FROM batch_application_items WHERE batch_id = ? AND sequence = ?
    `).get(batchId, cursor + 1) as unknown as ItemRow | undefined
    return row === undefined ? undefined : toItem(row)
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error('sqlite_batch_store_closed')
  }
}

function toItem(row: ItemRow): BatchApplicationItem {
  if (!ITEM_STATES.has(row.item_state)) throw new Error('source_corrupt_batch_item')
  const failure = parseJson<BatchFailure>(row.failure_json)
  const checkpoint = parseJson<BatchCheckpoint>(row.checkpoint_json)
  return {
    itemId: row.item_id,
    batchId: row.batch_id,
    leadId: row.lead_id,
    sequence: row.sequence,
    company: row.company,
    role: row.role,
    ...nullableString(row.channel_url, 'channelUrl'),
    ...nullableString(row.official_apply_url, 'officialApplyUrl'),
    leadContentHash: row.lead_content_hash,
    leadConfidence: row.lead_confidence,
    itemState: row.item_state,
    ...nullableString(row.gate_b_ref, 'gateBRef'),
    ...nullableString(row.gate_b_content_hash, 'gateBContentHash'),
    ...nullableString(row.gate_b_expires_at, 'gateBExpiresAt'),
    ...failure === undefined ? {} : { failure },
    ...checkpoint === undefined ? {} : { checkpoint },
  }
}

function normalizeLeadIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new Error('invalid_lead_ids')
  const normalized = value.map((leadId) => normalizeId(leadId, 'invalid_lead_id'))
  if (new Set(normalized).size !== normalized.length) throw new Error('duplicate_lead_id')
  return normalized
}

function normalizeId(value: string, errorCode: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(errorCode)
  return value.trim()
}

function assertTimestamp(value: string, errorCode: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(errorCode)
}

function assertFailure(failure: BatchFailure): void {
  if (failure.stage.trim().length === 0 || failure.stage.length > 200 || failure.code.trim().length === 0 || failure.code.length > 200 || failure.suggestedAction.trim().length === 0 || failure.suggestedAction.length > 500 || (failure.pageKind !== undefined && failure.pageKind.length > 200) || !Number.isInteger(failure.retryCount) || failure.retryCount < 0) {
    throw new Error('invalid_batch_failure')
  }
}

function nullableString(value: unknown, key: string): Record<string, string> {
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error('source_corrupt_batch_json')
  }
}
