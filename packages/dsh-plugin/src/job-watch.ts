import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BossWatchBrowserController, BossWatchDataSource, BrowserWatchPoll } from './domain.js'

export type JobWatchState = 'active' | 'polling' | 'paused_human_required' | 'stopped'
export type JobWatchObservationResult = 'unchanged' | 'changed' | 'transient_failure' | 'paused_human_required'

export interface JobWatch {
  readonly watchId: string
  readonly applicationId: string
  readonly platform: 'boss'
  readonly externalJobId: string
  readonly company: string
  readonly role: string
  readonly jobUrl: string
  readonly state: JobWatchState
  readonly createdAt: string
  readonly lastPolledAt?: string
  readonly nextPollAt?: string
  readonly baselineContentHash: string
  readonly consecutiveUnchanged: number
  readonly consecutiveFailures: number
  readonly dailyPollCount: number
  readonly lastResult?: JobWatchObservationResult
  readonly pausedReason?: string
}

export interface JobWatchObservation {
  readonly observationId: string
  readonly watchId: string
  readonly observedAt: string
  readonly result: JobWatchObservationResult
  readonly previousContentHash: string
  readonly currentContentHash?: string
  readonly errorCode?: string
}

export interface JobWatchPollResult {
  readonly result: JobWatchObservationResult
  readonly watch: JobWatch
  readonly observation: JobWatchObservation
  readonly browserStatus: BrowserWatchPoll['status']
}

export interface JobWatchPollService {
  list(): readonly JobWatch[]
  poll(watchId: string): Promise<JobWatchPollResult>
}

interface CreateWatchInput {
  readonly watchId: string
  readonly applicationId: string
  readonly externalJobId: string
  readonly company: string
  readonly role: string
  readonly jobUrl: string
  readonly baselineContentHash: string
  readonly createdAt: string
  readonly nextPollAt: string
}

interface BeginPollInput {
  readonly watchId: string
  readonly now: string
  readonly dayKey: string
  readonly dailyBudget: number
}

interface FinishPollInput {
  readonly watchId: string
  readonly observationId: string
  readonly now: string
  readonly result: JobWatchObservationResult
  readonly currentContentHash?: string
  readonly errorCode?: string
  readonly pausedReason?: string
}

export interface JobWatchStore {
  create(input: CreateWatchInput): JobWatch
  get(watchId: string): JobWatch | undefined
  list(): readonly JobWatch[]
  beginPoll(input: BeginPollInput): JobWatch
  finishPoll(input: FinishPollInput): { readonly watch: JobWatch; readonly observation: JobWatchObservation }
  stop(watchId: string): JobWatch
  resume(watchId: string, now: string): JobWatch
  close(): void
}

interface WatchRow {
  watch_id: string
  application_id: string
  platform: 'boss'
  external_job_id: string
  company: string
  role: string
  job_url: string
  state: JobWatchState
  created_at: string
  last_polled_at: string | null
  next_poll_at: string | null
  baseline_content_hash: string
  consecutive_unchanged: number
  consecutive_failures: number
  daily_poll_count: number
  last_result: JobWatchObservationResult | null
  paused_reason: string | null
  polling_started_at: string | null
}

interface PollingLockRow {
  watch_id: string
  polling_started_at: string | null
}

