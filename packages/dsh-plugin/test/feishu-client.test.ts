import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LarkCliFeishuClient } from '../src/feishu-client.ts'

interface CliFixture {
  readonly listData: unknown
  readonly upsertData?: unknown
}

async function withFakeCli<T>(fixture: CliFixture, run: (command: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'boss-watch-feishu-'))
  const command = join(directory, 'lark-cli')
  const script = [
    '#!/usr/bin/env node',
    `const listData = ${JSON.stringify(fixture.listData)};`,
    `const upsertData = ${JSON.stringify(fixture.upsertData ?? { ok: true, data: {} })};`,
    'const args = process.argv.slice(2);',
    'const data = args.includes("+record-upsert") ? upsertData : listData;',
    'process.stdout.write(JSON.stringify({ ok: true, data }));',
  ].join('\n')
  await writeFile(command, `${script}\n`, 'utf8')
  await chmod(command, 0o755)
  try {
    return await run(command)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('parses lark-cli record-list rows with field_id_list and record_id_list', async () => {
  await withFakeCli({
    listData: {
      data: [
        ['示例公司', '后端工程师'],
        ['另一家公司', '前端工程师'],
      ],
      field_id_list: ['fld-company', 'fld-role'],
      record_id_list: ['rec-1', 'rec-2'],
      has_more: false,
    },
  }, async (command) => {
    const client = new LarkCliFeishuClient({ command })
    const result = await client.listRecords({ baseToken: 'base-test', tableId: 'tbl-test' })
    assert.deepEqual(result, {
      records: [
        { recordId: 'rec-1', fields: { 'fld-company': '示例公司', 'fld-role': '后端工程师' } },
        { recordId: 'rec-2', fields: { 'fld-company': '另一家公司', 'fld-role': '前端工程师' } },
      ],
      hasMore: false,
    })
  })
})

test('keeps the legacy items and records list response shapes compatible', async () => {
  await withFakeCli({
    listData: {
      items: [{ record_id: 'rec-items', fields: { 'fld-company': '示例公司' } }],
      has_more: false,
    },
  }, async (command) => {
    const client = new LarkCliFeishuClient({ command })
    const result = await client.listRecords({ baseToken: 'base-test', tableId: 'tbl-test' })
    assert.deepEqual(result.records, [{ recordId: 'rec-items', fields: { 'fld-company': '示例公司' } }])
  })

  await withFakeCli({
    listData: {
      records: [{ id: 'rec-records', fields: { 'fld-role': '后端工程师' } }],
      hasMore: true,
      offset: 200,
    },
  }, async (command) => {
    const client = new LarkCliFeishuClient({ command })
    const result = await client.listRecords({ baseToken: 'base-test', tableId: 'tbl-test' })
    assert.deepEqual(result, {
      records: [{ recordId: 'rec-records', fields: { 'fld-role': '后端工程师' } }],
      hasMore: true,
      offset: 200,
    })
  })
})

test('recovers the created record id by uniquely matching identity fields', async () => {
  await withFakeCli({
    upsertData: { success: true },
    listData: {
      data: [['示例公司', '后端工程师', '[查看岗位](https://jobs.example.invalid/1)']],
      field_id_list: ['fld-company', 'fld-role', 'fld-url'],
      record_id_list: ['rec-created'],
      has_more: false,
    },
  }, async (command) => {
    const client = new LarkCliFeishuClient({ command })
    const result = await client.createRecord({
      baseToken: 'base-test',
      tableId: 'tbl-test',
      fields: {
        'fld-company': '示例公司',
        'fld-role': '后端工程师',
        'fld-url': 'https://jobs.example.invalid/1',
      },
      identityFieldIds: ['fld-url'],
    })
    assert.deepEqual(result, { recordId: 'rec-created' })
  })
})

test('fails closed when created record identity is ambiguous', async () => {
  await withFakeCli({
    upsertData: { success: true },
    listData: {
      data: [
        ['示例公司', '后端工程师'],
        ['示例公司', '后端工程师'],
      ],
      field_id_list: ['fld-company', 'fld-role'],
      record_id_list: ['rec-a', 'rec-b'],
      has_more: false,
    },
  }, async (command) => {
    const client = new LarkCliFeishuClient({ command })
    await assert.rejects(
      () => client.createRecord({
        baseToken: 'base-test',
        tableId: 'tbl-test',
        fields: { 'fld-company': '示例公司', 'fld-role': '后端工程师' },
        identityFieldIds: ['fld-company', 'fld-role'],
      }),
      /feishu_write_record_ambiguous/u,
    )
  })
})

test('fails closed when created record cannot be found after upsert', async () => {
  await withFakeCli({
    upsertData: { success: true },
    listData: {
      data: [],
      field_id_list: ['fld-url'],
      record_id_list: [],
      has_more: false,
    },
  }, async (command) => {
    const client = new LarkCliFeishuClient({ command })
    await assert.rejects(
      () => client.createRecord({
        baseToken: 'base-test',
        tableId: 'tbl-test',
        fields: { 'fld-url': 'https://jobs.example.invalid/missing' },
        identityFieldIds: ['fld-url'],
      }),
      /feishu_write_record_not_found_after_create/u,
    )
  })
})
