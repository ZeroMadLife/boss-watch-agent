import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { JobLead, JobLeadStore } from './job-lead.js'
import type { RecruitmentSource, RecruitmentSourceStore } from './recruitment-source.js'

const PREVIEW_TTL_MS = 15 * 60 * 1000
const MAX_JD_TEXT = 400 * 1024

export interface OfficialJobCaptureInput {
  readonly sourceId: string
  readonly company: string
  readonly role: string
  readonly officialJobUrl: string
  readonly jdText: string
  readonly capturedAt: string
}

export interface OfficialJobCaptureResult {
  readonly applicationId: string
  readonly eventId: string
  readonly artifactId: string
  readonly artifactRef: string
  readonly contentHash: string
  readonly savedAt: string
  readonly deduplicated: boolean
}

export interface OfficialJobCaptureClient {
  capture(input: OfficialJobCaptureInput): Promise<OfficialJobCaptureResult>
}

export interface RecruitmentJdPreviewInput {
  readonly sourceId: string
  readonly role: string
  readonly officialJobUrl: string
  readonly jdText: string
  readonly city?: string
  readonly cohort?: string
  readonly recruitmentType?: string
  readonly deadline?: string
}

export interface RecruitmentJdPreview {
  readonly previewToken: string
  readonly expiresAt: string
  readonly sourceId: string
  readonly sourceArtifactHash: string
  readonly company: string
  readonly role: string
  readonly officialJobUrl: string
  readonly jdContentHash: string
  readonly jdLength: number
  readonly city?: string
  readonly cohort?: string
  readonly recruitmentType?: string
  readonly deadline?: string
  readonly warnings: readonly string[]
  readonly requiresConfirmation: true
}

export interface RecruitmentJdApplyResult extends OfficialJobCaptureResult {
  readonly source: RecruitmentSource
  readonly lead: JobLead
}

interface PendingPreview {
  readonly expiresAt: number
  readonly sourceId: string
  readonly sourceArtifactHash: string
  readonly company: string
  readonly role: string
  readonly officialJobUrl: string
  readonly jdText: string
  readonly jdContentHash: string
  readonly capturedAt: string
  readonly city?: string
  readonly cohort?: string
  readonly recruitmentType?: string
  readonly deadline?: string
}

export interface RecruitmentJdService {
  preview(input: RecruitmentJdPreviewInput): Promise<RecruitmentJdPreview>
  apply(previewToken: string): Promise<RecruitmentJdApplyResult>
}

export class LocalRecruitmentJdService implements RecruitmentJdService {
  readonly #sources: RecruitmentSourceStore
  readonly #leads: JobLeadStore
  readonly #capture: OfficialJobCaptureClient
  readonly #now: () => Date
  readonly #previews = new Map<string, PendingPreview>()
  readonly #applied = new Map<string, RecruitmentJdApplyResult>()
  readonly #applying = new Set<string>()

  constructor(options: {
    readonly sources: RecruitmentSourceStore
    readonly leads: JobLeadStore
    readonly capture: OfficialJobCaptureClient
    readonly now?: () => Date
  }) {
    this.#sources = options.sources
    this.#leads = options.leads
    this.#capture = options.capture
    this.#now = options.now ?? (() => new Date())
  }

