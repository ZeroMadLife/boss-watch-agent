import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, extname, resolve } from "node:path";
import { convert as htmlToText } from "html-to-text";
import PostalMime, { type Email } from "postal-mime";
import { analyzeConversation } from "../application/analyze-conversation.js";
import {
  classifyProgressSignal,
  normalizeSignalText,
  type ProgressSignalClassification,
} from "../application/progress-signal.js";
import { parseConversationPageSnapshot, parseJobPageSnapshot } from "../capture/page-snapshot.js";
import { type ApplicationArtifactInput, applicationArtifactRef } from "../domain/application-artifact.js";
import type {
  ApplicationEvent,
  ApplicationStatus,
  ProgressSignalOutcome,
  ProgressSignalSourceKind,
  StoredApplicationEvent,
} from "../domain/application-event.js";
import type { ConversationAnalysis } from "../domain/conversation.js";
import type { SqliteApplicationStore, StoredApplicationRecord } from "../storage/sqlite-application-store.js";
import { ApiError } from "./api-error.js";
import type { RuntimeMode } from "./local-api-server.js";

export interface CaptureResult {
  applicationId: string;
  eventId: string;
  artifactId: string;
  artifactRef: string;
  contentHash: string;
  savedAt: string;
  deduplicated: boolean;
}

interface OfficialJobCaptureInput {
  readonly sourceId: string;
  readonly company: string;
  readonly role: string;
  readonly officialJobUrl: string;
  readonly jdText: string;
  readonly capturedAt: string;
}

interface AnalysisRequest {
  eventId: string;
  pageRevision: string;
  mode: "pi" | "baseline";
}

export type InterviewNoteStage =
  | "screening"
  | "first_interview"
  | "second_interview"
  | "final_interview"
  | "other";

export interface InterviewNotePreview {
  readonly previewToken: string;
  readonly applicationId: string;
  readonly interviewId: string;
  readonly stage: InterviewNoteStage;
  readonly contentHash: string;
  readonly contentLength: number;
  readonly expiresAt: string;
  readonly requiresConfirmation: true;
}

export interface InterviewNoteApplyResult extends CaptureResult {
  readonly interviewId: string;
  readonly stage: InterviewNoteStage;
}

export interface ProgressSignalPreview {
  readonly previewToken: string;
  readonly applicationId: string;
  readonly sourceKind: ProgressSignalSourceKind;
  readonly sourceMode: "pasted_text" | "staged_file";
  readonly outcome: ProgressSignalOutcome;
  readonly classifierVersion: string;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly proposedStatus?: string;
  readonly contentHash: string;
  readonly sourceHash: string;
  readonly contentLength: number;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly requiresConfirmation: true;
}

export interface ProgressSignalApplyResult {
  readonly applicationId: string;
  readonly signalEventId: string;
  readonly proposalEventId?: string;
  readonly artifactId: string;
  readonly artifactRef: string;
  readonly contentHash: string;
  readonly savedAt: string;
  readonly outcome: ProgressSignalOutcome;
  readonly proposedStatus?: string;
  readonly deduplicated: boolean;
}

interface PendingInterviewNote {
  readonly previewToken: string;
  readonly applicationId: string;
  readonly interviewId: string;
  readonly stage: InterviewNoteStage;
  readonly content: string;
  readonly contentHash: string;
  readonly occurredAt: string;
  readonly expiresAt: number;
}

interface AppliedInterviewNote {
  readonly result: InterviewNoteApplyResult;
  readonly expiresAt: number;
}

interface PendingProgressSignal {
  readonly applicationId: string;
  readonly sourceKind: ProgressSignalSourceKind;
  readonly sourceMode: "pasted_text" | "staged_file";
  readonly content: string;
  readonly sourceHash: string;
  readonly contentHash: string;
  readonly classification: ProgressSignalClassification;
  readonly observedAt: string;
  readonly expiresAt: number;
}

interface AppliedProgressSignal {
  readonly result: ProgressSignalApplyResult;
  readonly expiresAt: number;
}

export type ManuallyConfirmableApplicationStatus = Extract<
  ApplicationStatus,
  | "submitted"
  | "assessment_scheduled"
  | "assessment_completed"
  | "interview_scheduled"
  | "rejected"
  | "offer"
  | "closed"
>;

export interface ApplicationStatusPreview {
  readonly previewToken: string;
  readonly applicationId: string;
  readonly status: ManuallyConfirmableApplicationStatus;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly requiresConfirmation: true;
  readonly externalAction: "not_performed";
}

export interface ApplicationStatusApplyResult {
  readonly applicationId: string;
  readonly eventId: string;
  readonly status: ManuallyConfirmableApplicationStatus;
  readonly recordedAt: string;
  readonly deduplicated: boolean;
}

interface PendingApplicationStatus {
  readonly applicationId: string;
  readonly status: ManuallyConfirmableApplicationStatus;
  readonly occurredAt: string;
  readonly expiresAt: number;
}

