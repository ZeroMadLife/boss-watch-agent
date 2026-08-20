import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteFeishuTargetStore, LocalFeishuProjectionService } from '../src/feishu-projection.ts'
import type { BossWatchDataSource, JobDetails, ApplicationOverview } from '../src/domain.ts'
import type { FeishuClient, FeishuField, FeishuRecord } from '../src/feishu-client.ts'

const fields: readonly FeishuField[] = [
  { id: 'fld-company', name: '公司名称', type: 'text', styleType: 'plain', options: [] },
  { id: 'fld-role', name: '岗位名称', type: 'text', styleType: 'plain', options: [] },
  { id: 'fld-url', name: '岗位链接', type: 'text', styleType: 'url', options: [] },
  { id: 'fld-status', name: '当前进度', type: 'select', multiple: false, options: [{ name: '候选待评估' }, { name: '已投递' }] },
  { id: 'fld-applied-at', name: '投递时间', type: 'datetime', options: [] },
  { id: 'fld-note', name: '备注', type: 'text', styleType: 'plain', options: [] },
]

class FakeFeishuClient implements FeishuClient {
  records: FeishuRecord[] = []
  schema = fields
  createCalls = 0
  updateCalls = 0
  recoverCalls = 0
  failCreateAfterWrite = false
  lastCreateIdentityFieldIds: readonly string[] | undefined
  resolveUrl(): Promise<{ baseToken: string; title: string; tableId: string; viewId: string }> {
    return Promise.resolve({
      baseToken: 'base-test',
      title: '测试求职表',
      tableId: 'tbl-test',
      viewId: 'view-test',
    })
  }

  getBase(): Promise<{ baseToken: string; name: string }> {
    return Promise.resolve({ baseToken: 'base-test', name: '测试求职表' })
  }

  listBlocks(): Promise<readonly { id: string; name: string; type: string }[]> {
    return Promise.resolve([{ id: 'tbl-test', name: '投递进度', type: 'table' }])
  }

  listFields(): Promise<readonly FeishuField[]> {
    return Promise.resolve(this.schema)
  }

  listRecords(): Promise<{ records: readonly FeishuRecord[]; hasMore: boolean }> {
    return Promise.resolve({ records: this.records, hasMore: false })
  }

  createRecord(input: { identityFieldIds?: readonly string[] }): Promise<{ recordId: string }> {
    this.createCalls += 1
    this.lastCreateIdentityFieldIds = input.identityFieldIds
    if (this.failCreateAfterWrite) return Promise.reject(new Error('feishu_write_record_not_found_after_create'))
    return Promise.resolve({ recordId: `rec-created-${this.createCalls}` })
  }

  recoverCreatedRecord(): Promise<{ recordId: string }> {
    this.recoverCalls += 1
    return Promise.resolve({ recordId: 'rec-recovered' })
  }

  updateRecord(input: { recordId: string }): Promise<{ recordId: string }> {
    this.updateCalls += 1
    return Promise.resolve({ recordId: input.recordId })
  }
}

type FixtureStatus = 'new' | 'submitted' | 'proposed' | 'forged_confirmation'

function createSource(status: FixtureStatus = 'new'): BossWatchDataSource {
  const job: JobDetails = {
    applicationId: 'application-test-1',
    company: '示例公司',
    role: '后端工程师',
    jobUrl: 'https://careers.example.invalid/jobs/1',
    capturedAt: '2026-08-18T01:00:00.000Z',
    contentHash: 'a'.repeat(64),
    description: '负责服务端开发和 Agent 工程化。',
    artifactRef: 'local-artifact://test/job',
  }
  const overview: ApplicationOverview = {
    ...job,
    progressState: status === 'submitted' || status === 'forged_confirmation'
      ? 'status_confirmed'
      : status === 'proposed' ? 'status_proposed' : 'new',
    eventCount: 1,
    recruiterMessageCount: 0,
    interviewNoteCount: 0,
    progressSignalCount: 0,
    latestEventType: 'job_description_captured',
    latestEventAt: job.capturedAt,
    ...status === 'submitted' || status === 'forged_confirmation' ? { confirmedStatus: 'submitted' } : {},
    ...status === 'proposed' ? { proposedStatus: 'submitted' } : {},
  }
  return {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [overview] },
    async getApplicationOverview(applicationId) { return applicationId === job.applicationId ? overview : undefined },
    async getJob(applicationId) { return applicationId === job.applicationId ? job : undefined },
    async listTimeline() {
      if (status === 'submitted' || status === 'forged_confirmation') return [{
        sequence: 2,
        eventId: 'event-submitted',
        applicationId: job.applicationId,
        type: 'status_change_confirmed',
        occurredAt: '2026-08-18T02:30:00.000Z',
        actor: status === 'submitted' ? 'human' : 'agent',
        payload: { to: 'submitted', source: 'user_manual_confirmation' },
      }]
      if (status === 'proposed') return [{
        sequence: 2,
        eventId: 'event-proposed',
        applicationId: job.applicationId,
        type: 'status_change_proposed',
        occurredAt: '2026-08-18T02:30:00.000Z',
        actor: 'agent',
        payload: { to: 'submitted', evidenceEventIds: ['event-signal'] },
      }]
      return []
    },
  }
}

