import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalBossWatchBrowserController } from '../src/browser-controller-client.ts'

test('calls the local Browser Controller with the service token and preserves handoff state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-watch-controller-client-'))
  const tokenPath = join(directory, 'dsh-service-token')
  const token = 'service-token-client-fixture-1234567890'
  await writeFile(tokenPath, token, 'utf8')
  const requests: Array<{ path: string; authorization: string | undefined; origin: string | undefined }> = []
  const server = createServer((request, response) => {
    requests.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      origin: request.headers.origin,
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'human_required', reason: 'verification', targetCount: 1 }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing_server_address')

  try {
    const client = new LocalBossWatchBrowserController(`http://127.0.0.1:${address.port}`, tokenPath)
    assert.deepEqual(await client.status(), {
      status: 'human_required',
      reason: 'verification',
      targetCount: 1,
    })
    assert.deepEqual(requests, [{
      path: '/api/v1/browser/status',
      authorization: `Bearer ${token}`,
      origin: undefined,
    }])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    await rm(directory, { recursive: true, force: true })
  }
})

test('reads the process-local BOSS search guard without starting a search', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-watch-controller-guard-'))
  const tokenPath = join(directory, 'dsh-service-token')
  const token = 'service-token-guard-fixture-1234567890'
  await writeFile(tokenPath, token, 'utf8')
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      state: 'search_cooldown',
      guarded: true,
      retryAfterMs: 12_000,
      observedAt: '2026-08-19T03:00:00.000Z',
      scope: 'controller_process',
      resetsOnRestart: true,
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing_server_address')

  try {
    const client = new LocalBossWatchBrowserController(`http://127.0.0.1:${address.port}`, tokenPath)
    assert.deepEqual(await client.searchGuardStatus(), {
      state: 'search_cooldown',
      guarded: true,
      retryAfterMs: 12_000,
      observedAt: '2026-08-19T03:00:00.000Z',
      scope: 'controller_process',
      resetsOnRestart: true,
    })
    assert.deepEqual(requests, ['/api/v1/browser/jobs/search/status'])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    await rm(directory, { recursive: true, force: true })
  }
})

test('uses the bounded discovery and discovered-capture endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-watch-controller-discovery-'))
  const tokenPath = join(directory, 'dsh-service-token')
  const token = 'service-token-discovery-fixture-123456'
  await writeFile(tokenPath, token, 'utf8')
  const requests: Array<{ path: string; method: string | undefined; body: string }> = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    requests.push({ path: request.url ?? '', method: request.method, body })
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url === '/api/v1/browser/jobs/discover') {
      response.end(JSON.stringify({
        status: 'ready',
        discoveryId: 'discovery-client-001',
        targetCount: 1,
        target: { pageKind: 'job_list', url: 'https://www.zhipin.com/web/geek/job' },
        jobs: [{
          externalJobId: 'fixture-client-001',
          role: 'Agent 工程师',
          jobUrl: 'https://www.zhipin.com/job_detail/fixture-client-001.html',
        }],
      }))
      return
    }
    if (request.url === '/api/v1/browser/forms/inspect') {
      response.end(JSON.stringify({ status: 'human_required', reason: 'verification', targetCount: 1 }))
      return
    }
    response.end(JSON.stringify({ status: 'invalid_request', reason: 'job_not_found', targetCount: 0 }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing_server_address')

  try {
    const client = new LocalBossWatchBrowserController(`http://127.0.0.1:${address.port}`, tokenPath)
    assert.equal((await client.discoverJobs()).status, 'ready')
    assert.deepEqual(await client.captureDiscoveredJob('discovery-client-001', 'fixture-client-001'), {
      status: 'invalid_request',
      reason: 'job_not_found',
      targetCount: 0,
    })
    assert.deepEqual(await client.captureCurrentConversation('application-client-001'), {
      status: 'invalid_request',
      reason: 'job_not_found',
      targetCount: 0,
    })
    assert.deepEqual(await client.pollJob('application-client-001'), {
      status: 'invalid_request',
      reason: 'job_not_found',
      targetCount: 0,
    })
    assert.deepEqual(await client.inspectApplicationForm('https://careers.example.invalid/jobs/agent'), {
      status: 'human_required',
      reason: 'verification',
      targetCount: 1,
    })
    assert.deepEqual(requests, [
      { path: '/api/v1/browser/jobs/discover', method: 'GET', body: '' },
      {
        path: '/api/v1/browser/jobs/capture',
        method: 'POST',
        body: JSON.stringify({ discoveryId: 'discovery-client-001', externalJobId: 'fixture-client-001' }),
      },
      {
        path: '/api/v1/browser/captures/conversation',
        method: 'POST',
        body: JSON.stringify({ applicationId: 'application-client-001' }),
      },
      {
        path: '/api/v1/browser/jobs/poll',
        method: 'POST',
        body: JSON.stringify({ applicationId: 'application-client-001' }),
      },
      {
        path: '/api/v1/browser/forms/inspect',
        method: 'POST',
        body: JSON.stringify({ expectedUrl: 'https://careers.example.invalid/jobs/agent' }),
      },
    ])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    await rm(directory, { recursive: true, force: true })
  }
})
