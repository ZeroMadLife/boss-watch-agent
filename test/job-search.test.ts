import { describe, expect, it } from "vitest";
import { bossSearchUrl, createBrowserJobSearchPlan, isBossSearchUrl } from "../src/browser/job-search.js";

describe("BOSS search URL compatibility", () => {
  it("accepts the current plural search route after BOSS redirects the legacy route", () => {
    expect(isBossSearchUrl("https://www.zhipin.com/web/geek/job?query=agent")).toBe(true);
    expect(isBossSearchUrl("https://www.zhipin.com/web/geek/jobs?query=agent&city=101020100")).toBe(true);
    expect(isBossSearchUrl("https://www.zhipin.com/web/geek/job-list?query=agent")).toBe(false);
    expect(isBossSearchUrl("https://example.test/web/geek/jobs?query=agent")).toBe(false);
  });

  it("generates the current bounded search entry URL", () => {
    const plan = createBrowserJobSearchPlan({ keyword: "agent", city: "上海" });
    expect(bossSearchUrl(plan, 1)).toBe("https://www.zhipin.com/web/geek/jobs?query=agent&city=101020100");
  });
});