interface AppliedApplicationStatus {
  readonly result: ApplicationStatusApplyResult;
  readonly expiresAt: number;
}

export type PiConversationAnalyzer = (input: {
  conversationId: string;
  messageId: string;
  messageText: string;
  recruiterName: string;
}) => Promise<ConversationAnalysis>;

export class CaptureApi {
  readonly #store: SqliteApplicationStore;
  readonly #runtimeMode: RuntimeMode;
  readonly #piAnalyzer?: PiConversationAnalyzer;
  readonly #now: () => Date;
  readonly #progressSignalRoot: string;
  readonly #interviewNotePreviews = new Map<string, PendingInterviewNote>();
  readonly #interviewNoteApplied = new Map<string, AppliedInterviewNote>();
  readonly #progressSignalPreviews = new Map<string, PendingProgressSignal>();
  readonly #progressSignalApplied = new Map<string, AppliedProgressSignal>();
  readonly #applicationStatusPreviews = new Map<string, PendingApplicationStatus>();
  readonly #applicationStatusApplied = new Map<string, AppliedApplicationStatus>();

  constructor(options: {
    store: SqliteApplicationStore;
    runtimeMode: RuntimeMode;
    piAnalyzer?: PiConversationAnalyzer;
    now?: () => Date;
    progressSignalRoot?: string;
  }) {
    if (options.runtimeMode === "pi_ready" && options.piAnalyzer === undefined) {
      throw new Error("pi_ready_requires_analyzer");
    }
    this.#store = options.store;
    this.#runtimeMode = options.runtimeMode;
    this.#piAnalyzer = options.piAnalyzer;
    this.#now = options.now ?? (() => new Date());
    this.#progressSignalRoot = resolve(options.progressSignalRoot ?? ".");
  }

  async captureJob(value: unknown): Promise<CaptureResult> {
    const snapshot = parseSnapshot(parseJobPageSnapshot, value);
    this.#validateCaptureTime(snapshot.capturedAt);
    const applicationId = this.#store.resolveOrCreateApplicationSource(
      "boss",
      snapshot.externalJobId,
      `application-${randomUUID()}`,
      snapshot.capturedAt,
    );
    const idempotencyKey = `boss:job:${snapshot.externalJobId}:${snapshot.pageRevision}`;
    const existing = this.#store.getRecordByIdempotencyKey(applicationId, idempotencyKey);
    if (existing !== undefined) return captureResult(existing, true);

