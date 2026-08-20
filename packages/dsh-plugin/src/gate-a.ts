import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ResumeMatchLevel, ResumeMatchStore } from './resume-matching.js'

export interface GateAApproval {
  readonly gateAId: string
  readonly strategyVersion: 'gate-a-v1'
  readonly matchId: string
  readonly applicationId: string
  readonly resumeVersionId: string
  readonly jdContentHash: string
  readonly resumeContentHash: string
  readonly matchStrategyVersion: string
  readonly matchScore: number
  readonly matchLevel: ResumeMatchLevel
  readonly approvedAt: string
  readonly decision: 'proceed'
  readonly externalAction: 'not_authorized'
}

export interface GateAStore {
  save(approval: GateAApproval): GateAApproval
  get(gateAId: string): GateAApproval | undefined
  getByMatchId(matchId: string): GateAApproval | undefined
  list(options?: { applicationId?: string; limit?: number }): GateAApproval[]
  count(): number
  close(): void
}

export class SqliteGateAStore implements GateAStore {
  readonly #database: DatabaseSync
  #closed = false

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error('invalid_database_path')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#database = new DatabaseSync(path)
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS gate_a_approvals (
        gate_a_id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL UNIQUE,
        application_id TEXT NOT NULL,
        resume_version_id TEXT NOT NULL,
        jd_content_hash TEXT NOT NULL CHECK (length(jd_content_hash) = 64),
        resume_content_hash TEXT NOT NULL CHECK (length(resume_content_hash) = 64),
        match_strategy_version TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        approval_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gate_a_approvals_application
        ON gate_a_approvals(application_id, approved_at DESC, gate_a_id ASC);
    `)
  }

  save(approval: GateAApproval): GateAApproval {
    this.#assertOpen()
    const existing = this.getByMatchId(approval.matchId)
    if (existing !== undefined) return existing
    this.#database.prepare(`
      INSERT INTO gate_a_approvals (
        gate_a_id, match_id, application_id, resume_version_id, jd_content_hash,
        resume_content_hash, match_strategy_version, approved_at, approval_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.gateAId,
      approval.matchId,
      approval.applicationId,
      approval.resumeVersionId,
      approval.jdContentHash,
      approval.resumeContentHash,
      approval.matchStrategyVersion,
      approval.approvedAt,
      JSON.stringify(approval),
    )
    return approval
  }

  get(gateAId: string): GateAApproval | undefined {
    this.#assertOpen()
    const normalized = requireText(gateAId, 'gate_a_id')
    const row = this.#database.prepare(
      'SELECT approval_json FROM gate_a_approvals WHERE gate_a_id = ?',
    ).get(normalized) as { approval_json: string } | undefined
    return row === undefined ? undefined : parseApproval(row.approval_json)
  }

  getByMatchId(matchId: string): GateAApproval | undefined {
    this.#assertOpen()
    const normalized = requireText(matchId, 'match_id')
    const row = this.#database.prepare(
      'SELECT approval_json FROM gate_a_approvals WHERE match_id = ?',
    ).get(normalized) as { approval_json: string } | undefined
    return row === undefined ? undefined : parseApproval(row.approval_json)
  }

  list(options: { applicationId?: string; limit?: number } = {}): GateAApproval[] {
    this.#assertOpen()
    const limit = normalizeLimit(options.limit)
    const rows = options.applicationId === undefined
      ? this.#database.prepare(
        'SELECT approval_json FROM gate_a_approvals ORDER BY approved_at DESC, gate_a_id ASC LIMIT ?',
      ).all(limit)
      : this.#database.prepare(
        'SELECT approval_json FROM gate_a_approvals WHERE application_id = ? ORDER BY approved_at DESC, gate_a_id ASC LIMIT ?',
      ).all(requireText(options.applicationId, 'application_id'), limit)
    return (rows as unknown as { approval_json: string }[]).map(row => parseApproval(row.approval_json))
  }

  count(): number {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT COUNT(*) AS total FROM gate_a_approvals').get() as { total: number }
    return row.total
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('database_closed')
  }
}

export class LocalGateAService {
  readonly #matches: Pick<ResumeMatchStore, 'get'>
  readonly #approvals: Pick<GateAStore, 'save'>
  readonly #now: () => Date

  constructor(input: {
    matches: Pick<ResumeMatchStore, 'get'>
    approvals: Pick<GateAStore, 'save'>
    now?: () => Date
  }) {
    this.#matches = input.matches
    this.#approvals = input.approvals
    this.#now = input.now ?? (() => new Date())
  }

  confirm(input: { matchId: string }): GateAApproval {
    const matchId = requireText(input.matchId, 'match_id')
    const match = this.#matches.get(matchId)
    if (match === undefined) throw new Error('gate_a_match_not_found')
    const approvedAt = this.#now().toISOString()
    const gateAId = `gate-a:${createHash('sha256')
      .update(`${match.matchId}\n${match.applicationId}\n${match.jd.contentHash}\n${match.resume.contentHash}\ngate-a-v1`)
      .digest('hex')}`
    return this.#approvals.save({
      gateAId,
      strategyVersion: 'gate-a-v1',
      matchId: match.matchId,
      applicationId: match.applicationId,
      resumeVersionId: match.resume.resumeVersionId,
      jdContentHash: match.jd.contentHash,
      resumeContentHash: match.resume.contentHash,
      matchStrategyVersion: match.strategyVersion,
      matchScore: match.score,
      matchLevel: match.matchLevel,
      approvedAt,
      decision: 'proceed',
      externalAction: 'not_authorized',
    })
  }
}

function parseApproval(value: string): GateAApproval {
  return JSON.parse(value) as GateAApproval
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_gate_a_limit')
  return limit
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`invalid_${name}`)
  return normalized
}
