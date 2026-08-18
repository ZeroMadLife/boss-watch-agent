import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApplicationArtifactInput,
  ApplicationArtifactKind,
  StoredApplicationArtifact,
} from "../domain/application-artifact.js";
import { applicationArtifactRef } from "../domain/application-artifact.js";
import type {
  ApplicationArtifactEvent,
  ApplicationEvent,
  StoredApplicationEvent,
} from "../domain/application-event.js";
import { isApplicationArtifactEvent } from "../domain/application-event.js";
import type { ApplicationEventStore } from "./application-event-store.js";
import {
  canonicalJson,
  sameApplicationEventOperation,
  validateApplicationEvent,
} from "./application-event-store.js";

const SCHEMA_VERSION = 4;

interface EventRow {
  event_json: string;
  sequence: number;
  artifact_id: string | null;
}

interface ArtifactRow {
  artifact_id: string;
  application_id: string;
  kind: ApplicationArtifactKind;
  content: string;
  content_hash: string;
  artifact_ref: string;
  created_at: string;
  metadata_json: string;
}

interface StoredEventRow {
  event: StoredApplicationEvent;
  artifactId: string | null;
}

export interface StoredApplicationRecord {
  event: StoredApplicationEvent;
  artifact: StoredApplicationArtifact;
}

