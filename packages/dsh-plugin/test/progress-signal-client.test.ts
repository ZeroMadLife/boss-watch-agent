import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalProgressSignalClient } from '../src/progress-signal-client.ts'

test('uses the local service token for progress-signal preview and apply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-watch-progress-client-'))
  const tokenPath = join(directory, 'dsh-service-token')
  const token = 'service-token-progress-client-1234567890'
  await writeFile(tokenPath, token, 'utf8')
  const requests: Array<{ path: string; authorization: string | undefined; body: string }> = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    requests.push({ path: request.url ?? '', authorization: request.headers.authorization, body })
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url?.endsWith('/preview')) {
      response.end(JSON.stringify({
        previewToken: 'progress-signal-preview:fixture',
        applicationId: 'application-001',
        sourceKind: 'recruitment_email',
        sourceMode: 'pasted_text',
        outcome: 'rejected',
        classifierVersion: 'progress-signal-rules-v1',
        confidence: 0.91,
        reasonCodes: ['rejection_regret'],
        proposedStatus: 'rejected',
        contentHash: 'a'.repeat(64),
        sourceHash: 'a'.repeat(64),
        contentLength: 20,
        observedAt: '2026-08-18T03:00:00.000Z',
        expiresAt: '2026-08-18T03:15:00.000Z',
        requiresConfirmation: true,
      }))
      return
    }
    response.end(JSON.stringify({
      applicationId: 'application-001',
      signalEventId: 'event-signal-001',
      proposalEventId: 'event-proposal-001',
      artifactId: 'artifact-signal-001',
      artifactRef: 'local-artifact://application/artifact-signal-001',
      contentHash: 'a'.repeat(64),
      savedAt: '2026-08-18T03:00:00.000Z',
      outcome: 'rejected',
      proposedStatus: 'rejected',
      deduplicated: false,
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing_server_address')

  try {
    const client = new LocalProgressSignalClient(`http://127.0.0.1:${address.port}`, tokenPath)
    assert.equal((await client.preview({
      applicationId: 'application-001',
      sourceKind: 'recruitment_email',
      content: 'fixture rejection notice',
    })).requiresConfirmation, true)
    assert.equal((await client.apply('progress-signal-preview:fixture', true)).deduplicated, false)
    assert.deepEqual(requests, [
      {
        path: '/api/v1/progress-signals/preview',
        authorization: `Bearer ${token}`,
        body: JSON.stringify({
          applicationId: 'application-001',
          sourceKind: 'recruitment_email',
          content: 'fixture rejection notice',
        }),
      },
      {
        path: '/api/v1/progress-signals/apply',
        authorization: `Bearer ${token}`,
        body: JSON.stringify({ previewToken: 'progress-signal-preview:fixture', confirmed: true }),
      },
    ])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    await rm(directory, { recursive: true, force: true })
  }
})
