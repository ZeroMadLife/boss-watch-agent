import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface FeishuResolvedUrl {
  readonly baseToken: string
  readonly title?: string
  readonly tableId?: string
  readonly viewId?: string
  readonly wikiNodeToken?: string
}

export interface FeishuBaseInfo {
  readonly baseToken: string
  readonly name: string
  readonly url?: string
}

export interface FeishuBlock {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly recordsCount?: number
}

export interface FeishuFieldOption {
  readonly name: string
}

export interface FeishuField {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly multiple?: boolean
  readonly styleType?: string
  readonly options: readonly FeishuFieldOption[]
}

export interface FeishuRecord {
  readonly recordId: string
  readonly fields: Readonly<Record<string, unknown>>
}

export interface FeishuClient {
  resolveUrl(url: string): Promise<FeishuResolvedUrl>
  getBase(baseToken: string): Promise<FeishuBaseInfo>
  listBlocks(baseToken: string): Promise<readonly FeishuBlock[]>
  listFields(baseToken: string, tableId: string): Promise<readonly FeishuField[]>
  listRecords(input: {
    baseToken: string
    tableId: string
    viewId?: string
    fieldIds?: readonly string[]
    offset?: number
    limit?: number
  }): Promise<{ readonly records: readonly FeishuRecord[]; readonly hasMore: boolean; readonly offset?: number }>
  createRecord(input: {
    baseToken: string
    tableId: string
    fields: Readonly<Record<string, unknown>>
    identityFieldIds?: readonly string[]
  }): Promise<{ readonly recordId: string }>
  updateRecord(input: { baseToken: string; tableId: string; recordId: string; fields: Readonly<Record<string, unknown>> }): Promise<{ readonly recordId: string }>
}

interface JsonEnvelope {
  readonly ok?: boolean
  readonly data?: unknown
  readonly error?: unknown
  readonly message?: unknown
}

interface CliError extends Error {
  readonly code?: string | number
  readonly stderr?: string
}

export class LarkCliFeishuClient implements FeishuClient {
  readonly #command: string
  readonly #timeoutMs: number
  readonly #maxBuffer: number

  constructor(options: { command?: string; timeoutMs?: number; maxBuffer?: number } = {}) {
    this.#command = options.command ?? 'lark-cli'
    this.#timeoutMs = options.timeoutMs ?? 20_000
    this.#maxBuffer = options.maxBuffer ?? 2 * 1024 * 1024
  }

  async resolveUrl(url: string): Promise<FeishuResolvedUrl> {
    const normalized = requireHttpUrl(url)
    const data = await this.#run('base', '+url-resolve', '--url', normalized)
    const record = asRecord(data)
    const baseToken = stringValue(record.base_token)
    if (baseToken === undefined) throw new Error('feishu_url_unresolvable')
    const parsed = new URL(normalized)
    const tableId = queryId(parsed.searchParams.get('table'))
    const viewId = queryId(parsed.searchParams.get('view'))
    const title = stringValue(record.title)
    const wikiNodeToken = stringValue(record.wiki_node_token)
    return {
      baseToken,
      ...title === undefined ? {} : { title },
      ...tableId === undefined ? {} : { tableId },
      ...viewId === undefined ? {} : { viewId },
      ...wikiNodeToken === undefined ? {} : { wikiNodeToken },
    }
  }

  async getBase(baseToken: string): Promise<FeishuBaseInfo> {
    const data = await this.#run('base', '+base-get', '--base-token', requireId(baseToken, 'base_token'))
    const record = asRecord(asRecord(data).base ?? data)
    const resolvedToken = stringValue(record.base_token)
    const name = stringValue(record.name)
    if (resolvedToken === undefined || name === undefined) throw new Error('feishu_schema_invalid')
    const url = stringValue(record.url)
    return {
      baseToken: resolvedToken,
      name,
      ...url === undefined ? {} : { url },
    }
  }

  async listBlocks(baseToken: string): Promise<readonly FeishuBlock[]> {
    const data = await this.#run('base', '+base-block-list', '--base-token', requireId(baseToken, 'base_token'))
    const record = asRecord(data)
    const blocks = Array.isArray(record.blocks) ? record.blocks : []
    return blocks.flatMap((entry) => {
      const value = asRecord(entry)
      const id = stringValue(value.id)
      const name = stringValue(value.name)
      const type = stringValue(value.type)
      if (id === undefined || name === undefined || type === undefined) return []
      const recordsCount = numberValue(value.records_count)
      return [{ id, name, type, ...recordsCount === undefined ? {} : { recordsCount } }]
    })
  }

