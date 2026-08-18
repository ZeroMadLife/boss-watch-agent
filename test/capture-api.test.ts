import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConversationPageSnapshot,
  createPageRevision,
  type JobPageSnapshot,
} from "../src/capture/page-snapshot.js";
import { createLocalApiServer, type LocalApiServer } from "../src/server/local-api-server.js";

const temporaryDirectories: string[] = [];
const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const token = "client-token-for-capture-test";
const serviceToken = "service-token-for-capture-test-1234567890";
const dshOrigin = "http://127.0.0.1:3080";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startServer(): Promise<{
  server: LocalApiServer;
  origin: string;
  headers: Record<string, string>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "boss-watch-capture-"));
  temporaryDirectories.push(directory);
  const server = createLocalApiServer({
    databasePath: join(directory, "boss-watch.sqlite3"),
    pairingCode: "123456",
    tokenFactory: () => token,
    runtimeMode: "baseline_ready",
    serviceToken,
    now: () => new Date("2026-08-14T09:00:00.000Z"),
  });
  const { origin } = await server.start({ port: 0 });
  const paired = await fetch(`${origin}/api/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: extensionOrigin },
    body: JSON.stringify({ code: "123456" }),
  });
  expect(paired.status).toBe(200);
  return {
    server,
    origin,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin: extensionOrigin,
    },
  };
}

function jobSnapshot(overrides: Partial<JobPageSnapshot> = {}): JobPageSnapshot {
  const snapshot = {
    captureId: "capture-job-001",
    capturedAt: "2026-08-14T08:00:00.000Z",
    sourceUrl: "https://www.zhipin.com/job_detail/demo-job.html",
    pageKind: "job_detail" as const,
    externalJobId: "demo-job-001",
    company: "示例科技",
    role: "AI Agent 工程师",
    description: "负责构建可审计的 Agent 工作流。",
    ...overrides,
  };
  return { ...snapshot, pageRevision: createPageRevision(snapshot) };
}

function conversationSnapshot(
  applicationId: string,
  overrides: Partial<ConversationPageSnapshot> = {},
): ConversationPageSnapshot {
  const snapshot = {
    captureId: "capture-message-001",
    capturedAt: "2026-08-14T08:01:00.000Z",
    sourceUrl: "https://www.zhipin.com/web/geek/chat",
    pageKind: "conversation" as const,
    applicationId,
    conversationId: "conversation-demo-001",
    messageId: "message-demo-001",
    recruiterName: "招聘顾问",
    messageText: "方便发一份简历吗？",
    ...overrides,
  };
  return { ...snapshot, pageRevision: createPageRevision(snapshot) };
}

describe("capture API", () => {
  it("captures one current JD and returns the original record for equal visible evidence", async () => {
    const { server, origin, headers } = await startServer();
    try {
      const snapshot = jobSnapshot();
      const created = await fetch(`${origin}/api/v1/captures/job`, {
        method: "POST",
        headers,
        body: JSON.stringify(snapshot),
      });
      expect(created.status).toBe(201);
      const first = (await created.json()) as Record<string, unknown>;
      expect(first).toMatchObject({
        applicationId: expect.any(String),
        eventId: expect.any(String),
        artifactId: expect.any(String),
        contentHash: sha256(snapshot.description),
        deduplicated: false,
      });

      const replaySnapshot = jobSnapshot({
        captureId: "capture-job-002",
        capturedAt: "2026-08-14T08:02:00.000Z",
      });
      const replay = await fetch(`${origin}/api/v1/captures/job`, {
        method: "POST",
        headers,
        body: JSON.stringify(replaySnapshot),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        eventId: first.eventId,
        artifactId: first.artifactId,
        deduplicated: true,
      });

      const artifact = await fetch(`${origin}/api/v1/artifacts/${String(first.artifactId)}`, { headers });
      expect(artifact.status).toBe(200);
      expect(await artifact.json()).toMatchObject({
        kind: "job_description",
        content: snapshot.description,
        contentHash: sha256(snapshot.description),
      });
    } finally {
      await server.close();
    }
  });

  it("rejects captures not sourced from the supported BOSS host", async () => {
    const { server, origin, headers } = await startServer();
    try {
      const snapshot = jobSnapshot({ sourceUrl: "https://example.test/job_detail/demo-job.html" });
      const response = await fetch(`${origin}/api/v1/captures/job`, {
        method: "POST",
        headers,
        body: JSON.stringify(snapshot),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "unsupported_source_url" } });
    } finally {
      await server.close();
    }
  });

  it("rejects a capture timestamp more than five minutes in the future", async () => {
    const { server, origin, headers } = await startServer();
    try {
      const response = await fetch(`${origin}/api/v1/captures/job`, {
        method: "POST",
        headers,
        body: JSON.stringify(jobSnapshot({ capturedAt: "2026-08-14T09:05:01.000Z" })),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_capture_timestamp" } });
    } finally {
      await server.close();
    }
  });

  it("captures recruiter evidence before deterministic baseline analysis", async () => {
    const { server, origin, headers } = await startServer();
    try {
      const jobResponse = await fetch(`${origin}/api/v1/captures/job`, {
        method: "POST",
        headers,
        body: JSON.stringify(jobSnapshot()),
      });
      const job = (await jobResponse.json()) as { applicationId: string };
      const snapshot = conversationSnapshot(job.applicationId);
      const capturedResponse = await fetch(`${origin}/api/v1/captures/conversation`, {
        method: "POST",
        headers,
        body: JSON.stringify(snapshot),
      });
      expect(capturedResponse.status).toBe(201);
      const captured = (await capturedResponse.json()) as {
        eventId: string;
        artifactId: string;
      };

      const analysisResponse = await fetch(`${origin}/api/v1/analyses/conversation`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          eventId: captured.eventId,
          pageRevision: snapshot.pageRevision,
          mode: "baseline",
        }),
      });
      expect(analysisResponse.status).toBe(200);
      expect(await analysisResponse.json()).toEqual({
        mode: "baseline",
        eventId: captured.eventId,
        artifactId: captured.artifactId,
        analysis: {
          conversationId: snapshot.conversationId,
          intent: "resume_request",
          evidence: { messageId: snapshot.messageId, quote: snapshot.messageText },
          draft: {
            status: "draft_only",
            text: "收到，我会先核对岗位信息并准备匹配版本的简历，确认后发送。",
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it("rejects analysis when the page revision is stale or Pi is not configured", async () => {
    const { server, origin, headers } = await startServer();
    try {
      const jobResponse = await fetch(`${origin}/api/v1/captures/job`, {
        method: "POST",
        headers,
        body: JSON.stringify(jobSnapshot()),
      });
      const job = (await jobResponse.json()) as { applicationId: string };
      const snapshot = conversationSnapshot(job.applicationId);
      const capturedResponse = await fetch(`${origin}/api/v1/captures/conversation`, {
        method: "POST",
        headers,
        body: JSON.stringify(snapshot),
      });
      const captured = (await capturedResponse.json()) as { eventId: string };

      const stale = await fetch(`${origin}/api/v1/analyses/conversation`, {
        method: "POST",
        headers,
        body: JSON.stringify({ eventId: captured.eventId, pageRevision: "0".repeat(64), mode: "baseline" }),
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: { code: "stale_page_revision" } });

      const pi = await fetch(`${origin}/api/v1/analyses/conversation`, {
        method: "POST",
        headers,
        body: JSON.stringify({ eventId: captured.eventId, pageRevision: snapshot.pageRevision, mode: "pi" }),
      });
      expect(pi.status).toBe(409);
      expect(await pi.json()).toEqual({ error: { code: "pi_not_ready" } });
    } finally {
      await server.close();
    }
  });

  it("previews and records a manually confirmed interview note without returning the note body", async () => {
    const { server, origin, headers } = await startServer();
    try {
      const jobResponse = await fetch(`${origin}/api/v1/captures/job`, {
        method: "POST",
        headers,
        body: JSON.stringify(jobSnapshot()),
      });
      const job = (await jobResponse.json()) as { applicationId: string };
      const note = "一面重点讨论了幂等键、页面证据与人工接管边界。";
      const serviceHeaders = {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
      };
      const previewResponse = await fetch(`${origin}/api/v1/interview-notes/preview`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({
          applicationId: job.applicationId,
          interviewId: "interview-fixture-001",
          stage: "first_interview",
          content: note,
          occurredAt: "2026-08-14T08:30:00.000Z",
        }),
      });
      expect(previewResponse.status).toBe(200);
      const preview = (await previewResponse.json()) as {
        previewToken: string;
        contentHash: string;
        requiresConfirmation: boolean;
      };
      expect(preview).toMatchObject({
        contentHash: sha256(note),
        requiresConfirmation: true,
      });
      expect(JSON.stringify(preview)).not.toContain(note);

      const rejected = await fetch(`${origin}/api/v1/interview-notes/apply`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ previewToken: preview.previewToken, confirmed: false }),
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({ error: { code: "confirmation_required" } });

      const applied = await fetch(`${origin}/api/v1/interview-notes/apply`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ previewToken: preview.previewToken, confirmed: true }),
      });
      expect(applied.status).toBe(201);
      const appliedBody = (await applied.json()) as {
        eventId: string;
        artifactId: string;
        contentHash: string;
      };
      expect(appliedBody).toMatchObject({ contentHash: sha256(note) });

      const replay = await fetch(`${origin}/api/v1/interview-notes/apply`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ previewToken: preview.previewToken, confirmed: true }),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        eventId: appliedBody.eventId,
        artifactId: appliedBody.artifactId,
        deduplicated: true,
      });

      const applicationResponse = await fetch(`${origin}/api/v1/applications/${job.applicationId}`, {
        headers,
      });
      const application = (await applicationResponse.json()) as {
        events: Array<{ type: string; actor: string; payload: Record<string, unknown> }>;
      };
      expect(application.events.at(-1)).toMatchObject({
        type: "interview_note_recorded",
        actor: "human",
        payload: {
          interviewId: "interview-fixture-001",
          stage: "first_interview",
          contentHash: sha256(note),
        },
      });
      expect(JSON.stringify(application.events)).not.toContain(preview.previewToken);
      const artifact = await fetch(`${origin}/api/v1/artifacts/${appliedBody.artifactId}`, { headers });
      expect(await artifact.json()).toMatchObject({ kind: "interview_note", content: note });
    } finally {
      await server.close();
    }
  });

  it("previews a pasted recruiting signal and appends evidence plus a status proposal only after confirmation", async () => {
    const { server, origin, headers } = await startServer();
    try {
      const jobResponse = await fetch(`${origin}/api/v1/captures/job`, {
        method: "POST",
        headers,
        body: JSON.stringify(jobSnapshot()),
      });
      const job = (await jobResponse.json()) as { applicationId: string };
      const content = "很遗憾，您的申请未能通过本轮评估，招聘流程不再推进。";
      const serviceHeaders = {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
      };
      const previewResponse = await fetch(`${origin}/api/v1/progress-signals/preview`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({
          applicationId: job.applicationId,
          sourceKind: "recruitment_email",
          content,
          observedAt: "2026-08-14T08:40:00.000Z",
        }),
      });
      expect(previewResponse.status).toBe(200);
      const preview = (await previewResponse.json()) as { previewToken: string } & Record<string, unknown>;
      expect(preview).toMatchObject({
        applicationId: job.applicationId,
        sourceMode: "pasted_text",
        outcome: "rejected",
        proposedStatus: "rejected",
        contentHash: sha256(content),
        sourceHash: sha256(content),
        requiresConfirmation: true,
      });
      expect(JSON.stringify(preview)).not.toContain(content);

      const rejected = await fetch(`${origin}/api/v1/progress-signals/apply`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ previewToken: preview.previewToken, confirmed: false }),
      });
      expect(rejected.status).toBe(409);

      const applied = await fetch(`${origin}/api/v1/progress-signals/apply`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ previewToken: preview.previewToken, confirmed: true }),
      });
      expect(applied.status).toBe(201);
      const result = (await applied.json()) as {
        signalEventId: string;
        proposalEventId: string;
        artifactId: string;
      };
      expect(result).toMatchObject({
        signalEventId: expect.any(String),
        proposalEventId: expect.any(String),
        artifactId: expect.any(String),
        outcome: "rejected",
        proposedStatus: "rejected",
        deduplicated: false,
      });

      const replay = await fetch(`${origin}/api/v1/progress-signals/apply`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ previewToken: preview.previewToken, confirmed: true }),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        signalEventId: result.signalEventId,
        proposalEventId: result.proposalEventId,
        deduplicated: true,
      });

      const applicationResponse = await fetch(`${origin}/api/v1/applications/${job.applicationId}`, {
        headers,
      });
      const application = (await applicationResponse.json()) as {
        events: Array<{ eventId: string; type: string; actor: string; payload: Record<string, unknown> }>;
      };
      expect(application.events.slice(-2)).toMatchObject([
        {
          eventId: result.signalEventId,
          type: "progress_signal_recorded",
          actor: "human",
          payload: { sourceKind: "recruitment_email", outcome: "rejected" },
        },
        {
          eventId: result.proposalEventId,
          type: "status_change_proposed",
          actor: "agent",
          payload: { to: "rejected", evidenceEventIds: [result.signalEventId] },
        },
      ]);
      const artifact = await fetch(`${origin}/api/v1/artifacts/${result.artifactId}`, { headers });
      expect(await artifact.json()).toMatchObject({ kind: "progress_signal", content });
    } finally {
      await server.close();
    }
  });

  it("stages and parses a base64 .eml without placing the email body in the preview", async () => {
    const { server, origin, headers } = await startServer();
    try {
      const jobResponse = await fetch(`${origin}/api/v1/captures/job`, {
        method: "POST",
        headers,
        body: JSON.stringify(jobSnapshot()),
      });
      const job = (await jobResponse.json()) as { applicationId: string };
      const body = "面试邀请：邀请您参加第一轮面试，面试时间为周三 14:00。";
      const email = [
        "From: recruiter@example.invalid",
        "To: candidate@example.invalid",
        "Subject: =?UTF-8?B?6Z2i6K+V6YKA6K+3?=",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(body, "utf8").toString("base64"),
      ].join("\r\n");
      const sessionResponse = await fetch(`${origin}/api/v1/progress-signals/upload-session`, {
        method: "POST",
        headers: { origin: dshOrigin },
      });
      expect(sessionResponse.status).toBe(200);
      const session = (await sessionResponse.json()) as { token: string };
      const uploadResponse = await fetch(`${origin}/api/v1/progress-signals/upload`, {
        method: "POST",
        headers: {
          origin: dshOrigin,
          authorization: `Bearer ${session.token}`,
          "x-boss-watch-file-name": encodeURIComponent("interview.eml"),
        },
        body: Buffer.from(email, "utf8"),
      });
      expect(uploadResponse.status).toBe(201);
      const upload = (await uploadResponse.json()) as { fileName: string; contentHash: string };

      const previewResponse = await fetch(`${origin}/api/v1/progress-signals/preview`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          applicationId: job.applicationId,
          sourceKind: "recruitment_email",
          stagedFileName: upload.fileName,
          sourceHash: upload.contentHash,
          observedAt: "2026-08-14T08:45:00.000Z",
        }),
      });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json();
      expect(preview).toMatchObject({
        applicationId: job.applicationId,
        sourceMode: "staged_file",
        sourceHash: upload.contentHash,
        outcome: "interview",
        proposedStatus: "interview_scheduled",
      });
      expect(JSON.stringify(preview)).not.toContain(body);
    } finally {
      await server.close();
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
