import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BossHunterBrowserRuntime } from "../src/browser/browser-run-controller.js";
import { createLocalApiServer } from "../src/server/local-api-server.js";

const temporaryDirectories: string[] = [];
const serviceToken = "dsh-service-token-for-browser-controller-test";
const jobUrl = "https://www.zhipin.com/job_detail/fixture-api-001.html";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "boss-watch-browser-api-"));
  temporaryDirectories.push(directory);
  return join(directory, "boss-watch.sqlite3");
}

function browserRuntime(): BossHunterBrowserRuntime {
  return {
    async health() {
      return { status: "ok", runtime: "bosshunter", connected: true };
    },
    async targets() {
      return [{ targetId: "target-api-1", type: "page", title: "虚构岗位", url: jobUrl }];
    },
    async evaluate() {
      return {
        status: "ready",
        sourceUrl: jobUrl,
        externalJobId: "fixture-api-001",
        company: "示例科技",
        role: "Agent 平台工程师",
        description: "构建本地优先的求职 Agent。",
      };
    },
    async newTab() {
      return "target-new-api";
    },
    async close() {},
  };
}

function listBrowserRuntime(): BossHunterBrowserRuntime {
  const listUrl = "https://www.zhipin.com/web/geek/job?query=agent";
  const detailUrl = "https://www.zhipin.com/job_detail/fixture-api-discovered-001.html";
  let currentUrl = listUrl;
  return {
    async health() {
      return { status: "ok", runtime: "bosshunter", connected: true };
    },
    async targets() {
      return [{ targetId: "target-list-api-1", type: "page", title: "岗位列表", url: currentUrl }];
    },
    async evaluate(_targetId, expression) {
      if (expression.includes("job-card-wrap")) {
        return {
          status: "ready",
          sourceUrl: listUrl,
          jobs: [{ externalJobId: "fixture-api-discovered-001", role: "Agent 工程师", jobUrl: detailUrl }],
        };
      }
      return {
        status: "ready",
        sourceUrl: detailUrl,
        externalJobId: "fixture-api-discovered-001",
        company: "示例科技",
        role: "Agent 工程师",
        description: "构建本地优先的求职 Agent。",
      };
    },
    async newTab(url) {
      currentUrl = url;
      return "target-detail-api-1";
    },
    async close() {},
  };
}

function formBrowserRuntime(): BossHunterBrowserRuntime {
  const formUrl = "https://careers.example.invalid/jobs/agent/apply?token=redacted";
  return {
    async health() {
      return { status: "ok", runtime: "bosshunter", connected: true };
    },
    async targets() {
      return [{ targetId: "target-form-api-1", type: "page", title: "虚构申请表", url: formUrl }];
    },
    async evaluate() {
      return {
        status: "ready",
        sourceUrl: formUrl,
        title: "虚构申请表",
        fields: [
          {
            ordinal: 0,
            controlType: "file",
            inputType: "file",
            label: "上传简历",
            name: "resume",
            autocomplete: "",
            required: true,
            disabled: false,
            readOnly: false,
            currentState: "empty",
          },
        ],
      };
    },
    async newTab() {
      return "unused";
    },
    async close() {},
  };
}

