import { LocalBossWatchApiClient } from './local-api-client.js'

export type ManuallyConfirmableApplicationStatus =
  | 'submitted'
  | 'assessment_scheduled'
  | 'assessment_completed'
  | 'interview_scheduled'
  | 'rejected'
  | 'offer'
  | 'closed'

export interface ApplicationStatusPreview {
  readonly previewToken: string
  readonly applicationId: string
  readonly status: ManuallyConfirmableApplicationStatus
  readonly occurredAt: string
  readonly expiresAt: string
  readonly requiresConfirmation: true
  readonly externalAction: 'not_performed'
}

export interface ApplicationStatusApplyResult {
  readonly applicationId: string
  readonly eventId: string
  readonly status: ManuallyConfirmableApplicationStatus
  readonly recordedAt: string
  readonly deduplicated: boolean
}

/** Loopback-only transport for explicitly recording a user-observed application status. */
export class LocalApplicationStatusClient {
  readonly #api: LocalBossWatchApiClient

  constructor(
    origin?: string,
    tokenPath?: string,
  ) {
    this.#api = new LocalBossWatchApiClient(origin, tokenPath)
  }

  async preview(input: {
    applicationId: string
    status: ManuallyConfirmableApplicationStatus
    occurredAt?: string
  }): Promise<ApplicationStatusPreview> {
    return this.#request<ApplicationStatusPreview>('/api/v1/application-status/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }

  async apply(previewToken: string, confirmed: boolean): Promise<ApplicationStatusApplyResult> {
    return this.#request<ApplicationStatusApplyResult>('/api/v1/application-status/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previewToken, confirmed }),
    })
  }

  async #request<T>(path: string, init: RequestInit): Promise<T> {
    return this.#api.request<T>(path, init)
  }
}
