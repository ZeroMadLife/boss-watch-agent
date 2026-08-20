import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { LocalCandidateBoardService } from './candidate-board.js'
import type { BossWatchDashboardSnapshot } from './dashboard-contract.js'
import type { LocalWorkspaceOverviewService } from './workspace-overview.js'

export const BOSS_WATCH_DASHBOARD_PATH = '/boss-watch/api/v1/dashboard'
const DASHBOARD_LIMIT = 100

interface DashboardRouteOptions {
  readonly workspaceOverview: LocalWorkspaceOverviewService
  readonly candidateBoard?: LocalCandidateBoardService
  readonly now?: () => Date
}

/** Register a same-origin, read-only summary route on the DSH Web host. */
export function registerBossWatchDashboardRoute(
  webServer: Pick<WebServer, 'register'>,
  options: DashboardRouteOptions,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: BOSS_WATCH_DASHBOARD_PATH,
    handler: (request, response) => handleBossWatchDashboardRequest(request, response, options),
  })
}

export async function handleBossWatchDashboardRequest(
  request: Pick<IncomingMessage, 'method'>,
  response: Pick<ServerResponse, 'writeHead' | 'end'>,
  options: DashboardRouteOptions,
): Promise<void> {
  if (request.method !== 'GET') {
    writeJson(response, 405, { error: { code: 'method_not_allowed' } }, { allow: 'GET' })
    return
  }
  try {
    const [overview, candidates] = await Promise.all([
      options.workspaceOverview.inspect(),
      options.candidateBoard?.list({ limit: DASHBOARD_LIMIT }) ?? Promise.resolve([]),
    ])
    const snapshot: BossWatchDashboardSnapshot = {
      status: 'ok',
      generatedAt: (options.now ?? (() => new Date()))().toISOString(),
      readOnly: true,
      overview,
      candidates,
      count: candidates.length,
    }
    writeJson(response, 200, snapshot)
  } catch {
    writeJson(response, 503, { error: { code: 'dashboard_source_unavailable' } })
  }
}

function writeJson(
  response: Pick<ServerResponse, 'writeHead' | 'end'>,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  response.end(JSON.stringify(body))
}
