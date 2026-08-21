import { randomUUID } from 'node:crypto'
import type { GankCampusSearch, JobLead, JobLeadSearchSource } from './job-lead.js'

export type JobSourceRefreshRunStatus = 'completed' | 'failed'

export interface JobSourceRefreshRun {
  readonly runId: string
  readonly sourceKind: 'gankinterview_campus'
  readonly status: JobSourceRefreshRunStatus
  readonly startedAt: string
  readonly finishedAt: string
  readonly leadCount: number
  readonly leadIds: string[]
  readonly errorCode?: string
}

export interface JobSourceRefreshStatus {
  readonly enabled: boolean
  readonly running: boolean
  readonly intervalMinutes: number
  readonly nextRunAt?: string
  readonly lastRun?: JobSourceRefreshRun
}

interface SchedulerTimer {
  readonly unref?: () => void
}

export class LocalJobSourceRefreshScheduler {
  readonly #source: JobLeadSearchSource
  readonly #query: GankCampusSearch
  readonly #now: () => Date
  readonly #idFactory: () => string
  readonly #setTimeout: (callback: () => void, delayMs: number) => SchedulerTimer
  readonly #clearTimeout: (timer: SchedulerTimer) => void
  readonly #intervalMinutes: number
  #timer: SchedulerTimer | undefined
  #running: Promise<JobSourceRefreshRun> | undefined
  #lastRun: JobSourceRefreshRun | undefined
  #nextRunAt: string | undefined

  constructor(input: {
    source: JobLeadSearchSource
    intervalMinutes?: number | undefined
    query?: GankCampusSearch
    now?: () => Date
    idFactory?: () => string
    setTimeout?: (callback: () => void, delayMs: number) => SchedulerTimer
    clearTimeout?: (timer: SchedulerTimer) => void
  }) {
    this.#source = input.source
    this.#intervalMinutes = validateInterval(input.intervalMinutes ?? 120)
    this.#query = { limit: 50, ...input.query }
    this.#now = input.now ?? (() => new Date())
    this.#idFactory = input.idFactory ?? randomUUID
    this.#setTimeout = input.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimeout = input.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  start(input: { runImmediately?: boolean } = {}): JobSourceRefreshStatus {
    if (this.#timer !== undefined || this.#running !== undefined) return this.status()
    if (input.runImmediately === true) {
      void this.runNow().finally(() => this.#schedule(this.#intervalMinutes))
      return this.status()
    }
    this.#schedule(this.#intervalMinutes)
    return this.status()
  }

  stop(): JobSourceRefreshStatus {
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#nextRunAt = undefined
    return this.status()
  }

  async runNow(): Promise<JobSourceRefreshRun> {
    if (this.#running !== undefined) throw new Error('job_source_refresh_in_progress')
    const run = this.#run()
    this.#running = run
    try {
      return await run
    } finally {
      this.#running = undefined
    }
  }

  status(): JobSourceRefreshStatus {
    return {
      enabled: this.#timer !== undefined || this.#running !== undefined,
      running: this.#running !== undefined,
      intervalMinutes: this.#intervalMinutes,
      ...this.#nextRunAt === undefined ? {} : { nextRunAt: this.#nextRunAt },
      ...this.#lastRun === undefined ? {} : { lastRun: this.#lastRun },
    }
  }

  #schedule(delayMinutes: number): void {
    if (this.#timer !== undefined) this.#clearTimeout(this.#timer)
    const next = new Date(this.#now().getTime() + delayMinutes * 60_000)
    this.#nextRunAt = next.toISOString()
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined
      this.#nextRunAt = undefined
      void this.runNow().catch(() => undefined).finally(() => this.#schedule(this.#intervalMinutes))
    }, delayMinutes * 60_000)
    this.#timer.unref?.()
  }

  #run(): Promise<JobSourceRefreshRun> {
    return (async () => {
      const startedAt = this.#now().toISOString()
      try {
        const leads = await this.#source.search(this.#query)
        const result: JobSourceRefreshRun = {
          runId: `job-source-refresh:${this.#idFactory()}`,
          sourceKind: 'gankinterview_campus',
          status: 'completed',
          startedAt,
          finishedAt: this.#now().toISOString(),
          leadCount: leads.length,
          leadIds: leads.map((lead: JobLead) => lead.leadId),
        }
        this.#lastRun = result
        return result
      } catch (error: unknown) {
        const result: JobSourceRefreshRun = {
          runId: `job-source-refresh:${this.#idFactory()}`,
          sourceKind: 'gankinterview_campus',
          status: 'failed',
          startedAt,
          finishedAt: this.#now().toISOString(),
          leadCount: 0,
          leadIds: [],
          errorCode: toErrorCode(error),
        }
        this.#lastRun = result
        return result
      }
    })()
  }
}

function validateInterval(value: number): number {
  if (!Number.isInteger(value) || value < 60 || value > 180) throw new Error('invalid_job_source_refresh_interval')
  return value
}

function toErrorCode(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : 'job_source_refresh_failed'
}
