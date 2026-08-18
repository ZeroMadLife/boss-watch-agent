import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildProgressSignalImportDraft,
  ProgressSignalUploadClient,
  type ProgressSignalUploadFile,
  type ProgressSignalUploadResult,
} from '../src/client/progress-signal-upload-client.ts'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function file(name: string, bytes = new Uint8Array([1, 2, 3])): ProgressSignalUploadFile {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  }
}

test('stages an email through a short-lived local upload session', async () => {
  const responses = [
    response({ token: 'session-token-1234567890', expiresAt: '2030-01-01T00:10:00.000Z', maxBytes: 20 }),
    response({
      status: 'ok',
      fileName: `dsh-${'a'.repeat(64)}-notice.eml`,
      displayName: 'notice',
      mediaType: 'message/rfc822',
      byteSize: 3,
      contentHash: 'a'.repeat(64),
      requiresPreview: true,
    }, 201),
  ]
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push([input, init])
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected_fetch')
    return next
  }
  const client = new ProgressSignalUploadClient({
    apiOrigin: 'http://127.0.0.1:4318/',
    fetchImpl,
    now: () => Date.parse('2030-01-01T00:01:00.000Z'),
  })

  assert.equal((await client.upload(file('notice.eml'))).mediaType, 'message/rfc822')
  assert.equal(calls[0]?.[0], 'http://127.0.0.1:4318/api/v1/progress-signals/upload-session')
  assert.equal(calls[1]?.[0], 'http://127.0.0.1:4318/api/v1/progress-signals/upload')
  assert.deepEqual((calls[1]?.[1] as RequestInit).headers, {
    authorization: 'Bearer session-token-1234567890',
    'x-boss-watch-file-name': encodeURIComponent('notice.eml'),
    'content-type': 'application/octet-stream',
  })
})

test('builds a preview-only draft without exposing the staged email body', () => {
  const result: ProgressSignalUploadResult = {
    status: 'ok',
    fileName: `dsh-${'a'.repeat(64)}-notice.eml`,
    displayName: 'notice',
    mediaType: 'message/rfc822',
    byteSize: 42,
    contentHash: 'a'.repeat(64),
    requiresPreview: true,
  }

  const request = buildProgressSignalImportDraft('', result)
  assert.match(request, /不可信文件元数据/u)
  assert.match(request, /boss_watch_progress_signal_preview/u)
  assert.match(request, /先核对它对应的本地 applicationId/u)
  assert.equal(buildProgressSignalImportDraft('保留原草稿', result), `保留原草稿\n\n${request}`)
})
