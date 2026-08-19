const CITY_CODES: Readonly<Record<string, string>> = {
  北京: "101010100",
  上海: "101020100",
  深圳: "101280600",
  广州: "101280100",
  杭州: "101210100",
  成都: "101270100",
  武汉: "101200100",
  南京: "101190100",
  西安: "101110100",
  苏州: "101190400",
  天津: "101030100",
  重庆: "101040100",
  郑州: "101180100",
  长沙: "101250100",
  东莞: "101281600",
  佛山: "101280800",
  合肥: "101220100",
  厦门: "101230200",
  青岛: "101120200",
  大连: "101070200",
};

export const MAX_BOSS_SEARCH_PAGES = 2;
export const MAX_BOSS_SEARCH_JOBS = 5;

export interface BrowserJobSearchInput {
  readonly keyword: string;
  readonly city: string;
  readonly maxPages?: number;
  readonly maxJobs?: number;
}

export interface BrowserJobSearchPlan extends Required<Omit<BrowserJobSearchInput, "maxPages" | "maxJobs">> {
  readonly maxPages: number;
  readonly maxJobs: number;
}

export type BrowserJobSearchItem = {
  readonly job: import("./browser-run-controller.js").BrowserJobSummary;
  readonly status: "captured" | "failed";
  readonly applicationId?: string;
  readonly reason?: string;
};

export type BrowserJobSearchResult =
  | {
      readonly status: "ok" | "partial" | "cancelled";
      readonly plan: BrowserJobSearchPlan;
      readonly pagesVisited: number;
      readonly items: readonly BrowserJobSearchItem[];
    }
  | {
      readonly status: "invalid_request";
      readonly reason:
        | "invalid_boss_search_keyword"
        | "unsupported_boss_search_city"
        | "invalid_boss_search_pages"
        | "invalid_boss_search_jobs";
      readonly targetCount: 0;
    }
  | {
      readonly status: "no_supported_tab";
      readonly reason: "no_boss_page" | "no_job_cards" | "no_job_list";
      readonly targetCount: 0 | 1;
      readonly plan: BrowserJobSearchPlan;
      readonly pagesVisited: number;
      readonly items: readonly BrowserJobSearchItem[];
    }
  | {
      readonly status: "target_ambiguous";
      readonly reason: "multiple_boss_tabs";
      readonly targetCount: number;
      readonly plan: BrowserJobSearchPlan;
      readonly pagesVisited: number;
      readonly items: readonly BrowserJobSearchItem[];
    }
  | {
      readonly status: "human_required";
      readonly reason: "login" | "verification";
      readonly targetCount: number;
      readonly plan: BrowserJobSearchPlan;
      readonly pagesVisited: number;
      readonly items: readonly BrowserJobSearchItem[];
    }
  | {
      readonly status: "environment_interrupted";
      readonly reason: "runtime_unavailable" | "browser_disconnected";
      readonly targetCount: 0;
      readonly plan: BrowserJobSearchPlan;
      readonly pagesVisited: number;
      readonly items: readonly BrowserJobSearchItem[];
    };

export function createBrowserJobSearchPlan(input: BrowserJobSearchInput): BrowserJobSearchPlan {
  const keyword = input.keyword.trim();
  const city = input.city.trim();
  if (keyword.length === 0 || keyword.length > 80) throw new Error("invalid_boss_search_keyword");
  if (city.length === 0 || CITY_CODES[city] === undefined) throw new Error("unsupported_boss_search_city");
  const maxPages = input.maxPages ?? 1;
  const maxJobs = input.maxJobs ?? MAX_BOSS_SEARCH_JOBS;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_BOSS_SEARCH_PAGES) {
    throw new Error("invalid_boss_search_pages");
  }
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_BOSS_SEARCH_JOBS) {
    throw new Error("invalid_boss_search_jobs");
  }
  return { keyword, city, maxPages, maxJobs };
}

export function bossSearchUrl(plan: BrowserJobSearchPlan, page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > plan.maxPages)
    throw new Error("invalid_boss_search_page");
  const url = new URL("https://www.zhipin.com/web/geek/job");
  url.searchParams.set("query", plan.keyword);
  url.searchParams.set("city", CITY_CODES[plan.city] as string);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

export function isBossSearchUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.zhipin.com" && url.pathname === "/web/geek/job";
  } catch {
    return false;
  }
}
