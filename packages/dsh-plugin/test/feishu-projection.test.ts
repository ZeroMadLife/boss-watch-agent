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
  { id: 'fld-note', name: '备注', type: 'text', styleType: 'plain', options: [] },
]

class FakeFeishuClient implements FeishuClient {
  records: FeishuRecord[] = []
  schema = fields
  createCalls = 0
  updateCalls = 0
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
    return Promise.resolve({ recordId: `rec-created-${this.createCalls}` })
  }

  updateRecord(input: { recordId: string }): Promise<{ recordId: string }> {
    this.updateCalls += 1
    return Promise.resolve({ recordId: input.recordId })
  }
}

function createSource(): BossWatchDataSource {
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
    progressState: 'new',
    eventCount: 1,
    recruiterMessageCount: 0,
    interviewNoteCount: 0,
    progressSignalCount: 0,
    latestEventType: 'job_description_captured',
    latestEventAt: job.capturedAt,
  }
  return {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [overview] },
    async getApplicationOverview(applicationId) { return applicationId === job.applicationId ? overview : undefined },
    async getJob(applicationId) { return applicationId === job.applicationId ? job : undefined },
    async listTimeline() { return [] },
  }
}

async function setup(): Promise<{ service: LocalFeishuProjectionService; client: FakeFeishuClient; store: SqliteFeishuTargetStore }> {
  const client = new FakeFeishuClient()
  const store = new SqliteFeishuTargetStore(':memory:')
  const service = new LocalFeishuProjectionService({ client, store, source: createSource() })
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
