import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type {
  JobLead,
  JobLeadSourceSnapshot,
  JobLeadStore,
  LeadSourceKind,
  LeadObservationChangeKind,
} from './job-lead.js'
import type { ImportColumnMapping } from './job-source-import.js'

const PREVIEW_TTL_MS = 15 * 60 * 1000
const MAX_ROWS = 20_000
const MAX_TEXT = 32 * 1024
const LOW_CONFIDENCE_THRESHOLD = 0.75
const LEAD_SOURCE_KINDS = new Set<LeadSourceKind>([
  'gankinterview_campus',
  'tencent_smart_sheet',
  'boss_visible',
  'company_career_site',
])

export interface VisualLeadRowInput {
  readonly rowNumber?: number
  readonly company?: string
  readonly role?: string
  readonly city?: string
  readonly cohort?: string
  readonly recruitmentType?: string
  readonly deadline?: string
  readonly channelUrl?: string
  readonly sourceUpdatedAt?: string
  readonly confidence?: number | 'high' | 'medium' | 'low'
}

export interface VisualLeadPreviewInput {
  readonly sourceRef: string
  readonly screenshotRef: string
  readonly screenshotHash?: string
  readonly sourceKind?: LeadSourceKind
  readonly sheetName?: string
  readonly headers?: readonly string[]
  readonly columnMapping?: ImportColumnMapping
  readonly rows: readonly VisualLeadRowInput[]
}

export interface VisualLeadRejection {
  readonly rowNumber: number
  readonly code: 'invalid_row' | 'invalid_required_field' | 'low_confidence' | 'invalid_confidence'
}

export interface VisualLeadSample {
  readonly company: string
  readonly role: string
  readonly city?: string
  readonly cohort?: string
}

export interface VisualLeadPreview {
  readonly previewToken: string
  readonly expiresAt: string
  readonly sourceRef: string
  readonly screenshotRef: string
  readonly screenshotHash: string
  readonly sourceKind: LeadSourceKind
  readonly sheetName: string
  readonly headers: readonly string[]
  readonly resolvedMapping: ImportColumnMapping
  readonly mappingHash: string
  readonly rowCount: number
  readonly acceptedCount: number
  readonly rejectedCount: number
  readonly duplicateCount: number
  readonly lowConfidenceCount: number
  readonly estimatedNewCount: number
  readonly estimatedChangedCount: number
  readonly estimatedUnchangedCount: number
  readonly warnings: readonly string[]
  readonly rejections: readonly VisualLeadRejection[]
  readonly lowConfidenceRows: readonly number[]
  readonly sampleRows: readonly VisualLeadSample[]
}

export interface VisualLeadApplyResult {
  readonly snapshot: JobLeadSourceSnapshot
  readonly verificationInvalidatedCount: number
  readonly reused: boolean
}

export interface VisualLeadImportService {
  preview(input: VisualLeadPreviewInput): Promise<VisualLeadPreview>
  apply(previewToken: string): Promise<VisualLeadApplyResult>
}

interface VisualLeadImportOptions {
  readonly store: JobLeadStore
  readonly now?: () => Date
  /** Optional adapter for re-reading the temporary screenshot attachment. */
  readonly readScreenshotHash?: (screenshotRef: string) => Promise<string>
}

interface PreparedVisualImport {
  readonly input: NormalizedVisualInput
  readonly screenshotHash: string
  readonly mappingHash: string
  readonly sheetName: string
  readonly headers: readonly string[]
  readonly resolvedMapping: ImportColumnMapping
  readonly leads: readonly JobLead[]
  readonly rowCount: number
  readonly rejections: readonly VisualLeadRejection[]
  readonly duplicateCount: number
  readonly lowConfidenceRows: readonly number[]
  readonly warnings: readonly string[]
  readonly classifications: Readonly<Record<LeadObservationChangeKind, number>>
  readonly verificationInvalidatedCount: number
  readonly preparedHash: string
}

