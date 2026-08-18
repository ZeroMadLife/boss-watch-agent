import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import ExcelJS from 'exceljs'
import type {
  JobLead,
  JobLeadSourceSnapshot,
  JobLeadStore,
  LeadObservationChangeKind,
} from './job-lead.js'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_ROWS = 20_000
const MAX_CELL_TEXT = 32 * 1024
const PREVIEW_TTL_MS = 15 * 60 * 1000

export type ImportField =
  | 'company'
  | 'role'
  | 'city'
  | 'cohort'
  | 'recruitmentType'
  | 'deadline'
  | 'channelUrl'
  | 'sourceUpdatedAt'

export type ImportColumnMapping = Partial<Record<ImportField, string>>

export interface LeadImportPreviewInput {
  readonly sourceRef: string
  readonly fileName: string
  readonly sheetName?: string
  readonly columnMapping?: ImportColumnMapping
}

export interface LeadImportRejection {
  readonly rowNumber: number
  readonly code: string
}

export interface LeadImportPreview {
  readonly previewToken: string
  readonly expiresAt: string
  readonly fileHash: string
  readonly mappingHash: string
  readonly sheetName: string
  readonly headers: readonly string[]
  readonly resolvedMapping: ImportColumnMapping
  readonly rowCount: number
  readonly acceptedCount: number
  readonly rejectedCount: number
  readonly duplicateCount: number
  readonly estimatedNewCount: number
  readonly estimatedChangedCount: number
  readonly estimatedUnchangedCount: number
  readonly warnings: readonly string[]
  readonly rejections: readonly LeadImportRejection[]
  readonly sampleRows: readonly LeadImportSample[]
}

export interface LeadImportSample {
  readonly company: string
  readonly role: string
  readonly city?: string
  readonly cohort?: string
}

export interface LeadImportApplyResult {
  readonly snapshot: JobLeadSourceSnapshot
  readonly verificationInvalidatedCount: number
  readonly reused: boolean
}

export interface LeadSourceImportService {
  preview(input: LeadImportPreviewInput): Promise<LeadImportPreview>
  apply(previewToken: string): Promise<LeadImportApplyResult>
}

export interface ClipboardLeadImportPreviewInput {
  readonly sourceRef: string
  readonly columnMapping?: ImportColumnMapping
}

export interface ClipboardLeadSourceImportService {
  preview(input: ClipboardLeadImportPreviewInput): Promise<LeadImportPreview>
  apply(previewToken: string): Promise<LeadImportApplyResult>
}

interface LeadSourceImportOptions {
  readonly importRoot: string
  readonly store: JobLeadStore
  readonly now?: () => Date
}

interface PreparedImport {
  readonly input: LeadImportPreviewInput
  readonly fileHash: string
  readonly mappingHash: string
  readonly sheetName: string
  readonly headers: readonly string[]
  readonly resolvedMapping: ImportColumnMapping
  readonly rowCount: number
  readonly leads: readonly JobLead[]
  readonly rejections: readonly LeadImportRejection[]
  readonly duplicateCount: number
  readonly warnings: readonly string[]
  readonly classifications: Readonly<Record<LeadObservationChangeKind, number>>
  readonly verificationInvalidatedCount: number
}

interface StoredPreview {
  readonly token: string
  readonly expiresAt: number
  readonly prepared: PreparedImport
}

interface TabularSheet {
  readonly name: string
  readonly headers: readonly string[]
  readonly rows: readonly TabularRow[]
  readonly warnings: readonly string[]
}

interface TabularRow {
  readonly rowNumber: number
  readonly values: Readonly<Record<string, string>>
}

interface ClipboardPreview {
  readonly delegateToken: string
  readonly filePath: string
  readonly clipboardHash: string
  readonly expiresAt: number
}

interface ClipboardLeadSourceImportOptions extends LeadSourceImportOptions {
  readonly readClipboard?: () => Promise<Buffer>
}

