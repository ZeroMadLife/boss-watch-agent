import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type FollowUpReason = 'application_status' | 'no_response' | 'interview' | 'manual'
export type FollowUpState = 'scheduled' | 'completed'

export interface ApplicationFollowUp {
  readonly followUpId: string
  readonly applicationId: string
  readonly dueAt: string
  readonly reason: FollowUpReason
  readonly note?: string
  readonly state: FollowUpState
  readonly createdAt: string
  readonly completedAt?: string
}

export interface FollowUpStore {
  schedule(input: {
    readonly applicationId: string
    readonly dueAt: string
    readonly reason: FollowUpReason
    readonly note?: string
    readonly now?: string
  }): ApplicationFollowUp
  listActive(input?: { readonly asOf?: string; readonly limit?: number }): ApplicationFollowUp[]
  complete(followUpId: string, now?: string): ApplicationFollowUp
  close(): void
}

interface FollowUpRow {
  follow_up_id: string
  application_id: string
  due_at: string
  reason: FollowUpReason
  note: string | null
  state: FollowUpState
  created_at: string
  completed_at: string | null
}

const REASONS = new Set<FollowUpReason>(['application_status', 'no_response', 'interview', 'manual'])

export class SqliteFollowUpStore implements FollowUpStore {
  readonly #database: DatabaseSync
  #closed = false

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error('invalid_database_path')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS application_follow_ups (
          follow_up_id TEXT PRIMARY KEY,
          application_id TEXT NOT NULL,
          due_at TEXT NOT NULL,
          reason TEXT NOT NULL CHECK (reason IN ('application_status', 'no_response', 'interview', 'manual')),
          note TEXT,
          state TEXT NOT NULL CHECK (state IN ('scheduled', 'completed')),
          created_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE (application_id, due_at, reason)
        );
        CREATE INDEX IF NOT EXISTS application_follow_ups_active_due
          ON application_follow_ups(state, due_at, created_at);
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  schedule(input: {
    readonly applicationId: string
    readonly dueAt: string
    readonly reason: FollowUpReason
    readonly note?: string
    readonly now?: string
  }): ApplicationFollowUp {
    this.#ensureOpen()
    const applicationId = normalizeId(input.applicationId, 'invalid_application_id')
    const dueAt = normalizeTimestamp(input.dueAt, 'invalid_follow_up_due_at')
    const createdAt = normalizeTimestamp(input.now ?? new Date().toISOString(), 'invalid_follow_up_timestamp')
    if (!REASONS.has(input.reason)) throw new Error('invalid_follow_up_reason')
    const note = normalizeNote(input.note)
    return this.#transaction(() => {
      const existing = this.#findByKey(applicationId, dueAt, input.reason)
      if (existing !== undefined) return existing
      const followUpId = `follow-up:${randomUUID()}`
      this.#database.prepare(`
        INSERT INTO application_follow_ups (
          follow_up_id, application_id, due_at, reason, note, state, created_at
        ) VALUES (?, ?, ?, ?, ?, 'scheduled', ?)
      `).run(followUpId, applicationId, dueAt, input.reason, note ?? null, createdAt)
      return this.#get(followUpId) as ApplicationFollowUp
    })
  }

  listActive(input: { readonly asOf?: string; readonly limit?: number } = {}): ApplicationFollowUp[] {
    this.#ensureOpen()
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_follow_up_limit')
    if (input.asOf !== undefined) normalizeTimestamp(input.asOf, 'invalid_follow_up_timestamp')
    const rows = this.#database.prepare(`
      SELECT follow_up_id, application_id, due_at, reason, note, state, created_at, completed_at
      FROM application_follow_ups
      WHERE state = 'scheduled'
      ORDER BY due_at ASC, created_at ASC, follow_up_id ASC
      LIMIT ?
    `).all(limit) as unknown as FollowUpRow[]
    return rows.map(toFollowUp)
  }

  complete(followUpId: string, now = new Date().toISOString()): ApplicationFollowUp {
    this.#ensureOpen()
    const normalizedId = normalizeId(followUpId, 'invalid_follow_up_id')
    const completedAt = normalizeTimestamp(now, 'invalid_follow_up_timestamp')
    return this.#transaction(() => {
      const existing = this.#get(normalizedId)
      if (existing === undefined) throw new Error('follow_up_not_found')
      if (existing.state === 'completed') return existing
      this.#database.prepare(`
        UPDATE application_follow_ups
        SET state = 'completed', completed_at = ?
        WHERE follow_up_id = ? AND state = 'scheduled'
      `).run(completedAt, normalizedId)
      return this.#get(normalizedId) as ApplicationFollowUp
    })
  }

  close(): void {
    if (this.#closed) return
    this.#database.close()
    this.#closed = true
  }

  #get(followUpId: string): ApplicationFollowUp | undefined {
    const row = this.#database.prepare(`
      SELECT follow_up_id, application_id, due_at, reason, note, state, created_at, completed_at
      FROM application_follow_ups
      WHERE follow_up_id = ?
    `).get(followUpId) as unknown as FollowUpRow | undefined
    return row === undefined ? undefined : toFollowUp(row)
  }

  #findByKey(applicationId: string, dueAt: string, reason: FollowUpReason): ApplicationFollowUp | undefined {
    const row = this.#database.prepare(`
      SELECT follow_up_id, application_id, due_at, reason, note, state, created_at, completed_at
      FROM application_follow_ups
      WHERE application_id = ? AND due_at = ? AND reason = ?
    `).get(applicationId, dueAt, reason) as unknown as FollowUpRow | undefined
    return row === undefined ? undefined : toFollowUp(row)
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
    if (this.#closed) throw new Error('follow_up_store_closed')
  }
}

function toFollowUp(row: FollowUpRow): ApplicationFollowUp {
  return {
    followUpId: row.follow_up_id,
    applicationId: row.application_id,
    dueAt: row.due_at,
    reason: row.reason,
    ...row.note === null ? {} : { note: row.note },
    state: row.state,
    createdAt: row.created_at,
    ...row.completed_at === null ? {} : { completedAt: row.completed_at },
  }
}

function normalizeId(value: string, errorCode: string): string {
  if (typeof value !== 'string') throw new Error(errorCode)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 240) throw new Error(errorCode)
  return normalized
}

function normalizeTimestamp(value: string, errorCode: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(errorCode)
  return value
}

function normalizeNote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('invalid_follow_up_note')
  const normalized = value.trim()
  if (normalized.length === 0) return undefined
  if (normalized.length > 500) throw new Error('invalid_follow_up_note')
  return normalized
}