  async listFields(baseToken: string, tableId: string): Promise<readonly FeishuField[]> {
    const data = await this.#run(
      'base', '+field-list',
      '--base-token', requireId(baseToken, 'base_token'),
      '--table-id', requireId(tableId, 'table_id'),
    )
    const record = asRecord(data)
    const fields = Array.isArray(record.fields) ? record.fields : []
    return fields.flatMap((entry) => {
      const value = asRecord(entry)
      const id = stringValue(value.id)
      const name = stringValue(value.name)
      const type = stringValue(value.type)
      if (id === undefined || name === undefined || type === undefined) return []
      const style = asRecord(value.style)
      const options = Array.isArray(value.options)
        ? value.options.flatMap((option) => {
            const name = stringValue(asRecord(option).name)
            return name === undefined ? [] : [{ name }]
          })
        : []
      const styleType = stringValue(style.type)
      return [{
        id,
        name,
        type,
        ...typeof value.multiple === 'boolean' ? { multiple: value.multiple } : {},
        ...styleType === undefined ? {} : { styleType },
        options,
      }]
    })
  }

  async listRecords(input: Parameters<FeishuClient['listRecords']>[0]): Promise<Awaited<ReturnType<FeishuClient['listRecords']>>> {
    const args = [
      'base', '+record-list',
      '--base-token', requireId(input.baseToken, 'base_token'),
      '--table-id', requireId(input.tableId, 'table_id'),
      '--limit', String(validateLimit(input.limit)),
      '--offset', String(validateOffset(input.offset)),
    ]
    if (input.viewId !== undefined) args.push('--view-id', requireId(input.viewId, 'view_id'))
    for (const fieldId of input.fieldIds ?? []) args.push('--field-id', requireId(fieldId, 'field_id'))
    const data = await this.#run(...args)
    const record = asRecord(data)
    const records = parseRecordEntries(record)
    const hasMore = valueAsBoolean(record.has_more) ?? valueAsBoolean(record.hasMore) ?? false
    const nextOffset = numberValue(record.offset)
    return { records, hasMore, ...nextOffset === undefined ? {} : { offset: nextOffset } }
  }

  async createRecord(input: Parameters<FeishuClient['createRecord']>[0]): Promise<{ readonly recordId: string }> {
    const data = await this.#run(
      'base', '+record-upsert',
      '--base-token', requireId(input.baseToken, 'base_token'),
      '--table-id', requireId(input.tableId, 'table_id'),
      '--json', JSON.stringify(input.fields),
    )
    const recordId = parseRecordId(data)
    return recordId === undefined ? this.#recoverCreatedRecord(input) : { recordId }
  }

  async updateRecord(input: Parameters<FeishuClient['updateRecord']>[0]): Promise<{ readonly recordId: string }> {
    const data = await this.#run(
      'base', '+record-upsert',
      '--base-token', requireId(input.baseToken, 'base_token'),
      '--table-id', requireId(input.tableId, 'table_id'),
      '--record-id', requireId(input.recordId, 'record_id'),
      '--json', JSON.stringify(input.fields),
    )
    return { recordId: parseRecordId(data, input.recordId) ?? input.recordId }
  }

  async #recoverCreatedRecord(input: Parameters<FeishuClient['createRecord']>[0]): Promise<{ readonly recordId: string }> {
    const identityFieldIds = normalizeIdentityFieldIds(input.identityFieldIds, input.fields)
    const matches: FeishuRecord[] = []
    let offset = 0
    for (;;) {
      const page = await this.listRecords({
        baseToken: input.baseToken,
        tableId: input.tableId,
        offset,
        limit: 200,
      })
      matches.push(...page.records.filter((record) => matchesIdentity(record, input.fields, identityFieldIds)))
      if (matches.length > 1) throw new Error('feishu_write_record_ambiguous')
      if (!page.hasMore || page.records.length === 0) break
      const nextOffset = page.offset ?? offset + page.records.length
      if (nextOffset <= offset) throw new Error('feishu_record_pagination_invalid')
      offset = nextOffset
      if (offset > 10_000) throw new Error('feishu_record_limit_exceeded')
    }
    const record = matches[0]
    if (record === undefined) throw new Error('feishu_write_record_not_found_after_create')
    return { recordId: record.recordId }
  }

  async #run(...args: string[]): Promise<unknown> {
    try {
      const result = await execFileAsync(this.#command, [...args, '--as', 'user', '--format', 'json'], {
        maxBuffer: this.#maxBuffer,
        timeout: this.#timeoutMs,
        windowsHide: true,
      })
      const parsed = parseJson(result.stdout)
      const envelope = asRecord(parsed) as JsonEnvelope
      if (envelope.ok === false) throw new Error(errorMessage(envelope))
      return envelope.data ?? parsed
    } catch (error: unknown) {
      if (error instanceof Error && /^feishu_/u.test(error.message)) throw error
      const cliError = error as CliError
      const message = `${cliError.message ?? ''} ${cliError.stderr ?? ''}`.toLowerCase()
      if (cliError.code === 'ETIMEDOUT' || message.includes('timed out')) throw new Error('feishu_cli_timeout')
      if (message.includes('91403') || message.includes('permission') || message.includes('forbidden') || message.includes('missing scope')) {
        throw new Error('feishu_resource_forbidden')
      }
      if (message.includes('not found') || message.includes('invalid url') || message.includes('base token')) {
        throw new Error('feishu_url_unresolvable')
      }
      if (message.includes('command not found') || cliError.code === 'ENOENT') throw new Error('feishu_cli_unavailable')
      throw new Error('feishu_cli_failed')
    }
  }
}

