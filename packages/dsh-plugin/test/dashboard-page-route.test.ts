import assert from 'node:assert/strict'
import test from 'node:test'
import type { ServerResponse } from 'node:http'
import {
  BOSS_WATCH_DASHBOARD_PAGE_PATH,
  handleBossWatchDashboardPageRequest,
  registerBossWatchDashboardPageRoute,
} from '../src/dashboard-page-route.ts'

test('registers the standalone workbench at a dedicated same-origin page', () => {
  let path = ''
  const dispose = registerBossWatchDashboardPageRoute({
    register(route) {
      path = route.path
      assert.equal(route.kind, 'exact')
      return () => { path = '' }
    },
  })
  assert.equal(path, BOSS_WATCH_DASHBOARD_PAGE_PATH)
  dispose()
  assert.equal(path, '')
})

test('serves a user-facing personal job board without interpolating job facts', () => {
  const response = captureResponse()
  handleBossWatchDashboardPageRequest({ method: 'GET' }, response.value)
  const visibleMarkup = response.body().slice(response.body().indexOf('<body>'), response.body().indexOf('<script>'))
  assert.equal(response.status(), 200)
  assert.equal(response.headers()['content-type'], 'text/html; charset=utf-8')
  assert.equal(response.headers()['cache-control'], 'no-store')
  assert.match(visibleMarkup, /求职看板/u)
  assert.match(visibleMarkup, /岗位池/u)
  assert.match(response.body(), /\/boss-watch\/api\/v1\/dashboard/u)
  assert.match(visibleMarkup, /id="match-filter"/u)
  assert.match(visibleMarkup, /id="company-category-filter"/u)
  assert.match(visibleMarkup, /id="role-direction-filter"/u)
  assert.match(visibleMarkup, /公司 \/ 岗位/u)
  assert.match(visibleMarkup, /值得投吗/u)
  assert.match(visibleMarkup, /截止日期/u)
  assert.match(visibleMarkup, /进度/u)
  assert.match(visibleMarkup, /入口 \/ 下一步/u)
  assert.match(response.body(), /岗位分页/u)
  assert.match(response.body(), /匹配度/u)
  assert.match(response.body(), /<option value="other_or_unclassified">其他<\/option>/u)
  assert.match(response.body(), /function appendMeaningfulProfileBadges/u)
  assert.match(response.body(), /'Backend Engineering': '后端开发'/u)
  assert.match(response.body(), /'API Integration': '接口集成'/u)
  assert.match(response.body(), /profile\.companyCategory !== 'other' && profile\.companyCategory !== 'unclassified'/u)
  assert.match(response.body(), /profile\.roleDirection !== 'other' && profile\.roleDirection !== 'unclassified'/u)
  assert.match(response.body(), /latestMatch/u)
  assert.match(response.body(), /confirmedStatus/u)
  assert.match(response.body(), /candidate\.timeline/u)
  assert.match(visibleMarkup, /系统记录/u)
  assert.match(visibleMarkup, /<details/u)
  assert.match(response.body(), /已投递/u)
  assert.match(response.body(), /PAGE_SIZE = 10/u)
  assert.match(response.body(), /上一页/u)
  assert.match(response.body(), /下一页/u)
  assert.match(response.body(), /textContent/u)
  assert.match(response.body(), /embedded/u)
  assert.match(response.body(), /清空筛选/u)
  assert.match(response.body(), /history\.replaceState/u)
  assert.match(response.body(), /popstate/u)
  assert.match(response.body(), /按最近更新/u)
  assert.match(response.body(), /按截止时间/u)
  assert.match(response.body(), /按匹配度/u)
  assert.match(response.body(), /sort: valid\(params\.get\('sort'\), VALID_SORTS, 'match'\)/u)
  assert.match(response.body(), /state\.sort = 'match'/u)
  assert.match(response.body(), /state\.sort !== 'match'/u)
  assert.match(response.body(), /const directions = new Set\(\)/u)
  assert.match(response.body(), /return directions\.size === 1 \? \[\.\.\.directions\]\[0\] : 'unclassified'/u)
  assert.match(response.body(), /值得投/u)
  assert.match(response.body(), /可考虑/u)
  assert.match(response.body(), /暂不优先/u)
  assert.match(response.body(), /匹配度高，可以优先考虑/u)
  assert.match(response.body(), /匹配度中等，先查看缺口/u)
  assert.match(response.body(), /匹配度较低，暂不优先/u)
  assert.match(response.body(), /准备投递/u)
  assert.match(response.body(), /打开投递入口/u)
  assert.match(response.body(), /boss-watch:dashboard-draft/u)
  assert.match(response.body(), /重新读取/u)
  assert.match(response.body(), /打开投递入口/u)
  assert.match(response.body(), /skip-link/u)
  assert.doesNotMatch(visibleMarkup, /候选|只读派生|当前可见事实|contract|projection|source_only|evidence kind|Agent 建议|JOB BOARD|个人求职作战看板/u)
  assert.doesNotMatch(response.body(), /开始自动投递|一键自动投递/u)
})

