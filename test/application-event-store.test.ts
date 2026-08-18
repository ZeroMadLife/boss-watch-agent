import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApplicationEvent } from "../src/domain/application-event.js";
import { InMemoryApplicationEventStore } from "../src/storage/application-event-store.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jobEvent(overrides: Partial<ApplicationEvent> = {}): ApplicationEvent {
  return {
    schemaVersion: 1,
    eventId: "event-job-001",
    applicationId: "application-demo-001",
    idempotencyKey: "boss:job:job-demo-001",
    traceId: "trace-demo-001",
    occurredAt: "2026-08-14T07:00:00.000Z",
    actor: "agent",
    type: "job_description_captured",
    payload: {
      platform: "boss",
      externalJobId: "job-demo-001",
      company: "示例科技",
      role: "AI Agent 开发工程师",
      jobUrl: "https://www.zhipin.com/job_detail/example.html",
      contentHash: sha256("虚构 JD 内容"),
      artifactRef: "local://artifacts/job-demo-001",
    },
    ...overrides,
  } as ApplicationEvent;
}

describe("InMemoryApplicationEventStore", () => {
  it("keeps JD, conversation, and interview evidence in application order", async () => {
    const store = new InMemoryApplicationEventStore();
    const job = jobEvent();
    const conversation: ApplicationEvent = {
      schemaVersion: 1,
      eventId: "event-message-001",
      applicationId: job.applicationId,
      idempotencyKey: "boss:message:message-demo-001",
      traceId: job.traceId,
      occurredAt: "2026-08-14T07:01:00.000Z",
      actor: "agent",
      type: "recruiter_message_captured",
      payload: {
        conversationId: "conversation-demo-001",
        messageId: "message-demo-001",
        contentHash: sha256("可以发一份简历吗"),
        artifactRef: "local://artifacts/message-demo-001",
      },
    };
    const interview: ApplicationEvent = {
      schemaVersion: 1,
      eventId: "event-interview-001",
      applicationId: job.applicationId,
      idempotencyKey: "manual:interview-note:round-1",
      traceId: "trace-demo-002",
      occurredAt: "2026-08-14T08:00:00.000Z",
      actor: "human",
      type: "interview_note_recorded",
      payload: {
        interviewId: "interview-demo-001",
        stage: "first_interview",
        contentHash: sha256("面试重点：Agent 评测与恢复"),
        artifactRef: "local://artifacts/interview-demo-001",
      },
    };

    await store.append(job);
    await store.append(conversation);
    await store.append(interview);

    expect(await store.list(job.applicationId)).toMatchObject([
      { sequence: 1, type: "job_description_captured" },
      { sequence: 2, type: "recruiter_message_captured" },
      { sequence: 3, type: "interview_note_recorded" },
    ]);
  });

  it("returns the existing event when the same operation is retried", async () => {
    const store = new InMemoryApplicationEventStore();
    const first = await store.append(jobEvent());
    const replay = await store.append(jobEvent({ eventId: "event-job-retry-001" }));

    expect(replay).toEqual(first);
    expect(await store.list("application-demo-001")).toHaveLength(1);
  });

  it("rejects an idempotency key reused for different evidence", async () => {
    const store = new InMemoryApplicationEventStore();
    await store.append(jobEvent());

    await expect(
      store.append(
        jobEvent({
          eventId: "event-job-conflict-001",
          payload: {
            ...jobEvent().payload,
            contentHash: sha256("被修改的 JD 内容"),
          },
        } as Partial<ApplicationEvent>),
      ),
    ).rejects.toThrow("idempotency_key_collision:boss:job:job-demo-001");
  });

  it("scopes idempotency keys to one application", async () => {
    const store = new InMemoryApplicationEventStore();

    await store.append(jobEvent());
    const second = await store.append(
      jobEvent({
        eventId: "event-job-002",
        applicationId: "application-demo-002",
      }),
    );

    expect(second).toMatchObject({
      applicationId: "application-demo-002",
      idempotencyKey: "boss:job:job-demo-001",
      sequence: 1,
    });
  });
});
