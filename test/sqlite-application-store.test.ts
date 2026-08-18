import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationArtifactInput } from "../src/domain/application-artifact.js";
import { applicationArtifactRef } from "../src/domain/application-artifact.js";
import type { ApplicationEvent } from "../src/domain/application-event.js";
import { SqliteApplicationStore } from "../src/storage/sqlite-application-store.js";

const temporaryDirectories: string[] = [];
type JobDescriptionEvent = Extract<ApplicationEvent, { type: "job_description_captured" }>;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "boss-watch-sqlite-"));
  temporaryDirectories.push(directory);
  return join(directory, "application.sqlite3");
}

function jobRecord(
  options: {
    applicationId?: string;
    eventId?: string;
    idempotencyKey?: string;
    artifactId?: string;
    content?: string;
  } = {},
): { event: JobDescriptionEvent; artifact: ApplicationArtifactInput } {
  const applicationId = options.applicationId ?? "application-demo-001";
  const artifactId = options.artifactId ?? "artifact-job-001";
  const content = options.content ?? "虚构 JD 内容";
  return {
    event: {
      schemaVersion: 1,
      eventId: options.eventId ?? "event-job-001",
      applicationId,
      idempotencyKey: options.idempotencyKey ?? "boss:job:job-demo-001",
      traceId: "trace-demo-001",
      occurredAt: "2026-08-14T07:00:00.000Z",
      actor: "agent",
      type: "job_description_captured",
      payload: {
        platform: "boss",
        externalJobId: "job-demo-001",
        company: "示例科技",
        role: "AI Agent 开发工程师",
        contentHash: sha256(content),
        artifactRef: applicationArtifactRef(artifactId),
      },
    },
    artifact: {
      artifactId,
      applicationId,
      kind: "job_description",
      content,
      createdAt: "2026-08-14T07:00:00.000Z",
      metadata: { source: "fictional_fixture" },
    },
  };
}

