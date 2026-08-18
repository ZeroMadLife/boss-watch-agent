import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ProgressSignalSourceKind =
  | 'recruitment_email'
  | 'interview_invitation'
  | 'recruiter_message'
  | 'manual_update'

export type ProgressSignalOutcome = 'interview' | 'rejected' | 'offer' | 'needs_review'

const DEFAULT_API_ORIGIN = 'http://127.0.0.1:4318'

export interface ProgressSignalPreview {
  readonly previewToken: string
  readonly applicationId: string
  readonly sourceKind: ProgressSignalSourceKind
  readonly sourceMode: 'pasted_text' | 'staged_file'
  readonly outcome: ProgressSignalOutcome
  readonly classifierVersion: string
  readonly confidence: number
  readonly reasonCodes: string[]
  readonly proposedStatus?: string
  readonly contentHash: string
  readonly sourceHash: string
  readonly contentLength: number
  readonly observedAt: string
  readonly expiresAt: string
  readonly requiresConfirmation: true
}

export interface ProgressSignalApplyResult {
  readonly applicationId: string
  readonly signalEventId: string
  readonly proposalEventId?: string
  readonly artifactId: string
  readonly artifactRef: string
  readonly contentHash: string
  readonly savedAt: string
  readonly outcome: ProgressSignalOutcome
  readonly proposedStatus?: string
  readonly deduplicated: boolean
}

export type ProgressSignalPreviewInput = {
  readonly applicationId: string
  readonly sourceKind: ProgressSignalSourceKind
  readonly observedAt?: string
  readonly declaredOutcome?: ProgressSignalOutcome
} & (
  | { readonly content: string; readonly stagedFileName?: never; readonly sourceHash?: never }
  | { readonly stagedFileName: string; readonly sourceHash: string; readonly content?: never }
)

/** Loopback-only transport for previewing and recording progress evidence. */
export class LocalProgressSignalClient {
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

  async preview(input: ProgressSignalPreviewInput): Promise<ProgressSignalPreview> {
    return this.#request<ProgressSignalPreview>('/api/v1/progress-signals/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }

  async apply(previewToken: string, confirmed: boolean): Promise<ProgressSignalApplyResult> {
    return this.#request<ProgressSignalApplyResult>('/api/v1/progress-signals/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previewToken, confirmed }),
    })
  }

  async #request<T>(path: string, init: RequestInit): Promise<T> {
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
    if (!response.ok) {
      let code = 'controller_unavailable'
      try {
        const body = await response.json() as { error?: { code?: unknown } }
        if (typeof body.error?.code === 'string') code = body.error.code
      } catch {
        // Preserve the stable boundary error for non-JSON responses.
      }
      throw new Error(code)
    }
    return response.json() as Promise<T>
  }
}
