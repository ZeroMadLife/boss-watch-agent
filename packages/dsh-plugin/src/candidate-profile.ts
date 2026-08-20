import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type CandidateProfileField =
  | 'preferredCity'
  | 'arrivalTime'
  | 'wechat'
  | 'internshipDuration'
  | 'positionKeywords'

export interface CandidateProfileValues {
  readonly preferredCity?: string
  readonly arrivalTime?: string
  readonly wechat?: string
  readonly internshipDuration?: string
  readonly positionKeywords?: string
}

export interface CandidateProfile {
  readonly profileId: 'candidate-profile:default'
  readonly strategyVersion: 'candidate-profile-v1'
  readonly updatedAt: string
  readonly contentHash: string
  readonly values: CandidateProfileValues
}

export interface CandidateProfileSummary {
  readonly profileId: 'candidate-profile:default'
  readonly strategyVersion: 'candidate-profile-v1'
  readonly updatedAt: string
  readonly contentHash: string
  readonly availableFields: readonly CandidateProfileField[]
  readonly valuesReturned: false
}

/** Planning-only values for the local search planner; callers must not echo sensitive fields. */
export interface CandidateSearchPlanningValues {
  readonly preferredCity?: string
  readonly positionKeywords?: string
}

export interface CandidateProfilePreview extends CandidateProfileSummary {
  readonly previewToken: string
  readonly expiresAt: string
  readonly replacesContentHash?: string
  readonly requiresConfirmation: true
}

export interface CandidateProfileStore {
  get(): CandidateProfile | undefined
  save(profile: CandidateProfile): CandidateProfile
  close(): void
}

interface PendingCandidateProfile {
  readonly sessionId: string
  readonly profile: CandidateProfile
  readonly expiresAt: number
}

const FIELD_ORDER: readonly CandidateProfileField[] = [
  'preferredCity',
  'arrivalTime',
  'wechat',
  'internshipDuration',
  'positionKeywords',
]

