import type { BrowserPageSnapshot } from "./page-adapter.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:4318";

export interface HealthResponse {
  service: "ready";
  database: "ready";
  runtimeMode: "pi_ready" | "baseline_ready" | "capture_only";
  version: string;
}

export interface CaptureResponse {
  applicationId: string;
  eventId: string;
  artifactId: string;
  artifactRef: string;
  contentHash: string;
  savedAt: string;
  deduplicated: boolean;
}

export interface ConversationAnalysisResponse {
  mode: "pi" | "baseline";
  eventId: string;
  artifactId: string;
  analysis: {
    conversationId: string;
    intent: string;
    evidence?: { messageId: string; quote: string };
    draft: { status: string; text: string };
  };
}

export interface ApplicationTimeline {
  applicationId: string;
  events: Array<{
    eventId: string;
    sequence: number;
    occurredAt: string;
    type: string;
    payload: Record<string, unknown>;
  }>;
  artifacts: Array<{
    artifactId: string;
    kind: string;
    contentHash: string;
    artifactRef: string;
    createdAt: string;
  }>;
}

export class LocalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class LocalApiClient {
  constructor(
    readonly baseUrl = DEFAULT_BASE_URL,
    private token?: string,
    private readonly extensionId?: string,
  ) {}

  setToken(token: string | undefined): void {
    this.token = token;
  }

  health(): Promise<HealthResponse> {
    return this.request("/api/v1/health", { authenticated: false });
  }

  pair(code: string): Promise<{ token: string }> {
    return this.request("/api/v1/pair", { method: "POST", body: { code }, authenticated: false });
  }

  applications(): Promise<{
    applicationIds: string[];
    applications: Array<{ applicationId: string; company: string; role: string }>;
  }> {
    return this.request("/api/v1/applications");
  }

  capture(snapshot: BrowserPageSnapshot): Promise<CaptureResponse> {
    const path =
      snapshot.pageKind === "job_detail" ? "/api/v1/captures/job" : "/api/v1/captures/conversation";
    return this.request(path, { method: "POST", body: snapshot });
  }

  analyze(
    eventId: string,
    pageRevision: string,
    mode: "pi" | "baseline",
  ): Promise<ConversationAnalysisResponse> {
    return this.request("/api/v1/analyses/conversation", {
      method: "POST",
      body: { eventId, pageRevision, mode },
    });
  }

  timeline(applicationId: string): Promise<ApplicationTimeline> {
    return this.request(`/api/v1/applications/${encodeURIComponent(applicationId)}`);
  }

  async watchEvents(signal: AbortSignal, onEvent: (event: string, data: unknown) => void): Promise<void> {
    if (!this.token) throw new LocalApiError(401, "missing_client_token");
    const response = await fetch(`${this.baseUrl}/api/v1/events`, {
      headers: this.authenticatedHeaders(),
      signal,
    });
    if (!response.ok || response.body === null)
      throw new LocalApiError(response.status, "event_stream_failed");

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const messages = buffer.split("\n\n");
      buffer = messages.pop() ?? "";
      for (const message of messages) {
        const event = message.match(/^event: (.+)$/mu)?.[1];
        const data = message.match(/^data: (.+)$/mu)?.[1];
        if (event && data) onEvent(event, JSON.parse(data));
      }
    }
  }

  private async request<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown; authenticated?: boolean } = {},
  ): Promise<T> {
    const authenticated = options.authenticated ?? true;
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (authenticated) {
      if (!this.token) throw new LocalApiError(401, "missing_client_token");
      headers.authorization = `Bearer ${this.token}`;
      if (this.extensionId !== undefined) headers["x-boss-watch-extension-id"] = this.extensionId;
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const body = (await response.json()) as { error?: { code?: string } };
    if (!response.ok) throw new LocalApiError(response.status, body.error?.code ?? "request_failed");
    return body as T;
  }

  private authenticatedHeaders(): Record<string, string> {
    if (!this.token) throw new LocalApiError(401, "missing_client_token");
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (this.extensionId !== undefined) headers["x-boss-watch-extension-id"] = this.extensionId;
    return headers;
  }
}