interface StoredPreview {
  readonly expiresAt: number
  readonly prepared: PreparedVisualImport
}

interface NormalizedVisualInput extends VisualLeadPreviewInput {
  readonly sourceKind: LeadSourceKind
  readonly sheetName: string
  readonly headers: readonly string[]
  readonly rows: readonly VisualLeadRowInput[]
}

export class LocalVisualLeadImportService implements VisualLeadImportService {
  readonly #store: JobLeadStore
  readonly #now: () => Date
  readonly #readScreenshotHash: ((screenshotRef: string) => Promise<string>) | undefined
  readonly #previews = new Map<string, StoredPreview>()
  readonly #applied = new Map<string, VisualLeadApplyResult>()
  readonly #applyingSources = new Set<string>()

  constructor(options: VisualLeadImportOptions) {
    this.#store = options.store
    this.#now = options.now ?? (() => new Date())
    this.#readScreenshotHash = options.readScreenshotHash
  }

  async preview(input: VisualLeadPreviewInput): Promise<VisualLeadPreview> {
    const normalized = normalizeInput(input)
    const screenshotHash = await this.#verifyScreenshotHash(normalized)
    const prepared = this.#prepare(normalized, screenshotHash)
    const expiresAt = this.#now().getTime() + PREVIEW_TTL_MS
    const previewToken = `lead-visual-preview:${randomBytes(24).toString('hex')}`
    this.#previews.set(previewToken, { expiresAt, prepared })
    this.#discardExpired(this.#now().getTime())
    return toPreview(previewToken, expiresAt, prepared)
  }

  async apply(previewToken: string): Promise<VisualLeadApplyResult> {
    const reused = this.#applied.get(previewToken)
    if (reused !== undefined) return reused
    const stored = this.#previews.get(previewToken)
    if (stored === undefined) throw new Error('visual_preview_not_found')
    if (stored.expiresAt <= this.#now().getTime()) {
      this.#previews.delete(previewToken)
      throw new Error('visual_preview_stale')
    }
    const sourceKey = `${stored.prepared.input.sourceKind}\u0000${stored.prepared.input.sourceRef}`
    if (this.#applyingSources.has(sourceKey)) throw new Error('visual_import_in_progress')
    this.#applyingSources.add(sourceKey)
    try {
      const currentHash = await this.#verifyScreenshotHash(stored.prepared.input)
      if (currentHash !== stored.prepared.screenshotHash) {
        this.#previews.delete(previewToken)
        throw new Error('visual_source_changed')
      }
      if (preparedHash(stored.prepared) !== stored.prepared.preparedHash) {
        this.#previews.delete(previewToken)
        throw new Error('visual_preview_stale')
      }
      const latest = this.#store.getLatestSnapshot(
        stored.prepared.input.sourceKind,
        stored.prepared.input.sourceRef,
      )
      if (
        latest !== undefined
        && latest.fileHash === stored.prepared.screenshotHash
        && latest.mappingHash === stored.prepared.mappingHash
        && latest.sheetName === stored.prepared.sheetName
      ) {
        this.#previews.delete(previewToken)
        const result = { snapshot: latest, verificationInvalidatedCount: 0, reused: true }
        this.#applied.set(previewToken, result)
        return result
      }
      const importedAt = this.#now().toISOString()
      const snapshot: JobLeadSourceSnapshot = {
        snapshotId: `lead-source-snapshot:${randomBytes(24).toString('hex')}`,
        sourceKind: stored.prepared.input.sourceKind,
        sourceRef: stored.prepared.input.sourceRef,
        fileHash: stored.prepared.screenshotHash,
        mappingHash: stored.prepared.mappingHash,
        sheetName: stored.prepared.sheetName,
        importedAt,
        rowCount: stored.prepared.rowCount,
        acceptedCount: stored.prepared.leads.length,
        rejectedCount: stored.prepared.rejections.length,
        duplicateCount: stored.prepared.duplicateCount,
        newCount: stored.prepared.classifications.new,
        changedCount: stored.prepared.classifications.changed,
        unchangedCount: stored.prepared.classifications.unchanged,
        status: 'applied',
      }
      const leads = stored.prepared.leads.map((lead) => ({ ...lead, fetchedAt: importedAt }))
      this.#store.applySnapshot({ snapshot, leads })
      this.#previews.delete(previewToken)
      const result = {
        snapshot,
        verificationInvalidatedCount: stored.prepared.verificationInvalidatedCount,
        reused: false,
      }
      this.#applied.set(previewToken, result)
      return result
    } finally {
      this.#applyingSources.delete(sourceKey)
    }
  }

