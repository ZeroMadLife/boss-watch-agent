import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applicationArtifactRef } from "../src/domain/application-artifact.js";
import type { ApplicationEvent } from "../src/domain/application-event.js";
import { writeApplicationExport } from "../src/export/application-export.js";
import { SqliteApplicationStore } from "../src/storage/sqlite-application-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "boss-watch-export-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function captureJob(
  store: SqliteApplicationStore,
  applicationId: string,
  suffix: string,
  content: string,
): Promise<void> {
  const artifactId = `artifact-job-${suffix}`;
  const event: Extract<ApplicationEvent, { type: "job_description_captured" }> = {
    schemaVersion: 1,
    eventId: `event-job-${suffix}`,
    applicationId,
    idempotencyKey: `boss:job:${suffix}`,
    traceId: `trace-${suffix}`,
    occurredAt: "2026-08-14T07:00:00.000Z",
    actor: "agent",
    type: "job_description_captured",
    payload: {
      platform: "boss",
      externalJobId: `job-${suffix}`,
      company: "示例科技",
      role: "AI Agent 开发工程师",
      contentHash: sha256(content),
      artifactRef: applicationArtifactRef(artifactId),
    },
  };
  await store.appendWithArtifact(event, {
    artifactId,
    applicationId,
    kind: "job_description",
    content,
    createdAt: event.occurredAt,
    metadata: { source: "fictional_fixture" },
  });
}

describe("application export", () => {
  it("exports one selected application as machine-readable JSON", async () => {
    const directory = await workspace();
    const store = new SqliteApplicationStore(join(directory, "applications.sqlite3"));
    await captureJob(store, "application-demo-001", "001", "第一份虚构 JD");
    await captureJob(store, "application-demo-002", "002", "第二份虚构 JD");
    const outputPath = join(directory, "exports", "application.json");

    await writeApplicationExport(store, {
      outputPath,
      format: "json",
      applicationId: "application-demo-002",
      exportedAt: "2026-08-14T09:00:00.000Z",
    });

    const exported = JSON.parse(await readFile(outputPath, "utf8"));
    expect(exported).toMatchObject({
      schemaVersion: 1,
      exportedAt: "2026-08-14T09:00:00.000Z",
      applicationFilter: "application-demo-002",
      applications: [
        {
          applicationId: "application-demo-002",
          events: [{ eventId: "event-job-002", sequence: 1 }],
          artifacts: [{ artifactId: "artifact-job-002", content: "第二份虚构 JD" }],
        },
      ],
    });
    store.close();
  });

  it("exports readable Markdown without letting artifact fences escape", async () => {
    const directory = await workspace();
    const store = new SqliteApplicationStore(join(directory, "applications.sqlite3"));
    const content = "岗位描述\n```\n这不是 Markdown 围栏结尾";
    await captureJob(store, "application-demo-001", "001", content);
    const outputPath = join(directory, "application.md");

    await writeApplicationExport(store, {
      outputPath,
      format: "markdown",
      exportedAt: "2026-08-14T09:00:00.000Z",
    });

    const markdown = await readFile(outputPath, "utf8");
    expect(markdown).toContain("# Boss Watch Application Export");
    expect(markdown).toContain("application-demo-001");
    expect(markdown).toContain(sha256(content));
    expect(markdown).toContain("````text\n岗位描述\n```\n这不是 Markdown 围栏结尾\n````");
    store.close();
  });

  it("does not overwrite an existing export unless force is explicit", async () => {
    const directory = await workspace();
    const store = new SqliteApplicationStore(join(directory, "applications.sqlite3"));
    await captureJob(store, "application-demo-001", "001", "虚构 JD");
    const outputPath = join(directory, "application.json");
    await writeFile(outputPath, "keep me", "utf8");

    await expect(
      writeApplicationExport(store, {
        outputPath,
        format: "json",
        exportedAt: "2026-08-14T09:00:00.000Z",
      }),
    ).rejects.toThrow("export_path_exists");
    expect(await readFile(outputPath, "utf8")).toBe("keep me");

    await writeApplicationExport(store, {
      outputPath,
      format: "json",
      exportedAt: "2026-08-14T09:00:00.000Z",
      force: true,
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({ schemaVersion: 1 });
    store.close();
  });
});