describe("SqliteApplicationStore", () => {
  it("persists one JD artifact and event across database reopen", async () => {
    const path = await databasePath();
    const firstStore = new SqliteApplicationStore(path);
    const record = jobRecord();

    const stored = await firstStore.appendWithArtifact(record.event, record.artifact);
    firstStore.close();

    const reopenedStore = new SqliteApplicationStore(path);
    expect(await reopenedStore.list(record.event.applicationId)).toEqual([stored.event]);
    expect(await reopenedStore.listArtifacts(record.event.applicationId)).toEqual([stored.artifact]);
    reopenedStore.close();
  });

  it("rolls back both rows when the event hash does not match the artifact", async () => {
    const store = new SqliteApplicationStore(await databasePath());
    const record = jobRecord();
    const mismatchedEvent: ApplicationEvent = {
      ...record.event,
      payload: { ...record.event.payload, contentHash: sha256("另一份内容") },
    };

    await expect(store.appendWithArtifact(mismatchedEvent, record.artifact)).rejects.toThrow(
      "artifact_hash_mismatch",
    );
    expect(await store.list(record.event.applicationId)).toEqual([]);
    expect(await store.listArtifacts(record.event.applicationId)).toEqual([]);
    store.close();
  });

  it("returns the original record for an idempotent capture retry", async () => {
    const store = new SqliteApplicationStore(await databasePath());
    const record = jobRecord();
    const { metadata: _metadata, ...artifactWithoutMetadata } = record.artifact;
    const first = await store.appendWithArtifact(record.event, artifactWithoutMetadata);
    const replay = await store.appendWithArtifact(
      { ...record.event, eventId: "event-job-retry-001" },
      artifactWithoutMetadata,
    );

    expect(replay).toEqual(first);
    expect(await store.list(record.event.applicationId)).toHaveLength(1);
    expect(await store.listArtifacts(record.event.applicationId)).toHaveLength(1);
    store.close();
  });

  it("rejects changed evidence under the same application idempotency key", async () => {
    const store = new SqliteApplicationStore(await databasePath());
    const first = jobRecord();
    await store.appendWithArtifact(first.event, first.artifact);
    const changed = jobRecord({ eventId: "event-job-002", content: "被修改的虚构 JD" });

    await expect(store.appendWithArtifact(changed.event, changed.artifact)).rejects.toThrow(
      "idempotency_key_collision:boss:job:job-demo-001",
    );
    store.close();
  });

  it("allows the same idempotency key in two applications", async () => {
    const store = new SqliteApplicationStore(await databasePath());
    const first = jobRecord();
    const second = jobRecord({
      applicationId: "application-demo-002",
      eventId: "event-job-002",
      artifactId: "artifact-job-002",
    });

    await store.appendWithArtifact(first.event, first.artifact);
    const storedSecond = await store.appendWithArtifact(second.event, second.artifact);

    expect(storedSecond.event.sequence).toBe(1);
    store.close();
  });

  it("serializes application sequence numbers across two connections", async () => {
    const path = await databasePath();
    const firstStore = new SqliteApplicationStore(path);
    const secondStore = new SqliteApplicationStore(path);
    const first = jobRecord();
    const second = jobRecord({
      eventId: "event-job-002",
      idempotencyKey: "boss:job:job-demo-002",
      artifactId: "artifact-job-002",
      content: "第二份虚构 JD",
    });

    expect((await firstStore.appendWithArtifact(first.event, first.artifact)).event.sequence).toBe(1);
    expect((await secondStore.appendWithArtifact(second.event, second.artifact)).event.sequence).toBe(2);
    firstStore.close();
    secondStore.close();
  });

  it("requires evidence events to be appended with their artifact", async () => {
    const store = new SqliteApplicationStore(await databasePath());

    await expect(store.append(jobRecord().event)).rejects.toThrow("artifact_required_for_evidence_event");
    store.close();
  });

  it("appends a status proposal without an artifact", async () => {
    const store = new SqliteApplicationStore(await databasePath());
    const record = jobRecord();
    const captured = await store.appendWithArtifact(record.event, record.artifact);
    const proposal: ApplicationEvent = {
      schemaVersion: 1,
      eventId: "event-status-001",
      applicationId: record.event.applicationId,
      idempotencyKey: "manual:status:awaiting-gate-b",
      traceId: "trace-status-001",
      occurredAt: "2026-08-14T07:05:00.000Z",
      actor: "human",
      type: "status_change_proposed",
      payload: {
        proposalId: "proposal-001",
        from: "discovered",
        to: "awaiting_gate_b",
        evidenceEventIds: [captured.event.eventId],
      },
    };

    expect(await store.append(proposal)).toMatchObject({ sequence: 2, type: "status_change_proposed" });
    expect(await store.listArtifacts(record.event.applicationId)).toHaveLength(1);
    store.close();
  });

  it("rejects credentials in structured artifact metadata", async () => {
    const store = new SqliteApplicationStore(await databasePath());
    const record = jobRecord();

    await expect(
      store.appendWithArtifact(record.event, {
        ...record.artifact,
        metadata: { browser: { accessToken: "fictional-secret" } },
      }),
    ).rejects.toThrow("artifact_metadata_contains_credential");
    expect(await store.list(record.event.applicationId)).toEqual([]);
    store.close();
  });

  it("migrates a v3 database before persisting progress-signal evidence", async () => {
    const path = await databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE application_artifacts (
        artifact_id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('job_description', 'recruiter_message', 'interview_note')),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        artifact_ref TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE application_events (
        event_id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        idempotency_key TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        artifact_id TEXT UNIQUE,
        UNIQUE (application_id, sequence),
        UNIQUE (application_id, idempotency_key),
        FOREIGN KEY (artifact_id) REFERENCES application_artifacts(artifact_id)
      );
      PRAGMA user_version = 3;
    `);
    const job = jobRecord();
    legacy
      .prepare("INSERT INTO application_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        job.artifact.artifactId,
        job.artifact.applicationId,
        job.artifact.kind,
        job.artifact.content,
        sha256(job.artifact.content),
        applicationArtifactRef(job.artifact.artifactId),
        job.artifact.createdAt,
        JSON.stringify(job.artifact.metadata),
      );
    legacy
      .prepare("INSERT INTO application_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        job.event.eventId,
        job.event.applicationId,
        1,
        job.event.idempotencyKey,
        job.event.traceId,
        job.event.occurredAt,
        job.event.actor,
        job.event.type,
        JSON.stringify(job.event),
        job.artifact.artifactId,
      );
    legacy.close();

    const store = new SqliteApplicationStore(path);
    const signalContent = "面试邀请：请参加第一轮面试。";
    const artifactId = "artifact-progress-001";
    const signal: Extract<ApplicationEvent, { type: "progress_signal_recorded" }> = {
      schemaVersion: 1,
      eventId: "event-progress-001",
      applicationId: job.event.applicationId,
      idempotencyKey: "progress-signal:fixture",
      traceId: "trace-progress-001",
      occurredAt: "2026-08-14T08:00:00.000Z",
      actor: "human",
      type: "progress_signal_recorded",
      payload: {
        signalId: "progress-signal-001",
        sourceKind: "recruitment_email",
        outcome: "interview",
        classifierVersion: "progress-signal-rules-v1",
        confidence: 0.87,
        reasonCodes: ["interview_invitation"],
        contentHash: sha256(signalContent),
        artifactRef: applicationArtifactRef(artifactId),
      },
    };
    await store.appendWithArtifact(signal, {
      artifactId,
      applicationId: job.event.applicationId,
      kind: "progress_signal",
      content: signalContent,
      createdAt: signal.occurredAt,
    });
    expect((await store.list(job.event.applicationId)).map((event) => event.type)).toEqual([
      "job_description_captured",
      "progress_signal_recorded",
    ]);
    store.close();

    const verified = new DatabaseSync(path, { readOnly: true });
    expect((verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
    expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    verified.close();
  });
});
