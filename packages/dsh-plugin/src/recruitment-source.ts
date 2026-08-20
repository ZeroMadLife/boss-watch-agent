import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const PREVIEW_TTL_MS = 15 * 60 * 1000
const MAX_RAW_TEXT = 32 * 1024

export type RecruitmentSourceType = 'official_referral' | 'company_career' | 'campus_announcement' | 'unknown'
export type RecruitmentSourceStatus = 'source_only' | 'role_selected' | 'jd_ready'

export interface RecruitmentSource {
  readonly sourceId: string
  readonly company: string
  readonly channelUrl: string
  readonly referralCode?: string
  readonly sourceType: RecruitmentSourceType
  readonly rawArtifactHash: string
  readonly capturedAt: string
  readonly status: RecruitmentSourceStatus
  readonly boundLeadId?: string
  readonly boundApplicationId?: string
  readonly role?: string
  readonly officialJobUrl?: string
  readonly jdContentHash?: string
}

export interface RecruitmentSourceJdBinding {
  readonly sourceId: string
  readonly expectedRawArtifactHash: string
  readonly boundLeadId: string
  readonly boundApplicationId: string
  readonly role: string
  readonly officialJobUrl: string
  readonly jdContentHash: string
}

export interface RecruitmentSourcePreviewInput {
  readonly rawText: string
}

export interface RecruitmentSourcePreview {
  readonly previewToken: string
  readonly expiresAt: string
  readonly source: RecruitmentSource
  readonly warnings: readonly string[]
  readonly roleRequired: true
  readonly jdRequired: true
}

export interface RecruitmentSourceApplyResult {
  readonly source: RecruitmentSource
  readonly reused: boolean
}

export interface RecruitmentSourceStore {
  save(source: RecruitmentSource): RecruitmentSourceApplyResult
  bindJd(input: RecruitmentSourceJdBinding): RecruitmentSource
  list(options?: { limit?: number }): RecruitmentSource[]
  get(sourceId: string): RecruitmentSource | undefined
  close(): void
}

export interface RecruitmentSourceService {
  preview(input: RecruitmentSourcePreviewInput): Promise<RecruitmentSourcePreview>
  apply(previewToken: string): Promise<RecruitmentSourceApplyResult>
}

interface RecruitmentSourceServiceOptions {
  readonly store: RecruitmentSourceStore
  readonly now?: () => Date
}

interface StoredPreview {
  readonly expiresAt: number
  readonly rawText: string
  readonly source: RecruitmentSource
  readonly warnings: readonly string[]
}

export class LocalRecruitmentSourceService implements RecruitmentSourceService {
  readonly #store: RecruitmentSourceStore
  readonly #now: () => Date
  readonly #previews = new Map<string, StoredPreview>()
  readonly #applied = new Map<string, RecruitmentSourceApplyResult>()

  constructor(options: RecruitmentSourceServiceOptions) {
    this.#store = options.store
    this.#now = options.now ?? (() => new Date())
  }

  async preview(input: RecruitmentSourcePreviewInput): Promise<RecruitmentSourcePreview> {
    const now = this.#now()
    const parsed = parseRecruitmentSource(input.rawText, now.toISOString())
    const expiresAt = now.getTime() + PREVIEW_TTL_MS
    const previewToken = `recruitment-source-preview:${randomBytes(24).toString('hex')}`
    this.#previews.set(previewToken, {
      expiresAt,
      rawText: input.rawText,
      source: parsed.source,
      warnings: parsed.warnings,
    })
    this.#discardExpired(this.#now().getTime())
    return {
      previewToken,
      expiresAt: new Date(expiresAt).toISOString(),
      source: parsed.source,
      warnings: parsed.warnings,
      roleRequired: true,
      jdRequired: true,
    }
  }

  async apply(previewToken: string): Promise<RecruitmentSourceApplyResult> {
    const applied = this.#applied.get(previewToken)
    if (applied !== undefined) return applied
    const preview = this.#previews.get(previewToken)
    if (preview === undefined) throw new Error('recruitment_source_preview_not_found')
    if (preview.expiresAt <= this.#now().getTime()) {
      this.#previews.delete(previewToken)
      throw new Error('recruitment_source_preview_stale')
    }
    const current = parseRecruitmentSource(preview.rawText, preview.source.capturedAt)
    if (current.source.rawArtifactHash !== preview.source.rawArtifactHash) {
      this.#previews.delete(previewToken)
      throw new Error('recruitment_source_preview_stale')
    }
    const result = this.#store.save(current.source)
    this.#previews.delete(previewToken)
    this.#applied.set(previewToken, result)
    return result
  }

  #discardExpired(now: number): void {
    for (const [token, preview] of this.#previews) {
      if (preview.expiresAt <= now) this.#previews.delete(token)
    }
  }
}