async function setup(
  status: FixtureStatus = 'new',
  source?: BossWatchDataSource,
): Promise<{ service: LocalFeishuProjectionService; client: FakeFeishuClient; store: SqliteFeishuTargetStore }> {
  const client = new FakeFeishuClient()
  const store = new SqliteFeishuTargetStore(':memory:')
  const service = new LocalFeishuProjectionService({ client, store, source: source ?? createSource(status) })
  return { service, client, store }
}

test('previews a Feishu target, maps fields, and requires explicit confirmation', async () => {
  const { service, store } = await setup()
  try {
    const preview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    assert.equal(preview.tableName, '投递进度')
    assert.equal(preview.mapping.company?.fieldId, 'fld-company')
    assert.equal(preview.mapping.role?.fieldId, 'fld-role')
    assert.throws(() => service.confirmTarget(preview.previewToken, false), /feishu_confirmation_required/u)
    const confirmed = service.confirmTarget(preview.previewToken, true)
    assert.equal(confirmed.target.tableId, 'tbl-test')
    assert.equal(store.getTarget(confirmed.target.targetId)?.schemaHash, confirmed.target.schemaHash)
  } finally {
    store.close()
  }
})

test('previews create and applies one projection idempotently', async () => {
  const { service, client, store } = await setup()
  try {
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])
    assert.deepEqual(preview.counts, { create: 1, update: 0, unchanged: 0, conflict: 0 })
    assert.equal(preview.items[0]?.action, 'create')
    const applied = await service.syncApply(preview.previewToken, true)
    assert.deepEqual(applied.counts, { created: 1, updated: 0, unchanged: 0 })
    assert.equal(client.createCalls, 1)
    assert.deepEqual(client.lastCreateIdentityFieldIds, ['fld-url'])
    const repeated = await service.syncApply(preview.previewToken, true)
    assert.deepEqual(repeated, applied)
    assert.equal(client.createCalls, 1)
    assert.equal(store.getProjection(target.targetId, 'application-test-1')?.remoteRecordId, 'rec-created-1')
    assert.deepEqual(store.listProjections({ applicationId: 'application-test-1' }), [
      store.getProjection(target.targetId, 'application-test-1'),
    ])
  } finally {
    store.close()
  }
})

test('recovers an uncertain create without issuing a second remote create', async () => {
  const { service, client, store } = await setup()
  try {
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])
    client.failCreateAfterWrite = true

    await assert.rejects(() => service.syncApply(preview.previewToken, true), /feishu_write_record_not_found_after_create/u)
    client.failCreateAfterWrite = false
    const recovered = await service.syncApply(preview.previewToken, true)

    assert.equal(client.createCalls, 1)
    assert.equal(client.recoverCalls, 1)
    assert.deepEqual(recovered.counts, { created: 1, updated: 0, unchanged: 0 })
    assert.equal(store.getProjection(target.targetId, 'application-test-1')?.remoteRecordId, 'rec-recovered')
  } finally {
    store.close()
  }
})

test('projects only a user-confirmed submitted status and its observed application time', async () => {
  const { service, store } = await setup('submitted')
  try {
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])

    assert.equal(preview.items[0]?.fields?.['fld-status'], '已投递')
    assert.equal(preview.items[0]?.fields?.['fld-applied-at'], '2026-08-18T02:30:00.000Z')
  } finally {
    store.close()
  }
})

test('treats Feishu datetime offsets representing the same instant as unchanged', async () => {
  const { service, client, store } = await setup('submitted')
  try {
    client.records = [{
      recordId: 'rec-submitted',
      fields: {
        'fld-company': '示例公司',
        'fld-role': '后端工程师',
        'fld-url': '[查看岗位](https://careers.example.invalid/jobs/1)',
        'fld-status': '已投递',
        'fld-applied-at': '2026-08-18T10:30:00.000+08:00',
        'fld-note': 'JD摘要：负责服务端开发和 Agent 工程化。',
      },
    }]
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])

    assert.equal(preview.items[0]?.action, 'unchanged')
    assert.equal(preview.items[0]?.diffs, undefined)
  } finally {
    store.close()
  }
})

test('does not project an agent-proposed status as an application fact', async () => {
  const { service, store } = await setup('proposed')
  try {
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])

    assert.equal(preview.items[0]?.fields?.['fld-status'], undefined)
    assert.equal(preview.items[0]?.fields?.['fld-applied-at'], undefined)
  } finally {
    store.close()
  }
})

test('does not project an agent event that forges the manual-confirmation payload', async () => {
  const { service, store } = await setup('forged_confirmation')
  try {
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])

    assert.equal(preview.items[0]?.fields?.['fld-status'], undefined)
    assert.equal(preview.items[0]?.fields?.['fld-applied-at'], undefined)
  } finally {
    store.close()
  }
})

