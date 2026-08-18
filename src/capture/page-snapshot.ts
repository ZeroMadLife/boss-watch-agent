import { createHash } from "node:crypto";
import { createPageRevisionPayload, normalizeVisibleText } from "./page-revision.js";

interface PageSnapshotBase {
  captureId: string;
  capturedAt: string;
  sourceUrl: string;
  pageRevision: string;
}

export interface JobPageSnapshot extends PageSnapshotBase {
  pageKind: "job_detail";
  externalJobId: string;
  company: string;
  role: string;
  description: string;
}

export interface ConversationPageSnapshot extends PageSnapshotBase {
  pageKind: "conversation";
  applicationId: string;
  conversationId: string;
  messageId: string;
  recruiterName: string;
  messageText: string;
}

export type CapturablePageSnapshot = JobPageSnapshot | ConversationPageSnapshot;

type RevisionInput =
  | Omit<JobPageSnapshot, "pageRevision">
  | JobPageSnapshot
  | Omit<ConversationPageSnapshot, "pageRevision">
  | ConversationPageSnapshot;

export function createPageRevision(snapshot: RevisionInput): string {
  return createHash("sha256").update(createPageRevisionPayload(snapshot), "utf8").digest("hex");
}

export function parseJobPageSnapshot(value: unknown): JobPageSnapshot {
  const record = requireRecord(value);
  if (record.pageKind !== "job_detail") throw new Error("invalid_page_kind");
  const snapshot: JobPageSnapshot = {
    pageKind: "job_detail",
    captureId: requireString(record, "captureId", 128),
    capturedAt: requireTimestamp(record, "capturedAt"),
    sourceUrl: requireBossUrl(record, "sourceUrl"),
    pageRevision: requireRevision(record),
    externalJobId: requireString(record, "externalJobId", 256),
    company: requireString(record, "company", 256),
    role: requireString(record, "role", 256),
    description: requireString(record, "description", 500_000),
  };
  if (snapshot.pageRevision !== createPageRevision(snapshot)) throw new Error("page_revision_mismatch");
  return snapshot;
}

export function parseConversationPageSnapshot(value: unknown): ConversationPageSnapshot {
  const record = requireRecord(value);
  if (record.pageKind !== "conversation") throw new Error("invalid_page_kind");
  const snapshot: ConversationPageSnapshot = {
    pageKind: "conversation",
    captureId: requireString(record, "captureId", 128),
    capturedAt: requireTimestamp(record, "capturedAt"),
    sourceUrl: requireBossUrl(record, "sourceUrl"),
    pageRevision: requireRevision(record),
    applicationId: requireString(record, "applicationId", 256),
    conversationId: requireString(record, "conversationId", 256),
    messageId: requireString(record, "messageId", 256),
    recruiterName: requireString(record, "recruiterName", 256),
    messageText: requireString(record, "messageText", 500_000),
  };
  if (snapshot.pageRevision !== createPageRevision(snapshot)) throw new Error("page_revision_mismatch");
  return snapshot;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_snapshot");
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`invalid_snapshot_field:${key}`);
  const normalized = normalizeVisibleText(value);
  if (normalized.length === 0 || normalized.length > maxLength)
    throw new Error(`invalid_snapshot_field:${key}`);
  return normalized;
}

function requireTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key, 64);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid_snapshot_field:${key}`);
  return value;
}

function requireBossUrl(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key, 2048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("unsupported_source_url");
  }
  if (url.protocol !== "https:" || url.hostname !== "www.zhipin.com")
    throw new Error("unsupported_source_url");
  return normalizeUrl(url.toString());
}

function requireRevision(record: Record<string, unknown>): string {
  const value = requireString(record, "pageRevision", 64);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("invalid_snapshot_field:pageRevision");
  return value;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}
