import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BossWatchDataSource } from './domain.js'
import type { FeishuBlock, FeishuClient, FeishuField, FeishuRecord } from './feishu-client.js'

export type FeishuSemanticField =
  | 'company'
  | 'role'
  | 'jobUrl'
  | 'sourcePlatform'
  | 'status'
  | 'appliedAt'
  | 'deadline'
  | 'city'
  | 'location'
  | 'summary'
  | 'priority'
  | 'matchLevel'
  | 'companyType'
  | 'interviewId'
  | 'interviewStage'
  | 'interviewNote'
  | 'interviewAt'

export interface FeishuMappedField {
  readonly semantic: FeishuSemanticField
  readonly fieldId: string
  readonly fieldName: string
  readonly fieldType: string
  readonly multiple?: boolean
  readonly styleType?: string
  readonly options: readonly string[]
}

export type FeishuFieldMapping = Partial<Record<FeishuSemanticField, FeishuMappedField>>

export interface FeishuTarget {
  readonly targetId: string
  readonly baseToken: string
  readonly tableId: string
  readonly viewId?: string
  readonly title?: string
  readonly identity: 'user'
  readonly schemaHash: string
  readonly mapping: FeishuFieldMapping
  readonly createdAt: string
  readonly updatedAt: string
}

export interface FeishuProjection {
  readonly targetId: string
  readonly applicationId: string
  readonly remoteRecordId: string
  readonly sourceHash: string
  readonly projectedHash: string
  readonly projectedAt: string
  readonly lastResult: 'created' | 'updated' | 'unchanged'
}

export interface FeishuTargetStore {
  saveTarget(target: FeishuTarget): FeishuTarget
  countTargets(): number
  getTarget(targetId: string): FeishuTarget | undefined
  getProjection(targetId: string, applicationId: string): FeishuProjection | undefined
  listProjections(options?: { applicationId?: string; limit?: number }): FeishuProjection[]
  saveProjection(projection: FeishuProjection): FeishuProjection
  close(): void
}

interface TargetRow {
  target_id: string
  base_token: string
  table_id: string
  view_id: string | null
  title: string | null
  identity: 'user'
  schema_hash: string
  mapping_json: string
  created_at: string
  updated_at: string
}

interface ProjectionRow {
  target_id: string
  application_id: string
  remote_record_id: string
  source_hash: string
  projected_hash: string
  projected_at: string
  last_result: 'created' | 'updated' | 'unchanged'
}