    const artifactId = `artifact-${randomUUID()}`;
    const contentHash = sha256(snapshot.description);
    const event: Extract<ApplicationEvent, { type: "job_description_captured" }> = {
      schemaVersion: 1,
      eventId: `event-${randomUUID()}`,
      applicationId,
      idempotencyKey,
      traceId: snapshot.captureId,
      occurredAt: snapshot.capturedAt,
      actor: "agent",
      type: "job_description_captured",
      payload: {
        platform: "boss",
        externalJobId: snapshot.externalJobId,
        company: snapshot.company,
        role: snapshot.role,
        jobUrl: snapshot.sourceUrl,
        contentHash,
        artifactRef: applicationArtifactRef(artifactId),
      },
    };
    const artifact = {
      artifactId,
      applicationId,
      kind: "job_description",
      content: snapshot.description,
      createdAt: snapshot.capturedAt,
      metadata: {
        captureId: snapshot.captureId,
        sourceUrl: snapshot.sourceUrl,
        pageRevision: snapshot.pageRevision,
        company: snapshot.company,
        role: snapshot.role,
        externalJobId: snapshot.externalJobId,
      },
    } satisfies ApplicationArtifactInput;
    const record = await this.#appendWithConcurrentReplay(event, artifact, snapshot.pageRevision);
    return captureResult(record, false);
  }

  async captureOfficialJob(value: unknown): Promise<CaptureResult> {
    const input = parseOfficialJobCapture(value);
    this.#validateCaptureTime(input.capturedAt);
    const externalJobId = `official:${sha256(
      [input.sourceId, input.company, input.role, input.officialJobUrl].join("\u0000"),
    )}`;
    const applicationId = this.#store.resolveOrCreateApplicationSource(
      "official_portal",
      externalJobId,
      `application-${randomUUID()}`,
      input.capturedAt,
    );
    const contentHash = sha256(input.jdText);
    const idempotencyKey = `official:job:${externalJobId}:${contentHash}`;
    const existing = this.#store.getRecordByIdempotencyKey(applicationId, idempotencyKey);
    if (existing !== undefined) return captureResult(existing, true);

    const artifactId = `artifact-${randomUUID()}`;
    const event: Extract<ApplicationEvent, { type: "job_description_captured" }> = {
      schemaVersion: 1,
      eventId: `event-${randomUUID()}`,
      applicationId,
      idempotencyKey,
      traceId: input.sourceId,
      occurredAt: input.capturedAt,
      actor: "human",
      type: "job_description_captured",
      payload: {
        platform: "official_portal",
        externalJobId,
        company: input.company,
        role: input.role,
        jobUrl: input.officialJobUrl,
        contentHash,
        artifactRef: applicationArtifactRef(artifactId),
      },
    };
    const artifact = {
      artifactId,
      applicationId,
      kind: "job_description",
      content: input.jdText,
      createdAt: input.capturedAt,
      metadata: {
        sourceId: input.sourceId,
        sourceUrl: input.officialJobUrl,
        pageRevision: contentHash,
        company: input.company,
        role: input.role,
        externalJobId,
      },
    } satisfies ApplicationArtifactInput;
    const record = await this.#appendWithConcurrentReplay(event, artifact, contentHash);
    return captureResult(record, false);
  }

  async captureConversation(value: unknown): Promise<CaptureResult> {
    const snapshot = parseSnapshot(parseConversationPageSnapshot, value);
    this.#validateCaptureTime(snapshot.capturedAt);
    if (!this.#store.hasApplication(snapshot.applicationId)) throw new ApiError(404, "application_not_found");
    const idempotencyKey = [
      "boss:conversation",
      snapshot.conversationId,
      snapshot.messageId,
      snapshot.pageRevision,
    ].join(":");
    const existing = this.#store.getRecordByIdempotencyKey(snapshot.applicationId, idempotencyKey);
    if (existing !== undefined) return captureResult(existing, true);

    const artifactId = `artifact-${randomUUID()}`;
    const contentHash = sha256(snapshot.messageText);
    const event: Extract<ApplicationEvent, { type: "recruiter_message_captured" }> = {
      schemaVersion: 1,
      eventId: `event-${randomUUID()}`,
      applicationId: snapshot.applicationId,
      idempotencyKey,
      traceId: snapshot.captureId,
      occurredAt: snapshot.capturedAt,
      actor: "agent",
      type: "recruiter_message_captured",
      payload: {
        conversationId: snapshot.conversationId,
        messageId: snapshot.messageId,
        contentHash,
        artifactRef: applicationArtifactRef(artifactId),
      },
    };
    const artifact = {
      artifactId,
      applicationId: snapshot.applicationId,
      kind: "recruiter_message",
      content: snapshot.messageText,
      createdAt: snapshot.capturedAt,
      metadata: {
        captureId: snapshot.captureId,
        sourceUrl: snapshot.sourceUrl,
        pageRevision: snapshot.pageRevision,
        conversationId: snapshot.conversationId,
        messageId: snapshot.messageId,
        recruiterName: snapshot.recruiterName,
      },
    } as const;
    const record = await this.#appendWithConcurrentReplay(event, artifact, snapshot.pageRevision);
    return captureResult(record, false);
  }

  previewInterviewNote(value: unknown): InterviewNotePreview {
    const input = parseInterviewNoteInput(value);
    if (!this.#store.hasApplication(input.applicationId)) throw new ApiError(404, "application_not_found");
    this.#validateCaptureTime(input.occurredAt);
    this.#pruneInterviewNotePreviews();
    const previewToken = `interview-note-preview:${randomUUID()}`;
    const expiresAt = this.#now().getTime() + 15 * 60 * 1000;
    this.#interviewNotePreviews.set(previewToken, {
      previewToken,
      applicationId: input.applicationId,
      interviewId: input.interviewId,
      stage: input.stage,
      content: input.content,
      contentHash: sha256(input.content),
      occurredAt: input.occurredAt,
      expiresAt,
    });
    return {
      previewToken,
      applicationId: input.applicationId,
      interviewId: input.interviewId,
      stage: input.stage,
      contentHash: sha256(input.content),
      contentLength: input.content.length,
      expiresAt: new Date(expiresAt).toISOString(),
      requiresConfirmation: true,
    };
  }

  async applyInterviewNote(value: unknown): Promise<InterviewNoteApplyResult> {
    if (
      !isRecord(value) ||
      typeof value.previewToken !== "string" ||
      value.previewToken.trim().length === 0
    ) {
      throw new ApiError(400, "invalid_interview_note_apply");
    }
    if (value.confirmed !== true) throw new ApiError(409, "confirmation_required");
    this.#pruneInterviewNotePreviews();
    const applied = this.#interviewNoteApplied.get(value.previewToken);
    if (applied !== undefined) return { ...applied.result, deduplicated: true };
    const pending = this.#interviewNotePreviews.get(value.previewToken);
    if (pending === undefined) throw new ApiError(404, "interview_note_preview_not_found");
    if (!this.#store.hasApplication(pending.applicationId)) throw new ApiError(404, "application_not_found");

    const artifactId = `artifact-${randomUUID()}`;
    const event: Extract<ApplicationEvent, { type: "interview_note_recorded" }> = {
      schemaVersion: 1,
      eventId: `event-${randomUUID()}`,
      applicationId: pending.applicationId,
      idempotencyKey: `boss:interview-note:${pending.interviewId}:${pending.contentHash}`,
      traceId: `interview-note:${randomUUID()}`,
      occurredAt: pending.occurredAt,
      actor: "human",
      type: "interview_note_recorded",
      payload: {
        interviewId: pending.interviewId,
        stage: pending.stage,
        contentHash: pending.contentHash,
        artifactRef: applicationArtifactRef(artifactId),
      },
    };
    const artifact = {
      artifactId,
      applicationId: pending.applicationId,
      kind: "interview_note",
      content: pending.content,
      createdAt: pending.occurredAt,
      metadata: {
        interviewId: pending.interviewId,
        stage: pending.stage,
        source: "user_manual_entry",
      },
    } satisfies ApplicationArtifactInput;
    let record: StoredApplicationRecord;
    try {
      record = await this.#store.appendWithArtifact(event, artifact);
    } catch (error) {
      if (
        !(error instanceof Error && error.message === `idempotency_key_collision:${event.idempotencyKey}`)
      ) {
        throw error;
      }
      const existing = this.#store.getRecordByIdempotencyKey(event.applicationId, event.idempotencyKey);
      if (existing === undefined || existing.artifact.contentHash !== pending.contentHash) throw error;
      record = existing;
    }
    const result: InterviewNoteApplyResult = {
      ...captureResult(record, record.event.eventId !== event.eventId),
      interviewId: pending.interviewId,
      stage: pending.stage,
    };
    this.#interviewNotePreviews.delete(value.previewToken);
    this.#interviewNoteApplied.set(value.previewToken, { result, expiresAt: pending.expiresAt });
    return result;
  }

  async previewProgressSignal(value: unknown): Promise<ProgressSignalPreview> {
    const input = parseProgressSignalInput(value, this.#now().toISOString());
    if (!this.#store.hasApplication(input.applicationId)) throw new ApiError(404, "application_not_found");
    this.#validateCaptureTime(input.observedAt);
    this.#pruneProgressSignalPreviews();
    const loaded = await loadProgressSignalContent(input, this.#progressSignalRoot);
    const classification = classifyProgressSignal(loaded.classifierText, input.declaredOutcome);
    const contentHash = sha256(loaded.content);
    const previewToken = `progress-signal-preview:${randomUUID()}`;
    const expiresAt = this.#now().getTime() + 15 * 60 * 1000;
    this.#progressSignalPreviews.set(previewToken, {
      applicationId: input.applicationId,
      sourceKind: input.sourceKind,
      sourceMode: loaded.sourceMode,
      content: loaded.content,
      sourceHash: loaded.sourceHash,
      contentHash,
      classification,
      observedAt: input.observedAt,
      expiresAt,
    });
    return {
      previewToken,
      applicationId: input.applicationId,
      sourceKind: input.sourceKind,
      sourceMode: loaded.sourceMode,
      outcome: classification.outcome,
      classifierVersion: classification.classifierVersion,
      confidence: classification.confidence,
      reasonCodes: classification.reasonCodes,
      ...(classification.proposedStatus === undefined
        ? {}
        : { proposedStatus: classification.proposedStatus }),
      contentHash,
      sourceHash: loaded.sourceHash,
      contentLength: loaded.content.length,
      observedAt: input.observedAt,
      expiresAt: new Date(expiresAt).toISOString(),
      requiresConfirmation: true,
    };
  }

  async applyProgressSignal(value: unknown): Promise<ProgressSignalApplyResult> {
    if (
      !isRecord(value) ||
      typeof value.previewToken !== "string" ||
      value.previewToken.trim().length === 0
    ) {
      throw new ApiError(400, "invalid_progress_signal_apply");
    }
    if (value.confirmed !== true) throw new ApiError(409, "confirmation_required");
    this.#pruneProgressSignalPreviews();
    const alreadyApplied = this.#progressSignalApplied.get(value.previewToken);
    if (alreadyApplied !== undefined) return { ...alreadyApplied.result, deduplicated: true };
    const pending = this.#progressSignalPreviews.get(value.previewToken);
    if (pending === undefined) throw new ApiError(404, "progress_signal_preview_not_found");
    if (!this.#store.hasApplication(pending.applicationId)) throw new ApiError(404, "application_not_found");

    const artifactId = `artifact-${randomUUID()}`;
    const signalId = `progress-signal-${sha256(`${pending.applicationId}\u0000${pending.sourceKind}\u0000${pending.contentHash}`).slice(0, 32)}`;
    const signalEvent: Extract<ApplicationEvent, { type: "progress_signal_recorded" }> = {
      schemaVersion: 1,
      eventId: `event-${randomUUID()}`,
      applicationId: pending.applicationId,
      idempotencyKey: `progress-signal:${pending.sourceKind}:${pending.classification.classifierVersion}:${pending.contentHash}`,
      traceId: `progress-signal:${randomUUID()}`,
      occurredAt: pending.observedAt,
      actor: "human",
      type: "progress_signal_recorded",
      payload: {
        signalId,
        sourceKind: pending.sourceKind,
        outcome: pending.classification.outcome,
        classifierVersion: pending.classification.classifierVersion,
        confidence: pending.classification.confidence,
        reasonCodes: [...pending.classification.reasonCodes],
        contentHash: pending.contentHash,
        artifactRef: applicationArtifactRef(artifactId),
      },
    };
    const artifact = {
      artifactId,
      applicationId: pending.applicationId,
      kind: "progress_signal",
      content: pending.content,
      createdAt: pending.observedAt,
      metadata: {
        sourceKind: pending.sourceKind,
        sourceMode: pending.sourceMode,
        outcome: pending.classification.outcome,
        classifierVersion: pending.classification.classifierVersion,
        confidence: pending.classification.confidence,
        reasonCodes: [...pending.classification.reasonCodes],
      },
    } satisfies ApplicationArtifactInput;
    let record: StoredApplicationRecord;
    try {
      record = await this.#store.appendWithArtifact(signalEvent, artifact);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          error.message === `idempotency_key_collision:${signalEvent.idempotencyKey}`
        )
      ) {
        throw error;
      }
      const existing = this.#store.getRecordByIdempotencyKey(
        signalEvent.applicationId,
        signalEvent.idempotencyKey,
      );
      if (
        existing === undefined ||
        existing.event.type !== "progress_signal_recorded" ||
        existing.artifact.contentHash !== pending.contentHash
      ) {
        throw error;
      }
      record = existing;
    }

    let proposal: StoredApplicationEvent | undefined;
    if (pending.classification.proposedStatus !== undefined) {
      const proposalEvent: Extract<ApplicationEvent, { type: "status_change_proposed" }> = {
        schemaVersion: 1,
        eventId: `event-${randomUUID()}`,
        applicationId: pending.applicationId,
        idempotencyKey: `progress-signal-status:${record.event.eventId}:${pending.classification.proposedStatus}`,
        traceId: `progress-signal-proposal:${record.event.eventId}`,
        occurredAt: record.event.occurredAt,
        actor: "agent",
        type: "status_change_proposed",
        payload: {
          proposalId: `proposal-${sha256(`${record.event.eventId}\u0000${pending.classification.proposedStatus}`).slice(0, 32)}`,
          to: pending.classification.proposedStatus,
          evidenceEventIds: [record.event.eventId],
        },
      };
      proposal = await this.#store.append(proposalEvent);
    }

    const result: ProgressSignalApplyResult = {
      applicationId: pending.applicationId,
      signalEventId: record.event.eventId,
      ...(proposal === undefined ? {} : { proposalEventId: proposal.eventId }),
      artifactId: record.artifact.artifactId,
      artifactRef: record.artifact.artifactRef,
      contentHash: record.artifact.contentHash,
      savedAt: record.artifact.createdAt,
      outcome: pending.classification.outcome,
      ...(pending.classification.proposedStatus === undefined
        ? {}
        : { proposedStatus: pending.classification.proposedStatus }),
      deduplicated: record.event.eventId !== signalEvent.eventId,
    };
    this.#progressSignalPreviews.delete(value.previewToken);
    this.#progressSignalApplied.set(value.previewToken, { result, expiresAt: pending.expiresAt });
    return result;
  }

  previewApplicationStatus(value: unknown): ApplicationStatusPreview {
    const input = parseApplicationStatusInput(value, this.#now().toISOString());
    if (!this.#store.hasApplication(input.applicationId)) throw new ApiError(404, "application_not_found");
    this.#validateCaptureTime(input.occurredAt);
    this.#pruneApplicationStatusPreviews();
    const previewToken = `application-status-preview:${randomUUID()}`;
    const expiresAt = this.#now().getTime() + 15 * 60 * 1000;
    this.#applicationStatusPreviews.set(previewToken, { ...input, expiresAt });
    return {
      previewToken,
      applicationId: input.applicationId,
      status: input.status,
      occurredAt: input.occurredAt,
      expiresAt: new Date(expiresAt).toISOString(),
      requiresConfirmation: true,
      externalAction: "not_performed",
    };
  }

  async applyApplicationStatus(value: unknown): Promise<ApplicationStatusApplyResult> {
    if (
      !isRecord(value) ||
      typeof value.previewToken !== "string" ||
      value.previewToken.trim().length === 0
    ) {
      throw new ApiError(400, "invalid_application_status_apply");
    }
    if (value.confirmed !== true) throw new ApiError(409, "confirmation_required");
    this.#pruneApplicationStatusPreviews();
    const applied = this.#applicationStatusApplied.get(value.previewToken);
    if (applied !== undefined) return { ...applied.result, deduplicated: true };
    const pending = this.#applicationStatusPreviews.get(value.previewToken);
    if (pending === undefined) throw new ApiError(404, "application_status_preview_not_found");
    if (!this.#store.hasApplication(pending.applicationId)) throw new ApiError(404, "application_not_found");
    const identityHash = sha256(`${pending.applicationId}\u0000${pending.status}\u0000${pending.occurredAt}`);
    const event: Extract<ApplicationEvent, { type: "status_change_confirmed" }> = {
      schemaVersion: 1,
      eventId: `event-${randomUUID()}`,
      applicationId: pending.applicationId,
      idempotencyKey: `manual-status:${pending.status}:${pending.occurredAt}`,
      traceId: `manual-status:${identityHash}`,
      occurredAt: pending.occurredAt,
      actor: "human",
      type: "status_change_confirmed",
      payload: { to: pending.status, source: "user_manual_confirmation" },
    };
    const stored = await this.#store.append(event);
    const result: ApplicationStatusApplyResult = {
      applicationId: pending.applicationId,
      eventId: stored.eventId,
      status: pending.status,
      recordedAt: stored.occurredAt,
      deduplicated: stored.eventId !== event.eventId,
    };
    this.#applicationStatusPreviews.delete(value.previewToken);
    this.#applicationStatusApplied.set(value.previewToken, { result, expiresAt: pending.expiresAt });
    return result;
  }

  async analyzeConversation(value: unknown): Promise<{
    mode: "pi" | "baseline";
    eventId: string;
    artifactId: string;
    analysis: ConversationAnalysis;
  }> {
    const request = parseAnalysisRequest(value);
    if (request.mode === "pi" && (this.#runtimeMode !== "pi_ready" || this.#piAnalyzer === undefined)) {
      throw new ApiError(409, "pi_not_ready");
    }
    if (request.mode === "baseline" && this.#runtimeMode === "capture_only") {
      throw new ApiError(409, "analysis_not_ready");
    }

    const record = this.#store.getRecordByEventId(request.eventId);
    if (record === undefined || record.event.type !== "recruiter_message_captured") {
      throw new ApiError(404, "conversation_evidence_not_found");
    }
    const metadata = record.artifact.metadata;
    if (metadata?.pageRevision !== request.pageRevision) throw new ApiError(409, "stale_page_revision");
    const recruiterName = typeof metadata.recruiterName === "string" ? metadata.recruiterName : "recruiter";

    let analysis: ConversationAnalysis;
    if (request.mode === "pi") {
      const piAnalyzer = this.#piAnalyzer;
      if (piAnalyzer === undefined) throw new ApiError(409, "pi_not_ready");
      analysis = await piAnalyzer({
        conversationId: record.event.payload.conversationId,
        messageId: record.event.payload.messageId,
        messageText: record.artifact.content,
        recruiterName,
      });
    } else {
      analysis = analyzeConversation({
        conversationId: record.event.payload.conversationId,
        candidateId: "local-candidate",
        recruiterId: recruiterName,
        messages: [
          {
            id: record.event.payload.messageId,
            actor: "recruiter",
            text: record.artifact.content,
            sentAt: record.artifact.createdAt,
          },
        ],
      });
    }

    return {
      mode: request.mode,
      eventId: record.event.eventId,
      artifactId: record.artifact.artifactId,
      analysis,
    };
  }

  async #appendWithConcurrentReplay(
    event: Extract<ApplicationEvent, { type: "job_description_captured" | "recruiter_message_captured" }>,
    artifact: Parameters<SqliteApplicationStore["appendWithArtifact"]>[1],
    pageRevision: string,
  ): Promise<StoredApplicationRecord> {
    try {
      return await this.#store.appendWithArtifact(event, artifact);
    } catch (error) {
      if (
        !(error instanceof Error && error.message === `idempotency_key_collision:${event.idempotencyKey}`)
      ) {
        throw error;
      }
      const existing = this.#store.getRecordByIdempotencyKey(event.applicationId, event.idempotencyKey);
      if (
        existing === undefined ||
        existing.artifact.contentHash !== sha256(artifact.content) ||
        existing.artifact.metadata?.pageRevision !== pageRevision
      ) {
        throw error;
      }
      return existing;
    }
  }

  #validateCaptureTime(capturedAt: string): void {
    if (Date.parse(capturedAt) > this.#now().getTime() + 5 * 60 * 1000) {
      throw new ApiError(400, "invalid_capture_timestamp");
    }
  }

  #pruneInterviewNotePreviews(): void {
    const now = this.#now().getTime();
    for (const [token, preview] of this.#interviewNotePreviews) {
      if (preview.expiresAt <= now) this.#interviewNotePreviews.delete(token);
    }
    for (const [token, applied] of this.#interviewNoteApplied) {
      if (applied.expiresAt <= now) this.#interviewNoteApplied.delete(token);
    }
  }

  #pruneProgressSignalPreviews(): void {
    const now = this.#now().getTime();
    for (const [token, preview] of this.#progressSignalPreviews) {
      if (preview.expiresAt <= now) this.#progressSignalPreviews.delete(token);
    }
    for (const [token, applied] of this.#progressSignalApplied) {
      if (applied.expiresAt <= now) this.#progressSignalApplied.delete(token);
    }
  }

  #pruneApplicationStatusPreviews(): void {
    const now = this.#now().getTime();
    for (const [token, preview] of this.#applicationStatusPreviews) {
      if (preview.expiresAt <= now) this.#applicationStatusPreviews.delete(token);
    }
    for (const [token, applied] of this.#applicationStatusApplied) {
      if (applied.expiresAt <= now) this.#applicationStatusApplied.delete(token);
    }
  }
}