export class SqliteJobWatchStore implements JobWatchStore {
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
      CREATE TABLE IF NOT EXISTS job_watches (
        watch_id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL CHECK (platform = 'boss'),
        external_job_id TEXT NOT NULL,
        company TEXT NOT NULL,
        role TEXT NOT NULL,
        job_url TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'polling', 'paused_human_required', 'stopped')),
        created_at TEXT NOT NULL,
        last_polled_at TEXT,
        next_poll_at TEXT,
        baseline_content_hash TEXT NOT NULL CHECK (length(baseline_content_hash) = 64),
        consecutive_unchanged INTEGER NOT NULL CHECK (consecutive_unchanged >= 0),
        consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
        daily_poll_count INTEGER NOT NULL CHECK (daily_poll_count >= 0),
        last_result TEXT,
        paused_reason TEXT,
        polling_started_at TEXT
      );
      CREATE INDEX IF NOT EXISTS job_watches_due ON job_watches(state, next_poll_at);
      CREATE TABLE IF NOT EXISTS job_watch_daily_budget (
        day_key TEXT PRIMARY KEY,
        poll_count INTEGER NOT NULL CHECK (poll_count >= 0)
      );
      CREATE TABLE IF NOT EXISTS job_watch_observations (
        observation_id TEXT PRIMARY KEY,
        watch_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('unchanged', 'changed', 'transient_failure', 'paused_human_required')),
        previous_content_hash TEXT NOT NULL CHECK (length(previous_content_hash) = 64),
        current_content_hash TEXT,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS job_watch_observations_watch ON job_watch_observations(watch_id, observed_at);
    `)
  }

  create(input: CreateWatchInput): JobWatch {
    this.#ensureOpen()
    validateCreateInput(input)
    const existing = this.#database.prepare(`
      SELECT ${WATCH_COLUMNS} FROM job_watches WHERE application_id = ?
    `).get(input.applicationId) as unknown as WatchRow | undefined
    if (existing !== undefined) return fromWatchRow(existing)
    this.#database.prepare(`
      INSERT INTO job_watches (
        watch_id, application_id, platform, external_job_id, company, role, job_url, state,
        created_at, last_polled_at, next_poll_at, baseline_content_hash, consecutive_unchanged,
        consecutive_failures, daily_poll_count, last_result, paused_reason, polling_started_at
      ) VALUES (?, ?, 'boss', ?, ?, ?, ?, 'active', ?, NULL, ?, ?, 0, 0, 0, NULL, NULL, NULL)
    `).run(
      input.watchId,
      input.applicationId,
      input.externalJobId,
      input.company,
      input.role,
      input.jobUrl,
      input.createdAt,
      input.nextPollAt,
      input.baselineContentHash,
    )
    const created = this.get(input.watchId)
    if (created === undefined) throw new Error('watch_write_failed')
    return created
  }

  get(watchId: string): JobWatch | undefined {
    this.#ensureOpen()
    const row = this.#database.prepare(`
      SELECT ${WATCH_COLUMNS} FROM job_watches WHERE watch_id = ?
    `).get(requireText(watchId, 'watch_id')) as unknown as WatchRow | undefined
    return row === undefined ? undefined : fromWatchRow(row)
  }

  list(): readonly JobWatch[] {
    this.#ensureOpen()
    const rows = this.#database.prepare(`
      SELECT ${WATCH_COLUMNS} FROM job_watches ORDER BY created_at ASC, watch_id ASC
    `).all() as unknown as WatchRow[]
    return rows.map(fromWatchRow)
  }

  beginPoll(input: BeginPollInput): JobWatch {
    this.#ensureOpen()
    validateBeginInput(input)
    return this.#transaction(() => {
      const row = this.#getRow(input.watchId)
      if (row === undefined) throw new Error('watch_not_found')
      if (row.state === 'stopped') throw new Error('watch_stopped')
      if (row.state === 'paused_human_required') throw new Error('watch_paused')
      if (row.state === 'polling') {
        const startedAt = row.polling_started_at === null ? 0 : Date.parse(row.polling_started_at)
        if (!Number.isFinite(startedAt) || Date.parse(input.now) - startedAt < POLL_RECOVERY_WINDOW_MS) {
          throw new Error('watch_poll_in_progress')
        }
      }
      const competingPolls = this.#database.prepare(`
        SELECT watch_id, polling_started_at FROM job_watches
        WHERE state = 'polling' AND watch_id <> ?
      `).all(input.watchId) as unknown as PollingLockRow[]
      if (competingPolls.some((candidate) => pollingLockIsActive(candidate.polling_started_at, input.now))) {
        throw new Error('watch_profile_busy')
      }
      if (row.state === 'active' && row.next_poll_at !== null && Date.parse(row.next_poll_at) > Date.parse(input.now)) {
        throw new Error('watch_not_due')
      }
      const budget = this.#database.prepare(`
        SELECT poll_count FROM job_watch_daily_budget WHERE day_key = ?
      `).get(input.dayKey) as { poll_count: number } | undefined
      const used = budget?.poll_count ?? 0
      if (used >= input.dailyBudget) throw new Error('watch_daily_budget_exhausted')
      this.#database.prepare(`
        INSERT INTO job_watch_daily_budget (day_key, poll_count) VALUES (?, 1)
        ON CONFLICT (day_key) DO UPDATE SET poll_count = poll_count + 1
      `).run(input.dayKey)
      this.#database.prepare(`
        UPDATE job_watches SET state = 'polling', polling_started_at = ?, daily_poll_count = daily_poll_count + 1
        WHERE watch_id = ?
      `).run(input.now, input.watchId)
      const started = this.#getRow(input.watchId)
      if (started === undefined) throw new Error('watch_write_failed')
      return fromWatchRow(started)
    })
  }

  finishPoll(input: FinishPollInput): { readonly watch: JobWatch; readonly observation: JobWatchObservation } {
    this.#ensureOpen()
    validateFinishInput(input)
    return this.#transaction(() => {
      const row = this.#getRow(input.watchId)
      if (row === undefined) throw new Error('watch_not_found')
      if (row.state !== 'polling') throw new Error('watch_poll_not_started')
      const nowMs = Date.parse(input.now)
      const unchanged = input.result === 'unchanged'
      const changed = input.result === 'changed'
      const paused = input.result === 'paused_human_required'
      const consecutiveUnchanged = unchanged ? row.consecutive_unchanged + 1 : 0
      const consecutiveFailures = input.result === 'transient_failure' ? row.consecutive_failures + 1 : 0
      const nextPollAt = paused
        ? null
        : new Date(nowMs + nextDelayMs(input.result, consecutiveUnchanged, consecutiveFailures)).toISOString()
      const state: JobWatchState = paused ? 'paused_human_required' : 'active'
      const baseline = changed && input.currentContentHash !== undefined
        ? input.currentContentHash
        : row.baseline_content_hash
      this.#database.prepare(`
        UPDATE job_watches SET
          state = ?, last_polled_at = ?, next_poll_at = ?, baseline_content_hash = ?,
          consecutive_unchanged = ?, consecutive_failures = ?, last_result = ?, paused_reason = ?, polling_started_at = NULL
        WHERE watch_id = ?
      `).run(
        state,
        input.now,
        nextPollAt,
        baseline,
        consecutiveUnchanged,
        consecutiveFailures,
        input.result,
        paused ? input.pausedReason ?? input.errorCode ?? 'human_required' : null,
        input.watchId,
      )
      this.#database.prepare(`
        INSERT INTO job_watch_observations (
          observation_id, watch_id, observed_at, result, previous_content_hash, current_content_hash, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.observationId,
        input.watchId,
        input.now,
        input.result,
        row.baseline_content_hash,
        input.currentContentHash ?? null,
        input.errorCode ?? null,
      )
      const updated = this.#getRow(input.watchId)
      if (updated === undefined) throw new Error('watch_write_failed')
      const observation: JobWatchObservation = {
        observationId: input.observationId,
        watchId: input.watchId,
        observedAt: input.now,
        result: input.result,
        previousContentHash: row.baseline_content_hash,
        ...input.currentContentHash === undefined ? {} : { currentContentHash: input.currentContentHash },
        ...input.errorCode === undefined ? {} : { errorCode: input.errorCode },
      }
      return { watch: fromWatchRow(updated), observation }
    })
  }

  stop(watchId: string): JobWatch {
    this.#ensureOpen()
    const normalized = requireText(watchId, 'watch_id')
    this.#database.prepare(`
      UPDATE job_watches SET state = 'stopped', next_poll_at = NULL, polling_started_at = NULL, paused_reason = NULL
      WHERE watch_id = ?
    `).run(normalized)
    const watch = this.get(normalized)
    if (watch === undefined) throw new Error('watch_not_found')
    return watch
  }

  resume(watchId: string, now: string): JobWatch {
    this.#ensureOpen()
    if (!Number.isFinite(Date.parse(now))) throw new Error('invalid_watch_timestamp')
    const normalized = requireText(watchId, 'watch_id')
    const row = this.#getRow(normalized)
    if (row === undefined) throw new Error('watch_not_found')
    if (row.state !== 'paused_human_required') throw new Error('watch_not_paused')
    this.#database.prepare(`
      UPDATE job_watches SET state = 'active', next_poll_at = ?, paused_reason = NULL, polling_started_at = NULL
      WHERE watch_id = ?
    `).run(now, normalized)
    const watch = this.get(normalized)
    if (watch === undefined) throw new Error('watch_write_failed')
    return watch
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  #getRow(watchId: string): WatchRow | undefined {
    return this.#database.prepare(`
      SELECT ${WATCH_COLUMNS} FROM job_watches WHERE watch_id = ?
    `).get(watchId) as unknown as WatchRow | undefined
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
    if (this.#closed) throw new Error('sqlite_watch_store_closed')
  }
}

export class LocalJobWatchService implements JobWatchPollService {
  readonly #source: BossWatchDataSource
  readonly #browser: BossWatchBrowserController
  readonly #store: JobWatchStore
  readonly #now: () => Date
  readonly #idFactory: () => string

  constructor(input: {
    source: BossWatchDataSource
    browser: BossWatchBrowserController
    store: JobWatchStore
    now?: () => Date
    idFactory?: () => string
  }) {
    this.#source = input.source
    this.#browser = input.browser
    this.#store = input.store
    this.#now = input.now ?? (() => new Date())
    this.#idFactory = input.idFactory ?? randomUUID
  }

  async create(applicationId: string): Promise<JobWatch> {
    const job = await this.#source.getJob(requireText(applicationId, 'application_id'))
    if (job === undefined) throw new Error('watch_application_not_found')
    if (job.jobUrl === undefined) throw new Error('watch_job_url_missing')
    const identity = parseBossJobUrl(job.jobUrl)
    const now = this.#now().toISOString()
    return this.#store.create({
      watchId: `watch:${this.#idFactory()}`,
      applicationId: job.applicationId,
      externalJobId: identity.externalJobId,
      company: job.company,
      role: job.role,
      jobUrl: identity.jobUrl,
      baselineContentHash: job.contentHash,
      createdAt: now,
      nextPollAt: now,
    })
  }

  list(): readonly JobWatch[] {
    return this.#store.list()
  }

  stop(watchId: string): JobWatch {
    return this.#store.stop(watchId)
  }

  resume(watchId: string): JobWatch {
    return this.#store.resume(watchId, this.#now().toISOString())
  }

  async poll(watchId: string): Promise<JobWatchPollResult> {
    const currentTime = this.#now()
    const now = currentTime.toISOString()
    const started = this.#store.beginPoll({
      watchId,
      now,
      dayKey: dayKey(currentTime),
      dailyBudget: 20,
    })
    try {
      const browserResult = await this.#browser.pollJob(started.applicationId)
      if (browserResult.status === 'ok') {
        if (browserResult.applicationId !== started.applicationId) {
          return this.#finish(started, 'paused_human_required', browserResult.status, undefined, 'watch_application_mismatch')
        }
        const current = await this.#source.getJob(started.applicationId)
        if (current === undefined) return this.#finish(started, 'transient_failure', browserResult.status, undefined, 'watch_source_unavailable')
        const result: JobWatchObservationResult = current.contentHash === started.baselineContentHash ? 'unchanged' : 'changed'
        return this.#finish(started, result, browserResult.status, current.contentHash)
      }
      if (browserResult.status === 'human_required' || browserResult.status === 'page_adapter_mismatch' || browserResult.status === 'invalid_request') {
        const reason = browserResult.status === 'human_required'
          ? browserResult.reason
          : browserResult.status === 'page_adapter_mismatch'
            ? 'page_adapter_mismatch'
            : browserResult.reason
        return this.#finish(started, 'paused_human_required', browserResult.status, undefined, reason, reason)
      }
      return this.#finish(started, 'transient_failure', browserResult.status, undefined, browserResult.status)
    } catch (error: unknown) {
      return this.#finish(started, 'transient_failure', 'environment_interrupted', undefined, errorCode(error))
    }
  }

  #finish(
    started: JobWatch,
    result: JobWatchObservationResult,
    browserStatus: BrowserWatchPoll['status'],
    currentContentHash?: string,
    errorCode?: string,
    pausedReason?: string,
  ): JobWatchPollResult {
    const finished = this.#store.finishPoll({
      watchId: started.watchId,
      observationId: `watch-observation:${this.#idFactory()}`,
      now: this.#now().toISOString(),
      result,
      ...currentContentHash === undefined ? {} : { currentContentHash },
      ...errorCode === undefined ? {} : { errorCode },
      ...pausedReason === undefined ? {} : { pausedReason },
    })
    return { result, watch: finished.watch, observation: finished.observation, browserStatus }
  }
}