export class SqliteRecruitmentSourceStore implements RecruitmentSourceStore {
  readonly #database: DatabaseSync
  #closed = false

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error('invalid_database_path')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#database = new DatabaseSync(path)
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS recruitment_sources (
        source_id TEXT PRIMARY KEY,
        company TEXT NOT NULL,
        channel_url TEXT NOT NULL,
        referral_code TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('official_referral', 'company_career', 'campus_announcement', 'unknown')),
        raw_artifact_hash TEXT NOT NULL CHECK (length(raw_artifact_hash) = 64),
        captured_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('source_only', 'role_selected', 'jd_ready'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS recruitment_sources_identity ON recruitment_sources(company, channel_url, COALESCE(referral_code, ''));
      CREATE INDEX IF NOT EXISTS recruitment_sources_captured_at ON recruitment_sources(captured_at DESC, source_id ASC);
    `)
    this.#ensureColumn('bound_lead_id', 'TEXT')
    this.#ensureColumn('bound_application_id', 'TEXT')
    this.#ensureColumn('role', 'TEXT')
    this.#ensureColumn('official_job_url', 'TEXT')
    this.#ensureColumn('jd_content_hash', 'TEXT')
  }

  bindJd(input: RecruitmentSourceJdBinding): RecruitmentSource {
    this.#assertOpen()
    if (
      [input.sourceId, input.boundLeadId, input.boundApplicationId, input.role, input.officialJobUrl]
        .some(value => value.trim().length === 0)
      || !/^[a-f0-9]{64}$/u.test(input.expectedRawArtifactHash)
      || !/^[a-f0-9]{64}$/u.test(input.jdContentHash)
    ) throw new Error('invalid_recruitment_source_jd_binding')

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.get(input.sourceId)
      if (current === undefined) throw new Error('recruitment_source_not_found')
      if (current.rawArtifactHash !== input.expectedRawArtifactHash) {
        throw new Error('recruitment_jd_preview_stale')
      }
      this.#database.prepare(`
        UPDATE recruitment_sources
        SET status = 'jd_ready', bound_lead_id = ?, bound_application_id = ?, role = ?,
            official_job_url = ?, jd_content_hash = ?
        WHERE source_id = ? AND raw_artifact_hash = ?
      `).run(
        input.boundLeadId,
        input.boundApplicationId,
        input.role,
        input.officialJobUrl,
        input.jdContentHash,
        input.sourceId,
        input.expectedRawArtifactHash,
      )
      const bound = this.get(input.sourceId)
      if (bound === undefined) throw new Error('recruitment_source_binding_failed')
      this.#database.exec('COMMIT')
      return bound
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  save(source: RecruitmentSource): RecruitmentSourceApplyResult {
    this.#assertOpen()
    const existing = this.get(source.sourceId)
    if (existing !== undefined && existing.rawArtifactHash === source.rawArtifactHash) {
      return { source: existing, reused: true }
    }
    this.#database.prepare(`
      INSERT INTO recruitment_sources (source_id, company, channel_url, referral_code, source_type, raw_artifact_hash, captured_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        company = excluded.company,
        channel_url = excluded.channel_url,
        referral_code = excluded.referral_code,
        source_type = excluded.source_type,
        raw_artifact_hash = excluded.raw_artifact_hash,
        captured_at = excluded.captured_at,
        status = excluded.status,
        bound_lead_id = NULL,
        bound_application_id = NULL,
        role = NULL,
        official_job_url = NULL,
        jd_content_hash = NULL
    `).run(
      source.sourceId,
      source.company,
      source.channelUrl,
      source.referralCode ?? null,
      source.sourceType,
      source.rawArtifactHash,
      source.capturedAt,
      source.status,
    )
    return { source: this.get(source.sourceId) ?? source, reused: false }
  }

  list(options: { limit?: number } = {}): RecruitmentSource[] {
    this.#assertOpen()
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
    const rows = this.#database.prepare('SELECT * FROM recruitment_sources ORDER BY captured_at DESC, source_id ASC LIMIT ?').all(limit) as unknown as SourceRow[]
    return rows.map(toRecruitmentSource)
  }

  get(sourceId: string): RecruitmentSource | undefined {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM recruitment_sources WHERE source_id = ?').get(sourceId) as unknown as SourceRow | undefined
    return row === undefined ? undefined : toRecruitmentSource(row)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('database_closed')
  }

  #ensureColumn(column: string, type: string): void {
    const columns = this.#database.prepare('PRAGMA table_info(recruitment_sources)').all() as Array<{ name: string }>
    if (!columns.some(entry => entry.name === column)) {
      this.#database.exec(`ALTER TABLE recruitment_sources ADD COLUMN ${column} ${type}`)
    }
  }
}

interface SourceRow {
  source_id: string
  company: string
  channel_url: string
  referral_code: string | null
  source_type: RecruitmentSourceType
  raw_artifact_hash: string
  captured_at: string
  status: RecruitmentSourceStatus
  bound_lead_id: string | null
  bound_application_id: string | null
  role: string | null
  official_job_url: string | null
  jd_content_hash: string | null
}

function toRecruitmentSource(row: SourceRow): RecruitmentSource {
  return {
    sourceId: row.source_id,
    company: row.company,
    channelUrl: row.channel_url,
    ...(row.referral_code === null ? {} : { referralCode: row.referral_code }),
    sourceType: row.source_type,
    rawArtifactHash: row.raw_artifact_hash,
    capturedAt: row.captured_at,
    status: row.status,
    ...(row.bound_lead_id === null ? {} : { boundLeadId: row.bound_lead_id }),
    ...(row.bound_application_id === null ? {} : { boundApplicationId: row.bound_application_id }),
    ...(row.role === null ? {} : { role: row.role }),
    ...(row.official_job_url === null ? {} : { officialJobUrl: row.official_job_url }),
    ...(row.jd_content_hash === null ? {} : { jdContentHash: row.jd_content_hash }),
  }
}

function parseRecruitmentSource(rawText: string, capturedAt = new Date().toISOString()): { source: RecruitmentSource; warnings: string[] } {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) throw new Error('source_text_required')
  if (rawText.length > MAX_RAW_TEXT) throw new Error('source_text_too_large')
  const text = rawText.replaceAll('\r\n', '\n').trim()
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"']+/giu)].map(match => (match[0] ?? '').replace(/[),.;，。；）】]+$/u, ''))
  if (urls.length === 0) throw new Error('https_channel_url_required')
  const unsafeUrl = urls.find(url => !isHttpsUrl(url))
  if (unsafeUrl !== undefined) throw new Error('https_channel_url_required')
  const channelUrl = urls[0] as string
  const company = extractCompany(text)
  if (company === undefined) throw new Error('source_company_required')
  const referralCode = extractLabelValue(text, ['内推码', '推荐码', 'referral code', 'referral'])
  const identity = [company, channelUrl, referralCode ?? ''].join('\u001f')
  const identityHash = createHash('sha256').update(identity).digest('hex')
  const sourceType = classifySource(channelUrl, referralCode)
  const warnings: string[] = []
  if (urls.length > 1) warnings.push('multiple_urls_first_https_selected')
  if (referralCode === undefined) warnings.push('referral_code_not_found')
  return {
    source: {
      sourceId: `recruitment-source:${identityHash}`,
      company,
      channelUrl,
      ...(referralCode === undefined ? {} : { referralCode }),
      sourceType,
      rawArtifactHash: createHash('sha256').update(text).digest('hex'),
      capturedAt,
      status: 'source_only',
    },
    warnings,
  }
}

function extractCompany(text: string): string | undefined {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  for (const line of lines) {
    const labeled = line.match(/^(?:公司(?:名称)?|企业(?:名称)?|招聘企业|单位)\s*[:：]\s*(.+)$/u)?.[1]
    if (labeled !== undefined) return cleanCompany(labeled)
  }
  for (const line of lines) {
    if (/^(?:内推链接|投递链接|网申地址|官网链接|内推码|推荐码|referral(?:\s+code)?)\s*[:：]/iu.test(line)) continue
    if (/^https?:\/\//iu.test(line)) continue
    const value = cleanCompany(line.replace(/^[-*#>\s]+/u, ''))
    if (value !== undefined && !value.includes('：') && !value.includes(':')) return value
  }
  return undefined
}

function cleanCompany(value: string): string | undefined {
  const normalized = value.trim().replace(/[\u0000-\u001f]+/gu, ' ').replace(/\s+/gu, ' ')
  return normalized.length > 0 && normalized.length <= 120 ? normalized : undefined
}

function extractLabelValue(text: string, labels: readonly string[]): string | undefined {
  const escaped = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')
  const match = text.match(new RegExp(`(?:${escaped})\\s*[:：]\\s*([^\\s,，;；]+)`, 'iu'))
  const value = match?.[1]?.trim()
  return value === undefined || value.length === 0 || value.length > 200 ? undefined : value
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.length > 0
  } catch {
    return false
  }
}

function classifySource(urlValue: string, referralCode: string | undefined): RecruitmentSourceType {
  let hostname = ''
  try { hostname = new URL(urlValue).hostname.toLowerCase() } catch { return 'unknown' }
  if (referralCode !== undefined) return 'official_referral'
  if (/campus|career|zhaopin|jobs|recruit|mokahr|feishu/iu.test(hostname)) return 'company_career'
  return 'campus_announcement'
}