export class SqliteFeishuTargetStore implements FeishuTargetStore {
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
      CREATE TABLE IF NOT EXISTS feishu_targets (
        target_id TEXT PRIMARY KEY,
        base_token TEXT NOT NULL,
        table_id TEXT NOT NULL,
        view_id TEXT,
        title TEXT,
        identity TEXT NOT NULL CHECK (identity = 'user'),
        schema_hash TEXT NOT NULL CHECK (length(schema_hash) = 64),
        mapping_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (base_token, table_id)
      );
      CREATE TABLE IF NOT EXISTS feishu_projections (
        target_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        remote_record_id TEXT NOT NULL,
        source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
        projected_hash TEXT NOT NULL CHECK (length(projected_hash) = 64),
        projected_at TEXT NOT NULL,
        last_result TEXT NOT NULL CHECK (last_result IN ('created', 'updated', 'unchanged')),
        PRIMARY KEY (target_id, application_id),
        UNIQUE (target_id, remote_record_id)
      );
    `)
  }

  saveTarget(target: FeishuTarget): FeishuTarget {
    this.#ensureOpen()
    validateTarget(target)
    this.#database.prepare(`
      INSERT INTO feishu_targets (
        target_id, base_token, table_id, view_id, title, identity, schema_hash, mapping_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (base_token, table_id) DO UPDATE SET
        target_id = feishu_targets.target_id,
        view_id = excluded.view_id,
        title = excluded.title,
        identity = excluded.identity,
        schema_hash = excluded.schema_hash,
        mapping_json = excluded.mapping_json,
        updated_at = excluded.updated_at
    `).run(
      target.targetId,
      target.baseToken,
      target.tableId,
      target.viewId ?? null,
      target.title ?? null,
      target.identity,
      target.schemaHash,
      JSON.stringify(target.mapping),
      target.createdAt,
      target.updatedAt,
    )
    const row = this.#database.prepare(`
      SELECT target_id, base_token, table_id, view_id, title, identity, schema_hash, mapping_json, created_at, updated_at
      FROM feishu_targets WHERE base_token = ? AND table_id = ?
    `).get(target.baseToken, target.tableId) as unknown as TargetRow | undefined
    if (row === undefined) throw new Error('feishu_target_write_failed')
    return fromTargetRow(row)
  }

  countTargets(): number {
    this.#ensureOpen()
    const row = this.#database.prepare('SELECT COUNT(*) AS count FROM feishu_targets').get() as unknown as { count: number }
    return row.count
  }

  getTarget(targetId: string): FeishuTarget | undefined {
    this.#ensureOpen()
    const normalized = requireText(targetId, 'target_id')
    const row = this.#database.prepare(`
      SELECT target_id, base_token, table_id, view_id, title, identity, schema_hash, mapping_json, created_at, updated_at
      FROM feishu_targets WHERE target_id = ?
    `).get(normalized) as unknown as TargetRow | undefined
    return row === undefined ? undefined : fromTargetRow(row)
  }

  getProjection(targetId: string, applicationId: string): FeishuProjection | undefined {
    this.#ensureOpen()
    const row = this.#database.prepare(`
      SELECT target_id, application_id, remote_record_id, source_hash, projected_hash, projected_at, last_result
      FROM feishu_projections WHERE target_id = ? AND application_id = ?
    `).get(requireText(targetId, 'target_id'), requireText(applicationId, 'application_id')) as unknown as ProjectionRow | undefined
    return row === undefined ? undefined : fromProjectionRow(row)
  }

  listProjections(options: { applicationId?: string; limit?: number } = {}): FeishuProjection[] {
    this.#ensureOpen()
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
    const rows = options.applicationId === undefined
      ? this.#database.prepare(`
          SELECT target_id, application_id, remote_record_id, source_hash, projected_hash, projected_at, last_result
          FROM feishu_projections ORDER BY projected_at DESC, target_id ASC LIMIT ?
        `).all(limit)
      : this.#database.prepare(`
          SELECT target_id, application_id, remote_record_id, source_hash, projected_hash, projected_at, last_result
          FROM feishu_projections WHERE application_id = ? ORDER BY projected_at DESC, target_id ASC LIMIT ?
        `).all(requireText(options.applicationId, 'application_id'), limit)
    return (rows as unknown as ProjectionRow[]).map(fromProjectionRow)
  }

  saveProjection(projection: FeishuProjection): FeishuProjection {
    this.#ensureOpen()
    validateProjection(projection)
    this.#database.prepare(`
      INSERT INTO feishu_projections (
        target_id, application_id, remote_record_id, source_hash, projected_hash, projected_at, last_result
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (target_id, application_id) DO UPDATE SET
        remote_record_id = excluded.remote_record_id,
        source_hash = excluded.source_hash,
        projected_hash = excluded.projected_hash,
        projected_at = excluded.projected_at,
        last_result = excluded.last_result
    `).run(
      projection.targetId,
      projection.applicationId,
      projection.remoteRecordId,
      projection.sourceHash,
      projection.projectedHash,
      projection.projectedAt,
      projection.lastResult,
    )
    return projection
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error('sqlite_feishu_store_closed')
  }
}

export interface FeishuTargetPreview {
  readonly targetId: string
  readonly previewToken: string
  readonly expiresAt: string
  readonly title?: string
  readonly baseName: string
  readonly baseToken: string
  readonly tableId: string
  readonly tableName: string
  readonly viewId?: string
  readonly fields: readonly FeishuField[]
  readonly mapping: FeishuFieldMapping
  readonly warnings: readonly string[]
  readonly requiresConfirmation: true
}

export interface FeishuTargetConfirmResult {
  readonly target: FeishuTarget
  readonly confirmed: true
}

export type FeishuSyncAction = 'create' | 'update' | 'unchanged' | 'conflict'

export interface FeishuSyncItem {
  readonly applicationId: string
  readonly company: string
  readonly role: string
  readonly action: FeishuSyncAction
  readonly remoteRecordId?: string
  readonly fields?: Readonly<Record<string, unknown>>
  readonly diffs?: Readonly<Record<string, { readonly before: string; readonly after: string }>>
  readonly reason?: string
}

export interface FeishuSyncPreview {
  readonly targetId: string
  readonly previewToken: string
  readonly expiresAt: string
  readonly schemaHash: string
  readonly sourceHash: string
  readonly items: readonly FeishuSyncItem[]
  readonly counts: { readonly create: number; readonly update: number; readonly unchanged: number; readonly conflict: number }
  readonly requiresConfirmation: true
}

export interface FeishuSyncApplyResult {
  readonly targetId: string
  readonly previewToken: string
  readonly applied: readonly FeishuSyncItem[]
  readonly counts: { readonly created: number; readonly updated: number; readonly unchanged: number }
}

export interface FeishuInterviewNotePreview {
  readonly targetId: string
  readonly previewToken: string
  readonly expiresAt: string
  readonly applicationId: string
  readonly company: string
  readonly role: string
  readonly interviewId: string
  readonly stage: string
  readonly contentHash: string
  readonly contentLength: number
  readonly mappedFieldCount: number
  readonly requiresConfirmation: true
}

export interface FeishuInterviewNoteApplyResult {
  readonly targetId: string
  readonly previewToken: string
  readonly applicationId: string
  readonly remoteRecordId: string
  readonly created: boolean
  readonly contentHash: string
}

export type FeishuReconcileState = 'in_sync' | 'local_ahead' | 'remote_ahead' | 'conflict' | 'missing_remote'

export interface FeishuReconcileItem {
  readonly applicationId: string
  readonly company: string
  readonly role: string
  readonly state: FeishuReconcileState
  readonly remoteRecordId?: string
  readonly diffs?: Readonly<Record<string, { readonly before: string; readonly after: string }>>
  readonly reason?: string
}

export interface FeishuReconcilePreview {
  readonly targetId: string
  readonly schemaHash: string
  readonly checkedAt: string
  readonly items: readonly FeishuReconcileItem[]
  readonly counts: Readonly<Record<FeishuReconcileState, number>>
  readonly readOnly: true
}

interface StoredTargetPreview {
  readonly kind: 'target'
  readonly target: FeishuTargetPreview
  readonly createdAtMs: number
  readonly applied?: FeishuTarget
}

interface StoredSyncPreview {
  readonly kind: 'sync'
  readonly preview: FeishuSyncPreview
  readonly target: FeishuTarget
  readonly createdAtMs: number
  readonly sourceHashes: Readonly<Record<string, string>>
  readonly pendingCreates: Set<string>
  readonly applied?: FeishuSyncApplyResult
}

interface StoredInterviewNotePreview {
  readonly kind: 'interview_note'
  readonly preview: FeishuInterviewNotePreview
  readonly target: FeishuTarget
  readonly fields: Readonly<Record<string, unknown>>
  readonly identityFieldIds: readonly string[]
  readonly createdAtMs: number
  readonly pendingCreate?: boolean
  readonly remoteRecordId?: string
  readonly applied?: FeishuInterviewNoteApplyResult
}

type StoredPreview = StoredTargetPreview | StoredSyncPreview | StoredInterviewNotePreview

const PREVIEW_TTL_MS = 15 * 60 * 1000
const SEMANTICS: readonly FeishuSemanticField[] = [
  'company', 'role', 'jobUrl', 'sourcePlatform', 'status', 'appliedAt', 'deadline', 'city', 'location',
  'summary', 'priority', 'matchLevel', 'companyType', 'interviewId', 'interviewStage', 'interviewNote', 'interviewAt',
]

const FIELD_ALIASES: Readonly<Record<FeishuSemanticField, readonly string[]>> = {
  company: ['公司名称', '公司', '企业', '招聘企业', 'company'],
  role: ['岗位名称', '岗位', '职位', '招聘岗位', 'role'],
  jobUrl: ['岗位链接', '投递链接', '申请链接', '职位链接', 'joburl'],
  sourcePlatform: ['投递平台', '来源平台', '招聘平台', '平台', 'sourceplatform'],
  status: ['当前进度', '投递进度', '进度', '状态', 'status'],
  appliedAt: ['投递时间', '申请时间', '提交时间', 'appliedat'],
  deadline: ['截止时间', '截止日期', '报名截止', 'deadline'],
  city: ['城市', '工作城市', 'city'],
  location: ['地点', '工作地点', '工作地区', 'location'],
  summary: ['备注', '说明', '补充说明', 'jd摘要', 'summary'],
  priority: ['推荐优先级', '优先级', 'priority'],
  matchLevel: ['jd匹配度', '匹配度', '岗位匹配度', 'matchlevel'],
  companyType: ['公司类型', '企业类型', '单位性质', 'companytype'],
  interviewId: ['面试编号', '面试id', 'interviewid'],
  interviewStage: ['面试阶段', '面试轮次', 'interviewstage'],
  interviewNote: ['面经', '面试记录', '面试笔记', 'interviewnote'],
  interviewAt: ['面试时间', '面试日期', '面试发生时间', 'interviewat'],
}

const TEXT_SEMANTICS = new Set<FeishuSemanticField>(['company', 'role', 'jobUrl', 'city', 'location', 'summary', 'interviewId', 'interviewNote'])
const SELECT_SEMANTICS = new Set<FeishuSemanticField>(['sourcePlatform', 'status', 'priority', 'matchLevel', 'companyType', 'interviewStage'])
const DATE_SEMANTICS = new Set<FeishuSemanticField>(['appliedAt', 'deadline', 'interviewAt'])

const CONFIRMED_STATUS_OPTIONS = {
  submitted: ['已投递', '投递完成', '已申请'],
  assessment_scheduled: ['待笔试', '笔试待进行', '笔试安排'],
  assessment_completed: ['笔试完成', '已完成笔试', '笔试已完成'],
  interview_scheduled: ['待面试', '面试安排', '面试中'],
  rejected: ['已拒绝', '未通过', '流程终止'],
  offer: ['Offer', '已获Offer', '已录用', '录用'],
  closed: ['已关闭', '流程关闭', '已结束'],
} as const

type ConfirmedApplicationStatus = keyof typeof CONFIRMED_STATUS_OPTIONS

interface ConfirmedStatusFact {
  readonly status: ConfirmedApplicationStatus
  readonly occurredAt: string
  readonly sequence: number
}

export class LocalFeishuProjectionService {
  readonly #client: FeishuClient
  readonly #store: FeishuTargetStore
  readonly #source: BossWatchDataSource
  readonly #previews = new Map<string, StoredPreview>()

  constructor(input: { client: FeishuClient; store: FeishuTargetStore; source: BossWatchDataSource }) {
    this.#client = input.client
    this.#store = input.store
    this.#source = input.source
  }

  async targetPreview(url: string): Promise<FeishuTargetPreview> {
    const resolved = await this.#client.resolveUrl(url)
    const base = await this.#client.getBase(resolved.baseToken)
    const blocks = await this.#client.listBlocks(resolved.baseToken)
    const table = selectTable(blocks, resolved.tableId)
    const tableId = table.id
    const fields = await this.#client.listFields(resolved.baseToken, tableId)
    const mappingResult = buildMapping(fields)
    const targetId = `feishu-target:${randomBytes(18).toString('hex')}`
    const previewToken = `feishu-target-preview:${randomBytes(24).toString('hex')}`
    const preview: FeishuTargetPreview = {
      targetId,
      previewToken,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      ...resolved.title === undefined ? {} : { title: resolved.title },
      baseName: base.name,
      baseToken: resolved.baseToken,
      tableId,
      tableName: table.name,
      ...resolved.viewId === undefined ? {} : { viewId: resolved.viewId },
      fields,
      mapping: mappingResult.mapping,
      warnings: mappingResult.warnings,
      requiresConfirmation: true,
    }
    this.#previews.set(previewToken, { kind: 'target', target: preview, createdAtMs: Date.now() })
    this.#prunePreviews()
    return preview
  }

  confirmTarget(previewToken: string, confirmed: boolean): FeishuTargetConfirmResult {
    if (!confirmed) throw new Error('feishu_confirmation_required')
    const stored = this.#getPreview(previewToken)
    if (stored.kind !== 'target') throw new Error('feishu_preview_kind_mismatch')
    if (stored.applied !== undefined) return { target: stored.applied, confirmed: true }
    if (stored.target.mapping.company === undefined || stored.target.mapping.role === undefined) {
      throw new Error('feishu_mapping_incomplete')
    }
    const now = new Date().toISOString()
    const target: FeishuTarget = {
      targetId: stored.target.targetId,
      baseToken: stored.target.baseToken,
      tableId: stored.target.tableId,
      ...stored.target.viewId === undefined ? {} : { viewId: stored.target.viewId },
      ...stored.target.title === undefined ? {} : { title: stored.target.title },
      identity: 'user',
      schemaHash: hashFields(stored.target.fields),
      mapping: stored.target.mapping,
      createdAt: now,
      updatedAt: now,
    }
    const saved = this.#store.saveTarget(target)
    this.#previews.set(previewToken, { ...stored, applied: saved })
    return { target: saved, confirmed: true }
  }

  async syncPreview(targetId: string, applicationIds: readonly string[]): Promise<FeishuSyncPreview> {
    const target = this.#store.getTarget(requireText(targetId, 'target_id'))
    if (target === undefined) throw new Error('feishu_target_not_found')
    const fields = await this.#client.listFields(target.baseToken, target.tableId)
    const currentSchemaHash = hashFields(fields)
    if (currentSchemaHash !== target.schemaHash) throw new Error('feishu_schema_changed')
    const ids = normalizeApplicationIds(applicationIds)
    const records = await this.#listAllRecords(target, fields)
    const items: FeishuSyncItem[] = []
    const sourceHashes: Record<string, string> = {}
    for (const applicationId of ids) {
      const projection = await buildLocalProjection(this.#source, applicationId, target.mapping)
      if (projection === undefined) {
        items.push({ applicationId, company: '', role: '', action: 'conflict', reason: 'application_not_found' })
        continue
      }
      sourceHashes[applicationId] = projection.sourceHash
      const match = matchRemoteRecord(records, target.mapping, projection)
      if (match.kind === 'conflict') {
        items.push({ applicationId, company: projection.company, role: projection.role, action: 'conflict', reason: match.reason })
        continue
      }
      const projectedHash = hashJson(projection.fields)
      if (match.record === undefined) {
        items.push({ applicationId, company: projection.company, role: projection.role, action: 'create', fields: projection.fields })
        continue
      }
      const diffs = diffFields(match.record.fields, projection.fields, target.mapping)
      items.push({
        applicationId,
        company: projection.company,
        role: projection.role,
        action: Object.keys(diffs).length === 0 ? 'unchanged' : 'update',
        remoteRecordId: match.record.recordId,
        fields: projection.fields,
        ...Object.keys(diffs).length === 0 ? {} : { diffs },
      })
      void projectedHash
    }
    const sourceHash = hashJson(sourceHashes)
    const previewToken = `feishu-sync-preview:${randomBytes(24).toString('hex')}`
    const preview: FeishuSyncPreview = {
      targetId: target.targetId,
      previewToken,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      schemaHash: target.schemaHash,
      sourceHash,
      items,
      counts: {
        create: items.filter((item) => item.action === 'create').length,
        update: items.filter((item) => item.action === 'update').length,
        unchanged: items.filter((item) => item.action === 'unchanged').length,
        conflict: items.filter((item) => item.action === 'conflict').length,
      },
      requiresConfirmation: true,
    }
    this.#previews.set(previewToken, {
      kind: 'sync',
      preview,
      target,
      createdAtMs: Date.now(),
      sourceHashes,
      pendingCreates: new Set(),
    })
    this.#prunePreviews()
    return preview
  }

  async interviewNotePreview(input: {
    targetId: string
    applicationId: string
    interviewId: string
    stage: string
    content: string
    occurredAt: string
  }): Promise<FeishuInterviewNotePreview> {
    const target = this.#store.getTarget(requireText(input.targetId, 'target_id'))
    if (target === undefined) throw new Error('feishu_target_not_found')
    const job = await this.#source.getJob(requireText(input.applicationId, 'application_id'))
    if (job === undefined) throw new Error('application_not_found')
    const fields = await this.#client.listFields(target.baseToken, target.tableId)
    if (hashFields(fields) !== target.schemaHash) throw new Error('feishu_schema_changed')
    const mapping = target.mapping
    if (
      mapping.company === undefined
      || mapping.role === undefined
      || mapping.interviewId === undefined
      || mapping.interviewNote === undefined
    ) {
      throw new Error('feishu_interview_mapping_incomplete')
    }
    const values: Record<string, unknown> = {}
    const semanticValues: Partial<Record<FeishuSemanticField, string>> = {
      company: job.company,
      role: job.role,
      interviewId: requireText(input.interviewId, 'interview_id'),
      interviewStage: requireText(input.stage, 'interview_stage'),
      interviewNote: requireText(input.content, 'interview_note'),
      interviewAt: requireTimestamp(input.occurredAt),
    }
    for (const semantic of ['company', 'role', 'interviewId', 'interviewStage', 'interviewNote', 'interviewAt'] as const) {
      const mapped = mapping[semantic]
      const value = semanticValues[semantic]
      if (mapped === undefined || value === undefined) continue
      const converted = semantic === 'interviewStage'
        ? convertInterviewStage(mapped, value)
        : convertCellValue(mapped, value)
      if (converted !== undefined) values[mapped.fieldId] = converted
    }
    if (values[mapping.interviewNote.fieldId] === undefined) throw new Error('feishu_interview_mapping_incompatible')
    const identityFieldIds = [mapping.company, mapping.role, mapping.interviewId]
      .filter((field): field is FeishuMappedField => field !== undefined)
      .map(field => field.fieldId)
    const previewToken = `feishu-interview-preview:${randomBytes(24).toString('hex')}`
    const preview: FeishuInterviewNotePreview = {
      targetId: target.targetId,
      previewToken,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      applicationId: input.applicationId,
      company: job.company,
      role: job.role,
      interviewId: input.interviewId,
      stage: input.stage,
      contentHash: hashJson(input.content),
      contentLength: input.content.length,
      mappedFieldCount: Object.keys(values).length,
      requiresConfirmation: true,
    }
    this.#previews.set(previewToken, {
      kind: 'interview_note',
      preview,
      target,
      fields: values,
      identityFieldIds,
      createdAtMs: Date.now(),
    })
    this.#prunePreviews()
    return preview
  }

  async interviewNoteApply(previewToken: string, confirmed: boolean): Promise<FeishuInterviewNoteApplyResult> {
    if (!confirmed) throw new Error('feishu_confirmation_required')
    const stored = this.#getPreview(previewToken)
    if (stored.kind !== 'interview_note') throw new Error('feishu_preview_kind_mismatch')
    if (stored.applied !== undefined) return stored.applied
    const fields = await this.#client.listFields(stored.target.baseToken, stored.target.tableId)
    if (hashFields(fields) !== stored.target.schemaHash) throw new Error('feishu_schema_changed')
    const records = await this.#listAllRecords(stored.target, fields)
    const matches = records.filter(record => stored.identityFieldIds.every(fieldId => cellText(record.fields[fieldId]) === cellText(stored.fields[fieldId])))
    if (matches.length > 1) throw new Error('feishu_interview_record_ambiguous')
    let remoteRecordId: string
    let created: boolean
    if (matches.length === 1) {
      remoteRecordId = (await this.#client.updateRecord({
        baseToken: stored.target.baseToken,
        tableId: stored.target.tableId,
        recordId: matches[0]!.recordId,
        fields: stored.fields,
      })).recordId
      created = false
    } else {
      try {
        remoteRecordId = stored.pendingCreate === true
          ? (this.#client.recoverCreatedRecord === undefined
            ? (() => { throw new Error('feishu_create_recovery_unsupported') })()
            : (await this.#client.recoverCreatedRecord({
              baseToken: stored.target.baseToken,
              tableId: stored.target.tableId,
              fields: stored.fields,
              identityFieldIds: stored.identityFieldIds,
            })).recordId)
          : (await this.#client.createRecord({
            baseToken: stored.target.baseToken,
            tableId: stored.target.tableId,
            fields: stored.fields,
            identityFieldIds: stored.identityFieldIds,
          })).recordId
      } catch (error: unknown) {
        if (error instanceof Error && error.message === 'feishu_write_record_not_found_after_create') {
          this.#previews.set(previewToken, { ...stored, pendingCreate: true })
        }
        throw error
      }
      created = true
    }
    const result: FeishuInterviewNoteApplyResult = {
      targetId: stored.target.targetId,
      previewToken,
      applicationId: stored.preview.applicationId,
      remoteRecordId,
      created,
      contentHash: stored.preview.contentHash,
    }
    this.#previews.set(previewToken, { ...stored, pendingCreate: false, remoteRecordId, applied: result })
    return result
  }

  /** Compare local facts with saved projections and remote rows without writing either side. */
  async reconcilePreview(targetId: string, applicationIds?: readonly string[]): Promise<FeishuReconcilePreview> {
    const target = this.#store.getTarget(requireText(targetId, 'target_id'))
    if (target === undefined) throw new Error('feishu_target_not_found')
    const fields = await this.#client.listFields(target.baseToken, target.tableId)
    const schemaHash = hashFields(fields)
    if (schemaHash !== target.schemaHash) throw new Error('feishu_schema_changed')
    const ids = applicationIds === undefined
      ? (await this.#source.listApplicationOverviews(10_000)).map(item => item.applicationId)
      : normalizeApplicationIds(applicationIds)
    const records = await this.#listAllRecords(target, fields)
    const items: FeishuReconcileItem[] = []
    for (const applicationId of ids) {
      const current = await buildLocalProjection(this.#source, applicationId, target.mapping)
      if (current === undefined) {
        items.push({ applicationId, company: '', role: '', state: 'conflict', reason: 'application_not_found' })
        continue
      }
      const stored = this.#store.getProjection(target.targetId, applicationId)
      const remote = stored === undefined
        ? matchRemoteRecord(records, target.mapping, current)
        : { kind: 'match' as const, record: records.find(record => record.recordId === stored.remoteRecordId) }
      if (remote.kind === 'conflict') {
        items.push({ applicationId, company: current.company, role: current.role, state: 'conflict', reason: remote.reason })
        continue
      }
      if (remote.record === undefined) {
        items.push({ applicationId, company: current.company, role: current.role, state: 'missing_remote', reason: stored === undefined ? 'not_projected' : 'record_not_found' })
        continue
      }
      const diffs = diffFields(remote.record.fields, current.fields, target.mapping)
      if (Object.keys(diffs).length === 0) {
        items.push({ applicationId, company: current.company, role: current.role, state: 'in_sync', remoteRecordId: remote.record.recordId })
        continue
      }
      if (stored === undefined) {
        items.push({ applicationId, company: current.company, role: current.role, state: 'remote_ahead', remoteRecordId: remote.record.recordId, diffs })
        continue
      }
      const localChanged = stored.sourceHash !== current.sourceHash
      items.push({
        applicationId,
        company: current.company,
        role: current.role,
        state: localChanged ? 'conflict' : 'remote_ahead',
        remoteRecordId: remote.record.recordId,
        diffs,
      })
    }
    const states: FeishuReconcileState[] = ['in_sync', 'local_ahead', 'remote_ahead', 'conflict', 'missing_remote']
    const counts = Object.fromEntries(states.map(state => [state, items.filter(item => item.state === state).length])) as Record<FeishuReconcileState, number>
    return { targetId: target.targetId, schemaHash, checkedAt: new Date().toISOString(), items, counts, readOnly: true }
  }

  async syncApply(previewToken: string, confirmed: boolean): Promise<FeishuSyncApplyResult> {
    if (!confirmed) throw new Error('feishu_confirmation_required')
    const stored = this.#getPreview(previewToken)
    if (stored.kind !== 'sync') throw new Error('feishu_preview_kind_mismatch')
    if (stored.applied !== undefined) return stored.applied
    const fields = await this.#client.listFields(stored.target.baseToken, stored.target.tableId)
    if (hashFields(fields) !== stored.preview.schemaHash) throw new Error('feishu_schema_changed')
    for (const item of stored.preview.items) {
      if (item.action === 'conflict') continue
      const expectedSourceHash = stored.sourceHashes[item.applicationId]
      const current = await buildLocalProjection(this.#source, item.applicationId, stored.target.mapping)
      if (expectedSourceHash === undefined || current?.sourceHash !== expectedSourceHash) {
        throw new Error('feishu_preview_stale')
      }
    }
    const applied: FeishuSyncItem[] = []
    let created = 0
    let updated = 0
    let unchanged = 0
    for (const item of stored.preview.items) {
      if (item.action === 'conflict') continue
      const sourceHash = stored.sourceHashes[item.applicationId]
      if (sourceHash === undefined) throw new Error('feishu_preview_stale')
      const existingProjection = this.#store.getProjection(stored.target.targetId, item.applicationId)
      if (item.action === 'unchanged') {
        const remoteRecordId = item.remoteRecordId ?? existingProjection?.remoteRecordId
        if (remoteRecordId === undefined) throw new Error('feishu_preview_stale')
        this.#store.saveProjection({
          targetId: stored.target.targetId,
          applicationId: item.applicationId,
          remoteRecordId,
          sourceHash,
          projectedHash: hashJson(item.fields ?? {}),
          projectedAt: new Date().toISOString(),
          lastResult: 'unchanged',
        })
        applied.push({ ...item, action: 'unchanged', remoteRecordId })
        unchanged += 1
        continue
      }
      if (existingProjection !== undefined && existingProjection.sourceHash === sourceHash && item.action === 'create') {
        applied.push({ ...item, action: 'unchanged', remoteRecordId: existingProjection.remoteRecordId })
        unchanged += 1
        continue
      }
      if (item.fields === undefined) throw new Error('feishu_preview_stale')
      const identityFieldIds = selectIdentityFieldIds(stored.target.mapping, item.fields)
      let remoteRecordId: string
      if (item.action === 'update' && item.remoteRecordId !== undefined) {
        remoteRecordId = (await this.#client.updateRecord({
          baseToken: stored.target.baseToken,
          tableId: stored.target.tableId,
          recordId: item.remoteRecordId,
          fields: item.fields,
        })).recordId
      } else {
        const createInput = {
          baseToken: stored.target.baseToken,
          tableId: stored.target.tableId,
          fields: item.fields,
          identityFieldIds,
        }
        if (stored.pendingCreates.has(item.applicationId)) {
          if (this.#client.recoverCreatedRecord === undefined) throw new Error('feishu_create_recovery_unsupported')
          remoteRecordId = (await this.#client.recoverCreatedRecord(createInput)).recordId
        } else {
          try {
            remoteRecordId = (await this.#client.createRecord(createInput)).recordId
          } catch (error) {
            if (error instanceof Error && error.message === 'feishu_write_record_not_found_after_create') {
              stored.pendingCreates.add(item.applicationId)
            }
            throw error
          }
        }
        stored.pendingCreates.delete(item.applicationId)
      }
      const lastResult = item.action === 'update' ? 'updated' : 'created'
      const projection: FeishuProjection = {
        targetId: stored.target.targetId,
        applicationId: item.applicationId,
        remoteRecordId,
        sourceHash,
        projectedHash: hashJson(item.fields),
        projectedAt: new Date().toISOString(),
        lastResult,
      }
      this.#store.saveProjection(projection)
      applied.push({ ...item, action: item.action, remoteRecordId })
      if (item.action === 'update') updated += 1
      else created += 1
    }
    const result: FeishuSyncApplyResult = {
      targetId: stored.target.targetId,
      previewToken,
      applied,
      counts: { created, updated, unchanged },
    }
    this.#previews.set(previewToken, { ...stored, applied: result })
    return result
  }

  #getPreview(token: string): StoredPreview {
    const normalized = requireText(token, 'preview_token')
    const stored = this.#previews.get(normalized)
    if (stored === undefined) throw new Error('feishu_preview_not_found')
    if (Date.now() - stored.createdAtMs >= PREVIEW_TTL_MS) {
      this.#previews.delete(normalized)
      throw new Error('feishu_preview_stale')
    }
    return stored
  }

  async #listAllRecords(target: FeishuTarget, fields: readonly FeishuField[]): Promise<FeishuRecord[]> {
    const fieldIds = Object.values(target.mapping).map((field) => field.fieldId)
    const records: FeishuRecord[] = []
    let offset = 0
    for (;;) {
      const page = await this.#client.listRecords({
        baseToken: target.baseToken,
        tableId: target.tableId,
        ...target.viewId === undefined ? {} : { viewId: target.viewId },
        fieldIds,
        offset,
        limit: 200,
      })
      records.push(...page.records)
      if (!page.hasMore || page.records.length === 0) break
      offset = page.offset ?? offset + page.records.length
      if (records.length > 10_000) throw new Error('feishu_record_limit_exceeded')
    }
    void fields
    return records
  }

  #prunePreviews(): void {
    const cutoff = Date.now() - PREVIEW_TTL_MS
    for (const [token, preview] of this.#previews) {
      if (preview.createdAtMs < cutoff) this.#previews.delete(token)
    }
  }
}

function selectTable(blocks: readonly FeishuBlock[], requested?: string): FeishuBlock {
  const tables = blocks.filter((block) => block.type === 'table')
  if (requested !== undefined) {
    const table = tables.find((entry) => entry.id === requested)
    if (table === undefined) throw new Error('feishu_table_not_found')
    return table
  }
  if (tables.length !== 1) throw new Error('feishu_table_required')
  return tables[0] as FeishuBlock
}

function buildMapping(fields: readonly FeishuField[]): { mapping: FeishuFieldMapping; warnings: string[] } {
  const mapping: FeishuFieldMapping = {}
  const warnings: string[] = []
  for (const semantic of SEMANTICS) {
    const aliases = new Set(FIELD_ALIASES[semantic].map(normalizeName))
    const candidates = fields.filter((field) => aliases.has(normalizeName(field.name)) && isCompatibleField(semantic, field))
    if (candidates.length === 1) {
      const field = candidates[0] as FeishuField
      mapping[semantic] = toMappedField(semantic, field)
    } else if (candidates.length > 1) {
      warnings.push(`mapping_conflict:${semantic}`)
    }
  }
  if (mapping.company === undefined) warnings.push('required_mapping_missing:company')
  if (mapping.role === undefined) warnings.push('required_mapping_missing:role')
  return { mapping, warnings }
}

function isCompatibleField(semantic: FeishuSemanticField, field: FeishuField): boolean {
  if (semantic === 'interviewStage') return field.type === 'select' || field.type === 'text'
  if (TEXT_SEMANTICS.has(semantic)) return field.type === 'text'
  if (SELECT_SEMANTICS.has(semantic)) return field.type === 'select'
  if (DATE_SEMANTICS.has(semantic)) return field.type === 'datetime'
  return false
}

function toMappedField(semantic: FeishuSemanticField, field: FeishuField): FeishuMappedField {
  return {
    semantic,
    fieldId: field.id,
    fieldName: field.name,
    fieldType: field.type,
    ...field.multiple === undefined ? {} : { multiple: field.multiple },
    ...field.styleType === undefined ? {} : { styleType: field.styleType },
    options: field.options.map((option) => option.name),
  }
}

interface LocalProjection {
  readonly applicationId: string
  readonly company: string
  readonly role: string
  readonly sourceHash: string
  readonly fields: Readonly<Record<string, unknown>>
}

async function buildLocalProjection(
  source: BossWatchDataSource,
  applicationId: string,
  mapping: FeishuFieldMapping,
): Promise<LocalProjection | undefined> {
  const job = await source.getJob(applicationId)
  if (job === undefined) return undefined
  const overview = await source.getApplicationOverview(applicationId)
  const timeline = await source.listTimeline(applicationId)
  const confirmedFacts = timeline
    .map(toConfirmedStatusFact)
    .filter((fact): fact is ConfirmedStatusFact => fact !== undefined)
    .sort((left, right) => left.sequence - right.sequence)
  const latestConfirmed = confirmedFacts.at(-1)
  const confirmedStatus = latestConfirmed !== undefined && overview?.confirmedStatus === latestConfirmed.status
    ? latestConfirmed.status
    : undefined
  const submittedAt = confirmedFacts.find((fact) => fact.status === 'submitted')?.occurredAt
  const confirmedStatusOption = confirmedStatus === undefined || mapping.status === undefined
    ? undefined
    : selectConfirmedStatusOption(mapping.status, confirmedStatus)
  const values: Record<string, unknown> = {}
  const semanticValues: Partial<Record<FeishuSemanticField, string>> = {
    company: job.company,
    role: job.role,
    ...job.jobUrl === undefined ? {} : { jobUrl: job.jobUrl },
    ...confirmedStatusOption === undefined ? {} : { status: confirmedStatusOption },
    ...submittedAt === undefined ? {} : { appliedAt: submittedAt },
    summary: summarizeDescription(job.description),
  }
  for (const [semantic, mapped] of Object.entries(mapping) as [FeishuSemanticField, FeishuMappedField][]) {
    const value = semanticValues[semantic]
    if (typeof value !== 'string' || value.length === 0) continue
    const converted = convertCellValue(mapped, value)
    if (converted !== undefined) values[mapped.fieldId] = converted
  }
  const sourceFact = {
    applicationId,
    company: job.company,
    role: job.role,
    jobUrl: job.jobUrl ?? null,
    capturedAt: job.capturedAt,
    contentHash: job.contentHash,
    progressState: overview?.progressState ?? null,
    latestEventAt: overview?.latestEventAt ?? null,
    confirmedStatus: confirmedStatus ?? null,
    submittedAt: submittedAt ?? null,
  }
  return {
    applicationId,
    company: job.company,
    role: job.role,
    sourceHash: hashJson(sourceFact),
    fields: values,
  }
}

function toConfirmedStatusFact(event: Awaited<ReturnType<BossWatchDataSource['listTimeline']>>[number]): ConfirmedStatusFact | undefined {
  if (event.type !== 'status_change_confirmed' || event.actor !== 'human' || typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    return undefined
  }
  const status = event.payload.to
  if (event.payload.source !== 'user_manual_confirmation' || !isConfirmedApplicationStatus(status)) return undefined
  return { status, occurredAt: event.occurredAt, sequence: event.sequence }
}

function isConfirmedApplicationStatus(value: unknown): value is ConfirmedApplicationStatus {
  return typeof value === 'string' && Object.hasOwn(CONFIRMED_STATUS_OPTIONS, value)
}

function selectConfirmedStatusOption(field: FeishuMappedField, status: ConfirmedApplicationStatus): string | undefined {
  return CONFIRMED_STATUS_OPTIONS[status].find((option) => field.options.includes(option))
}

function convertCellValue(field: FeishuMappedField, value: string): unknown {
  if (field.fieldType === 'select') {
    if (!field.options.includes(value)) return undefined
    return field.multiple === true ? [value] : value
  }
  if (field.fieldType === 'datetime') return toFeishuDate(value)
  if (field.fieldType === 'text') return value
  return undefined
}

function convertInterviewStage(field: FeishuMappedField, value: string): unknown {
  if (field.fieldType !== 'select') return value
  const aliases: Record<string, readonly string[]> = {
    screening: ['筛选', '初筛', '电话面'],
    first_interview: ['一面', '初面', '第一轮面试'],
    second_interview: ['二面', '第二轮面试'],
    final_interview: ['终面', '终轮', '最终面试'],
    other: ['其他', '其他面试'],
  }
  const normalized = value.toLowerCase()
  const option = field.options.find(candidate => candidate === value || (aliases[normalized] ?? []).includes(candidate))
  return option === undefined ? undefined : field.multiple === true ? [option] : option
}

function toFeishuDate(value: string): string | undefined {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return undefined
  return parsed.toISOString()
}

function requireTimestamp(value: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid_interview_timestamp')
  return parsed.toISOString()
}

function summarizeDescription(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= 500 ? `JD摘要：${normalized}` : `JD摘要：${normalized.slice(0, 500)}…`
}

function matchRemoteRecord(
  records: readonly FeishuRecord[],
  mapping: FeishuFieldMapping,
  projection: LocalProjection,
): { readonly kind: 'match'; readonly record?: FeishuRecord } | { readonly kind: 'conflict'; readonly reason: string } {
  const url = mapping.jobUrl === undefined ? undefined : projection.fields[mapping.jobUrl.fieldId]
  const urlMatches = typeof url === 'string' && url.length > 0
    ? records.filter((record) => cellText(record.fields[mapping.jobUrl?.fieldId ?? '']) === url)
    : []
  if (urlMatches.length === 1) return { kind: 'match', record: urlMatches[0] as FeishuRecord }
  if (urlMatches.length > 1) return { kind: 'conflict', reason: 'feishu_record_conflict:job_url' }
  const company = mapping.company === undefined ? undefined : projection.fields[mapping.company.fieldId]
  const role = mapping.role === undefined ? undefined : projection.fields[mapping.role.fieldId]
  if (typeof company !== 'string' || typeof role !== 'string') return { kind: 'conflict', reason: 'feishu_mapping_incomplete' }
  const fallback = records.filter((record) => {
    const recordCompany = cellText(record.fields[mapping.company?.fieldId ?? ''])
    const recordRole = cellText(record.fields[mapping.role?.fieldId ?? ''])
    return recordCompany === company && recordRole === role
  })
  if (fallback.length === 1) return { kind: 'match', record: fallback[0] as FeishuRecord }
  if (fallback.length > 1) return { kind: 'conflict', reason: 'feishu_record_conflict:company_role' }
  return { kind: 'match' }
}

function selectIdentityFieldIds(
  mapping: FeishuFieldMapping,
  fields: Readonly<Record<string, unknown>>,
): readonly string[] {
  const jobUrl = mapping.jobUrl?.fieldId
  if (jobUrl !== undefined && fields[jobUrl] !== undefined) return [jobUrl]
  const company = mapping.company?.fieldId
  const role = mapping.role?.fieldId
  const companyRole = [company, role].filter((fieldId): fieldId is string => fieldId !== undefined && fields[fieldId] !== undefined)
  if (companyRole.length === 2) return companyRole
  return Object.keys(fields)
}

function diffFields(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  mapping: FeishuFieldMapping,
): Readonly<Record<string, { before: string; after: string }>> {
  const result: Record<string, { before: string; after: string }> = {}
  for (const [fieldId, value] of Object.entries(after)) {
    const mapped = Object.values(mapping).find(field => field.fieldId === fieldId)
    const previous = comparableCellText(before[fieldId], mapped)
    const next = comparableCellText(value, mapped)
    if (previous !== next) result[fieldId] = { before: previous, after: next }
  }
  return result
}

function comparableCellText(value: unknown, field: FeishuMappedField | undefined): string {
  if (field?.fieldType !== 'datetime') return cellText(value)
  const text = cellText(value)
  if (text.length === 0) return text
  const numeric = /^\d{10,13}$/u.test(text) ? Number(text) : undefined
  const timestamp = numeric === undefined
    ? Date.parse(text)
    : numeric < 10_000_000_000 ? numeric * 1000 : numeric
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : text
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

function normalizeApplicationIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw new Error('invalid_application_ids')
  const normalized = values.map((value) => requireText(value, 'application_id'))
  if (new Set(normalized).size !== normalized.length) throw new Error('duplicate_application_id')
  return normalized
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-/:：()（）]+/gu, '')
}

function hashFields(fields: readonly FeishuField[]): string {
  return hashJson(fields.map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type,
    multiple: field.multiple ?? null,
    styleType: field.styleType ?? null,
    options: field.options.map((option) => option.name),
  })).sort((left, right) => left.id.localeCompare(right.id)))
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_, nested) => nested && typeof nested === 'object' && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
    : nested)).digest('hex')
}

function fromTargetRow(row: TargetRow): FeishuTarget {
  let mapping: FeishuFieldMapping
  try {
    mapping = JSON.parse(row.mapping_json) as FeishuFieldMapping
  } catch {
    throw new Error('feishu_target_corrupt')
  }
  return {
    targetId: row.target_id,
    baseToken: row.base_token,
    tableId: row.table_id,
    ...row.view_id === null ? {} : { viewId: row.view_id },
    ...row.title === null ? {} : { title: row.title },
    identity: row.identity,
    schemaHash: row.schema_hash,
    mapping,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function fromProjectionRow(row: ProjectionRow): FeishuProjection {
  return {
    targetId: row.target_id,
    applicationId: row.application_id,
    remoteRecordId: row.remote_record_id,
    sourceHash: row.source_hash,
    projectedHash: row.projected_hash,
    projectedAt: row.projected_at,
    lastResult: row.last_result,
  }
}

function validateTarget(target: FeishuTarget): void {
  requireText(target.targetId, 'target_id')
  requireText(target.baseToken, 'base_token')
  requireText(target.tableId, 'table_id')
  if (!/^[a-f0-9]{64}$/u.test(target.schemaHash)) throw new Error('invalid_feishu_schema_hash')
}

function validateProjection(projection: FeishuProjection): void {
  requireText(projection.targetId, 'target_id')
  requireText(projection.applicationId, 'application_id')
  requireText(projection.remoteRecordId, 'remote_record_id')
  if (!/^[a-f0-9]{64}$/u.test(projection.sourceHash) || !/^[a-f0-9]{64}$/u.test(projection.projectedHash)) {
    throw new Error('invalid_feishu_projection_hash')
  }
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 512) throw new Error(`invalid_${name}`)
  return normalized
}