export class SqliteCandidateProfileStore implements CandidateProfileStore {
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
      CREATE TABLE IF NOT EXISTS candidate_profile (
        profile_id TEXT PRIMARY KEY CHECK (profile_id = 'candidate-profile:default'),
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        updated_at TEXT NOT NULL,
        profile_json TEXT NOT NULL
      );
    `)
  }

  get(): CandidateProfile | undefined {
    this.#assertOpen()
    const row = this.#database.prepare(
      'SELECT profile_json FROM candidate_profile WHERE profile_id = ?',
    ).get('candidate-profile:default') as { profile_json: string } | undefined
    return row === undefined ? undefined : parseProfile(row.profile_json)
  }

  save(profile: CandidateProfile): CandidateProfile {
    this.#assertOpen()
    const parsed = parseProfile(JSON.stringify(profile))
    this.#database.prepare(`
      INSERT INTO candidate_profile (profile_id, content_hash, updated_at, profile_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at,
        profile_json = excluded.profile_json
    `).run(parsed.profileId, parsed.contentHash, parsed.updatedAt, JSON.stringify(parsed))
    return parsed
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('candidate_profile_store_closed')
  }
}

export class LocalCandidateProfileService {
  readonly #store: CandidateProfileStore
  readonly #now: () => Date
  readonly #token: () => string
  readonly #pending = new Map<string, PendingCandidateProfile>()
  readonly #consumed = new Set<string>()

  constructor(input: {
    store: CandidateProfileStore
    now?: () => Date
    token?: () => string
  }) {
    this.#store = input.store
    this.#now = input.now ?? (() => new Date())
    this.#token = input.token ?? (() => `candidate-profile-preview:${randomBytes(24).toString('hex')}`)
  }

  getSummary(): CandidateProfileSummary | undefined {
    const profile = this.#store.get()
    return profile === undefined ? undefined : summarize(profile)
  }

  getSearchPlanningValues(): CandidateSearchPlanningValues | undefined {
    const values = this.#store.get()?.values
    if (values === undefined) return undefined
    return {
      ...values.preferredCity === undefined ? {} : { preferredCity: values.preferredCity },
      ...values.positionKeywords === undefined ? {} : { positionKeywords: values.positionKeywords },
    }
  }

  preview(input: CandidateProfileValues, sessionId = 'local-session'): CandidateProfilePreview {
    const session = requireText(sessionId, 'session_id')
    const current = this.#store.get()
    const values = normalizeValues({ ...current?.values, ...input })
    if (Object.keys(values).length === 0) throw new Error('candidate_profile_empty')
    const now = this.#now()
    const expiresAt = now.getTime() + 15 * 60 * 1000
    const profile = profileFrom(values, now.toISOString())
    const previewToken = this.#token()
    this.#pruneExpired(now.getTime())
    this.#pending.set(previewToken, { sessionId: session, profile, expiresAt })
    return {
      ...summarize(profile),
      previewToken,
      expiresAt: new Date(expiresAt).toISOString(),
      ...current === undefined ? {} : { replacesContentHash: current.contentHash },
      requiresConfirmation: true,
    }
  }

  apply(previewTokenInput: string, confirmed: boolean, sessionId = 'local-session'): CandidateProfileSummary {
    if (confirmed !== true) throw new Error('candidate_profile_confirmation_required')
    const previewToken = requireText(previewTokenInput, 'candidate_profile_preview_token')
    if (this.#consumed.has(previewToken)) throw new Error('candidate_profile_preview_consumed')
    const pending = this.#pending.get(previewToken)
    if (pending === undefined) throw new Error('candidate_profile_preview_not_found')
    if (pending.sessionId !== requireText(sessionId, 'session_id')) throw new Error('candidate_profile_session_mismatch')
    if (pending.expiresAt <= this.#now().getTime()) {
      this.#pending.delete(previewToken)
      throw new Error('candidate_profile_preview_expired')
    }
    this.#pending.delete(previewToken)
    this.#consumed.add(previewToken)
    return summarize(this.#store.save(pending.profile))
  }

  #pruneExpired(now: number): void {
    for (const [token, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(token)
    }
  }
}

function profileFrom(values: CandidateProfileValues, updatedAt: string): CandidateProfile {
  const canonical = JSON.stringify(FIELD_ORDER.flatMap((field) => values[field] === undefined ? [] : [[field, values[field]]]))
  return {
    profileId: 'candidate-profile:default',
    strategyVersion: 'candidate-profile-v1',
    updatedAt,
    contentHash: createHash('sha256').update(canonical).digest('hex'),
    values,
  }
}

function summarize(profile: CandidateProfile): CandidateProfileSummary {
  return {
    profileId: profile.profileId,
    strategyVersion: profile.strategyVersion,
    updatedAt: profile.updatedAt,
    contentHash: profile.contentHash,
    availableFields: FIELD_ORDER.filter(field => profile.values[field] !== undefined),
    valuesReturned: false,
  }
}

function normalizeValues(input: CandidateProfileValues): CandidateProfileValues {
  return Object.fromEntries(FIELD_ORDER.flatMap((field) => {
    const value = input[field]
    if (value === undefined) return []
    const normalized = value.trim()
    if (normalized.length === 0 || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
      throw new Error(`invalid_candidate_profile_${camelToSnake(field)}`)
    }
    return [[field, normalized]]
  })) as CandidateProfileValues
}

function parseProfile(value: string): CandidateProfile {
  const parsed = JSON.parse(value) as Partial<CandidateProfile>
  if (
    parsed.profileId !== 'candidate-profile:default'
    || parsed.strategyVersion !== 'candidate-profile-v1'
    || typeof parsed.updatedAt !== 'string'
    || typeof parsed.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(parsed.contentHash)
    || parsed.values === undefined
  ) throw new Error('candidate_profile_invalid')
  const values = normalizeValues(parsed.values)
  const expected = profileFrom(values, parsed.updatedAt)
  if (expected.contentHash !== parsed.contentHash) throw new Error('candidate_profile_hash_mismatch')
  return expected
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`)
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`invalid_${name}`)
  return normalized
}