test('reconciles remote edits and missing rows without writing local projections', async () => {
  const { service, client, store } = await setup('submitted')
  try {
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const sync = await service.syncPreview(target.targetId, ['application-test-1'])
    await service.syncApply(sync.previewToken, true)
    client.records = [{
      recordId: 'rec-created-1',
      fields: {
        'fld-company': '示例公司',
        'fld-role': '后端工程师',
        'fld-url': 'https://careers.example.invalid/jobs/1',
        'fld-status': '候选待评估',
      },
    }]
    const preview = await service.reconcilePreview(target.targetId)
    assert.equal(preview.readOnly, true)
    assert.equal(preview.items[0]?.state, 'remote_ahead')
    assert.equal(preview.items[0]?.diffs?.['fld-status']?.before, '候选待评估')
    assert.equal(store.getProjection(target.targetId, 'application-test-1')?.lastResult, 'created')

    client.records = []
    const missing = await service.reconcilePreview(target.targetId, ['application-test-1'])
    assert.equal(missing.items[0]?.state, 'missing_remote')
  } finally {
    store.close()
  }
})

test('previews unchanged and update actions using a stable job URL', async () => {
  const { service, client, store } = await setup()
  try {
    client.records = [{
      recordId: 'rec-existing',
      fields: {
        'fld-company': '示例公司',
        'fld-role': '后端工程师',
        'fld-url': '[查看岗位](https://careers.example.invalid/jobs/1)',
        'fld-note': '旧备注',
      },
    }]
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])
    assert.equal(preview.items[0]?.action, 'update')
    assert.equal(preview.items[0]?.remoteRecordId, 'rec-existing')
    assert.equal(preview.items[0]?.diffs?.['fld-note']?.before, '旧备注')
    const applied = await service.syncApply(preview.previewToken, true)
    assert.equal(applied.counts.updated, 1)
    assert.equal(client.updateCalls, 1)
  } finally {
    store.close()
  }
})

test('does not create a duplicate when the remote row is already unchanged', async () => {
  const { service, client, store } = await setup()
  try {
    client.records = [{
      recordId: 'rec-existing',
      fields: {
        'fld-company': '示例公司',
        'fld-role': '后端工程师',
        'fld-url': '[查看岗位](https://careers.example.invalid/jobs/1)',
        'fld-note': 'JD摘要：负责服务端开发和 Agent 工程化。',
      },
    }, {
      recordId: 'rec-same-company-different-role-url',
      fields: {
        'fld-company': '示例公司',
        'fld-role': '后端工程师',
        'fld-url': '[查看岗位](https://careers.example.invalid/jobs/other)',
        'fld-note': '另一条历史记录',
      },
    }]
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    assert.equal(store.getProjection(target.targetId, 'application-test-1'), undefined)
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])
    assert.equal(preview.items[0]?.action, 'unchanged')
    const applied = await service.syncApply(preview.previewToken, true)
    assert.deepEqual(applied.counts, { created: 0, updated: 0, unchanged: 1 })
    assert.equal(client.createCalls, 0)
    assert.equal(client.updateCalls, 0)
    assert.equal(applied.applied[0]?.remoteRecordId, 'rec-existing')
    assert.equal(store.getProjection(target.targetId, 'application-test-1')?.remoteRecordId, 'rec-existing')
    assert.equal(store.getProjection(target.targetId, 'application-test-1')?.lastResult, 'unchanged')
  } finally {
    store.close()
  }
})

test('rejects applying a preview after the target schema changes', async () => {
  const { service, client, store } = await setup()
  try {
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])
    client.schema = [...fields, { id: 'fld-extra', name: '新字段', type: 'text', options: [] }]
    await assert.rejects(() => service.syncApply(preview.previewToken, true), /feishu_schema_changed/u)
  } finally {
    store.close()
  }
})

test('rejects the entire apply before writing when local facts change after preview', async () => {
  const base = createSource()
  let currentRole = '后端工程师'
  const mutableSource: BossWatchDataSource = {
    ...base,
    async getJob(applicationId) {
      const job = await base.getJob(applicationId)
      return job === undefined ? undefined : { ...job, role: currentRole }
    },
  }
  const { service, client, store } = await setup('new', mutableSource)
  try {
    const targetPreview = await service.targetPreview('https://example.feishu.cn/wiki/test?table=tbl-test&view=view-test')
    const target = service.confirmTarget(targetPreview.previewToken, true).target
    const preview = await service.syncPreview(target.targetId, ['application-test-1'])
    currentRole = 'Agent 平台工程师'

    await assert.rejects(() => service.syncApply(preview.previewToken, true), /feishu_preview_stale/u)
    assert.equal(client.createCalls, 0)
    assert.equal(client.updateCalls, 0)
    assert.equal(store.getProjection(target.targetId, 'application-test-1'), undefined)
  } finally {
    store.close()
  }
})