function captureResult(record: StoredApplicationRecord, deduplicated: boolean): CaptureResult {
  return {
    applicationId: record.event.applicationId,
    eventId: record.event.eventId,
    artifactId: record.artifact.artifactId,
    artifactRef: record.artifact.artifactRef,
    contentHash: record.artifact.contentHash,
    savedAt: record.artifact.createdAt,
    deduplicated,
  };
}

function parseSnapshot<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "invalid_snapshot");
  }
}

function parseOfficialJobCapture(value: unknown): OfficialJobCaptureInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_official_job_capture");
  }
  const record = value as Record<string, unknown>;
  const sourceId = officialJobText(record.sourceId, "official_job_source_id_required", 256);
  const company = officialJobText(record.company, "official_job_company_required", 200);
  const role = officialJobText(record.role, "official_job_role_required", 240);
  const jdText = officialJobText(record.jdText, "official_job_jd_required", 400 * 1024, false);
  const capturedAt = officialJobText(record.capturedAt, "official_job_capture_time_required", 64);
  if (!Number.isFinite(Date.parse(capturedAt))) throw new ApiError(400, "invalid_capture_timestamp");
  return {
    sourceId,
    company,
    role,
    officialJobUrl: normalizeOfficialJobUrl(record.officialJobUrl),
    jdText,
    capturedAt,
  };
}