const WATCH_COLUMNS = `
  watch_id, application_id, platform, external_job_id, company, role, job_url, state,
  created_at, last_polled_at, next_poll_at, baseline_content_hash, consecutive_unchanged,
  consecutive_failures, daily_poll_count, last_result, paused_reason, polling_started_at
`

const POLL_RECOVERY_WINDOW_MS = 15 * 60 * 1000

function validateCreateInput(input: CreateWatchInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`invalid_watch_${name}`)
  }
  if (!/^[a-f0-9]{64}$/u.test(input.baselineContentHash)) throw new Error('invalid_watch_baseline_hash')
  if (!Number.isFinite(Date.parse(input.createdAt)) || !Number.isFinite(Date.parse(input.nextPollAt))) {
    throw new Error('invalid_watch_timestamp')
  }
}

function validateBeginInput(input: BeginPollInput): void {
  if (input.dailyBudget < 1 || !Number.isInteger(input.dailyBudget)) throw new Error('invalid_watch_budget')
  if (!Number.isFinite(Date.parse(input.now)) || input.dayKey.trim().length === 0) throw new Error('invalid_watch_timestamp')
}

function validateFinishInput(input: FinishPollInput): void {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error('invalid_watch_timestamp')
  if (!/^[a-f0-9]{64}$/u.test(input.currentContentHash ?? 'a'.repeat(64)) && input.currentContentHash !== undefined) {
    throw new Error('invalid_watch_content_hash')
  }
}

