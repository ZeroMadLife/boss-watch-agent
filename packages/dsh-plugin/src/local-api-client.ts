import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const EXPECTED_BOSS_WATCH_API_CONTRACT = '2026-08-19.closed-loop-v1'

export interface BossWatchLocalApiHealth {
  readonly service: 'ready'
  readonly database: 'ready'
  readonly runtimeMode: string
  readonly version: string
  readonly apiContractVersion: typeof EXPECTED_BOSS_WATCH_API_CONTRACT
  readonly buildIdentity: string
  readonly startedAt: string
}

const DEFAULT_API_ORIGIN = 'http://127.0.0.1:4318'

/** Authenticated loopback transport with an explicit server-contract preflight. */
export class LocalBossWatchApiClient {
  readonly #origin: string
  readonly #tokenPath: string

  constructor(
    origin = process.env.BOSS_WATCH_API_ORIGIN ?? DEFAULT_API_ORIGIN,
    tokenPath = process.env.BOSS_WATCH_SERVICE_TOKEN_PATH
      ?? join(homedir(), 'Library', 'Application Support', 'BossWatchAgent', 'dsh-service-token'),
  ) {
    const url = new URL(origin)
    if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
      throw new Error('boss_watch_api_must_be_loopback_http')
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error('boss_watch_api_origin_required')
    this.#origin = url.origin
    this.#tokenPath = tokenPath
  }

  async health(): Promise<BossWatchLocalApiHealth> {
    let response: Response
    try {
      response = await fetch(`${this.#origin}/api/v1/health`, { signal: AbortSignal.timeout(3_000) })
    } catch {
      throw new Error('controller_unavailable')
    }
    if (!response.ok) throw new Error('controller_unavailable')
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new Error('controller_unavailable')
    }
    if (!isRecord(value) || value.service !== 'ready' || value.database !== 'ready') {
      throw new Error('controller_unavailable')
    }
    if (
      value.apiContractVersion !== EXPECTED_BOSS_WATCH_API_CONTRACT
      || typeof value.buildIdentity !== 'string'
      || value.buildIdentity.trim().length === 0
      || typeof value.startedAt !== 'string'
      || !Number.isFinite(Date.parse(value.startedAt))
      || typeof value.runtimeMode !== 'string'
      || typeof value.version !== 'string'
    ) {
      throw new Error('controller_restart_required')
    }
    return value as unknown as BossWatchLocalApiHealth
  }

  async request<T>(path: string, init: RequestInit): Promise<T> {
    await this.health()
    let token: string
    try {
      token = (await readFile(this.#tokenPath, 'utf8')).trim()
    } catch {
      throw new Error('controller_unavailable')
    }
    if (token.length < 32) throw new Error('controller_unavailable')
    let response: Response
    try {
      response = await fetch(`${this.#origin}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
        signal: AbortSignal.timeout(35_000),
      })
    } catch {
      throw new Error('controller_unavailable')
    }
    if (!response.ok) throw new Error(await responseErrorCode(response))
    return response.json() as Promise<T>
  }
}

async function responseErrorCode(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { code?: unknown } }
    if (typeof body.error?.code === 'string') return body.error.code
  } catch {
    // Preserve the stable boundary error for non-JSON responses.
  }
  return 'controller_unavailable'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