function officialJobText(value: unknown, code: string, maxLength: number, collapseWhitespace = true): string {
  if (typeof value !== "string") throw new ApiError(400, code);
  const normalized = collapseWhitespace
    ? Array.from(value.trim(), (character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
      })
        .join("")
        .replace(/\s+/gu, " ")
    : value.replaceAll("\r\n", "\n").trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new ApiError(400, code);
  return normalized;
}

function normalizeOfficialJobUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096) {
    throw new ApiError(400, "official_job_url_invalid");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiError(400, "official_job_url_invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port.length > 0 && url.port !== "443") ||
    hostname.length === 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIP(hostname) !== 0
  ) {
    throw new ApiError(400, "official_job_url_invalid");
  }
  return url.toString();
}

function parseAnalysisRequest(value: unknown): AnalysisRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_analysis_request");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.eventId !== "string" ||
    record.eventId.trim().length === 0 ||
    typeof record.pageRevision !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.pageRevision) ||
    (record.mode !== "pi" && record.mode !== "baseline")
  ) {
    throw new ApiError(400, "invalid_analysis_request");
  }
  return { eventId: record.eventId, pageRevision: record.pageRevision, mode: record.mode };
}

interface InterviewNoteInput {
  applicationId: string;
  interviewId: string;
  stage: InterviewNoteStage;
  content: string;
  occurredAt: string;
}