  async #verifyScreenshotHash(input: NormalizedVisualInput): Promise<string> {
    const supplied = input.screenshotHash
    if (this.#readScreenshotHash === undefined) {
      if (supplied === undefined) throw new Error('invalid_visual_source')
      return supplied
    }
    const actual = normalizeHash(await this.#readScreenshotHash(input.screenshotRef))
    if (actual === undefined) throw new Error('invalid_visual_source')
    if (supplied !== undefined && actual !== supplied) throw new Error('visual_source_changed')
    return actual
  }

  #prepare(input: NormalizedVisualInput, screenshotHash: string): PreparedVisualImport {
    const warnings: string[] = []
    const rejections: VisualLeadRejection[] = []
    const lowConfidenceRows: number[] = []
    const seen = new Set<string>()
    const leads: JobLead[] = []
    let duplicateCount = 0
    for (const [index, row] of input.rows.entries()) {
      const rowNumber = row.rowNumber ?? index + 2
      if (!Number.isInteger(rowNumber) || rowNumber < 2) {
        rejections.push({ rowNumber: index + 2, code: 'invalid_row' })
        continue
      }
      const confidence = normalizeConfidence(row.confidence)
      if (confidence === 'invalid') {
        rejections.push({ rowNumber, code: 'invalid_confidence' })
        continue
      }
      if (confidence === 'low') {
        rejections.push({ rowNumber, code: 'low_confidence' })
        lowConfidenceRows.push(rowNumber)
        warnings.push(`row:${rowNumber}:low_confidence_requires_review`)
        continue
      }
      const company = textField(row.company)
      const role = textField(row.role)
      if (company === undefined || role === undefined) {
        rejections.push({ rowNumber, code: 'invalid_required_field' })
        continue
      }
      const truncatedChannelUrl = isTruncatedChannelUrl(row.channelUrl)
      const channelUrl = normalizeChannelUrl(row.channelUrl)
      if (truncatedChannelUrl) warnings.push(`row:${rowNumber}:truncated_channel_url`)
      else if (row.channelUrl !== undefined && channelUrl === undefined) warnings.push(`row:${rowNumber}:invalid_channel_url`)
      const city = textField(row.city)
      const cohort = textField(row.cohort)
      const recruitmentType = textField(row.recruitmentType)
      const deadline = textField(row.deadline)
      const sourceUpdatedAt = textField(row.sourceUpdatedAt)
      const identityAnchor = channelUrl ?? [company, cohort, recruitmentType, role].map(value => value ?? '').join('\u0000')
      const sourceRecordId = hash([input.sourceRef, input.sheetName, identityAnchor].join('\u0000'))
      if (seen.has(sourceRecordId)) {
        duplicateCount += 1
        continue
      }
      seen.add(sourceRecordId)
      const facts = { sourceRecordId, company, role, city, cohort, recruitmentType, deadline, channelUrl, sourceUpdatedAt }
      leads.push({
        leadId: `lead:${input.sourceKind}:${sourceRecordId}`,
        sourceKind: input.sourceKind,
        sourceRecordId,
        company,
        role,
        ...city === undefined ? {} : { city },
        ...cohort === undefined ? {} : { cohort },
        ...recruitmentType === undefined ? {} : { recruitmentType },
        ...deadline === undefined ? {} : { deadline },
        ...channelUrl === undefined ? {} : { channelUrl },
        ...sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt },
        fetchedAt: this.#now().toISOString(),
        rawRef: `visual://${hash(input.sourceRef)}/${hash(input.screenshotRef)}/row/${rowNumber}`,
        contentHash: hash(JSON.stringify(facts)),
        confidence: 'source_only',
      })
    }
    const classifications: Record<LeadObservationChangeKind, number> = { new: 0, changed: 0, unchanged: 0 }
    let verificationInvalidatedCount = 0
    for (const lead of leads) {
      const existing = this.#store.getBySource(lead.sourceKind, lead.sourceRecordId)
      const kind: LeadObservationChangeKind = existing === undefined
        ? 'new'
        : existing.contentHash === lead.contentHash ? 'unchanged' : 'changed'
      classifications[kind] += 1
      if (kind === 'changed' && existing !== undefined && existing.confidence !== 'source_only') verificationInvalidatedCount += 1
    }
    const prepared: PreparedVisualImport = {
      input,
      screenshotHash,
      // The model output is part of the visual import contract. Include its
      // normalized row fingerprint so a nondeterministic second extraction of
      // the same screenshot cannot be mistaken for the same applied snapshot.
      mappingHash: hash(JSON.stringify({
        headers: input.headers,
        mapping: sortMapping(input.columnMapping ?? defaultMapping(input.headers)),
        rows: leads.map((lead) => [lead.sourceRecordId, lead.contentHash]),
      })),
      sheetName: input.sheetName,
      headers: input.headers,
      resolvedMapping: input.columnMapping ?? defaultMapping(input.headers),
      leads,
      rowCount: input.rows.length,
      rejections,
      duplicateCount,
      lowConfidenceRows,
      warnings: [...new Set(warnings)].slice(0, 100),
      classifications,
      verificationInvalidatedCount,
      preparedHash: '',
    }
    return { ...prepared, preparedHash: preparedHash(prepared) }
  }

  #discardExpired(now: number): void {
    for (const [token, stored] of this.#previews) if (stored.expiresAt <= now) this.#previews.delete(token)
  }
}

