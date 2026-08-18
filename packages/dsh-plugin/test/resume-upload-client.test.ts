import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildResumeImportDraft,
  ResumeUploadClient,
  type ResumeUploadFile,
  type ResumeUploadResult,
} from '../src/client/resume-upload-client.ts'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function file(name: string, bytes = new Uint8Array([1, 2, 3])): ResumeUploadFile {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  }
}

test('reuses a short-lived resume upload session and preserves staged metadata', async () => {
  const responses = [
    response({ token: 'session-token-1234567890', expiresAt: '2030-01-01T00:10:00.000Z', maxBytes: 20 }),
    response({
      status: 'ok',
      fileName: 'dsh-abc-resume.pdf',
      displayName: 'resume',
      mediaType: 'application/pdf',
      byteSize: 3,
      contentHash: 'a'.repeat(64),
      requiresPreview: true,
    }, 201),
    response({
      status: 'ok',
      fileName: 'dsh-def-resume.docx',
      displayName: 'resume',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteSize: 3,
      contentHash: 'b'.repeat(64),
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
  const client = new ResumeUploadClient({
    apiOrigin: 'http://127.0.0.1:4318/',
    fetchImpl,
    now: () => Date.parse('2030-01-01T00:01:00.000Z'),
  })

  assert.equal((await client.upload(file('示例候选人.pdf'))).mediaType, 'application/pdf')
  assert.equal(
    (await client.upload(file('示例候选人.docx'))).mediaType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
  assert.equal(calls.length, 3)
  assert.equal(calls[1]?.[0], 'http://127.0.0.1:4318/api/v1/resumes/upload')
  assert.deepEqual((calls[1]?.[1] as RequestInit).headers, {
    'x-boss-watch-file-name': encodeURIComponent('示例候选人.pdf'),
    authorization: 'Bearer session-token-1234567890',
    'content-type': 'application/octet-stream',
  })
})

test('does not upload a resume that exceeds the server-advertised limit', async () => {
  let callCount = 0
  const fetchImpl: typeof fetch = async () => {
    callCount += 1
    return response({ token: 'session-token-1234567890', expiresAt: '2030-01-01T00:10:00.000Z', maxBytes: 2 })
  }
  const client = new ResumeUploadClient({ fetchImpl, now: () => Date.parse('2030-01-01T00:01:00.000Z') })

  await assert.rejects(() => client.upload(file('resume.pdf')), /resume_file_too_large/u)
  assert.equal(callCount, 1)
})

test('appends an untrusted-metadata preview request without replacing the user draft', () => {
  const result: ResumeUploadResult = {
    status: 'ok',
    fileName: 'dsh-hash-resume.pdf',
    displayName: 'resume',
    mediaType: 'application/pdf',
    byteSize: 42,
    contentHash: 'a'.repeat(64),
    requiresPreview: true,
  }

  const request = buildResumeImportDraft('', result)
  assert.match(request, /不可信文件元数据/u)
  assert.match(request, /boss_watch_resume_import_preview/u)
  assert.match(request, /dsh-hash-resume\.pdf/u)

  assert.equal(buildResumeImportDraft('保留我的原草稿', result), `保留我的原草稿\n\n${request}`)
})