function parseRecordId(data: unknown, fallback?: string): string | undefined {
  const root = asRecord(data)
  const record = asRecord(root.record ?? data)
  const recordId = stringValue(record.record_id) ?? stringValue(record.recordId) ?? stringValue(root.record_id) ?? fallback
  return recordId
}

function parseRecordEntries(record: Record<string, unknown>): FeishuRecord[] {
  const legacyEntries = Array.isArray(record.items) ? record.items : Array.isArray(record.records) ? record.records : undefined
  if (legacyEntries !== undefined) {
    return legacyEntries.flatMap((entry) => {
      const value = asRecord(entry)
      const recordId = stringValue(value.record_id) ?? stringValue(value.id)
      const fields = asRecord(value.fields)
      return recordId === undefined ? [] : [{ recordId, fields }]
    })
  }

  const rows = Array.isArray(record.data) ? record.data : []
  const fieldIds = Array.isArray(record.field_id_list) ? record.field_id_list : []
  const recordIds = Array.isArray(record.record_id_list) ? record.record_id_list : []
  return rows.flatMap((row, rowIndex) => {
    if (!Array.isArray(row)) return []
    const recordId = stringValue(recordIds[rowIndex])
    if (recordId === undefined) return []
    const fields: Record<string, unknown> = {}
    for (let columnIndex = 0; columnIndex < fieldIds.length; columnIndex += 1) {
      const fieldId = stringValue(fieldIds[columnIndex])
      if (fieldId === undefined || row[columnIndex] === undefined) continue
      fields[fieldId] = row[columnIndex]
    }
    return [{ recordId, fields }]
  })
}

function normalizeIdentityFieldIds(
  values: readonly string[] | undefined,
  fields: Readonly<Record<string, unknown>>,
): readonly string[] {
  const candidateIds = values === undefined ? Object.keys(fields) : values
  const ids = candidateIds.filter((fieldId) => typeof fieldId === 'string' && fieldId.trim().length > 0 && fields[fieldId] !== undefined)
  if (ids.length === 0) throw new Error('feishu_write_identity_missing')
  return [...new Set(ids)]
}

function matchesIdentity(
  record: FeishuRecord,
  expectedFields: Readonly<Record<string, unknown>>,
  identityFieldIds: readonly string[],
): boolean {
  return identityFieldIds.every((fieldId) => {
    const expected = cellText(expectedFields[fieldId])
    const actual = cellText(record.fields[fieldId])
    return expected.length > 0 && expected === actual
  })
}

function cellText(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = value.trim()
    const markdownLink = /^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/u.exec(normalized)
    return markdownLink?.[1] ?? normalized
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(', ')
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return cellText(record.text ?? record.value ?? record.name ?? record.id)
  }
  return ''
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error('feishu_cli_invalid_response')
  }
}

function errorMessage(value: JsonEnvelope): string {
  const message = stringValue(value.message)
  return message === undefined ? 'feishu_cli_error' : message
}

function requireHttpUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    if (!/(?:^|\.)feishu\.cn$/u.test(url.hostname) && !/(?:^|\.)larkoffice\.com$/u.test(url.hostname)) throw new Error()
    return url.toString()
  } catch {
    throw new Error('feishu_url_unresolvable')
  }
}

function queryId(value: string | null): string | undefined {
  return value !== null && /^[a-zA-Z0-9_-]{3,128}$/u.test(value) ? value : undefined
}

function requireId(value: string, name: string): string {
  const normalized = value.trim()
  if (!/^[a-zA-Z0-9_-]{3,256}$/u.test(normalized)) throw new Error(`invalid_${name}`)
  return normalized
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid_feishu_limit')
  return limit
}

function validateOffset(value: number | undefined): number {
  const offset = value ?? 0
  if (!Number.isInteger(offset) || offset < 0) throw new Error('invalid_feishu_offset')
  return offset
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function valueAsBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