const FIELD_ALIASES: Readonly<Record<ImportField, readonly string[]>> = {
  company: ['公司', '企业', '单位', '公司名称', '企业名称'],
  role: ['岗位', '职位', '招聘岗位', '招聘职位', '岗位方向'],
  city: ['地点', '工作地点', '城市', '办公地点'],
  cohort: ['届别', '面向人群', '招聘对象'],
  recruitmentType: ['招聘类型', '招聘批次', '类型'],
  deadline: ['截止时间', '报名截止', '投递截止'],
  channelUrl: ['投递链接', '公告链接', '来源链接', '网申地址'],
  sourceUpdatedAt: ['更新时间', '发布日期', '更新日期'],
}

export class LocalLeadSourceImportService implements LeadSourceImportService {
  readonly #importRoot: string
  readonly #store: JobLeadStore
  readonly #now: () => Date
  readonly #previews = new Map<string, StoredPreview>()
  readonly #applied = new Map<string, LeadImportApplyResult>()
  readonly #applyingSources = new Set<string>()

  constructor(options: LeadSourceImportOptions) {
    if (options.importRoot.trim().length === 0) throw new Error('invalid_import_root')
    this.#importRoot = resolve(options.importRoot)
    this.#store = options.store
    this.#now = options.now ?? (() => new Date())
    mkdirSync(this.#importRoot, { recursive: true })
  }

  async preview(input: LeadImportPreviewInput): Promise<LeadImportPreview> {
    const prepared = await this.#prepare(input)
    const now = this.#now().getTime()
    const expiresAt = now + PREVIEW_TTL_MS
    const token = `lead-import-preview:${randomBytes(24).toString('hex')}`
    this.#previews.set(token, { token, expiresAt, prepared })
    this.#discardExpired(now)
    return toPreview(token, expiresAt, prepared)
  }

  async apply(previewToken: string): Promise<LeadImportApplyResult> {
    const applied = this.#applied.get(previewToken)
    if (applied !== undefined) return applied
    const preview = this.#previews.get(previewToken)
    if (preview === undefined) throw new Error('preview_not_found')
    const now = this.#now()
    if (preview.expiresAt <= now.getTime()) {
      this.#previews.delete(previewToken)
      throw new Error('preview_stale')
    }
    const sourceRef = preview.prepared.input.sourceRef
    if (this.#applyingSources.has(sourceRef)) throw new Error('import_in_progress')
    this.#applyingSources.add(sourceRef)
    try {
      const current = await this.#prepare(preview.prepared.input)
      if (
        current.fileHash !== preview.prepared.fileHash
        || current.mappingHash !== preview.prepared.mappingHash
        || current.sheetName !== preview.prepared.sheetName
      ) {
        this.#previews.delete(previewToken)
        throw new Error('preview_stale')
      }

      const latest = this.#store.getLatestSnapshot('tencent_smart_sheet', current.input.sourceRef)
      if (
        latest !== undefined
        && latest.fileHash === current.fileHash
        && latest.mappingHash === current.mappingHash
        && latest.sheetName === current.sheetName
      ) {
        this.#previews.delete(previewToken)
        const result = {
          snapshot: latest,
          verificationInvalidatedCount: 0,
          reused: true,
        }
        this.#applied.set(previewToken, result)
        return result
      }

      const importedAt = now.toISOString()
      const snapshotId = `lead-source-snapshot:${randomBytes(24).toString('hex')}`
      const snapshot: JobLeadSourceSnapshot = {
        snapshotId,
        sourceKind: 'tencent_smart_sheet',
        sourceRef: current.input.sourceRef,
        fileHash: current.fileHash,
        mappingHash: current.mappingHash,
        sheetName: current.sheetName,
        importedAt,
        rowCount: current.rowCount,
        acceptedCount: current.leads.length,
        rejectedCount: current.rejections.length,
        duplicateCount: current.duplicateCount,
        newCount: current.classifications.new,
        changedCount: current.classifications.changed,
        unchangedCount: current.classifications.unchanged,
        status: 'applied',
      }
      const leads = current.leads.map((lead) => ({ ...lead, fetchedAt: importedAt }))
      this.#store.applySnapshot({ snapshot, leads })
      this.#previews.delete(previewToken)
      const result = {
        snapshot,
        verificationInvalidatedCount: current.verificationInvalidatedCount,
        reused: false,
      }
      this.#applied.set(previewToken, result)
      return result
    } finally {
      this.#applyingSources.delete(sourceRef)
    }
  }

  async #prepare(input: LeadImportPreviewInput): Promise<PreparedImport> {
    const normalizedInput = normalizeInput(input)
    const filePath = await resolveImportFile(this.#importRoot, normalizedInput.fileName)
    const file = await readFile(filePath)
    if (file.byteLength > MAX_FILE_BYTES) throw new Error('file_too_large')
    const fileHash = hash(file)
    const sheet = await readSheet(file, extname(filePath).toLowerCase(), normalizedInput.sheetName)
    const resolvedMapping = resolveColumnMapping(sheet.headers, normalizedInput.columnMapping)
    const mappingHash = hash(JSON.stringify(sortMapping(resolvedMapping)))
    const fetchedAt = this.#now().toISOString()
    const seen = new Set<string>()
    const leads: JobLead[] = []
    const rejections: LeadImportRejection[] = []
    let duplicateCount = 0
    const warnings = [...sheet.warnings]

    for (const row of sheet.rows) {
      const mapped = mapRow(row, resolvedMapping)
      if (mapped.company === undefined || mapped.role === undefined) {
        rejections.push({ rowNumber: row.rowNumber, code: 'invalid_required_field' })
        continue
      }
      const channel = normalizeChannelUrl(mapped.channelUrl)
      if (mapped.channelUrl !== undefined && channel === undefined) warnings.push(`row:${row.rowNumber}:invalid_channel_url`)
      const identityAnchor = channel ?? [mapped.company, mapped.cohort, mapped.recruitmentType, mapped.role]
        .map(value => value ?? '')
        .join('\u0000')
      const sourceRecordId = hash([normalizedInput.sourceRef, sheet.name, identityAnchor].join('\u0000'))
      if (seen.has(sourceRecordId)) {
        duplicateCount += 1
        continue
      }
      seen.add(sourceRecordId)
      const facts = {
        sourceRecordId,
        company: mapped.company,
        role: mapped.role,
        city: mapped.city,
        cohort: mapped.cohort,
        recruitmentType: mapped.recruitmentType,
        deadline: mapped.deadline,
        channelUrl: channel,
        sourceUpdatedAt: mapped.sourceUpdatedAt,
      }
      const lead: JobLead = {
        leadId: `lead:tencent_smart_sheet:${sourceRecordId}`,
        sourceKind: 'tencent_smart_sheet',
        sourceRecordId,
        company: mapped.company,
        role: mapped.role,
        ...mapped.city === undefined ? {} : { city: mapped.city },
        ...mapped.cohort === undefined ? {} : { cohort: mapped.cohort },
        ...mapped.recruitmentType === undefined ? {} : { recruitmentType: mapped.recruitmentType },
        ...mapped.deadline === undefined ? {} : { deadline: mapped.deadline },
        ...channel === undefined ? {} : { channelUrl: channel },
        ...mapped.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: mapped.sourceUpdatedAt },
        fetchedAt,
        rawRef: `tencent-sheet://${hash(normalizedInput.sourceRef)}/${encodeURIComponent(sheet.name)}/row/${row.rowNumber}`,
        contentHash: hash(JSON.stringify(facts)),
        confidence: 'source_only',
      }
      leads.push(lead)
    }

    const classifications: Record<LeadObservationChangeKind, number> = { new: 0, changed: 0, unchanged: 0 }
    let verificationInvalidatedCount = 0
    for (const lead of leads) {
      const existing = this.#store.getBySource(lead.sourceKind, lead.sourceRecordId)
      const kind: LeadObservationChangeKind = existing === undefined
        ? 'new'
        : existing.contentHash === lead.contentHash ? 'unchanged' : 'changed'
      classifications[kind] += 1
      if (kind === 'changed' && existing !== undefined && existing.confidence !== 'source_only') {
        verificationInvalidatedCount += 1
      }
    }

    return {
      input: normalizedInput,
      fileHash,
      mappingHash,
      sheetName: sheet.name,
      headers: sheet.headers,
      resolvedMapping,
      rowCount: sheet.rows.length,
      leads,
      rejections,
      duplicateCount,
      warnings: [...new Set(warnings)].slice(0, 100),
      classifications,
      verificationInvalidatedCount,
    }
  }

  #discardExpired(now: number): void {
    for (const [token, preview] of this.#previews) {
      if (preview.expiresAt <= now) this.#previews.delete(token)
    }
  }
}