  async preview(input: RecruitmentJdPreviewInput): Promise<RecruitmentJdPreview> {
    const sourceId = requireText(input.sourceId, 'recruitment_source_id_required', 256)
    const source = this.#sources.get(sourceId)
    if (source === undefined) throw new Error('recruitment_source_not_found')
    const role = requireText(input.role, 'official_job_role_required', 240)
    const officialJobUrl = normalizeOfficialJobUrl(input.officialJobUrl)
    const jdText = normalizeJdText(input.jdText)
    const now = this.#now()
    const expiresAt = now.getTime() + PREVIEW_TTL_MS
    const jdContentHash = sha256(jdText)
    const optional = {
      ...optionalText(input.city, 'city'),
      ...optionalText(input.cohort, 'cohort'),
      ...optionalText(input.recruitmentType, 'recruitmentType'),
      ...optionalText(input.deadline, 'deadline'),
    }
    const previewToken = `recruitment-jd-preview:${randomBytes(24).toString('hex')}`
    this.#previews.set(previewToken, {
      expiresAt,
      sourceId,
      sourceArtifactHash: source.rawArtifactHash,
      company: source.company,
      role,
      officialJobUrl,
      jdText,
      jdContentHash,
      capturedAt: now.toISOString(),
      ...optional,
    })
    this.#discardExpired(this.#now().getTime())
    return {
      previewToken,
      expiresAt: new Date(expiresAt).toISOString(),
      sourceId,
      sourceArtifactHash: source.rawArtifactHash,
      company: source.company,
      role,
      officialJobUrl,
      jdContentHash,
      jdLength: jdText.length,
      ...optional,
      warnings: jdText.length < 120 ? ['jd_text_may_be_incomplete'] : [],
      requiresConfirmation: true,
    }
  }

  async apply(previewToken: string): Promise<RecruitmentJdApplyResult> {
    const applied = this.#applied.get(previewToken)
    if (applied !== undefined) return applied
    if (this.#applying.has(previewToken)) throw new Error('recruitment_jd_apply_in_progress')
    const preview = this.#previews.get(previewToken)
    if (preview === undefined) throw new Error('recruitment_jd_preview_not_found')
    if (preview.expiresAt <= this.#now().getTime()) {
      this.#previews.delete(previewToken)
      throw new Error('recruitment_jd_preview_stale')
    }
    const sourceId = preview.sourceId
    const current = this.#sources.get(sourceId)
    if (current === undefined) throw new Error('recruitment_source_not_found')
    if (current.rawArtifactHash !== preview.sourceArtifactHash || current.company !== preview.company) {
      throw new Error('recruitment_jd_preview_stale')
    }

    this.#applying.add(previewToken)
    try {
      const captured = await this.#capture.capture({
        sourceId,
        company: preview.company,
        role: preview.role,
        officialJobUrl: preview.officialJobUrl,
        jdText: preview.jdText,
        capturedAt: preview.capturedAt,
      })
      if (captured.contentHash !== preview.jdContentHash) throw new Error('official_job_capture_hash_mismatch')
      const lead = createOfficialJobLead(sourceId, preview)
      this.#leads.upsert([lead])
      const urlConfirmed = this.#leads.confirmCandidateUrl({
        leadId: lead.leadId,
        expectedContentHash: lead.contentHash,
        confirmedAt: preview.capturedAt,
      })
      const jdConfirmed = this.#leads.confirmJd({
        leadId: lead.leadId,
        expectedContentHash: lead.contentHash,
        confirmedAt: preview.capturedAt,
      })
      const source = this.#sources.bindJd({
        sourceId,
        expectedRawArtifactHash: preview.sourceArtifactHash,
        boundLeadId: jdConfirmed.lead.leadId,
        boundApplicationId: captured.applicationId,
        role: preview.role,
        officialJobUrl: urlConfirmed.lead.officialApplyUrl ?? preview.officialJobUrl,
        jdContentHash: preview.jdContentHash,
      })
      const result: RecruitmentJdApplyResult = { ...captured, source, lead: jdConfirmed.lead }
      this.#previews.delete(previewToken)
      this.#applied.set(previewToken, result)
      return result
    } finally {
      this.#applying.delete(previewToken)
    }
  }

  #discardExpired(now: number): void {
    for (const [token, preview] of this.#previews) {
      if (preview.expiresAt <= now) this.#previews.delete(token)
    }
  }
}

function createOfficialJobLead(sourceId: string, preview: PendingPreview): JobLead {
  const identityHash = sha256(sourceId)
  const contentHash = sha256(JSON.stringify({
    sourceId,
    company: preview.company,
    role: preview.role,
    officialJobUrl: preview.officialJobUrl,
    jdContentHash: preview.jdContentHash,
    city: preview.city,
    cohort: preview.cohort,
    recruitmentType: preview.recruitmentType,
    deadline: preview.deadline,
  }))
  return {
    leadId: `lead:company_career_site:${identityHash}`,
    sourceKind: 'company_career_site',
    sourceRecordId: sourceId,
    company: preview.company,
    role: preview.role,
    ...preview.city === undefined ? {} : { city: preview.city },
    ...preview.cohort === undefined ? {} : { cohort: preview.cohort },
    ...preview.recruitmentType === undefined ? {} : { recruitmentType: preview.recruitmentType },
    ...preview.deadline === undefined ? {} : { deadline: preview.deadline },
    channelUrl: preview.officialJobUrl,
    fetchedAt: preview.capturedAt,
    rawRef: `recruitment-source://${identityHash}/jd/${preview.jdContentHash}`,
    contentHash,
    confidence: 'source_only',
  }
}

function requireText(value: string, code: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(code)
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ')
  if (normalized.length === 0 || normalized.length > maxLength) throw new Error(code)
  return normalized
}

function normalizeJdText(value: string): string {
  if (typeof value !== 'string') throw new Error('official_job_jd_required')
  const normalized = value.replaceAll('\r\n', '\n').trim()
  if (normalized.length === 0 || normalized.length > MAX_JD_TEXT) throw new Error('official_job_jd_required')
  return normalized
}

function optionalText(value: string | undefined, key: 'city' | 'cohort' | 'recruitmentType' | 'deadline'): Partial<Record<typeof key, string>> {
  if (value === undefined) return {}
  return { [key]: requireText(value, `invalid_${key}`, 240) }
}

function normalizeOfficialJobUrl(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096) throw new Error('official_job_url_invalid')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('official_job_url_invalid') }
  const hostname = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:'
    || url.username.length > 0
    || url.password.length > 0
    || (url.port.length > 0 && url.port !== '443')
    || hostname.length === 0
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || isIP(hostname) !== 0
  ) throw new Error('official_job_url_invalid')
  return url.toString()
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