type ProgressSignalInput = {
  applicationId: string;
  sourceKind: ProgressSignalSourceKind;
  observedAt: string;
  declaredOutcome?: ProgressSignalOutcome;
} & (
  | { content: string; stagedFileName?: never; sourceHash?: never }
  | { stagedFileName: string; sourceHash: string; content?: never }
);

function parseApplicationStatusInput(
  value: unknown,
  defaultOccurredAt: string,
): { applicationId: string; status: ManuallyConfirmableApplicationStatus; occurredAt: string } {
  if (!isRecord(value)) throw new ApiError(400, "invalid_application_status");
  const applicationId = stringField(value.applicationId, 256);
  const statuses: ManuallyConfirmableApplicationStatus[] = [
    "submitted",
    "assessment_scheduled",
    "assessment_completed",
    "interview_scheduled",
    "rejected",
    "offer",
    "closed",
  ];
  if (
    applicationId === undefined ||
    !statuses.includes(value.status as ManuallyConfirmableApplicationStatus)
  ) {
    throw new ApiError(400, "invalid_application_status");
  }
  const occurredAt = value.occurredAt === undefined ? defaultOccurredAt : stringField(value.occurredAt, 64);
  if (occurredAt === undefined || !Number.isFinite(Date.parse(occurredAt))) {
    throw new ApiError(400, "invalid_application_status_timestamp");
  }
  return { applicationId, status: value.status as ManuallyConfirmableApplicationStatus, occurredAt };
}