/**
 * Adapts a user-selected clipboard snapshot to the normal tabular importer.
 * The clipboard is read only at preview/apply time and is never sent to DSH.
 */
export class LocalClipboardLeadSourceImportService implements ClipboardLeadSourceImportService {
  readonly #importRoot: string
  readonly #delegate: LocalLeadSourceImportService
  readonly #readClipboard: () => Promise<Buffer>
  readonly #now: () => Date
  readonly #previews = new Map<string, ClipboardPreview>()

  constructor(options: ClipboardLeadSourceImportOptions) {
    this.#importRoot = resolve(options.importRoot)
    mkdirSync(this.#importRoot, { recursive: true })
    this.#delegate = new LocalLeadSourceImportService(options)
    this.#readClipboard = options.readClipboard ?? readSystemClipboard
    this.#now = options.now ?? (() => new Date())
  }

  async preview(input: ClipboardLeadImportPreviewInput): Promise<LeadImportPreview> {
    await this.#discardExpired()
    const clipboard = await this.#readClipboard()
    if (clipboard.byteLength === 0 || clipboard.toString('utf8').trim().length === 0) {
      throw new Error('clipboard_empty')
    }
    const extension = detectClipboardDelimiter(clipboard) === '\t' ? '.tsv' : '.csv'
    const fileName = `.clipboard-${randomBytes(18).toString('hex')}${extension}`
    const filePath = resolve(this.#importRoot, fileName)
    await writeFile(filePath, clipboard, { mode: 0o600 })
    try {
      const preview = await this.#delegate.preview({
        sourceRef: input.sourceRef,
        fileName,
        ...input.columnMapping === undefined ? {} : { columnMapping: input.columnMapping },
      })
      const previewToken = `lead-clipboard-import-preview:${randomBytes(24).toString('hex')}`
      this.#previews.set(previewToken, {
        delegateToken: preview.previewToken,
        filePath,
        clipboardHash: hash(clipboard),
        expiresAt: this.#now().getTime() + PREVIEW_TTL_MS,
      })
      return { ...preview, previewToken }
    } catch (error: unknown) {
      await removeFile(filePath)
      throw error
    }
  }

  async apply(previewToken: string): Promise<LeadImportApplyResult> {
    await this.#discardExpired()
    const preview = this.#previews.get(previewToken)
    if (preview === undefined) throw new Error('preview_not_found')
    if (preview.expiresAt <= this.#now().getTime()) {
      this.#previews.delete(previewToken)
      await removeFile(preview.filePath)
      throw new Error('preview_stale')
    }
    const currentClipboard = await this.#readClipboard()
    if (hash(currentClipboard) !== preview.clipboardHash) {
      this.#previews.delete(previewToken)
      await removeFile(preview.filePath)
      throw new Error('clipboard_changed_since_preview')
    }
    try {
      return await this.#delegate.apply(preview.delegateToken)
    } finally {
      this.#previews.delete(previewToken)
      await removeFile(preview.filePath)
    }
  }

  async #discardExpired(): Promise<void> {
    const now = this.#now().getTime()
    const expired = [...this.#previews.entries()].filter(([, preview]) => preview.expiresAt <= now)
    await Promise.all(expired.map(async ([token, preview]) => {
      this.#previews.delete(token)
      await removeFile(preview.filePath)
    }))
  }
}