function normalizeInput(input: VisualLeadPreviewInput): NormalizedVisualInput {
  const sourceRef = textField(input.sourceRef)
  const screenshotRef = textField(input.screenshotRef)
  const protocol = screenshotRef === undefined ? undefined : referenceProtocol(screenshotRef)
  if (sourceRef === undefined || screenshotRef === undefined || protocol === 'http:' || protocol === 'https:') {
    throw new Error('invalid_visual_source')
  }
  const screenshotHash = input.screenshotHash === undefined ? undefined : normalizeHash(input.screenshotHash)
  if (input.screenshotHash !== undefined && screenshotHash === undefined) throw new Error('invalid_visual_source')
  if (!LEAD_SOURCE_KINDS.has(input.sourceKind ?? 'tencent_smart_sheet')) throw new Error('invalid_visual_source')
  if (!Array.isArray(input.rows) || input.rows.length > MAX_ROWS) throw new Error('invalid_visual_rows')
  const headers = (input.headers ?? inferHeaders(input.rows)).map((header) => textField(header) ?? '')
  const presentHeaders = headers.filter(Boolean)
  if (new Set(presentHeaders).size !== presentHeaders.length) throw new Error('invalid_visual_headers')
  const sourceKind = input.sourceKind ?? 'tencent_smart_sheet'
  const sheetName = textField(input.sheetName) ?? 'visual-viewport'
  return {
    ...input,
    sourceRef,
    screenshotRef,
    ...screenshotHash === undefined ? {} : { screenshotHash },
    sourceKind,
    sheetName,
    headers: presentHeaders,
    rows: input.rows,
  }
}

function referenceProtocol(value: string): string | undefined {
  try { return new URL(value).protocol } catch { return undefined }
}

