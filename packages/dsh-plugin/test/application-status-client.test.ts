import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalApplicationStatusClient } from '../src/application-status-client.ts'
import type { BossWatchDataSource } from '../src/domain.ts'
import { registerBossWatchTools } from '../src/tools.ts'

test('uses the loopback service token for application status preview and apply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-watch-status-client-'))
  const tokenPath = join(directory, 'dsh-service-token')
  const token = 'service-token-status-client-1234567890'
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
    response.writeHead(request.url?.endsWith('/preview') ? 200 : 201, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url?.endsWith('/preview') ? {
      previewToken: 'application-status-preview:fixture',
      applicationId: 'application-001',
      status: 'submitted',
      occurredAt: '2026-08-19T06:00:00.000Z',
      expiresAt: '2026-08-19T06:15:00.000Z',
      requiresConfirmation: true,
      externalAction: 'not_performed',
    } : {
      applicationId: 'application-001',
      eventId: 'event-status-001',
      status: 'submitted',
      recordedAt: '2026-08-19T06:00:00.000Z',
      deduplicated: false,
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing_server_address')

  try {
    const client = new LocalApplicationStatusClient(`http://127.0.0.1:${address.port}`, tokenPath)
    assert.equal((await client.preview({ applicationId: 'application-001', status: 'submitted' })).requiresConfirmation, true)
    assert.equal((await client.apply('application-status-preview:fixture', true)).deduplicated, false)
    assert.deepEqual(requests, [
      {
        path: '/api/v1/application-status/preview',
        authorization: `Bearer ${token}`,
        body: JSON.stringify({ applicationId: 'application-001', status: 'submitted' }),
      },
      {
        path: '/api/v1/application-status/apply',
        authorization: `Bearer ${token}`,
        body: JSON.stringify({ previewToken: 'application-status-preview:fixture', confirmed: true }),
      },
    ])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    await rm(directory, { recursive: true, force: true })
  }
})

test('fails with an explicit restart requirement before writing to a stale local API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-watch-status-stale-'))
  const tokenPath = join(directory, 'dsh-service-token')
  await writeFile(tokenPath, 'service-token-status-client-1234567890', 'utf8')
  let writeRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ service: 'ready', database: 'ready', version: '0.1.0' }))
      return
    }
    writeRequests += 1
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'unauthorized' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing_server_address')

  try {
    const client = new LocalApplicationStatusClient(`http://127.0.0.1:${address.port}`, tokenPath)
    await assert.rejects(
      () => client.preview({ applicationId: 'application-001', status: 'submitted' }),
      /controller_restart_required/u,
    )
    assert.equal(writeRequests, 0)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    await rm(directory, { recursive: true, force: true })
  }
})

test('exposes confirmed status recording as two explicit DSH tools', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const calls: unknown[] = []
  const client = {
    async preview(input: unknown) {
      calls.push({ kind: 'preview', input })
      return {
        previewToken: 'application-status-preview:fixture',
        applicationId: 'application-001',
        status: 'assessment_completed' as const,
        occurredAt: '2026-08-19T06:00:00.000Z',
        expiresAt: '2026-08-19T06:15:00.000Z',
        requiresConfirmation: true as const,
        externalAction: 'not_performed' as const,
      }
    },
    async apply(previewToken: string, confirmed: boolean) {
      calls.push({ kind: 'apply', previewToken, confirmed })
      return {
        applicationId: 'application-001',
        eventId: 'event-status-001',
        status: 'assessment_completed' as const,
        recordedAt: '2026-08-19T06:00:00.000Z',
        deduplicated: false,
      }
    },
  } as unknown as LocalApplicationStatusClient
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const register = registerBossWatchTools as unknown as (...args: unknown[]) => () => void
  const dispose = register(context, source, ...Array.from({ length: 27 }, () => undefined), client)

  try {
    const preview = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('application-status-preview'),
      name: 'boss_watch_application_status_preview',
      arguments: { applicationId: 'application-001', status: 'assessment_completed' },
    })
    assert.equal(preview.isError, false)
    assert.match(preview.content.map(block => block.type === 'text' ? block.text : '').join(''), /not_performed/u)

    const apply = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('application-status-apply'),
      name: 'boss_watch_application_status_apply',
      arguments: { previewToken: 'application-status-preview:fixture', confirmed: true },
    })
    assert.equal(apply.isError, false)
    assert.deepEqual(calls, [
      { kind: 'preview', input: { applicationId: 'application-001', status: 'assessment_completed' } },
      { kind: 'apply', previewToken: 'application-status-preview:fixture', confirmed: true },
    ])
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})
