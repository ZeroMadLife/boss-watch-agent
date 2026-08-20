import type {
  OfficialJobCaptureClient,
  OfficialJobCaptureInput,
  OfficialJobCaptureResult,
} from './recruitment-jd.js'
import { LocalBossWatchApiClient } from './local-api-client.js'

/** Loopback-only transport for persisting an explicitly confirmed official JD. */
export class LocalOfficialJobCaptureClient implements OfficialJobCaptureClient {
  readonly #api: LocalBossWatchApiClient

  constructor(
    origin?: string,
    tokenPath?: string,
  ) {
    this.#api = new LocalBossWatchApiClient(origin, tokenPath)
  }

  async capture(input: OfficialJobCaptureInput): Promise<OfficialJobCaptureResult> {
    return this.#api.request<OfficialJobCaptureResult>('/api/v1/official-jds/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }
}
