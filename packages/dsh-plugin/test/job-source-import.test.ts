import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ExcelJS from 'exceljs'
import {
  LocalClipboardLeadSourceImportService,
  LocalLeadSourceImportService,
} from '../src/job-source-import.ts'
import { SqliteJobLeadStore } from '../src/job-lead.ts'

test('previews a local CSV without writing facts, then applies one atomic source snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-import-csv-'))
  const importRoot = join(root, 'imports')
  const databasePath = join(root, 'boss-watch.sqlite3')
  const store = new SqliteJobLeadStore(databasePath)
  const now = new Date('2026-08-17T09:00:00.000Z')
  const service = new LocalLeadSourceImportService({ importRoot, store, now: () => now })
  await writeFile(join(importRoot, 'campus.csv'), [
    '公司,岗位,地点,届别,招聘类型,投递链接',
    '虚构星河科技,后端工程师,上海,2027届,秋招,https://careers.example.invalid/jobs/1',
    ',测试工程师,杭州,2027届,秋招,https://careers.example.invalid/jobs/2',
    '虚构星河科技,后端工程师,上海,2027届,秋招,https://careers.example.invalid/jobs/1',
    '',
  ].join('\n'))

  try {
    const preview = await service.preview({
      sourceRef: 'tencent-27-campus',
      fileName: 'campus.csv',
    })
    assert.equal(preview.rowCount, 3)
    assert.equal(preview.acceptedCount, 1)
    assert.equal(preview.rejectedCount, 1)
    assert.equal(preview.duplicateCount, 1)
    assert.equal(preview.estimatedNewCount, 1)
    assert.equal(preview.resolvedMapping.company, '公司')
    assert.equal(preview.resolvedMapping.role, '岗位')
    assert.deepEqual(store.list({ limit: 10 }), [])
    assert.deepEqual(store.listSnapshots({ limit: 10 }), [])

    const applied = await service.apply(preview.previewToken)
    assert.equal(applied.reused, false)
    assert.equal(applied.snapshot.acceptedCount, 1)
    assert.equal(applied.snapshot.rejectedCount, 1)
    assert.equal(applied.snapshot.duplicateCount, 1)
    assert.equal(applied.snapshot.newCount, 1)
    assert.equal(store.list({ limit: 10 })[0]?.company, '虚构星河科技')
    assert.equal(store.list({ limit: 10 })[0]?.confidence, 'source_only')
    assert.equal(store.list({ limit: 10 })[0]?.officialApplyUrl, undefined)
    assert.equal(store.listObservations({ includeUnchanged: true, limit: 10 })[0]?.snapshotId, applied.snapshot.snapshotId)

    const retried = await service.apply(preview.previewToken)
    assert.deepEqual(retried, applied)

    const repeatedPreview = await service.preview({ sourceRef: 'tencent-27-campus', fileName: 'campus.csv' })
    const repeated = await service.apply(repeatedPreview.previewToken)
    assert.equal(repeated.reused, true)
    assert.equal(repeated.snapshot.snapshotId, applied.snapshot.snapshotId)
    assert.equal(store.listObservations({ includeUnchanged: true, limit: 10 }).length, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps A to B to A source snapshots and invalidates verification only on changed content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-import-history-'))
  const importRoot = join(root, 'imports')
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  let now = new Date('2026-08-17T10:00:00.000Z')
  const service = new LocalLeadSourceImportService({ importRoot, store, now: () => now })
  const filePath = join(importRoot, 'campus.csv')
  const sourceRef = 'tencent-27-history'
  const header = '公司,岗位,届别,招聘类型,投递链接\n'
  const url = 'https://careers.example.invalid/jobs/stable'

  try {
    await writeFile(filePath, `${header}虚构云杉科技,后端工程师,2027届,秋招,${url}\n`)
    const previewA = await service.preview({ sourceRef, fileName: 'campus.csv' })
    const appliedA = await service.apply(previewA.previewToken)
    const lead = store.list({ sourceKind: 'tencent_smart_sheet', limit: 10 })[0]
    assert.ok(lead)
    store.confirmCandidateUrl({ leadId: lead.leadId, expectedContentHash: lead.contentHash })
    store.confirmJd({ leadId: lead.leadId, expectedContentHash: lead.contentHash })

    now = new Date('2026-08-17T10:05:00.000Z')
    await writeFile(filePath, `${header}虚构云杉科技,平台工程师,2027届,秋招,${url}\n`)
    const previewB = await service.preview({ sourceRef, fileName: 'campus.csv' })
    assert.equal(previewB.estimatedChangedCount, 1)
    const appliedB = await service.apply(previewB.previewToken)
    assert.equal(appliedB.verificationInvalidatedCount, 1)
    assert.equal(store.get(lead.leadId)?.confidence, 'source_only')
    assert.equal(store.get(lead.leadId)?.officialApplyUrl, undefined)

    now = new Date('2026-08-17T10:10:00.000Z')
    await writeFile(filePath, `${header}虚构云杉科技,后端工程师,2027届,秋招,${url}\n`)
    const previewA2 = await service.preview({ sourceRef, fileName: 'campus.csv' })
    assert.equal(previewA2.estimatedChangedCount, 1)
    const appliedA2 = await service.apply(previewA2.previewToken)
    assert.notEqual(appliedA2.snapshot.snapshotId, appliedA.snapshot.snapshotId)
    assert.notEqual(appliedA2.snapshot.snapshotId, appliedB.snapshot.snapshotId)
    assert.deepEqual(
      store.listObservations({ sourceKind: 'tencent_smart_sheet', includeUnchanged: true, limit: 10 })
        .map(observation => observation.changeKind),
      ['changed', 'changed', 'new'],
    )
    assert.equal(store.listSnapshots({ sourceKind: 'tencent_smart_sheet', limit: 10 }).length, 3)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('requires an explicit XLSX sheet and ignores formula cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-import-xlsx-'))
  const importRoot = join(root, 'imports')
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  const service = new LocalLeadSourceImportService({ importRoot, store })
  const workbook = new ExcelJS.Workbook()
  const first = workbook.addWorksheet('每日更新')
  first.addRow(['公司', '岗位', '地点'])
  first.addRow(['虚构青峦科技', 'Agent 工程师', { formula: '1+1', result: 2 }])
  const second = workbook.addWorksheet('内推企业')
  second.addRow(['公司', '岗位'])
  second.addRow(['虚构远山科技', '数据工程师'])
  await workbook.xlsx.writeFile(join(importRoot, 'campus.xlsx'))

  try {
    await assert.rejects(
      () => service.preview({ sourceRef: 'tencent-xlsx', fileName: 'campus.xlsx' }),
      /sheet_selection_required/u,
    )
    const preview = await service.preview({
      sourceRef: 'tencent-xlsx',
      fileName: 'campus.xlsx',
      sheetName: '每日更新',
    })
    assert.equal(preview.acceptedCount, 1)
    assert.deepEqual(preview.sampleRows, [{ company: '虚构青峦科技', role: 'Agent 工程师' }])
    assert.ok(preview.warnings.includes('row:2:formula_ignored'))
    await assert.rejects(
      () => service.preview({ sourceRef: 'tencent-xlsx', fileName: '../campus.xlsx' }),
      /file_outside_import_root/u,
    )
    const outside = join(root, 'outside.csv')
    await writeFile(outside, '公司,岗位\n虚构外部公司,后端工程师\n')
    await symlink(outside, join(importRoot, 'linked.csv'))
    await assert.rejects(
      () => service.preview({ sourceRef: 'tencent-xlsx', fileName: 'linked.csv' }),
      /file_outside_import_root/u,
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('previews copied Tencent table rows without writing facts, then applies the same clipboard snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-import-clipboard-'))
  const importRoot = join(root, 'imports')
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  let clipboard = [
    '公司\t岗位\t地点\t届别\t投递链接\t私人备注',
    '虚构潮汐科技\t后端工程师\t深圳\t2027届\thttps://careers.example.invalid/jobs/clipboard-1\t不得返回完整剪贴板',
    '\t测试工程师\t杭州\t2027届\thttps://careers.example.invalid/jobs/clipboard-2\t拒绝行',
    '',
  ].join('\n')
  const service = new LocalClipboardLeadSourceImportService({
    importRoot,
    store,
    readClipboard: async () => Buffer.from(clipboard),
    now: () => new Date('2026-08-17T11:00:00.000Z'),
  })

  try {
    const preview = await service.preview({ sourceRef: 'tencent-view-only-27-campus' })
    assert.equal(preview.rowCount, 2)
    assert.equal(preview.acceptedCount, 1)
    assert.equal(preview.rejectedCount, 1)
    assert.equal(preview.estimatedNewCount, 1)
    assert.deepEqual(preview.sampleRows, [{
      company: '虚构潮汐科技',
      role: '后端工程师',
      city: '深圳',
      cohort: '2027届',
    }])
    assert.doesNotMatch(JSON.stringify(preview), /不得返回完整剪贴板/u)
    assert.deepEqual(store.list({ limit: 10 }), [])

    const applied = await service.apply(preview.previewToken)
    assert.equal(applied.reused, false)
    assert.equal(applied.snapshot.acceptedCount, 1)
    assert.equal(store.list({ limit: 10 })[0]?.company, '虚构潮汐科技')
    assert.equal(store.listSnapshots({ limit: 10 })[0]?.sourceRef, 'tencent-view-only-27-campus')
    assert.deepEqual(await readdir(importRoot), [])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a clipboard apply when copied rows changed after preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-import-clipboard-stale-'))
  const importRoot = join(root, 'imports')
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  let clipboard = '公司\t岗位\n虚构星港科技\tAgent 工程师\n'
  const service = new LocalClipboardLeadSourceImportService({
    importRoot,
    store,
    readClipboard: async () => Buffer.from(clipboard),
  })

  try {
    const preview = await service.preview({ sourceRef: 'tencent-view-only-stale' })
    clipboard = '公司\t岗位\n虚构星港科技\t平台工程师\n'
    await assert.rejects(() => service.apply(preview.previewToken), /clipboard_changed_since_preview/u)
    assert.deepEqual(store.list({ limit: 10 }), [])
    assert.deepEqual(store.listSnapshots({ limit: 10 }), [])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects an empty clipboard before creating an import preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-import-clipboard-empty-'))
  const importRoot = join(root, 'imports')
  const store = new SqliteJobLeadStore(join(root, 'boss-watch.sqlite3'))
  const service = new LocalClipboardLeadSourceImportService({
    importRoot,
    store,
    readClipboard: async () => Buffer.from('  \n'),
  })

  try {
    await assert.rejects(
      () => service.preview({ sourceRef: 'tencent-view-only-empty' }),
      /clipboard_empty/u,
    )
    assert.deepEqual(store.listSnapshots({ limit: 10 }), [])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