export class SqliteApplicationStore implements ApplicationEventStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error("invalid_database_path");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    this.#database = new DatabaseSync(path);
    try {
      this.#configure();
      this.#migrate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  async append(event: ApplicationEvent): Promise<StoredApplicationEvent> {
    this.#ensureOpen();
    validateApplicationEvent(event);
    if (isApplicationArtifactEvent(event)) throw new Error("artifact_required_for_evidence_event");

    return this.#transaction(() => this.#appendEvent(event, null));
  }

  async appendWithArtifact(
    event: ApplicationEvent,
    artifact: ApplicationArtifactInput,
  ): Promise<StoredApplicationRecord> {
    this.#ensureOpen();
    validateApplicationEvent(event);
    if (!isApplicationArtifactEvent(event)) throw new Error("artifact_not_supported_for_event");
    const candidate = prepareArtifact(artifact);
    validateArtifactEvent(event, candidate);

    return this.#transaction(() => {
      const existingByKey = this.#findEventByIdempotencyKey(event.applicationId, event.idempotencyKey);
      if (existingByKey !== undefined) {
        if (!sameApplicationEventOperation(existingByKey.event, event)) {
          throw new Error(`idempotency_key_collision:${event.idempotencyKey}`);
        }
        return this.#existingRecord(
          existingByKey,
          candidate,
          `idempotency_key_collision:${event.idempotencyKey}`,
        );
      }

      const existingById = this.#findEventById(event.eventId);
      if (existingById !== undefined) {
        if (!sameApplicationEventOperation(existingById.event, event)) {
          throw new Error(`event_id_collision:${event.eventId}`);
        }
        return this.#existingRecord(existingById, candidate, `event_id_collision:${event.eventId}`);
      }

      if (this.#findArtifactById(candidate.artifactId) !== undefined) {
        throw new Error(`artifact_id_collision:${candidate.artifactId}`);
      }

      this.#insertArtifact(candidate);
      const storedEvent = this.#insertEvent(event, candidate.artifactId);
      return { event: storedEvent, artifact: structuredClone(candidate) };
    });
  }

  async list(applicationId: string): Promise<StoredApplicationEvent[]> {
    this.#ensureOpen();
    const rows = this.#database
      .prepare(
        `SELECT event_json, sequence, artifact_id
         FROM application_events
         WHERE application_id = ?
         ORDER BY sequence ASC`,
      )
      .all(applicationId) as unknown as EventRow[];
    return rows.map((row) => this.#eventFromRow(row).event);
  }

  async listArtifacts(applicationId: string): Promise<StoredApplicationArtifact[]> {
    this.#ensureOpen();
    const rows = this.#database
      .prepare(
        `SELECT artifact_id, application_id, kind, content, content_hash, artifact_ref, created_at,
                metadata_json
         FROM application_artifacts
         WHERE application_id = ?
         ORDER BY created_at ASC, artifact_id ASC`,
      )
      .all(applicationId) as unknown as ArtifactRow[];
    return rows.map(artifactFromRow);
  }

  async listApplicationIds(): Promise<string[]> {
    this.#ensureOpen();
    const rows = this.#database
      .prepare(
        `SELECT application_id
         FROM (
           SELECT application_id FROM application_events
           UNION
           SELECT application_id FROM application_artifacts
         )
         ORDER BY application_id ASC`,
      )
      .all() as unknown as Array<{ application_id: string }>;
    return rows.map((row) => row.application_id);
  }

  resolveOrCreateApplicationSource(
    platform: string,
    externalJobId: string,
    candidateApplicationId: string,
    createdAt: string,
  ): string {
    this.#ensureOpen();
    if ([platform, externalJobId, candidateApplicationId].some((value) => value.trim().length === 0)) {
      throw new Error("invalid_application_source");
    }
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error("invalid_application_source_timestamp");

    return this.#transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT application_id
           FROM application_sources
           WHERE platform = ? AND external_job_id = ?`,
        )
        .get(platform, externalJobId) as { application_id: string } | undefined;
      if (existing !== undefined) return existing.application_id;

      this.#database
        .prepare(
          `INSERT INTO application_sources (platform, external_job_id, application_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(platform, externalJobId, candidateApplicationId, createdAt);
      return candidateApplicationId;
    });
  }

  hasApplication(applicationId: string): boolean {
    this.#ensureOpen();
    const row = this.#database
      .prepare(
        `SELECT 1 AS present
         FROM (
           SELECT application_id FROM application_sources
           UNION ALL
           SELECT application_id FROM application_events
           UNION ALL
           SELECT application_id FROM application_artifacts
         )
         WHERE application_id = ?
         LIMIT 1`,
      )
      .get(applicationId) as { present: number } | undefined;
    return row?.present === 1;
  }

  getRecordByIdempotencyKey(
    applicationId: string,
    idempotencyKey: string,
  ): StoredApplicationRecord | undefined {
    this.#ensureOpen();
    const row = this.#findEventByIdempotencyKey(applicationId, idempotencyKey);
    return row === undefined ? undefined : this.#recordFromStoredEventRow(row);
  }

  getRecordByEventId(eventId: string): StoredApplicationRecord | undefined {
    this.#ensureOpen();
    const row = this.#findEventById(eventId);
    return row === undefined ? undefined : this.#recordFromStoredEventRow(row);
  }

  getArtifact(artifactId: string): StoredApplicationArtifact | undefined {
    this.#ensureOpen();
    const artifact = this.#findArtifactById(artifactId);
    return artifact === undefined ? undefined : structuredClone(artifact);
  }

  authorizeExtensionClient(extensionId: string, tokenHash: string, createdAt: string): void {
    this.#ensureOpen();
    if (!/^[a-p]{32}$/u.test(extensionId)) throw new Error("invalid_extension_id");
    if (!/^[a-f0-9]{64}$/u.test(tokenHash)) throw new Error("invalid_client_token_hash");
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error("invalid_client_timestamp");

    this.#database
      .prepare(
        `INSERT INTO authorized_extension_clients (extension_id, token_hash, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (extension_id) DO UPDATE SET
           token_hash = excluded.token_hash,
           created_at = excluded.created_at`,
      )
      .run(extensionId, tokenHash, createdAt);
  }

  isExtensionClientAuthorized(extensionId: string, tokenHash: string): boolean {
    this.#ensureOpen();
    if (!/^[a-p]{32}$/u.test(extensionId) || !/^[a-f0-9]{64}$/u.test(tokenHash)) return false;
    const row = this.#database
      .prepare(
        `SELECT 1 AS authorized
         FROM authorized_extension_clients
         WHERE extension_id = ? AND token_hash = ?`,
      )
      .get(extensionId, tokenHash) as { authorized: number } | undefined;
    return row?.authorized === 1;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #configure(): void {
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);
  }

  #migrate(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    const version = versionRow?.user_version ?? 0;
    if (version > SCHEMA_VERSION) throw new Error(`unsupported_database_version:${version}`);

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS application_artifacts (
        artifact_id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('job_description', 'recruiter_message', 'interview_note', 'progress_signal')),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        artifact_ref TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS application_artifacts_application_id
        ON application_artifacts(application_id, created_at, artifact_id);

      CREATE TABLE IF NOT EXISTS application_events (
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

      CREATE INDEX IF NOT EXISTS application_events_application_id
        ON application_events(application_id, sequence);

      CREATE TABLE IF NOT EXISTS authorized_extension_clients (
        extension_id TEXT PRIMARY KEY CHECK (length(extension_id) = 32),
        token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS application_sources (
        platform TEXT NOT NULL,
        external_job_id TEXT NOT NULL,
        application_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (platform, external_job_id)
      );

    `);
    if (version > 0 && version < 4) this.#upgradeArtifactKindsToV4();
    this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  #upgradeArtifactKindsToV4(): void {
    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.#database.exec(`
        BEGIN IMMEDIATE;

        CREATE TABLE application_artifacts_v4 (
          artifact_id TEXT PRIMARY KEY,
          application_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('job_description', 'recruiter_message', 'interview_note', 'progress_signal')),
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          artifact_ref TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );

        INSERT INTO application_artifacts_v4
          SELECT artifact_id, application_id, kind, content, content_hash, artifact_ref, created_at, metadata_json
          FROM application_artifacts;

        CREATE TABLE application_events_v4 (
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
          FOREIGN KEY (artifact_id) REFERENCES application_artifacts_v4(artifact_id)
        );

        INSERT INTO application_events_v4
          SELECT event_id, application_id, sequence, idempotency_key, trace_id, occurred_at, actor,
                 event_type, event_json, artifact_id
          FROM application_events;

        DROP TABLE application_events;
        DROP TABLE application_artifacts;
        ALTER TABLE application_artifacts_v4 RENAME TO application_artifacts;
        ALTER TABLE application_events_v4 RENAME TO application_events;

        CREATE INDEX application_artifacts_application_id
          ON application_artifacts(application_id, created_at, artifact_id);
        CREATE INDEX application_events_application_id
          ON application_events(application_id, sequence);

        COMMIT;
      `);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the migration error when SQLite already rolled back.
      }
      throw error;
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #appendEvent(event: ApplicationEvent, artifactId: string | null): StoredApplicationEvent {
    const existingByKey = this.#findEventByIdempotencyKey(event.applicationId, event.idempotencyKey);
    if (existingByKey !== undefined) {
      if (sameApplicationEventOperation(existingByKey.event, event)) {
        return structuredClone(existingByKey.event);
      }
      throw new Error(`idempotency_key_collision:${event.idempotencyKey}`);
    }

    const existingById = this.#findEventById(event.eventId);
    if (existingById !== undefined) {
      if (sameApplicationEventOperation(existingById.event, event)) {
        return structuredClone(existingById.event);
      }
      throw new Error(`event_id_collision:${event.eventId}`);
    }

    return this.#insertEvent(event, artifactId);
  }

  #insertEvent(event: ApplicationEvent, artifactId: string | null): StoredApplicationEvent {
    const sequenceRow = this.#database
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM application_events
         WHERE application_id = ?`,
      )
      .get(event.applicationId) as { next_sequence: number };
    const stored: StoredApplicationEvent = { ...structuredClone(event), sequence: sequenceRow.next_sequence };
    this.#database
      .prepare(
        `INSERT INTO application_events (
           event_id, application_id, sequence, idempotency_key, trace_id, occurred_at, actor,
           event_type, event_json, artifact_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.applicationId,
        stored.sequence,
        event.idempotencyKey,
        event.traceId,
        event.occurredAt,
        event.actor,
        event.type,
        JSON.stringify(event),
        artifactId,
      );
    return stored;
  }

  #insertArtifact(artifact: StoredApplicationArtifact): void {
    this.#database
      .prepare(
        `INSERT INTO application_artifacts (
           artifact_id, application_id, kind, content, content_hash, artifact_ref, created_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.artifactId,
        artifact.applicationId,
        artifact.kind,
        artifact.content,
        artifact.contentHash,
        artifact.artifactRef,
        artifact.createdAt,
        JSON.stringify(artifact.metadata ?? null),
      );
  }

  #findEventByIdempotencyKey(applicationId: string, idempotencyKey: string): StoredEventRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT event_json, sequence, artifact_id
         FROM application_events
         WHERE application_id = ? AND idempotency_key = ?`,
      )
      .get(applicationId, idempotencyKey) as EventRow | undefined;
    return row === undefined ? undefined : this.#eventFromRow(row);
  }

  #findEventById(eventId: string): StoredEventRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT event_json, sequence, artifact_id
         FROM application_events
         WHERE event_id = ?`,
      )
      .get(eventId) as EventRow | undefined;
    return row === undefined ? undefined : this.#eventFromRow(row);
  }

  #eventFromRow(row: EventRow): StoredEventRow {
    const event = JSON.parse(row.event_json) as ApplicationEvent;
    validateApplicationEvent(event);
    return { event: { ...event, sequence: row.sequence }, artifactId: row.artifact_id };
  }

  #findArtifactById(artifactId: string): StoredApplicationArtifact | undefined {
    const row = this.#database
      .prepare(
        `SELECT artifact_id, application_id, kind, content, content_hash, artifact_ref, created_at,
                metadata_json
         FROM application_artifacts
         WHERE artifact_id = ?`,
      )
      .get(artifactId) as ArtifactRow | undefined;
    return row === undefined ? undefined : artifactFromRow(row);
  }

  #existingRecord(
    existing: StoredEventRow,
    candidate: StoredApplicationArtifact,
    collisionError: string,
  ): StoredApplicationRecord {
    if (existing.artifactId === null) throw new Error("corrupt_event_missing_artifact");
    const artifact = this.#findArtifactById(existing.artifactId);
    if (artifact === undefined) throw new Error("corrupt_event_missing_artifact");
    if (!sameArtifact(artifact, candidate)) throw new Error(collisionError);
    return { event: structuredClone(existing.event), artifact: structuredClone(artifact) };
  }

  #recordFromStoredEventRow(row: StoredEventRow): StoredApplicationRecord {
    if (row.artifactId === null) throw new Error("event_has_no_artifact");
    const artifact = this.#findArtifactById(row.artifactId);
    if (artifact === undefined) throw new Error("corrupt_event_missing_artifact");
    return { event: structuredClone(row.event), artifact: structuredClone(artifact) };
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("sqlite_store_closed");
  }
}

