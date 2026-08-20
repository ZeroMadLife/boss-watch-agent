import { randomUUID } from 'node:crypto'
import type {
  BrowserJobSearchInput,
  BrowserJobSearchResult,
  BossWatchBrowserController,
} from './domain.ts'

const PREVIEW_TTL_MS = 10 * 60 * 1000

export interface BossJobSearchPreview {
  readonly previewToken: string
  readonly expiresAt: string
  readonly plan: Required<BrowserJobSearchInput>
  readonly constraints: readonly string[]
}

export class LocalBossJobSearchService {
  readonly #browser: BossWatchBrowserController
  readonly #now: () => Date
  readonly #tokenFactory: () => string
  readonly #previews = new Map<string, { plan: Required<BrowserJobSearchInput>; expiresAt: number }>()

  constructor(options: {
    browser: BossWatchBrowserController
    now?: () => Date
    tokenFactory?: () => string
  }) {
    this.#browser = options.browser
    this.#now = options.now ?? (() => new Date())
    this.#tokenFactory = options.tokenFactory ?? (() => `boss-search-preview:${randomUUID()}`)
  }

  preview(input: BrowserJobSearchInput): BossJobSearchPreview {
    const plan = normalizePlan(input)
    const expiresAt = this.#now().getTime() + PREVIEW_TTL_MS
    const previewToken = this.#tokenFactory()
    this.#previews.set(previewToken, { plan, expiresAt })
    return {
      previewToken,
      expiresAt: new Date(expiresAt).toISOString(),
      plan,
      constraints: [
        '最多 2 页、最多 5 个岗位',
        '按岗位 externalJobId 去重，详情页串行打开',
        '同一搜索任务互斥；导航间隔、运行冷却和风险冷却由本地 Controller 执行',
        '登录、验证码、风控或浏览器断连立即交还人工',
        '不会发送消息、投递简历或写入飞书',
      ],
    }
  }

  async run(previewToken: string, confirmed: boolean): Promise<BrowserJobSearchResult> {
    if (!confirmed) throw new Error('confirmation_required')
    const preview = this.#previews.get(previewToken)
    if (preview === undefined || this.#now().getTime() >= preview.expiresAt) {
      this.#previews.delete(previewToken)
      throw new Error('search_preview_expired')
    }
    this.#previews.delete(previewToken)
    return this.#browser.searchJobs(preview.plan)
  }
}

function normalizePlan(input: BrowserJobSearchInput): Required<BrowserJobSearchInput> {
  const keyword = input.keyword.trim()
  const city = input.city.trim()
  const maxPages = input.maxPages ?? 1
  const maxJobs = input.maxJobs ?? 5
  const cities = new Set([
    '北京', '上海', '深圳', '广州', '杭州', '成都', '武汉', '南京', '西安', '苏州', '天津',
    '重庆', '郑州', '长沙', '东莞', '佛山', '合肥', '厦门', '青岛', '大连',
  ])
  if (keyword.length === 0 || keyword.length > 80) throw new Error('invalid_boss_search_keyword')
  if (!cities.has(city)) throw new Error('unsupported_boss_search_city')
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 2) throw new Error('invalid_boss_search_pages')
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 5) throw new Error('invalid_boss_search_jobs')
  return { keyword, city, maxPages, maxJobs }
}