test('serves ten-item pagination for the full job board and normalizes its query page', () => {
  const response = captureResponse()
  handleBossWatchDashboardPageRequest({ method: 'GET' }, response.value)

  assert.match(response.body(), /aria-label="岗位分页"/u)
  assert.match(response.body(), /id="page-prev"/u)
  assert.match(response.body(), /id="page-status"/u)
  assert.match(response.body(), /id="page-next"/u)
  assert.match(response.body(), /pageRows = rows\.slice\(\(page - 1\) \* PAGE_SIZE, page \* PAGE_SIZE\)/u)
  assert.match(response.body(), /function boardPool\(\).*state\.snapshot\?\.candidates/u)
  assert.match(response.body(), /Math\.min\(Math\.max\(requestedPage, 1\), totalPages\)/u)
  assert.match(response.body(), /pageIsValid && rawPageValue !== null \? rawPage : 1/u)
  assert.match(response.body(), /!pageIsValid \|\| params\.get\('view'\) !== 'jobs'/u)
  assert.match(response.body(), /state\.pageNeedsNormalization = false/u)
  assert.match(response.body(), /renderJobs\(\); renderDetail\(\)/u)
})

test('offers first-screen match shortcuts, an inline empty-state recovery, and a complete mobile header', () => {
  const response = captureResponse()
  handleBossWatchDashboardPageRequest({ method: 'GET' }, response.value)

  assert.match(response.body(), /aria-label="岗位快速筛选"/u)
  assert.match(response.body(), /function metric\(label, value, match\)/u)
  assert.match(response.body(), /node\.setAttribute\('aria-pressed', String\(state\.match === match\)\)/u)
  assert.match(response.body(), /state\.match = match; restoreControls\(\); resetPageAndSelection\(\)/u)
  assert.match(response.body(), /metric\('全部岗位', rows\.length, 'all'\)/u)
  assert.match(response.body(), /metric\('值得投', recommended, 'strong'\)/u)
  assert.match(response.body(), /metric\('可考虑', review, 'moderate'\)/u)
  assert.match(response.body(), /metric\('待评估', pending, 'pending'\)/u)
  assert.match(response.body(), /id="jobs-empty-reset"/u)
  assert.match(response.body(), /显示全部岗位/u)
  assert.match(response.body(), /\$\('jobs-empty-reset'\)\.addEventListener\('click', clearFilters\)/u)
  assert.match(response.body(), /class="runtime-label"/u)
  assert.match(response.body(), /class="mobile-dsh-label"/u)
  assert.match(response.body(), /@media \(max-width: 430px\)[\s\S]*\.runtime-label \{ position: absolute/u)
  assert.doesNotMatch(response.body(), /\.header-actions \.button\.primary \{ display: none; \}/u)
})

test('offers a draft-only multi-select queue for jobs ready to prepare', () => {
  const response = captureResponse()
  handleBossWatchDashboardPageRequest({ method: 'GET' }, response.value)

  assert.match(response.body(), /aria-label="待投递选择"/u)
  assert.match(response.body(), /id="batch-toggle-page"/u)
  assert.match(response.body(), /选择本页可投岗位/u)
  assert.match(response.body(), /id="batch-clear"/u)
  assert.match(response.body(), /id="batch-prepare"/u)
  assert.match(response.body(), /加入待投递/u)
  assert.match(response.body(), /function queueAvailability\(candidate\)/u)
  assert.match(response.body(), /缺完整 JD/u)
  assert.match(response.body(), /待完成匹配/u)
  assert.match(response.body(), /待确认值得投/u)
  assert.match(response.body(), /缺投递入口/u)
  assert.match(response.body(), /candidate\.nextAction !== 'prepare_application'/u)
  assert.match(response.body(), /candidate\.gateA\.decision !== 'proceed'/u)
  assert.match(response.body(), /type = 'checkbox'/u)
  assert.match(response.body(), /delivery: 'draft_only', autoSubmit: false/u)
  assert.match(response.body(), /不要自动发送、导航、填表、上传、提交或写入飞书/u)
  assert.match(response.body(), /遇到登录、验证码或风控时立即停下/u)
  assert.match(response.body(), /event\.target === row/u)
  assert.doesNotMatch(response.body(), /autoSubmit: true|自动批量投递|自动提交申请/u)
})

test('rejects writes to the workbench document route', () => {
  const response = captureResponse()
  handleBossWatchDashboardPageRequest({ method: 'POST' }, response.value)
  assert.equal(response.status(), 405)
  assert.equal(response.headers().allow, 'GET')
})

function captureResponse(): {
  readonly value: ServerResponse
  readonly status: () => number | undefined
  readonly headers: () => Record<string, string>
  readonly body: () => string
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
  return { value, status: () => status, headers: () => headers, body: () => body }
}