export class LeadImportError extends Error {
  readonly details?: readonly string[]

  constructor(code: string, details?: readonly string[]) {
    super(code)
    this.name = 'LeadImportError'
    if (details !== undefined) this.details = details
  }
}

function normalizeInput(input: LeadImportPreviewInput): LeadImportPreviewInput {
  const sourceRef = input.sourceRef.trim()
  const fileName = input.fileName.trim()
  if (sourceRef.length === 0) throw new Error('invalid_source_ref')
  if (fileName.length === 0 || basename(fileName) !== fileName || fileName.includes('..')) {
    throw new Error('file_outside_import_root')
  }
  return {
    sourceRef,
    fileName,
    ...input.sheetName?.trim() ? { sheetName: input.sheetName.trim() } : {},
    ...input.columnMapping === undefined ? {} : { columnMapping: input.columnMapping },
  }
}

async function resolveImportFile(importRoot: string, fileName: string): Promise<string> {
  const filePath = resolve(importRoot, fileName)
  if (!filePath.startsWith(`${importRoot}${sep}`)) throw new Error('file_outside_import_root')
  const [realRoot, realFile] = await Promise.all([
    realpath(importRoot),
    realpath(filePath).catch(() => undefined),
  ])
  if (realFile === undefined) throw new Error('import_file_not_found')
  if (!realFile.startsWith(`${realRoot}${sep}`)) throw new Error('file_outside_import_root')
  const metadata = await stat(filePath).catch(() => undefined)
  if (metadata === undefined || !metadata.isFile()) throw new Error('import_file_not_found')
  if (metadata.size > MAX_FILE_BYTES) throw new Error('file_too_large')
  const extension = extname(fileName).toLowerCase()
  if (extension !== '.csv' && extension !== '.tsv' && extension !== '.xlsx') throw new Error('unsupported_file_type')
  return filePath
}

