import assert from 'node:assert/strict'
import test from 'node:test'
import type { ServerResponse } from 'node:http'
import type { LocalCandidateBoardService } from '../src/candidate-board.ts'
import {
  BOSS_WATCH_DASHBOARD_PATH,
  handleBossWatchDashboardRequest,
  registerBossWatchDashboardRoute,
} from '../src/dashboard-route.ts'
import type { LocalWorkspaceOverviewService } from '../src/workspace-overview.ts'

const overview = {
  phase: 'match_ready',
  databaseReady: true,
  readOnly: true,
  externalNetworkAccess: false,
  bossSearchGuard: {
    state: 'ready', guarded: false, observedAt: '2026-08-19T03:00:00.000Z', scope: 'controller_process', resetsOnRestart: true,
  },
  counts: { resumeVersions: 1, jobLeads: 2, sourceOnlyLeads: 1, verifiedLeads: 1, capturedJobs: 1, resumeMatches: 1, gateAApprovals: 0, feishuTargets: 1 },
  sourceChannels: [],
  checkpoints: [],
  recommendedActions: [],
} as const

const candidates = [{
  candidateId: 'application:fixture',
  recordKind: 'captured_job',
  sourceKind: 'boss_visible',
  company: '虚构云图科技',
  role: 'AI 应用工程师',
  capturedAt: '2026-08-19T02:00:00.000Z',
  confidence: 'captured_jd',
  jdStatus: 'complete',
  resumeReady: true,
  progressState: 'new',
  nextAction: 'match_resume',
  nextTool: 'boss_watch_resume_match',
}] as const

test('serves a bounded read-only dashboard snapshot through the DSH host route', async () => {
  let registeredPath = ''
  let handler: ((request: { method?: string }, response: ServerResponse) => void | Promise<void>) | undefined
  const dispose = registerBossWatchDashboardRoute({
    register(route) {
      registeredPath = route.path
      handler = route.handler as typeof handler
      return () => { registeredPath = '' }
    },
  }, {
    workspaceOverview: { async inspect() { return overview } } as unknown as LocalWorkspaceOverviewService,
    candidateBoard: { async list(options) {
      assert.deepEqual(options, { limit: 100 })
      return candidates
    } } as unknown as LocalCandidateBoardService,
    now: () => new Date('2026-08-19T04:00:00.000Z'),
  })

  assert.equal(registeredPath, BOSS_WATCH_DASHBOARD_PATH)
  assert.ok(handler)
  const response = captureResponse()
  await handler({ method: 'GET' }, response.value)
  assert.equal(response.status(), 200)
  assert.equal(response.headers()['cache-control'], 'no-store')
  assert.deepEqual(response.body(), {
    status: 'ok',
    generatedAt: '2026-08-19T04:00:00.000Z',
    readOnly: true,
    overview,
    candidates,
    count: 1,
  })
  dispose()
  assert.equal(registeredPath, '')
})

test('rejects non-GET dashboard requests without reading facts', async () => {
  let reads = 0
  const response = captureResponse()
  await handleBossWatchDashboardRequest({ method: 'POST' }, response.value, {
    workspaceOverview: { async inspect() { reads += 1; return overview } } as unknown as LocalWorkspaceOverviewService,
  })
  assert.equal(reads, 0)
  assert.equal(response.status(), 405)
  assert.equal(response.headers().allow, 'GET')
  assert.deepEqual(response.body(), { error: { code: 'method_not_allowed' } })
})

function captureResponse(): {
  readonly value: ServerResponse
  readonly status: () => number | undefined
  readonly headers: () => Record<string, string>
  readonly body: () => unknown
} {
  let status: number | undefined
  let headers: Record<string, string> = {}
  let body = ''
  const value = {
    writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
      status = nextStatus
      headers = nextHeaders
      return this
    },
    end(chunk?: string) {
      body = chunk ?? ''
      return this
    },
  } as unknown as ServerResponse
  return {
    value,
    status: () => status,
    headers: () => headers,
    body: () => JSON.parse(body) as unknown,
  }
}
