import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {
  BrowserCapture,
  BrowserApplicationFormFill,
  BrowserApplicationFormFillInput,
  BrowserApplicationFormInspection,
  BrowserConversationCapture,
  BrowserDiscoveredCapture,
  BrowserJobDiscovery,
  BrowserJobSearchInput,
  BrowserJobSearchResult,
  BrowserStatus,
  BrowserSearchGuardStatus,
  BrowserWatchPoll,
  BossWatchBrowserController,
} from './domain.ts'

const DEFAULT_API_ORIGIN = 'http://127.0.0.1:4318'

export class LocalBossWatchBrowserController implements BossWatchBrowserController {
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

  async status(): Promise<BrowserStatus> {
    return this.#request<BrowserStatus>('/api/v1/browser/status', { method: 'GET' })
  }

  async searchGuardStatus(): Promise<BrowserSearchGuardStatus> {
    return this.#request<BrowserSearchGuardStatus>('/api/v1/browser/jobs/search/status', { method: 'GET' })
  }

  async captureCurrentJob(): Promise<BrowserCapture> {
    return this.#request<BrowserCapture>('/api/v1/browser/captures/job', { method: 'POST' })
  }

  async captureCurrentConversation(applicationId: string): Promise<BrowserConversationCapture> {
    return this.#request<BrowserConversationCapture>('/api/v1/browser/captures/conversation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ applicationId }),
    })
  }

  async discoverJobs(): Promise<BrowserJobDiscovery> {
    return this.#request<BrowserJobDiscovery>('/api/v1/browser/jobs/discover', { method: 'GET' })
  }

  async searchJobs(input: BrowserJobSearchInput): Promise<BrowserJobSearchResult> {
    return this.#request<BrowserJobSearchResult>('/api/v1/browser/jobs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }

  async captureDiscoveredJob(discoveryId: string, externalJobId: string): Promise<BrowserDiscoveredCapture> {
    return this.#request<BrowserDiscoveredCapture>('/api/v1/browser/jobs/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ discoveryId, externalJobId }),
    })
  }

  async pollJob(applicationId: string): Promise<BrowserWatchPoll> {
    return this.#request<BrowserWatchPoll>('/api/v1/browser/jobs/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ applicationId }),
    })
  }

  async inspectApplicationForm(expectedUrl: string): Promise<BrowserApplicationFormInspection> {
    return this.#request<BrowserApplicationFormInspection>('/api/v1/browser/forms/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedUrl }),
    })
  }

  async fillApplicationForm(input: BrowserApplicationFormFillInput): Promise<BrowserApplicationFormFill> {
    return this.#request<BrowserApplicationFormFill>('/api/v1/browser/forms/fill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
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
    if (!response.ok) throw new Error('controller_unavailable')
    return response.json() as Promise<T>
  }
}