function fromWatchRow(row: WatchRow): JobWatch {
  return {
    watchId: row.watch_id,
    applicationId: row.application_id,
    platform: row.platform,
    externalJobId: row.external_job_id,
    company: row.company,
    role: row.role,
    jobUrl: row.job_url,
    state: row.state,
    createdAt: row.created_at,
    ...row.last_polled_at === null ? {} : { lastPolledAt: row.last_polled_at },
    ...row.next_poll_at === null ? {} : { nextPollAt: row.next_poll_at },
    baselineContentHash: row.baseline_content_hash,
    consecutiveUnchanged: row.consecutive_unchanged,
    consecutiveFailures: row.consecutive_failures,
    dailyPollCount: row.daily_poll_count,
    ...row.last_result === null ? {} : { lastResult: row.last_result },
    ...row.paused_reason === null ? {} : { pausedReason: row.paused_reason },
  }
}

function parseBossJobUrl(value: string): { readonly jobUrl: string; readonly externalJobId: string } {
  try {
    const url = new URL(value)
    const match = /^\/job_detail\/([a-zA-Z0-9_-]+)(?:\.html)?/u.exec(url.pathname)
    if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || match?.[1] === undefined) throw new Error()
    url.hash = ''
    url.search = ''
    return { jobUrl: url.toString(), externalJobId: match[1] }
  } catch {
    throw new Error('watch_unsupported_job_url')
  }
}

function nextDelayMs(result: JobWatchObservationResult, consecutiveUnchanged: number, consecutiveFailures: number): number {
  if (result === 'changed') return 12 * 60 * 60 * 1000
  if (result === 'unchanged') return (consecutiveUnchanged <= 1 ? 24 : 48) * 60 * 60 * 1000
  if (result === 'transient_failure') return Math.min(30 * 60 * 1000 * (2 ** Math.max(0, consecutiveFailures - 1)), 6 * 60 * 60 * 1000)
  return 0
}

function pollingLockIsActive(startedAt: string | null, now: string): boolean {
  if (startedAt === null) return true
  const startedAtMs = Date.parse(startedAt)
  return !Number.isFinite(startedAtMs) || Date.parse(now) - startedAtMs < POLL_RECOVERY_WINDOW_MS
}

function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`invalid_${name}`)
  return normalized
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : 'watch_poll_failed'
}