function prepareArtifact(artifact: ApplicationArtifactInput): StoredApplicationArtifact {
  const requiredStrings = [
    artifact.artifactId,
    artifact.applicationId,
    artifact.kind,
    artifact.content,
    artifact.createdAt,
  ];
  if (requiredStrings.some((value) => value.trim().length === 0))
    throw new Error("invalid_application_artifact");
  if (!Number.isFinite(Date.parse(artifact.createdAt))) throw new Error("invalid_artifact_timestamp");
  try {
    JSON.stringify(artifact.metadata ?? null);
  } catch {
    throw new Error("invalid_artifact_metadata");
  }
  if (containsCredentialKey(artifact.metadata)) throw new Error("artifact_metadata_contains_credential");
  return {
    ...structuredClone(artifact),
    metadata: artifact.metadata ?? undefined,
    contentHash: hashContent(artifact.content),
    artifactRef: applicationArtifactRef(artifact.artifactId),
  };
}

function validateArtifactEvent(event: ApplicationArtifactEvent, artifact: StoredApplicationArtifact): void {
  const expectedKind: Record<ApplicationArtifactEvent["type"], ApplicationArtifactKind> = {
    job_description_captured: "job_description",
    recruiter_message_captured: "recruiter_message",
    interview_note_recorded: "interview_note",
    progress_signal_recorded: "progress_signal",
  };
  if (event.applicationId !== artifact.applicationId) throw new Error("artifact_application_mismatch");
  if (event.payload.contentHash !== artifact.contentHash) throw new Error("artifact_hash_mismatch");
  if (event.payload.artifactRef !== artifact.artifactRef) throw new Error("artifact_reference_mismatch");
  if (artifact.kind !== expectedKind[event.type]) throw new Error("artifact_kind_mismatch");
}

function artifactFromRow(row: ArtifactRow): StoredApplicationArtifact {
  const artifact: StoredApplicationArtifact = {
    artifactId: row.artifact_id,
    applicationId: row.application_id,
    kind: row.kind,
    content: row.content,
    contentHash: row.content_hash,
    artifactRef: row.artifact_ref,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata_json) ?? undefined,
  };
  if (hashContent(artifact.content) !== artifact.contentHash) {
    throw new Error(`corrupt_artifact_hash:${artifact.artifactId}`);
  }
  return artifact;
}

function sameArtifact(left: StoredApplicationArtifact, right: StoredApplicationArtifact): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function containsCredentialKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCredentialKey);
  return Object.entries(value).some(([key, item]) => {
    const normalizedKey = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
    const credentialNames = [
      "authorization",
      "cookie",
      "password",
      "secret",
      "token",
      "apikey",
      "credential",
    ];
    return (
      credentialNames.some(
        (name) => normalizedKey === name || normalizedKey.startsWith(name) || normalizedKey.endsWith(name),
      ) || containsCredentialKey(item)
    );
  });
}
