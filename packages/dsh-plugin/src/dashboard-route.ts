import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { LocalCandidateBoardService } from './candidate-board.js'
import type { CandidateProfileSummary } from './candidate-profile.js'
import type { BossWatchDashboardSnapshot, DashboardResumeCenter } from './dashboard-contract.js'
import type { ResumeMatchStore } from './resume-matching.js'
import type { ResumeVersionStore } from './resume-version.js'
import type { LocalWorkspaceOverviewService } from './workspace-overview.js'
import { deriveTodayRecommendations } from './today-recommendations.js'

export const BOSS_WATCH_DASHBOARD_PATH = '/boss-watch/api/v1/dashboard'
const DASHBOARD_LIMIT = 100
const DASHBOARD_RESUME_LIMIT = 20
const DASHBOARD_MATCH_LIMIT = 100
const CANDIDATE_PROFILE_FIELD_COUNT = 5

interface DashboardRouteOptions {
  readonly workspaceOverview: LocalWorkspaceOverviewService
  readonly candidateBoard?: LocalCandidateBoardService
  readonly resumeVersions?: Pick<ResumeVersionStore, 'list'>
  readonly resumeMatches?: Pick<ResumeMatchStore, 'list'>
  readonly candidateProfile?: { readonly getSummary: () => CandidateProfileSummary | undefined }
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
    const resumeCenter = buildResumeCenter(options)
    const generatedAt = (options.now ?? (() => new Date()))()
    const snapshot: BossWatchDashboardSnapshot = {
      status: 'ok',
      generatedAt: generatedAt.toISOString(),
      readOnly: true,
      overview,
      candidates,
      todayRecommendations: deriveTodayRecommendations(candidates, { limit: 5, now: generatedAt }),
      resumeCenter,
      count: candidates.length,
    }
    writeJson(response, 200, snapshot)
  } catch {
    writeJson(response, 503, { error: { code: 'dashboard_source_unavailable' } })
  }
}

function buildResumeCenter(options: DashboardRouteOptions): DashboardResumeCenter {
  const versions = options.resumeVersions?.list({ limit: DASHBOARD_RESUME_LIMIT }) ?? []
  const matches = options.resumeMatches?.list({ limit: DASHBOARD_MATCH_LIMIT }) ?? []
  const matchedApplications = new Map<string, Set<string>>()
  for (const match of matches) {
    const applications = matchedApplications.get(match.resume.resumeVersionId) ?? new Set<string>()
    applications.add(match.applicationId)
    matchedApplications.set(match.resume.resumeVersionId, applications)
  }
  const profile = options.candidateProfile?.getSummary()
  return {
    versions: versions.map((version, index) => {
      const matchedJobCount = matchedApplications.get(version.resumeVersionId)?.size ?? 0
      return {
        resumeVersionId: version.resumeVersionId,
        current: index === 0,
        mediaType: version.mediaType,
        byteSize: version.byteSize,
        createdAt: version.createdAt,
        parseStatus: matchedJobCount > 0 ? 'parsed_for_matching' : 'not_yet_parsed_for_matching',
        matchedJobCount,
        matchedJobCountLimited: matches.length === DASHBOARD_MATCH_LIMIT,
      }
    }),
    count: versions.length,
    candidateProfile: profile === undefined
      ? { configured: false, availableFieldCount: 0, totalFieldCount: CANDIDATE_PROFILE_FIELD_COUNT, valuesReturned: false }
      : {
          configured: true,
          availableFieldCount: profile.availableFields.length,
          totalFieldCount: CANDIDATE_PROFILE_FIELD_COUNT,
          valuesReturned: false,
          updatedAt: profile.updatedAt,
        },
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
