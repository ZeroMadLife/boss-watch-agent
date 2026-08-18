import { randomUUID } from 'node:crypto'
import type {
  JobWatchPollService,
  JobWatchPollResult,
} from './job-watch.js'

export type JobWatchSchedulerRunStatus = 'completed' | 'cancelled' | 'stopped_handoff' | 'stopped_failure'

export type JobWatchSchedulerStopReason =
  | 'paused_human_required'
  | 'transient_failure'
  | 'watch_profile_busy'
  | 'watch_daily_budget_exhausted'
  | 'watch_scheduler_error'

export interface JobWatchSchedulerItem {
  readonly watchId: string
  readonly status: 'polled' | 'failed'
  readonly result?: JobWatchPollResult['result']
  readonly browserStatus?: JobWatchPollResult['browserStatus']
  readonly errorCode?: string
}

export interface JobWatchSchedulerRun {
  readonly runId: string
  readonly status: JobWatchSchedulerRunStatus
  readonly startedAt: string
  readonly finishedAt: string
  readonly limit: number
  readonly dueCount: number
  readonly attemptedCount: number
  readonly remainingDueCount: number
  readonly items: readonly JobWatchSchedulerItem[]
  readonly stopReason?: JobWatchSchedulerStopReason
}

export class LocalJobWatchScheduler {
  readonly #service: JobWatchPollService
  readonly #now: () => Date
  readonly #idFactory: () => string
  #running: Promise<JobWatchSchedulerRun> | undefined
  #cancelRequested = false

  constructor(input: {
    service: JobWatchPollService
    now?: () => Date
    idFactory?: () => string
  }) {
    this.#service = input.service
    this.#now = input.now ?? (() => new Date())
    this.#idFactory = input.idFactory ?? randomUUID
  }

  async runDue(input: { limit?: number; signal?: AbortSignal } = {}): Promise<JobWatchSchedulerRun> {
    if (this.#running !== undefined) throw new Error('watch_scheduler_in_progress')
    const limit = validateLimit(input.limit)
    this.#cancelRequested = input.signal?.aborted ?? false
    const abort = () => { this.#cancelRequested = true }
    input.signal?.addEventListener('abort', abort, { once: true })

    const run = this.#run(limit)
    this.#running = run
    try {
      return await run
    } finally {
      input.signal?.removeEventListener('abort', abort)
      this.#running = undefined
      this.#cancelRequested = false
    }
  }

  cancel(): void {
    if (this.#running !== undefined) this.#cancelRequested = true
  }

  #run(limit: number): Promise<JobWatchSchedulerRun> {
    return (async () => {
      const startedAt = this.#now().toISOString()
      const dueWatches = this.#service.list()
        .filter((watch) => watch.state === 'active' && watch.nextPollAt !== undefined && isDue(watch.nextPollAt, startedAt))
        .sort((left, right) => {
          const leftAt = Date.parse(left.nextPollAt ?? '')
          const rightAt = Date.parse(right.nextPollAt ?? '')
          return leftAt - rightAt || left.watchId.localeCompare(right.watchId)
        })
      const due = dueWatches.slice(0, limit)
      const items: JobWatchSchedulerItem[] = []
      let status: JobWatchSchedulerRunStatus = 'completed'
      let stopReason: JobWatchSchedulerStopReason | undefined

      for (const watch of due) {
        if (this.#cancelRequested) {
          status = 'cancelled'
          break
        }
        try {
          const result = await this.#service.poll(watch.watchId)
          items.push({
            watchId: watch.watchId,
            status: 'polled',
            result: result.result,
            browserStatus: result.browserStatus,
          })
          if (this.#cancelRequested) {
            status = 'cancelled'
            break
          }
          if (result.result === 'paused_human_required') {
            status = 'stopped_handoff'
            stopReason = 'paused_human_required'
            break
          }
          if (result.result === 'transient_failure') {
            status = 'stopped_failure'
            stopReason = 'transient_failure'
            break
          }
        } catch (error: unknown) {
          const errorCode = toErrorCode(error)
          items.push({ watchId: watch.watchId, status: 'failed', errorCode })
          if (errorCode === 'watch_not_due' || errorCode === 'watch_stopped' || errorCode === 'watch_paused') continue
          status = 'stopped_failure'
          stopReason = asStopReason(errorCode)
          break
        }
      }

      const finishedAt = this.#now().toISOString()
      return {
        runId: `watch-scheduler:${this.#idFactory()}`,
        status,
        startedAt,
        finishedAt,
        limit,
        dueCount: dueWatches.length,
        attemptedCount: items.length,
        remainingDueCount: dueWatches.length - items.length,
        items,
        ...stopReason === undefined ? {} : { stopReason },
      }
    })()
  }
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? 5
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('invalid_watch_scheduler_limit')
  return limit
}

function isDue(nextPollAt: string, now: string): boolean {
  const nextMs = Date.parse(nextPollAt)
  const nowMs = Date.parse(now)
  return Number.isFinite(nextMs) && Number.isFinite(nowMs) && nextMs <= nowMs
}

function toErrorCode(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : 'watch_scheduler_error'
}

function asStopReason(errorCode: string): JobWatchSchedulerStopReason {
  if (
    errorCode === 'watch_profile_busy'
    || errorCode === 'watch_daily_budget_exhausted'
    || errorCode === 'transient_failure'
  ) return errorCode
  return 'watch_scheduler_error'
}
