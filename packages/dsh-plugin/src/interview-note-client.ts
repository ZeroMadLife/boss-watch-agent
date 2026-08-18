import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
export type InterviewNoteStage =
  | 'screening'
  | 'first_interview'
  | 'second_interview'
  | 'final_interview'
  | 'other'

const DEFAULT_API_ORIGIN = 'http://127.0.0.1:4318'

export interface InterviewNotePreview {
  readonly previewToken: string
  readonly applicationId: string
  readonly interviewId: string
  readonly stage: InterviewNoteStage
  readonly contentHash: string
  readonly contentLength: number
  readonly expiresAt: string
  readonly requiresConfirmation: true
}

export interface InterviewNoteApplyResult {
  readonly applicationId: string
  readonly eventId: string
  readonly artifactId: string
  readonly artifactRef: string
  readonly contentHash: string
  readonly savedAt: string
  readonly deduplicated: boolean
  readonly interviewId: string
  readonly stage: InterviewNoteStage
}

export class LocalInterviewNoteClient {
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

  async preview(input: {
    applicationId: string
    interviewId: string
    stage: InterviewNoteStage
    content: string
    occurredAt?: string
  }): Promise<InterviewNotePreview> {
    return this.#request<InterviewNotePreview>('/api/v1/interview-notes/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }

  async apply(previewToken: string, confirmed: boolean): Promise<InterviewNoteApplyResult> {
    return this.#request<InterviewNoteApplyResult>('/api/v1/interview-notes/apply', {
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
        // Keep the stable boundary error when the server response is not JSON.
      }
      throw new Error(code)
    }
    return response.json() as Promise<T>
  }
}
