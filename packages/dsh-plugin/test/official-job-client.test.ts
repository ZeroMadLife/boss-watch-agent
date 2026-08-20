import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalOfficialJobCaptureClient } from '../src/official-job-client.ts'

test('sends confirmed official JD evidence only to the authenticated loopback capture endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-watch-official-job-client-'))
  const tokenPath = join(directory, 'dsh-service-token')
  const token = 'service-token-official-job-client-1234567890'
  await writeFile(tokenPath, token, 'utf8')
  const requests: Array<{ path: string; authorization: string | undefined; body: string }> = []
  const server = createServer(async (request, response) => {
    if (request.url === '/api/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        service: 'ready',
        database: 'ready',
        runtimeMode: 'baseline_ready',
        version: '0.1.0',
        apiContractVersion: '2026-08-19.closed-loop-v1',
        buildIdentity: 'boss-watch-agent@0.1.0+api-2026-08-19.closed-loop-v1',
        startedAt: '2026-08-19T09:00:00.000Z',
      }))
      return
    }
    let body = ''
    for await (const chunk of request) body += String(chunk)
    requests.push({ path: request.url ?? '', authorization: request.headers.authorization, body })
    response.writeHead(201, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      applicationId: 'application-official-001',
      eventId: 'event-official-001',
      artifactId: 'artifact-official-001',
      artifactRef: 'local-artifact://application/artifact-official-001',
      contentHash: 'a'.repeat(64),
      savedAt: '2026-08-19T06:10:00.000Z',
      deduplicated: false,
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing_server_address')
  const input = {
    sourceId: `recruitment-source:${'b'.repeat(64)}`,
    company: '虚构星舟科技',
    role: 'Agent 平台工程师',
    officialJobUrl: 'https://careers.example.invalid/jobs/agent',
    jdText: '使用 TypeScript 构建 Agent 平台。',
    capturedAt: '2026-08-19T06:10:00.000Z',
  }

  try {
    const client = new LocalOfficialJobCaptureClient(`http://127.0.0.1:${address.port}`, tokenPath)
    assert.equal((await client.capture(input)).applicationId, 'application-official-001')
    assert.deepEqual(requests, [{
      path: '/api/v1/official-jds/capture',
      authorization: `Bearer ${token}`,
      body: JSON.stringify(input),
    }])
    assert.throws(() => new LocalOfficialJobCaptureClient('https://careers.example.invalid', tokenPath), /boss_watch_api_must_be_loopback_http/u)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    await rm(directory, { recursive: true, force: true })
  }
})