function inferHeaders(rows: readonly VisualLeadRowInput[]): string[] {
  const fields = ['company', 'role', 'city', 'cohort', 'recruitmentType', 'deadline', 'channelUrl', 'sourceUpdatedAt'] as const
  return fields.filter((field) => rows.some((row) => textField(row[field]) !== undefined))
}

function normalizeConfidence(value: VisualLeadRowInput['confidence']): 'high' | 'medium' | 'low' | 'invalid' {
  if (value === undefined || value === 'high' || value === 'medium') return value ?? 'high'
  if (value === 'low') return 'low'
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value < LOW_CONFIDENCE_THRESHOLD ? 'low' : 'high'
  return 'invalid'
}

function textField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (normalized.length === 0 || normalized.length > MAX_TEXT) return undefined
  return normalized
}

function normalizeHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value.trim()) ? value.trim() : undefined
}

function normalizeChannelUrl(value: string | undefined): string | undefined {
  const text = textField(value)
  if (text === undefined) return undefined
  if (isTruncatedChannelUrl(text)) return undefined
  let url: URL
  try { url = new URL(text) } catch { return undefined }
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || isIP(hostname) !== 0) return undefined
  url.hash = ''
  return url.toString()
}

function isTruncatedChannelUrl(value: string | undefined): boolean {
  const text = textField(value)
  return text !== undefined && /(?:\.\.\.|…)/u.test(text)
}

function defaultMapping(headers: readonly string[]): ImportColumnMapping {
  const known = new Set(headers.map((header) => header.toLowerCase()))
  return Object.fromEntries((['company', 'role', 'city', 'cohort', 'recruitmentType', 'deadline', 'channelUrl', 'sourceUpdatedAt'] as const).filter((field) => known.has(field)).map((field) => [field, field])) as ImportColumnMapping
}

function sortMapping(mapping: ImportColumnMapping): ImportColumnMapping {
  return Object.fromEntries(Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right))) as ImportColumnMapping
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function preparedHash(prepared: Omit<PreparedVisualImport, 'preparedHash'> | PreparedVisualImport): string {
  return hash(JSON.stringify({
    screenshotHash: prepared.screenshotHash,
    mappingHash: prepared.mappingHash,
    sheetName: prepared.sheetName,
    leads: prepared.leads.map((lead) => [lead.sourceRecordId, lead.contentHash]),
    rejections: prepared.rejections,
    duplicateCount: prepared.duplicateCount,
  }))
}

function toPreview(token: string, expiresAt: number, prepared: PreparedVisualImport): VisualLeadPreview {
  return {
    previewToken: token,
    expiresAt: new Date(expiresAt).toISOString(),
    sourceRef: prepared.input.sourceRef,
    screenshotRef: prepared.input.screenshotRef,
    screenshotHash: prepared.screenshotHash,
    sourceKind: prepared.input.sourceKind,
    sheetName: prepared.sheetName,
    headers: prepared.headers,
    resolvedMapping: prepared.resolvedMapping,
    mappingHash: prepared.mappingHash,
    rowCount: prepared.rowCount,
    acceptedCount: prepared.leads.length,
    rejectedCount: prepared.rejections.length,
    duplicateCount: prepared.duplicateCount,
    lowConfidenceCount: prepared.lowConfidenceRows.length,
    estimatedNewCount: prepared.classifications.new,
    estimatedChangedCount: prepared.classifications.changed,
    estimatedUnchangedCount: prepared.classifications.unchanged,
    warnings: prepared.warnings,
    rejections: prepared.rejections,
    lowConfidenceRows: prepared.lowConfidenceRows,
    sampleRows: prepared.leads.slice(0, 5).map((lead) => ({
      company: lead.company,
      role: lead.role,
      ...lead.city === undefined ? {} : { city: lead.city },
      ...lead.cohort === undefined ? {} : { cohort: lead.cohort },
    })),
  }
}
