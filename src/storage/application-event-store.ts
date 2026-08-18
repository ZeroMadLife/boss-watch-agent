import type { ApplicationEvent, StoredApplicationEvent } from "../domain/application-event.js";

export interface ApplicationEventStore {
  append(event: ApplicationEvent): Promise<StoredApplicationEvent>;
  list(applicationId: string): Promise<StoredApplicationEvent[]>;
}

/**
 * Deterministic store for the first runtime slice. The public interface is
 * intentionally async so a SQLite or service-backed implementation can replace
 * it without changing Tool contracts.
 */
export class InMemoryApplicationEventStore implements ApplicationEventStore {
  readonly #eventsByApplication = new Map<string, StoredApplicationEvent[]>();
  readonly #eventById = new Map<string, StoredApplicationEvent>();
  readonly #eventByIdempotencyKey = new Map<string, StoredApplicationEvent>();

  async append(event: ApplicationEvent): Promise<StoredApplicationEvent> {
    validateApplicationEvent(event);

    const scopedIdempotencyKey = idempotencyIndexKey(event.applicationId, event.idempotencyKey);
    const existingByKey = this.#eventByIdempotencyKey.get(scopedIdempotencyKey);
    if (existingByKey !== undefined) {
      if (sameApplicationEventOperation(existingByKey, event)) return structuredClone(existingByKey);
      throw new Error(`idempotency_key_collision:${event.idempotencyKey}`);
    }

    const existingById = this.#eventById.get(event.eventId);
    if (existingById !== undefined) {
      if (sameApplicationEventOperation(existingById, event)) return structuredClone(existingById);
      throw new Error(`event_id_collision:${event.eventId}`);
    }

    const applicationEvents = this.#eventsByApplication.get(event.applicationId) ?? [];
    const stored: StoredApplicationEvent = {
      ...structuredClone(event),
      sequence: applicationEvents.length + 1,
    };
    applicationEvents.push(stored);
    this.#eventsByApplication.set(event.applicationId, applicationEvents);
    this.#eventById.set(event.eventId, stored);
    this.#eventByIdempotencyKey.set(scopedIdempotencyKey, stored);
    return structuredClone(stored);
  }

  async list(applicationId: string): Promise<StoredApplicationEvent[]> {
    return structuredClone(this.#eventsByApplication.get(applicationId) ?? []);
  }
}

function idempotencyIndexKey(applicationId: string, idempotencyKey: string): string {
  return `${applicationId}\u0000${idempotencyKey}`;
}

export function validateApplicationEvent(event: ApplicationEvent): void {
  const requiredStrings = [
    event.eventId,
    event.applicationId,
    event.idempotencyKey,
    event.traceId,
    event.occurredAt,
  ];
  if (event.schemaVersion !== 1 || requiredStrings.some((value) => value.trim().length === 0)) {
    throw new Error("invalid_application_event");
  }
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error("invalid_event_timestamp");

  if ("contentHash" in event.payload && !/^[a-f0-9]{64}$/u.test(event.payload.contentHash)) {
    throw new Error("invalid_evidence_hash");
  }
  if (event.type === "status_change_proposed" && event.payload.evidenceEventIds.length === 0) {
    throw new Error("status_proposal_requires_evidence");
  }
  if (
    event.type === "progress_signal_recorded" &&
    (!Number.isFinite(event.payload.confidence) ||
      event.payload.confidence < 0 ||
      event.payload.confidence > 1 ||
      event.payload.classifierVersion.trim().length === 0 ||
      event.payload.reasonCodes.length === 0 ||
      event.payload.reasonCodes.some((code) => code.trim().length === 0))
  ) {
    throw new Error("invalid_progress_signal_event");
  }
}

export function sameApplicationEventOperation(
  existing: StoredApplicationEvent,
  incoming: ApplicationEvent,
): boolean {
  const { eventId: _existingEventId, sequence: _sequence, ...existingOperation } = existing;
  const { eventId: _incomingEventId, ...incomingOperation } = incoming;
  return canonicalJson(existingOperation) === canonicalJson(incomingOperation);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}
