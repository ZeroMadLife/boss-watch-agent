import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalApiServer } from "../src/server/local-api-server.js";
import { SqliteApplicationStore } from "../src/storage/sqlite-application-store.js";

const temporaryDirectories: string[] = [];
const serviceToken = "dsh-service-token-for-official-job-capture-test";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "boss-watch-official-job-"));
  temporaryDirectories.push(directory);
  return join(directory, "boss-watch.sqlite3");
}

const requestBody = {
  sourceId: "recruitment-source:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  company: "虚构星舟科技",
  role: "Agent 平台开发工程师",
  officialJobUrl: "https://careers.example.invalid/jobs/agent-platform",
  jdText: "岗位职责：使用 TypeScript 和 Node.js 构建 Agent 平台。任职要求：本科及以上，2027 届。",
  capturedAt: "2026-08-19T06:00:00.000Z",
};

describe("official job capture API", () => {
  it("requires the local service identity and rejects unsafe official URLs", async () => {
    const path = await databasePath();
    const server = createLocalApiServer({
      databasePath: path,
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
      serviceToken,
      now: () => new Date("2026-08-19T06:00:00.000Z"),
    });

    try {
      const address = await server.start({ port: 0 });
      const unauthorized = await fetch(`${address.origin}/api/v1/official-jds/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const unsafe = await fetch(`${address.origin}/api/v1/official-jds/capture`, {
        method: "POST",
        headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ...requestBody, officialJobUrl: "https://127.0.0.1/private" }),
      });

      expect(unauthorized.status).toBe(401);
      expect(unsafe.status).toBe(400);
      expect(await unsafe.json()).toEqual({ error: { code: "official_job_url_invalid" } });
    } finally {
      await server.close();
    }
  });

  it("stores one confirmed official JD fact and deduplicates an equal retry", async () => {
    const path = await databasePath();
    const server = createLocalApiServer({
      databasePath: path,
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
      serviceToken,
      now: () => new Date("2026-08-19T06:00:00.000Z"),
    });

    try {
      const address = await server.start({ port: 0 });
      const capture = () =>
        fetch(`${address.origin}/api/v1/official-jds/capture`, {
          method: "POST",
          headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        });
      const first = await capture();
      const firstBody = (await first.json()) as Record<string, unknown>;
      const replay = await capture();
      const replayBody = (await replay.json()) as Record<string, unknown>;

      expect(first.status).toBe(201);
      expect(firstBody).toMatchObject({
        applicationId: expect.stringMatching(/^application-/u),
        eventId: expect.stringMatching(/^event-/u),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        deduplicated: false,
      });
      expect(JSON.stringify(firstBody)).not.toContain(requestBody.jdText);
      expect(replay.status).toBe(200);
      expect(replayBody).toMatchObject({
        applicationId: firstBody.applicationId,
        eventId: firstBody.eventId,
        contentHash: firstBody.contentHash,
        deduplicated: true,
      });

      const store = new SqliteApplicationStore(path);
      try {
        const applicationId = String(firstBody.applicationId);
        const events = await store.list(applicationId);
        const artifacts = await store.listArtifacts(applicationId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actor: "human",
          type: "job_description_captured",
          payload: {
            platform: "official_portal",
            company: requestBody.company,
            role: requestBody.role,
            jobUrl: requestBody.officialJobUrl,
          },
        });
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]?.content).toBe(requestBody.jdText);
      } finally {
        store.close();
      }
    } finally {
      await server.close();
    }
  });
});
