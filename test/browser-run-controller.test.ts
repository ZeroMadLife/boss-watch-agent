import { describe, expect, it, vi } from "vitest";
import {
  BossBrowserRunController,
  type BossHunterBrowserRuntime,
} from "../src/browser/browser-run-controller.js";
import type { CaptureResult } from "../src/server/capture-api.js";

const jobUrl = "https://www.zhipin.com/job_detail/fixture-job-001.html";

function runtime(overrides: Partial<BossHunterBrowserRuntime> = {}): BossHunterBrowserRuntime {
  return {
    async health() {
      return { status: "ok", runtime: "bosshunter", connected: true };
    },
    async targets() {
      return [{ targetId: "target-1", type: "page", title: "虚构岗位", url: jobUrl }];
    },
    async evaluate() {
      return {
        status: "ready",
        sourceUrl: jobUrl,
        externalJobId: "fixture-job-001",
        company: "示例科技",
        role: "Agent 工程师",
        description: "负责构建可审计的 Agent 工作流。",
      };
    },
    async newTab() {
      return "target-new";
    },
    async close() {},
    ...overrides,
  };
}

describe("Boss Browser Run Controller", () => {
  it("reports an environment interruption when the BossHunter Runtime is unavailable", async () => {
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async health() {
          return undefined;
        },
      }),
      captureJob: vi.fn(),
    });

    await expect(controller.status()).resolves.toEqual({
      status: "environment_interrupted",
      reason: "runtime_unavailable",
      targetCount: 0,
    });
  });

  it("uses targets as the connection handshake when health reports a stale disconnected state", async () => {
    const targets = vi.fn(async () => [
      { targetId: "target-1", type: "page", title: "学习页面", url: "https://example.com/" },
    ]);
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async health() {
          return { status: "ok", runtime: "bosshunter", connected: false };
        },
        targets,
      }),
      captureJob: vi.fn(),
    });

    await expect(controller.status()).resolves.toEqual({
      status: "no_supported_tab",
      reason: "no_boss_page",
      targetCount: 0,
    });
    expect(targets).toHaveBeenCalledOnce();
  });

  it("does not expose BOSS detail query credentials in browser status", async () => {
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async targets() {
          return [
            {
              targetId: "target-credential",
              type: "page",
              title: "虚构岗位",
              url: `${jobUrl}?securityId=fixture-secret&ka=search_list_jname_1_blank`,
            },
          ];
        },
      }),
      captureJob: vi.fn(),
    });

    await expect(controller.status()).resolves.toEqual({
      status: "ready",
      targetCount: 1,
      target: { pageKind: "job_detail", title: "虚构岗位", url: jobUrl },
    });
  });

  it("discovers visible list cards and captures a selected card through constrained navigation", async () => {
    const listUrl = "https://www.zhipin.com/web/geek/job?query=agent";
    const detailUrl = "https://www.zhipin.com/job_detail/fixture-discovered-001.html";
    let currentUrl = listUrl;
    const newTab = vi.fn(async (url: string) => {
      currentUrl = url;
      return "detail-target";
    });
    const close = vi.fn(async () => {});
    const evaluate = vi.fn(async (_targetId: string, expression: string) => {
      if (expression.includes("job-card-wrap")) {
        return {
          status: "ready",
          sourceUrl: listUrl,
          jobs: [
            {
              externalJobId: "fixture-discovered-001",
              role: "Agent 工程师",
              company: "示例科技",
              salary: "20-30K",
              jobUrl: detailUrl,
            },
          ],
        };
      }
      return {
        status: "ready",
        sourceUrl: detailUrl,
        externalJobId: "fixture-discovered-001",
        company: "示例科技",
        role: "Agent 工程师",
        description: "负责构建可审计的 Agent 工作流。",
      };
    });
    const captureJob = vi.fn(
      async (): Promise<CaptureResult> => ({
        applicationId: "application-discovered-001",
        eventId: "event-discovered-001",
        artifactId: "artifact-discovered-001",
        artifactRef: "local-artifact://application/artifact-discovered-001",
        contentHash: "a".repeat(64),
        savedAt: "2026-08-17T04:00:00.000Z",
        deduplicated: false,
      }),
    );
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async targets() {
          return [{ targetId: "list-target", type: "page", title: "BOSS 岗位列表", url: currentUrl }];
        },
        evaluate,
        newTab,
        close,
      }),
      captureJob,
      now: () => new Date("2026-08-17T04:00:00.000Z"),
      discoveryIdFactory: () => "discovery-fixture-001",
      captureIdFactory: () => "capture-fixture-001",
    });

    await expect(controller.discoverJobs()).resolves.toEqual({
      status: "ready",
      discoveryId: "discovery-fixture-001",
      targetCount: 1,
      target: { pageKind: "job_list", title: "BOSS 岗位列表", url: listUrl },
      jobs: [
        {
          externalJobId: "fixture-discovered-001",
          role: "Agent 工程师",
          company: "示例科技",
          salary: "20-30K",
          salaryStatus: "available",
          jobUrl: detailUrl,
        },
      ],
    });
    await expect(
      controller.captureDiscoveredJob("discovery-fixture-001", "fixture-discovered-001"),
    ).resolves.toMatchObject({
      status: "ok",
      applicationId: "application-discovered-001",
      job: { externalJobId: "fixture-discovered-001", jobUrl: detailUrl },
    });
    expect(newTab).toHaveBeenCalledWith(detailUrl);
    expect(close).toHaveBeenCalledWith("detail-target");
    expect(captureJob).toHaveBeenCalledOnce();
  });

  it("polls a fixed stored job URL through a temporary tab and closes it after capture", async () => {
    const newTab = vi.fn(async () => "watch-detail-target");
    const close = vi.fn(async () => {});
    const captureJob = vi.fn(
      async (): Promise<CaptureResult> => ({
        applicationId: "application-watch-001",
        eventId: "event-watch-001",
        artifactId: "artifact-watch-001",
        artifactRef: "local-artifact://application/artifact-watch-001",
        contentHash: "b".repeat(64),
        savedAt: "2026-08-18T02:00:00.000Z",
        deduplicated: false,
      }),
    );
    const controller = new BossBrowserRunController({
      runtime: runtime({ newTab, close }),
      captureJob,
      now: () => new Date("2026-08-18T02:00:00.000Z"),
    });

    await expect(controller.pollFixedJob(jobUrl, "fixture-job-001")).resolves.toMatchObject({
      status: "ok",
      applicationId: "application-watch-001",
      job: { externalJobId: "fixture-job-001", jobUrl },
    });
    expect(newTab).toHaveBeenCalledWith(jobUrl);
    expect(close).toHaveBeenCalledWith("watch-detail-target");
    expect(captureJob).toHaveBeenCalledOnce();
  });

  it("searches bounded pages, deduplicates external ids, captures details serially, and closes temporary tabs", async () => {
    const listUrls = [
      "https://www.zhipin.com/web/geek/job?query=agent&city=101020100",
      "https://www.zhipin.com/web/geek/job?query=agent&city=101020100&page=2",
    ];
    const detailUrls = [
      "https://www.zhipin.com/job_detail/search-001.html",
      "https://www.zhipin.com/job_detail/search-002.html",
      "https://www.zhipin.com/job_detail/search-003.html",
    ];
    let currentUrl = "";
    let sequence = 0;
    const newTab = vi.fn(async (url: string) => {
      currentUrl = url;
      sequence += 1;
      return `search-target-${sequence}`;
    });
    const close = vi.fn(async () => {});
    const captureJob = vi.fn(
      async (snapshot: unknown): Promise<CaptureResult> => ({
        applicationId: `application-${(snapshot as { externalJobId: string }).externalJobId}`,
        eventId: "event-search",
        artifactId: "artifact-search",
        artifactRef: "local-artifact://search",
        contentHash: "d".repeat(64),
        savedAt: "2026-08-18T02:00:00.000Z",
        deduplicated: false,
      }),
    );
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async targets() {
          return [{ targetId: "unused", type: "page", title: "搜索", url: currentUrl }];
        },
        async evaluate(_targetId, expression) {
          if (expression.includes("job-card-wrap")) {
            const page = currentUrl.includes("page=2") ? 1 : 0;
            const jobs =
              page === 0
                ? [
                    {
                      externalJobId: "search-001",
                      role: "后端工程师",
                      company: "示例一",
                      jobUrl: detailUrls[0],
                    },
                    {
                      externalJobId: "search-002",
                      role: "平台工程师",
                      company: "示例二",
                      jobUrl: detailUrls[1],
                    },
                  ]
                : [
                    {
                      externalJobId: "search-002",
                      role: "平台工程师",
                      company: "示例二",
                      jobUrl: detailUrls[1],
                    },
                    {
                      externalJobId: "search-003",
                      role: "AI 工程师",
                      company: "示例三",
                      jobUrl: detailUrls[2],
                    },
                  ];
            return { status: "ready", sourceUrl: currentUrl, jobs };
          }
          const id = currentUrl.match(/search-[0-9]+/u)?.[0] ?? "search-001";
          return {
            status: "ready",
            sourceUrl: currentUrl,
            externalJobId: id,
            company: "示例公司",
            role: "工程师",
            description: "虚构 JD",
          };
        },
        newTab,
        close,
      }),
      captureJob,
      now: () => new Date("2026-08-18T02:00:00.000Z"),
    });

    const result = await controller.searchJobs({ keyword: "agent", city: "上海", maxPages: 2, maxJobs: 3 });
    expect(result).toMatchObject({ status: "ok", pagesVisited: 2 });
    if (!("items" in result)) throw new Error("expected_search_items");
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.job.externalJobId)).toEqual([
      "search-001",
      "search-002",
      "search-003",
    ]);
    expect(newTab.mock.calls.map(([url]) => url)).toEqual([
      listUrls[0],
      detailUrls[0],
      detailUrls[1],
      listUrls[1],
      detailUrls[2],
    ]);
    expect(close).toHaveBeenCalledTimes(5);
    expect(captureJob).toHaveBeenCalledTimes(3);
  });

  it("stops a bounded search at a verification handoff without opening another detail", async () => {
    const newTab = vi.fn(async (url: string) =>
      url.includes("job_detail") ? "detail-handoff" : "list-handoff",
    );
    const close = vi.fn(async () => {});
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async evaluate(_targetId, expression) {
          if (expression.includes("job-card-wrap")) {
            return {
              status: "ready",
              sourceUrl: "https://www.zhipin.com/web/geek/job?query=agent&city=101020100",
              jobs: [
                {
                  externalJobId: "search-handoff",
                  role: "工程师",
                  jobUrl: "https://www.zhipin.com/job_detail/search-handoff.html",
                },
              ],
            };
          }
          return {
            status: "human_required",
            reason: "verification",
            sourceUrl: "https://www.zhipin.com/job_detail/search-handoff.html",
          };
        },
        newTab,
        close,
      }),
      captureJob: vi.fn(),
    });

    await expect(controller.searchJobs({ keyword: "agent", city: "上海" })).resolves.toMatchObject({
      status: "human_required",
      reason: "verification",
      pagesVisited: 1,
    });
    expect(newTab).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith("list-handoff");
    expect(close).not.toHaveBeenCalledWith("detail-handoff");
  });

  it("keeps a watch tab open when polling reaches a human handoff", async () => {
    const close = vi.fn(async () => {});
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async evaluate() {
          return { status: "human_required", reason: "verification", sourceUrl: jobUrl };
        },
        close,
      }),
      captureJob: vi.fn(),
    });

    await expect(controller.pollFixedJob(jobUrl, "fixture-job-001")).resolves.toEqual({
      status: "human_required",
      reason: "verification",
      targetCount: 1,
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps a watch tab open when the detail adapter cannot identify the page", async () => {
    const close = vi.fn(async () => {});
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async evaluate() {
          return { status: "page_adapter_mismatch" };
        },
        close,
      }),
      captureJob: vi.fn(),
    });

    await expect(controller.pollFixedJob(jobUrl, "fixture-job-001")).resolves.toEqual({
      status: "page_adapter_mismatch",
      reason: "job_detail",
      targetCount: 1,
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("rejects a watch URL and external id mismatch before opening a tab", async () => {
    const newTab = vi.fn(async () => "watch-detail-target");
    const controller = new BossBrowserRunController({
      runtime: runtime({ newTab }),
      captureJob: vi.fn(),
    });

    await expect(
      controller.pollFixedJob("https://example.invalid/jobs/1", "fixture-job-001"),
    ).resolves.toEqual({
      status: "invalid_request",
      reason: "unsupported_job_url",
      targetCount: 0,
    });
    await expect(controller.pollFixedJob(jobUrl, "different-job")).resolves.toEqual({
      status: "invalid_request",
      reason: "external_job_id_mismatch",
      targetCount: 0,
    });
    expect(newTab).not.toHaveBeenCalled();
  });

  it("does not expose private-use salary glyphs as trusted salary text", async () => {
    const listUrl = "https://www.zhipin.com/web/geek/job?query=agent";
    const detailUrl = "https://www.zhipin.com/job_detail/fixture-obfuscated-001.html";
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async targets() {
          return [{ targetId: "list-target", type: "page", title: "BOSS 岗位列表", url: listUrl }];
        },
        async evaluate() {
          return {
            status: "ready",
            sourceUrl: listUrl,
            jobs: [
              {
                externalJobId: "fixture-obfuscated-001",
                role: "Agent 工程师",
                company: "示例科技",
                salary: "\uE033\uE031-\uE033\uE036K·\uE032\uE037薪",
                jobUrl: detailUrl,
              },
            ],
          };
        },
      }),
      captureJob: vi.fn(),
      discoveryIdFactory: () => "discovery-obfuscated-001",
    });

    const result = await controller.discoverJobs();

    expect(result).toMatchObject({
      status: "ready",
      jobs: [
        {
          externalJobId: "fixture-obfuscated-001",
          salaryStatus: "obfuscated",
        },
      ],
    });
    if (result.status === "ready") expect(result.jobs[0]).not.toHaveProperty("salary");
  });

  it("keeps the temporary detail tab open when login or verification needs a human", async () => {
    const listUrl = "https://www.zhipin.com/web/geek/job?query=agent";
    const detailUrl = "https://www.zhipin.com/job_detail/fixture-handoff-001.html";
    const close = vi.fn(async () => {});
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async targets() {
          return [{ targetId: "list-target", type: "page", url: listUrl }];
        },
        async evaluate(_targetId, expression) {
          return expression.includes("job-card-wrap")
            ? {
                status: "ready",
                sourceUrl: listUrl,
                jobs: [{ externalJobId: "fixture-handoff-001", role: "Agent 工程师", jobUrl: detailUrl }],
              }
            : { status: "human_required", reason: "verification", sourceUrl: detailUrl };
        },
        async newTab() {
          return "detail-target";
        },
        close,
      }),
      captureJob: vi.fn(),
      discoveryIdFactory: () => "discovery-handoff-001",
    });

    await expect(controller.discoverJobs()).resolves.toMatchObject({ status: "ready" });
    await expect(
      controller.captureDiscoveredJob("discovery-handoff-001", "fixture-handoff-001"),
    ).resolves.toEqual({ status: "human_required", reason: "verification", targetCount: 1 });
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps a discovered detail tab open when the detail adapter cannot identify the page", async () => {
    const listUrl = "https://www.zhipin.com/web/geek/job?query=agent";
    const detailUrl = "https://www.zhipin.com/job_detail/fixture-adapter-mismatch-001.html";
    const close = vi.fn(async () => {});
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async targets() {
          return [{ targetId: "list-target", type: "page", url: listUrl }];
        },
        async evaluate(_targetId, expression) {
          return expression.includes("job-card-wrap")
            ? {
                status: "ready",
                sourceUrl: listUrl,
                jobs: [
                  { externalJobId: "fixture-adapter-mismatch-001", role: "Agent 工程师", jobUrl: detailUrl },
                ],
              }
            : { status: "page_adapter_mismatch" };
        },
        async newTab() {
          return "detail-target";
        },
        close,
      }),
      captureJob: vi.fn(),
      discoveryIdFactory: () => "discovery-adapter-mismatch-001",
    });

    await expect(controller.discoverJobs()).resolves.toMatchObject({ status: "ready" });
    await expect(
      controller.captureDiscoveredJob("discovery-adapter-mismatch-001", "fixture-adapter-mismatch-001"),
    ).resolves.toEqual({ status: "page_adapter_mismatch", reason: "job_detail", targetCount: 1 });
    expect(close).not.toHaveBeenCalled();
  });

  it("does not guess when more than one supported job tab is open", async () => {
    const evaluate = vi.fn();
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async targets() {
          return [
            { targetId: "target-1", type: "page", title: "岗位一", url: jobUrl },
            {
              targetId: "target-2",
              type: "page",
              title: "岗位二",
              url: "https://www.zhipin.com/job_detail/fixture-job-002.html",
            },
          ];
        },
        evaluate,
      }),
      captureJob: vi.fn(),
    });

    await expect(controller.captureCurrentJob()).resolves.toEqual({
      status: "target_ambiguous",
      reason: "multiple_job_tabs",
      targetCount: 2,
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("hands login and verification states back without writing a fact", async () => {
    const captureJob = vi.fn();
    const loginController = new BossBrowserRunController({
      runtime: runtime({
        async targets() {
          return [
            {
              targetId: "login-target",
              type: "page",
              title: "登录",
              url: "https://www.zhipin.com/web/user/?ka=header-login",
            },
          ];
        },
      }),
      captureJob,
    });
    const verificationController = new BossBrowserRunController({
      runtime: runtime({
        async evaluate() {
          return { status: "human_required", reason: "verification", sourceUrl: jobUrl };
        },
      }),
      captureJob,
    });

    await expect(loginController.captureCurrentJob()).resolves.toEqual({
      status: "human_required",
      reason: "login",
      targetCount: 0,
    });
    await expect(verificationController.captureCurrentJob()).resolves.toEqual({
      status: "human_required",
      reason: "verification",
      targetCount: 1,
    });
    expect(captureJob).not.toHaveBeenCalled();
  });

  it("captures the current unique job through the existing fact-writing seam", async () => {
    const captureJob = vi.fn(
      async (_snapshot: unknown): Promise<CaptureResult> => ({
        applicationId: "application-fixture-001",
        eventId: "event-fixture-001",
        artifactId: "artifact-fixture-001",
        artifactRef: "local-artifact://application/artifact-fixture-001",
        contentHash: "a".repeat(64),
        savedAt: "2026-08-17T02:00:00.000Z",
        deduplicated: false,
      }),
    );
    const evaluate = vi.fn(async (_targetId: string, _expression: string) =>
      runtime().evaluate(_targetId, _expression),
    );
    const controller = new BossBrowserRunController({
      runtime: runtime({ evaluate }),
      captureJob,
      now: () => new Date("2026-08-17T02:00:00.000Z"),
      captureIdFactory: () => "capture-fixture-001",
    });

    await expect(controller.captureCurrentJob()).resolves.toMatchObject({
      status: "ok",
      applicationId: "application-fixture-001",
      eventId: "event-fixture-001",
      deduplicated: false,
      job: {
        company: "示例科技",
        role: "Agent 工程师",
        jobUrl,
        externalJobId: "fixture-job-001",
      },
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0]).toBe("target-1");
    expect(evaluate.mock.calls[0]?.[1]).not.toContain("fixture-job-001");
    expect(captureJob).toHaveBeenCalledOnce();
    expect(captureJob.mock.calls[0]?.[0]).toMatchObject({
      pageKind: "job_detail",
      captureId: "capture-fixture-001",
      capturedAt: "2026-08-17T02:00:00.000Z",
      sourceUrl: jobUrl,
      externalJobId: "fixture-job-001",
      company: "示例科技",
      role: "Agent 工程师",
      description: "负责构建可审计的 Agent 工作流。",
    });
    const capturedSnapshot = captureJob.mock.calls[0]?.[0] as { pageRevision?: unknown } | undefined;
    expect(capturedSnapshot?.pageRevision).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("captures only the selected conversation evidence for an existing application", async () => {
    const conversationUrl = "https://www.zhipin.com/web/geek/chat";
    const captureConversation = vi.fn(
      async (): Promise<CaptureResult> => ({
        applicationId: "application-conversation-001",
        eventId: "event-conversation-001",
        artifactId: "artifact-conversation-001",
        artifactRef: "local-artifact://application/artifact-conversation-001",
        contentHash: "c".repeat(64),
        savedAt: "2026-08-18T03:00:00.000Z",
        deduplicated: false,
      }),
    );
    const evaluate = vi.fn(async (_targetId: string, _expression: string) => ({
      status: "ready",
      sourceUrl: conversationUrl,
      conversationId: "conversation-fixture-001",
      messageId: "message-fixture-003",
      recruiterName: "招聘顾问",
      messageText: "方便约一下明天下午的一面吗？",
    }));
    const controller = new BossBrowserRunController({
      runtime: runtime({
        async targets() {
          return [{ targetId: "conversation-target", type: "page", title: "沟通", url: conversationUrl }];
        },
        evaluate,
      }),
      captureJob: vi.fn(),
      captureConversation,
      now: () => new Date("2026-08-18T03:00:00.000Z"),
      captureIdFactory: () => "capture-conversation-001",
    });

    await expect(
      controller.captureCurrentConversation("application-conversation-001"),
    ).resolves.toMatchObject({
      status: "ok",
      applicationId: "application-conversation-001",
      conversation: {
        conversationId: "conversation-fixture-001",
        messageId: "message-fixture-003",
        recruiterName: "招聘顾问",
        pageRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(String(evaluate.mock.calls[0]?.[1])).toContain("item-myself");
    expect(captureConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        pageKind: "conversation",
        applicationId: "application-conversation-001",
        conversationId: "conversation-fixture-001",
        messageId: "message-fixture-003",
        recruiterName: "招聘顾问",
        messageText: "方便约一下明天下午的一面吗？",
      }),
    );
  });
});