function parseInterviewNoteInput(value: unknown): InterviewNoteInput {
  if (!isRecord(value)) throw new ApiError(400, "invalid_interview_note");
  const applicationId = stringField(value.applicationId, 256);
  const interviewId = stringField(value.interviewId, 256);
  const content = stringField(value.content, 500_000);
  const stages: InterviewNoteStage[] = [
    "screening",
    "first_interview",
    "second_interview",
    "final_interview",
    "other",
  ];
  if (
    applicationId === undefined ||
    interviewId === undefined ||
    content === undefined ||
    !stages.includes(value.stage as InterviewNoteStage)
  ) {
    throw new ApiError(400, "invalid_interview_note");
  }
  const occurredAt =
    value.occurredAt === undefined ? new Date().toISOString() : stringField(value.occurredAt, 64);
  if (occurredAt === undefined || !Number.isFinite(Date.parse(occurredAt)))
    throw new ApiError(400, "invalid_interview_note_timestamp");
  return { applicationId, interviewId, stage: value.stage as InterviewNoteStage, content, occurredAt };
}

function parseProgressSignalInput(value: unknown, defaultObservedAt: string): ProgressSignalInput {
  if (!isRecord(value)) throw new ApiError(400, "invalid_progress_signal");
  const applicationId = stringField(value.applicationId, 256);
  const sourceKinds: ProgressSignalSourceKind[] = [
    "recruitment_email",
    "interview_invitation",
    "recruiter_message",
    "manual_update",
  ];
  const outcomes: ProgressSignalOutcome[] = ["interview", "rejected", "offer", "needs_review"];
  if (applicationId === undefined || !sourceKinds.includes(value.sourceKind as ProgressSignalSourceKind)) {
    throw new ApiError(400, "invalid_progress_signal");
  }
  const sourceKind = value.sourceKind as ProgressSignalSourceKind;
  const declaredOutcome = outcomes.includes(value.declaredOutcome as ProgressSignalOutcome)
    ? (value.declaredOutcome as ProgressSignalOutcome)
    : undefined;
  if (
    (sourceKind === "manual_update" && declaredOutcome === undefined) ||
    (sourceKind !== "manual_update" && value.declaredOutcome !== undefined)
  ) {
    throw new ApiError(400, "invalid_progress_signal_outcome");
  }
  const observedAt = value.observedAt === undefined ? defaultObservedAt : stringField(value.observedAt, 64);
  if (observedAt === undefined || !Number.isFinite(Date.parse(observedAt))) {
    throw new ApiError(400, "invalid_progress_signal_timestamp");
  }
  const content = stringField(value.content, 500_000);
  const stagedFileName = stringField(value.stagedFileName, 300);
  const sourceHash =
    typeof value.sourceHash === "string" && /^[a-f0-9]{64}$/u.test(value.sourceHash)
      ? value.sourceHash
      : undefined;
  if ((content === undefined) === (stagedFileName === undefined)) {
    throw new ApiError(400, "progress_signal_source_required");
  }
  if (stagedFileName !== undefined && sourceHash === undefined) {
    throw new ApiError(400, "progress_signal_source_hash_required");
  }
  const base = {
    applicationId,
    sourceKind,
    observedAt,
    ...(declaredOutcome === undefined ? {} : { declaredOutcome }),
  };
  return content !== undefined
    ? { ...base, content }
    : { ...base, stagedFileName: stagedFileName as string, sourceHash: sourceHash as string };
}