async function readSheet(file: Uint8Array, extension: string, requestedSheet?: string): Promise<TabularSheet> {
  const workbook = new ExcelJS.Workbook()
  if (extension === '.csv' || extension === '.tsv') {
    await workbook.csv.read(Readable.from(file), {
      parserOptions: extension === '.tsv' ? { delimiter: '\t' } : {},
    })
  } else if (extension === '.xlsx') {
    await workbook.xlsx.load(file as never)
  } else {
    throw new Error('unsupported_file_type')
  }
  const sheets = workbook.worksheets
  if (sheets.length === 0) throw new Error('empty_workbook')
  if (requestedSheet === undefined && sheets.length > 1) {
    throw new LeadImportError('sheet_selection_required', sheets.map(sheet => sheet.name))
  }
  const worksheet = requestedSheet === undefined
    ? sheets[0]
    : sheets.find(sheet => sheet.name === requestedSheet)
  if (worksheet === undefined) throw new LeadImportError('sheet_not_found', sheets.map(sheet => sheet.name))
  if (worksheet.rowCount > MAX_ROWS + 1) throw new Error('row_limit_exceeded')
  const headerRow = worksheet.getRow(1)
  const headers = Array.from({ length: headerRow.cellCount }, (_, index) => cellText(headerRow.getCell(index + 1)))
    .map(value => value?.trim() ?? '')
  if (headers.every(header => header.length === 0)) throw new Error('header_row_missing')
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) throw new Error('duplicate_header')
  const rows: TabularRow[] = []
  const warnings: string[] = []
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    const values: Record<string, string> = {}
    let hasValue = false
    for (let column = 1; column <= headers.length; column += 1) {
      const header = headers[column - 1]
      if (header === undefined || header.length === 0) continue
      const cell = row.getCell(column)
      if (isFormulaCell(cell.value)) {
        warnings.push(`row:${rowNumber}:formula_ignored`)
        continue
      }
      const value = cellText(cell)
      if (value === undefined || value.trim().length === 0) continue
      if (value.length > MAX_CELL_TEXT) {
        warnings.push(`row:${rowNumber}:cell_too_large`)
        continue
      }
      values[header] = normalizeText(value)
      hasValue = true
    }
    if (hasValue) rows.push({ rowNumber, values })
  }
  return { name: worksheet.name, headers: headers.filter(Boolean), rows, warnings }
}