describe("Browser Controller local API", () => {
  it("accepts the local DSH service identity and rejects web or unauthenticated callers", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
      browserRuntime: browserRuntime(),
      serviceToken,
      now: () => new Date("2026-08-17T03:00:00.000Z"),
    });

    try {
      const address = await server.start({ port: 0 });
      const unauthorized = await fetch(`${address.origin}/api/v1/browser/status`);
      const webOrigin = await fetch(`${address.origin}/api/v1/browser/status`, {
        headers: { authorization: `Bearer ${serviceToken}`, origin: "https://example.test" },
      });
      const authorized = await fetch(`${address.origin}/api/v1/browser/status`, {
        headers: { authorization: `Bearer ${serviceToken}` },
      });

      expect(unauthorized.status).toBe(401);
      expect(webOrigin.status).toBe(403);
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual({
        status: "ready",
        targetCount: 1,
        target: { pageKind: "job_detail", title: "虚构岗位", url: jobUrl },
      });
    } finally {
      await server.close();
    }
  });

  it("captures the current job without extension pairing and deduplicates an equal retry", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
      browserRuntime: browserRuntime(),
      serviceToken,
      now: () => new Date("2026-08-17T03:00:00.000Z"),
    });

    try {
      const address = await server.start({ port: 0 });
      const request = () =>
        fetch(`${address.origin}/api/v1/browser/captures/job`, {
          method: "POST",
          headers: { authorization: `Bearer ${serviceToken}` },
        });
      const first = await request();
      const firstBody = (await first.json()) as {
        status: string;
        applicationId: string;
        eventId: string;
        deduplicated: boolean;
      };
      const replay = await request();
      const replayBody = (await replay.json()) as {
        status: string;
        applicationId: string;
        eventId: string;
        deduplicated: boolean;
      };

      expect(first.status).toBe(201);
      expect(firstBody).toMatchObject({ status: "ok", deduplicated: false });
      expect(replay.status).toBe(200);
      expect(replayBody).toEqual(
        expect.objectContaining({
          status: "ok",
          applicationId: firstBody.applicationId,
          eventId: firstBody.eventId,
          deduplicated: true,
        }),
      );
    } finally {
      await server.close();
    }
  });

  it("discovers a visible job card and captures it after a controller-approved navigation", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
      browserRuntime: listBrowserRuntime(),
      serviceToken,
      now: () => new Date("2026-08-17T03:00:00.000Z"),
    });

    try {
      const address = await server.start({ port: 0 });
      const headers = { authorization: `Bearer ${serviceToken}` };
      const discovered = await fetch(`${address.origin}/api/v1/browser/jobs/discover`, { headers });
      const discoveredBody = (await discovered.json()) as {
        status: string;
        discoveryId: string;
        jobs: Array<{ externalJobId: string }>;
      };
      expect(discovered.status).toBe(200);
      expect(discoveredBody).toMatchObject({
        status: "ready",
        jobs: [{ externalJobId: "fixture-api-discovered-001" }],
      });

      const captured = await fetch(`${address.origin}/api/v1/browser/jobs/capture`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          discoveryId: discoveredBody.discoveryId,
          externalJobId: "fixture-api-discovered-001",
        }),
      });
      expect(captured.status).toBe(201);
      expect(await captured.json()).toMatchObject({
        status: "ok",
        job: { externalJobId: "fixture-api-discovered-001" },
      });
    } finally {
      await server.close();
    }
  });

  it("polls a previously captured application without accepting a caller-supplied URL", async () => {
    const newTab = vi.fn(async () => "target-watch-api");
    const runtime = browserRuntime();
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
      browserRuntime: { ...runtime, newTab },
      serviceToken,
      now: () => new Date("2026-08-17T03:00:00.000Z"),
    });

    try {
      const address = await server.start({ port: 0 });
      const headers = { authorization: `Bearer ${serviceToken}` };
      const captured = await fetch(`${address.origin}/api/v1/browser/captures/job`, {
        method: "POST",
        headers,
      });
      const capturedBody = (await captured.json()) as { applicationId: string };
      const polled = await fetch(`${address.origin}/api/v1/browser/jobs/poll`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          applicationId: capturedBody.applicationId,
          jobUrl: "https://example.invalid/attacker-controlled-url",
        }),
      });

      expect(polled.status).toBe(200);
      expect(await polled.json()).toMatchObject({ status: "ok", applicationId: capturedBody.applicationId });
      expect(newTab).toHaveBeenCalledWith(jobUrl);
    } finally {
      await server.close();
    }
  });

  it("inspects a verified-origin application form through the service-only endpoint", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
      browserRuntime: formBrowserRuntime(),
      serviceToken,
      now: () => new Date("2026-08-18T05:00:00.000Z"),
    });

    try {
      const address = await server.start({ port: 0 });
      const unauthorized = await fetch(`${address.origin}/api/v1/browser/forms/inspect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedUrl: "https://careers.example.invalid/jobs/agent" }),
      });
      const invalid = await fetch(`${address.origin}/api/v1/browser/forms/inspect`, {
        method: "POST",
        headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ expectedUrl: "" }),
      });
      const inspected = await fetch(`${address.origin}/api/v1/browser/forms/inspect`, {
        method: "POST",
        headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ expectedUrl: "https://careers.example.invalid/jobs/agent" }),
      });

      expect(unauthorized.status).toBe(401);
      expect(invalid.status).toBe(400);
      expect(inspected.status).toBe(200);
      const body = await inspected.json();
      expect(body).toMatchObject({
        status: "ready",
        page: {
          pageKind: "application_form",
          url: "https://careers.example.invalid/jobs/agent/apply",
          formHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        fields: [{ label: "上传简历", currentState: "empty" }],
      });
      expect(JSON.stringify(body)).not.toContain("token=redacted");
    } finally {
      await server.close();
    }
  });

  it("captures the latest recruiter message from the selected conversation into the existing application", async () => {
    const conversationUrl = "https://www.zhipin.com/web/geek/chat";
    let currentUrl = jobUrl;
    const runtime: BossHunterBrowserRuntime = {
      async health() {
        return { status: "ok", runtime: "bosshunter", connected: true };
      },
      async targets() {
        return [{ targetId: "target-conversation-api", type: "page", title: "沟通", url: currentUrl }];
      },
      async evaluate() {
        if (currentUrl === jobUrl) {
          return {
            status: "ready",
            sourceUrl: jobUrl,
            externalJobId: "fixture-api-001",
            company: "示例科技",
            role: "Agent 平台工程师",
            description: "构建本地优先的求职 Agent。",
          };
        }
        return {
          status: "ready",
          sourceUrl: conversationUrl,
          conversationId: "conversation-api-001",
          messageId: "message-api-003",
          recruiterName: "招聘顾问",
          messageText: "方便约明天下午的一面吗？",
        };
      },
      async newTab() {
        return "target-new-api";
      },
      async close() {},
    };
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
      browserRuntime: runtime,
      serviceToken,
      now: () => new Date("2026-08-18T03:00:00.000Z"),
    });

    try {
      const address = await server.start({ port: 0 });
      const headers = { authorization: `Bearer ${serviceToken}` };
      const capturedJob = await fetch(`${address.origin}/api/v1/browser/captures/job`, {
        method: "POST",
        headers,
      });
      const job = (await capturedJob.json()) as { applicationId: string };
      currentUrl = conversationUrl;
      const capturedConversation = await fetch(`${address.origin}/api/v1/browser/captures/conversation`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ applicationId: job.applicationId }),
      });

      expect(capturedConversation.status).toBe(201);
      expect(await capturedConversation.json()).toMatchObject({
        status: "ok",
        applicationId: job.applicationId,
        deduplicated: false,
        conversation: {
          conversationId: "conversation-api-001",
          messageId: "message-api-003",
          recruiterName: "招聘顾问",
        },
      });
    } finally {
      await server.close();
    }
  });
});