async function loadProgressSignalContent(
  input: ProgressSignalInput,
  progressSignalRoot: string,
): Promise<{
  content: string;
  classifierText: string;
  sourceHash: string;
  sourceMode: "pasted_text" | "staged_file";
}> {
  if (typeof input.content === "string") {
    const content = normalizeSignalText(input.content);
    return {
      content,
      classifierText: content,
      sourceHash: sha256(content),
      sourceMode: "pasted_text",
    };
  }
  const fileName = input.stagedFileName;
  if (fileName !== basename(fileName) || !/^dsh-[a-f0-9]{64}-.+\.(?:eml|txt)$/iu.test(fileName)) {
    throw new ApiError(400, "invalid_progress_signal_file");
  }
  const target = resolve(progressSignalRoot, fileName);
  if (dirname(target) !== resolve(progressSignalRoot))
    throw new ApiError(400, "progress_signal_file_outside_root");
  let bytes: Buffer;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 2 * 1024 * 1024) {
      throw new ApiError(400, "invalid_progress_signal_file");
    }
    bytes = await readFile(target);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(404, "progress_signal_file_not_found");
  }
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  if (sourceHash !== input.sourceHash) throw new ApiError(409, "progress_signal_file_hash_mismatch");
  const content = normalizeSignalText(bytes.toString("utf8"));
  if (content.length === 0) throw new ApiError(400, "invalid_progress_signal_content");
  if (extname(fileName).toLowerCase() === ".txt") {
    return { content, classifierText: content, sourceHash, sourceMode: "staged_file" };
  }
  let email: Email;
  try {
    email = await PostalMime.parse(bytes, { attachmentEncoding: "base64", maxNestingDepth: 10 });
  } catch {
    throw new ApiError(400, "progress_signal_email_parse_failed");
  }
  const classifierText = normalizeSignalText(
    [
      email.subject,
      email.text,
      email.html === undefined
        ? undefined
        : htmlToText(email.html, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }] }),
    ]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n"),
  );
  if (classifierText.length === 0) throw new ApiError(400, "progress_signal_email_body_missing");
  return { content, classifierText, sourceHash, sourceMode: "staged_file" };
}

function stringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