function resolveColumnMapping(headers: readonly string[], explicit: ImportColumnMapping | undefined): ImportColumnMapping {
  const mapping: ImportColumnMapping = {}
  const normalizedHeaders = new Map(headers.map(header => [normalizeHeader(header), header]))
  for (const field of Object.keys(FIELD_ALIASES) as ImportField[]) {
    const requested = explicit?.[field]
    if (requested !== undefined) {
      const header = normalizedHeaders.get(normalizeHeader(requested))
      if (header === undefined) throw new LeadImportError('mapping_required', [field])
      mapping[field] = header
      continue
    }
    const matches = FIELD_ALIASES[field]
      .map(alias => normalizedHeaders.get(normalizeHeader(alias)))
      .filter((header): header is string => header !== undefined)
    const unique = [...new Set(matches)]
    if (unique.length > 1) throw new LeadImportError('mapping_required', [field])
    if (unique[0] !== undefined) mapping[field] = unique[0]
  }
  if (mapping.company === undefined || mapping.role === undefined) {
    throw new LeadImportError('mapping_required', [
      ...mapping.company === undefined ? ['company'] : [],
      ...mapping.role === undefined ? ['role'] : [],
    ])
  }
  const used = Object.values(mapping)
  if (new Set(used).size !== used.length) throw new Error('mapping_conflict')
  return mapping
}

function mapRow(row: TabularRow, mapping: ImportColumnMapping): Partial<Record<ImportField, string>> {
  const mapped: Partial<Record<ImportField, string>> = {}
  for (const field of Object.keys(mapping) as ImportField[]) {
    const header = mapping[field]
    const value = header === undefined ? undefined : row.values[header]
    if (value !== undefined && value.trim().length > 0) mapped[field] = normalizeText(value)
  }
  return mapped
}

function normalizeChannelUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const hostname = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:'
    || url.username.length > 0
    || url.password.length > 0
    || (url.port.length > 0 && url.port !== '443')
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || isIP(hostname) !== 0
  ) {
    return undefined
  }
  url.hash = ''
  return url.toString()
}

function cellText(cell: ExcelJS.Cell): string | undefined {
  const value = cell.value
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && 'richText' in value && Array.isArray(value.richText)) {
    return value.richText.map(entry => entry.text).join('')
  }
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text
  return undefined
}

function isFormulaCell(value: ExcelJS.CellValue): boolean {
  return typeof value === 'object' && value !== null && 'formula' in value
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

function normalizeHeader(value: string): string {
  return normalizeText(value).toLowerCase()
}

function sortMapping(mapping: ImportColumnMapping): ImportColumnMapping {
  return Object.fromEntries(Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right))) as ImportColumnMapping
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function detectClipboardDelimiter(clipboard: Buffer): string {
  const text = clipboard.toString('utf8').replace(/^\uFEFF/u, '')
  const firstLines = text.split(/\r?\n/u).slice(0, 10)
  const tabCount = firstLines.reduce((count, line) => count + countOccurrences(line, '\t'), 0)
  const commaCount = firstLines.reduce((count, line) => count + countOccurrences(line, ','), 0)
  return tabCount > commaCount ? '\t' : ','
}

function countOccurrences(value: string, needle: string): number {
  return [...value].filter(character => character === needle).length
}

async function removeFile(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => undefined)
}

const execFileAsync = promisify(execFile)

async function readSystemClipboard(): Promise<Buffer> {
  try {
    const result = await execFileAsync('pbpaste', [], {
      encoding: 'buffer',
      maxBuffer: MAX_FILE_BYTES + 1,
    })
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
  } catch {
    throw new Error('clipboard_unavailable')
  }
}

function toPreview(token: string, expiresAt: number, prepared: PreparedImport): LeadImportPreview {
  return {
    previewToken: token,
    expiresAt: new Date(expiresAt).toISOString(),
    fileHash: prepared.fileHash,
    mappingHash: prepared.mappingHash,
    sheetName: prepared.sheetName,
    headers: prepared.headers,
    resolvedMapping: prepared.resolvedMapping,
    rowCount: prepared.rowCount,
    acceptedCount: prepared.leads.length,
    rejectedCount: prepared.rejections.length,
    duplicateCount: prepared.duplicateCount,
    estimatedNewCount: prepared.classifications.new,
    estimatedChangedCount: prepared.classifications.changed,
    estimatedUnchangedCount: prepared.classifications.unchanged,
    warnings: prepared.warnings,
    rejections: prepared.rejections,
    sampleRows: prepared.leads.slice(0, 5).map(lead => ({
      company: lead.company,
      role: lead.role,
      ...lead.city === undefined ? {} : { city: lead.city },
      ...lead.cohort === undefined ? {} : { cohort: lead.cohort },
    })),
  }
}
