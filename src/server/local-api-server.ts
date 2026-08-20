import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  BossBrowserRunController,
  type BossHunterBrowserRuntime,
} from "../browser/browser-run-controller.js";
import { type BrowserJobSearchInput, createBrowserJobSearchPlan } from "../browser/job-search.js";
import { SqliteApplicationStore } from "../storage/sqlite-application-store.js";
import { ApiError } from "./api-error.js";
import { CaptureApi, type PiConversationAnalyzer } from "./capture-api.js";

const HOSTNAME = "127.0.0.1";
const MAX_BODY_BYTES = 512 * 1024;
const MAX_RESUME_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PROGRESS_SIGNAL_UPLOAD_BYTES = 2 * 1024 * 1024;
const RESUME_UPLOAD_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_RESUME_UPLOADS_PER_SESSION = 20;
const MAX_ACTIVE_RESUME_UPLOAD_SESSIONS = 32;
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/([a-p]{32})$/u;
const DEFAULT_DSH_WEB_ORIGINS = ["http://127.0.0.1:3080", "http://127.0.0.1:3081"] as const;
export const BOSS_WATCH_API_CONTRACT_VERSION = "2026-08-19.closed-loop-v1";
const BOSS_WATCH_BUILD_IDENTITY = `boss-watch-agent@0.1.0+api-${BOSS_WATCH_API_CONTRACT_VERSION}`;
const RESUME_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".md", "text/markdown"],
  [".txt", "text/plain"],
] as const);
const PROGRESS_SIGNAL_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  [".eml", "message/rfc822"],
  [".txt", "text/plain"],
] as const);

export type RuntimeMode = "pi_ready" | "baseline_ready" | "capture_only";

export interface LocalApiServerOptions {
  databasePath: string;
  pairingCode?: string;
  pairingExpiresAt?: Date;
  tokenFactory?: () => string;
  now?: () => Date;
  runtimeMode: RuntimeMode;
  piAnalyzer?: PiConversationAnalyzer;
  browserRuntime?: BossHunterBrowserRuntime;
  serviceToken?: string;
  /** Legacy single exact DSH Web origin allowed to stage local files. */
  dshWebOrigin?: string;
  /** Exact DSH Web origins allowed to stage local files. Never use a wildcard. */
  dshWebOrigins?: readonly string[];
  /** Controlled local directory used by the DSH resume import tool. */
  resumeRoot?: string;
  /** Controlled local directory used by the DSH progress-signal import tool. */
  progressSignalRoot?: string;
}

export interface LocalApiAddress {
  hostname: typeof HOSTNAME;
  port: number;
  origin: string;
}

export interface LocalApiServer {
  readonly pairingCode: string;
  readonly pairingExpiresAt: Date;
  start(options?: { port?: number }): Promise<LocalApiAddress>;
  close(): Promise<void>;
}

export function createLocalApiServer(options: LocalApiServerOptions): LocalApiServer {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  const pairingCode = options.pairingCode ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
  if (!/^\d{6}$/u.test(pairingCode)) throw new Error("invalid_pairing_code");
  const pairingExpiresAt = options.pairingExpiresAt ?? new Date(now().getTime() + 5 * 60 * 1000);
  const configuredDshWebOrigins =
    options.dshWebOrigins ??
    (options.dshWebOrigin === undefined ? DEFAULT_DSH_WEB_ORIGINS : [options.dshWebOrigin]);
  if (configuredDshWebOrigins.length === 0) throw new Error("invalid_dsh_web_origin");
  const dshWebOrigins = new Set(configuredDshWebOrigins.map(normalizeDshWebOrigin));
  const isDshWebOrigin = (origin: string | undefined): origin is string =>
    origin !== undefined && dshWebOrigins.has(origin);
  const resumeRoot = resolve(options.resumeRoot ?? join(dirname(options.databasePath), "resumes"));
  const progressSignalRoot = resolve(
    options.progressSignalRoot ?? join(dirname(options.databasePath), "progress-signals"),
  );
  const store = new SqliteApplicationStore(options.databasePath);
  let captureApi: CaptureApi;
  try {
    captureApi = new CaptureApi({
      store,
      runtimeMode: options.runtimeMode,
      piAnalyzer: options.piAnalyzer,
      now,
      progressSignalRoot,
    });
  } catch (error) {
    store.close();
    throw error;
  }
  let failedPairingAttempts = 0;
  let pairingConsumed = false;
  let closed = false;
  const eventStreams = new Set<ServerResponse>();
  const resumeUploadSessions = new Map<string, { expiresAt: number; uploads: number }>();
  const progressSignalUploadSessions = new Map<string, { expiresAt: number; uploads: number }>();
  const browserController =
    options.browserRuntime === undefined
      ? undefined
      : new BossBrowserRunController({
          runtime: options.browserRuntime,
          captureJob: (snapshot) => captureApi.captureJob(snapshot),
          captureConversation: (snapshot) => captureApi.captureConversation(snapshot),
          now,
          allowedResumeRoot: resumeRoot,
        });

  const httpServer = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      const httpError = error instanceof ApiError ? error : new ApiError(500, "internal_error");
      if (!response.headersSent) writeJson(response, httpError.status, { error: { code: httpError.code } });
      else response.end();
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    const extensionId = extensionIdFromOrigin(origin);
    if (origin !== undefined && extensionId === undefined && !isDshWebOrigin(origin)) {
      throw new ApiError(403, "origin_not_allowed");
    }
    if (origin !== undefined) setCorsHeaders(response, origin);

    if (request.method === "OPTIONS") {
      if (extensionId === undefined && !isDshWebOrigin(origin)) throw new ApiError(403, "origin_not_allowed");
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${HOSTNAME}`);
    if (request.method === "GET" && url.pathname === "/") {
      writeJson(response, 200, {
        service: "ready",
        message: "Boss Watch local API is running. Use DSH Web or the optional Chrome Side Panel.",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      writeJson(response, 200, {
        service: "ready",
        database: "ready",
        runtimeMode: options.runtimeMode,
        version: "0.1.0",
        apiContractVersion: BOSS_WATCH_API_CONTRACT_VERSION,
        buildIdentity: BOSS_WATCH_BUILD_IDENTITY,
        startedAt,
      });
      return;
    }

    if (url.pathname === "/api/v1/resumes/upload-session" || url.pathname === "/api/v1/resumes/upload") {
      if (!isDshWebOrigin(origin)) throw new ApiError(403, "dsh_origin_required");
      if (request.method === "POST" && url.pathname === "/api/v1/resumes/upload-session") {
        discardExpiredResumeUploadSessions(now().getTime());
        if (resumeUploadSessions.size >= MAX_ACTIVE_RESUME_UPLOAD_SESSIONS) {
          throw new ApiError(429, "resume_upload_session_limit_reached");
        }
        const token = randomBytes(24).toString("base64url");
        const expiresAt = now().getTime() + RESUME_UPLOAD_SESSION_TTL_MS;
        resumeUploadSessions.set(token, { expiresAt, uploads: 0 });
        writeJson(response, 200, {
          token,
          expiresAt: new Date(expiresAt).toISOString(),
          maxBytes: MAX_RESUME_UPLOAD_BYTES,
          maxUploads: MAX_RESUME_UPLOADS_PER_SESSION,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/resumes/upload") {
        const session = resumeUploadSession(request, resumeUploadSessions, now().getTime());
        // Reserve the slot before the first await so concurrent requests cannot
        // all pass the per-session admission check.
        session.uploads += 1;
        const fileName = resumeUploadFileName(request.headers["x-boss-watch-file-name"]);
        const bytes = await readBytesBody(request, MAX_RESUME_UPLOAD_BYTES);
        const staged = await stageResumeFile(resumeRoot, fileName, bytes);
        writeJson(response, 201, { status: "ok", ...staged, requiresPreview: true });
        return;
      }
      throw new ApiError(404, "route_not_found");
    }

    if (
      url.pathname === "/api/v1/progress-signals/upload-session" ||
      url.pathname === "/api/v1/progress-signals/upload"
    ) {
      if (!isDshWebOrigin(origin)) throw new ApiError(403, "dsh_origin_required");
      if (request.method === "POST" && url.pathname === "/api/v1/progress-signals/upload-session") {
        discardExpiredUploadSessions(progressSignalUploadSessions, now().getTime());
        if (progressSignalUploadSessions.size >= MAX_ACTIVE_RESUME_UPLOAD_SESSIONS) {
          throw new ApiError(429, "progress_signal_upload_session_limit_reached");
        }
        const token = randomBytes(24).toString("base64url");
        const expiresAt = now().getTime() + RESUME_UPLOAD_SESSION_TTL_MS;
        progressSignalUploadSessions.set(token, { expiresAt, uploads: 0 });
        writeJson(response, 200, {
          token,
          expiresAt: new Date(expiresAt).toISOString(),
          maxBytes: MAX_PROGRESS_SIGNAL_UPLOAD_BYTES,
          maxUploads: MAX_RESUME_UPLOADS_PER_SESSION,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/progress-signals/upload") {
        const session = progressSignalUploadSession(request, progressSignalUploadSessions, now().getTime());
        session.uploads += 1;
        const fileName = progressSignalUploadFileName(request.headers["x-boss-watch-file-name"]);
        const bytes = await readBytesBody(request, MAX_PROGRESS_SIGNAL_UPLOAD_BYTES);
        const staged = await stageProgressSignalFile(progressSignalRoot, fileName, bytes);
        writeJson(response, 201, { status: "ok", ...staged, requiresPreview: true });
        return;
      }
      throw new ApiError(404, "route_not_found");
    }

    if (
      url.pathname === "/api/v1/browser/status" ||
      url.pathname === "/api/v1/browser/jobs/search/status" ||
      url.pathname === "/api/v1/browser/jobs/discover" ||
      url.pathname === "/api/v1/browser/jobs/search" ||
      url.pathname === "/api/v1/browser/captures/job" ||
      url.pathname === "/api/v1/browser/captures/conversation" ||
      url.pathname === "/api/v1/browser/jobs/capture" ||
      url.pathname === "/api/v1/browser/jobs/poll" ||
      url.pathname === "/api/v1/browser/forms/inspect" ||
      url.pathname === "/api/v1/browser/forms/fill"
    ) {
      if (!authenticateService(request, options.serviceToken)) throw new ApiError(401, "unauthorized");
      if (browserController === undefined) throw new ApiError(503, "browser_controller_unavailable");
      if (request.method === "GET" && url.pathname === "/api/v1/browser/status") {
        writeJson(response, 200, await browserController.status());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/browser/jobs/search/status") {
        writeJson(response, 200, browserController.searchGuardStatus());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/browser/jobs/discover") {
        writeJson(response, 200, await browserController.discoverJobs());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/browser/jobs/search") {
        const body = await readJsonBody(request);
        if (!isRecord(body) || typeof body.keyword !== "string" || typeof body.city !== "string") {
          throw new ApiError(400, "invalid_request");
        }
        const input: BrowserJobSearchInput = {
          keyword: body.keyword,
          city: body.city,
          ...(typeof body.maxPages === "number" ? { maxPages: body.maxPages } : {}),
          ...(typeof body.maxJobs === "number" ? { maxJobs: body.maxJobs } : {}),
        };
        try {
          createBrowserJobSearchPlan(input);
        } catch {
          throw new ApiError(400, "invalid_request");
        }
        const abortController = new AbortController();
        const abortDisconnectedSearch = () => {
          if (!response.writableEnded) abortController.abort();
        };
        request.once("aborted", abortDisconnectedSearch);
        response.once("close", abortDisconnectedSearch);
        try {
          const result = await browserController.searchJobs(input, abortController.signal);
          if (!abortController.signal.aborted && !response.destroyed) writeJson(response, 200, result);
        } finally {
          request.off("aborted", abortDisconnectedSearch);
          response.off("close", abortDisconnectedSearch);
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/browser/captures/job") {
        const result = await browserController.captureCurrentJob();
        const status = result.status === "ok" ? (result.deduplicated ? 200 : 201) : 200;
        writeJson(response, status, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/browser/captures/conversation") {
        const body = await readJsonBody(request);
        if (
          !isRecord(body) ||
          typeof body.applicationId !== "string" ||
          body.applicationId.trim().length === 0
        ) {
          throw new ApiError(400, "invalid_request");
        }
        const result = await browserController.captureCurrentConversation(body.applicationId.trim());
        const status = result.status === "ok" ? (result.deduplicated ? 200 : 201) : 200;
        writeJson(response, status, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/browser/jobs/capture") {
        const body = await readJsonBody(request);
        if (
          !isRecord(body) ||
          typeof body.discoveryId !== "string" ||
          typeof body.externalJobId !== "string" ||
          body.discoveryId.length === 0 ||
          body.externalJobId.length === 0
        ) {
          throw new ApiError(400, "invalid_request");
        }
        const result = await browserController.captureDiscoveredJob(body.discoveryId, body.externalJobId);
        const status = result.status === "ok" ? (result.deduplicated ? 200 : 201) : 200;
        writeJson(response, status, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/browser/jobs/poll") {
        const body = await readJsonBody(request);
        if (
          !isRecord(body) ||
          typeof body.applicationId !== "string" ||
          body.applicationId.trim().length === 0
        ) {
          throw new ApiError(400, "invalid_request");
        }
        const events = await store.list(body.applicationId.trim());
        const jobEvent = [...events].reverse().find((event) => event.type === "job_description_captured");
        if (jobEvent === undefined) throw new ApiError(404, "application_not_found");
        if (jobEvent.payload.jobUrl === undefined) throw new ApiError(409, "watch_job_url_missing");
        const result = await browserController.pollFixedJob(
          jobEvent.payload.jobUrl,
          jobEvent.payload.externalJobId,
        );
        const status = result.status === "ok" ? (result.deduplicated ? 200 : 201) : 200;
        writeJson(response, status, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/browser/forms/inspect") {
        const body = await readJsonBody(request);
        if (
          !isRecord(body) ||
          typeof body.expectedUrl !== "string" ||
          body.expectedUrl.trim().length === 0 ||
          body.expectedUrl.length > 4096
        ) {
          throw new ApiError(400, "invalid_request");
        }
        writeJson(response, 200, await browserController.inspectApplicationForm(body.expectedUrl.trim()));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/browser/forms/fill") {
        const body = await readJsonBody(request);
        if (
          !isRecord(body) ||
          typeof body.expectedUrl !== "string" ||
          body.expectedUrl.trim().length === 0 ||
          body.expectedUrl.length > 4096 ||
          typeof body.expectedFormHash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(body.expectedFormHash) ||
          !Array.isArray(body.fields) ||
          (body.fields.length === 0 && body.resumeUpload === undefined) ||
          body.fields.length > 50 ||
          !body.fields.every(
            (field) =>
              isRecord(field) &&
              typeof field.fieldId === "string" &&
              /^form-field:[a-f0-9]{64}$/u.test(field.fieldId) &&
              typeof field.value === "string" &&
              field.value.trim().length > 0 &&
              field.value.length <= 2_000 &&
              !field.value.includes("\u0000"),
          )
        ) {
          throw new ApiError(400, "invalid_request");
        }
        if (
          body.resumeUpload !== undefined &&
          (!isRecord(body.resumeUpload) ||
            typeof body.resumeUpload.filePath !== "string" ||
            body.resumeUpload.filePath.length > 4096 ||
            typeof body.resumeUpload.contentHash !== "string" ||
            !/^[a-f0-9]{64}$/u.test(body.resumeUpload.contentHash) ||
            typeof body.resumeUpload.fieldId !== "string" ||
            !/^form-field:[a-f0-9]{64}$/u.test(body.resumeUpload.fieldId))
        ) {
          throw new ApiError(400, "invalid_request");
        }
        writeJson(
          response,
          200,
          await browserController.fillApplicationForm({
            expectedUrl: body.expectedUrl.trim(),
            expectedFormHash: body.expectedFormHash,
            fields: body.fields.map((field) => ({ fieldId: field.fieldId, value: field.value })),
            ...(body.resumeUpload === undefined
              ? {}
              : {
                  resumeUpload: {
                    filePath: body.resumeUpload.filePath as string,
                    contentHash: body.resumeUpload.contentHash as string,
                    fieldId: body.resumeUpload.fieldId as string,
                  },
                }),
          }),
        );
        return;
      }
      throw new ApiError(404, "route_not_found");
    }

    if (
      url.pathname === "/api/v1/interview-notes/preview" ||
      url.pathname === "/api/v1/interview-notes/apply" ||
      url.pathname === "/api/v1/progress-signals/preview" ||
      url.pathname === "/api/v1/progress-signals/apply" ||
      url.pathname === "/api/v1/application-status/preview" ||
      url.pathname === "/api/v1/application-status/apply" ||
      url.pathname === "/api/v1/official-jds/capture"
    ) {
      if (!authenticateService(request, options.serviceToken)) throw new ApiError(401, "unauthorized");
      if (request.method === "POST" && url.pathname === "/api/v1/interview-notes/preview") {
        writeJson(response, 200, await captureApi.previewInterviewNote(await readJsonBody(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/interview-notes/apply") {
        const result = await captureApi.applyInterviewNote(await readJsonBody(request));
        writeJson(response, result.deduplicated ? 200 : 201, result);
        emitEvent("capture", {
          kind: "interview_note",
          applicationId: result.applicationId,
          eventId: result.eventId,
          deduplicated: result.deduplicated,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/progress-signals/preview") {
        writeJson(response, 200, await captureApi.previewProgressSignal(await readJsonBody(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/progress-signals/apply") {
        const result = await captureApi.applyProgressSignal(await readJsonBody(request));
        writeJson(response, result.deduplicated ? 200 : 201, result);
        emitEvent("capture", {
          kind: "progress_signal",
          applicationId: result.applicationId,
          eventId: result.signalEventId,
          deduplicated: result.deduplicated,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/application-status/preview") {
        writeJson(response, 200, captureApi.previewApplicationStatus(await readJsonBody(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/application-status/apply") {
        const result = await captureApi.applyApplicationStatus(await readJsonBody(request));
        writeJson(response, result.deduplicated ? 200 : 201, result);
        emitEvent("capture", {
          kind: "application_status",
          applicationId: result.applicationId,
          eventId: result.eventId,
          deduplicated: result.deduplicated,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/official-jds/capture") {
        const result = await captureApi.captureOfficialJob(await readJsonBody(request));
        writeJson(response, result.deduplicated ? 200 : 201, result);
        emitEvent("capture", {
          kind: "official_job_description",
          applicationId: result.applicationId,
          eventId: result.eventId,
          deduplicated: result.deduplicated,
        });
        return;
      }
      throw new ApiError(404, "route_not_found");
    }

    if (request.method === "POST" && url.pathname === "/api/v1/pair") {
      if (extensionId === undefined) throw new ApiError(403, "extension_origin_required");
      if (pairingConsumed) throw new ApiError(409, "pairing_code_consumed");
      if (now().getTime() >= pairingExpiresAt.getTime()) throw new ApiError(410, "pairing_code_expired");
      if (failedPairingAttempts >= 5) throw new ApiError(429, "pairing_attempts_exceeded");
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.code !== "string" || body.code !== pairingCode) {
        failedPairingAttempts += 1;
        throw new ApiError(401, "invalid_pairing_code");
      }

      const token = tokenFactory();
      if (token.length < 16) throw new Error("invalid_generated_client_token");
      store.authorizeExtensionClient(extensionId, sha256(token), now().toISOString());
      pairingConsumed = true;
      writeJson(response, 200, { token });
      return;
    }

    const authenticatedExtensionId = authenticate(request, store);
    if (authenticatedExtensionId === undefined) throw new ApiError(401, "unauthorized");

    if (request.method === "POST" && url.pathname === "/api/v1/captures/job") {
      const result = await captureApi.captureJob(await readJsonBody(request));
      writeJson(response, result.deduplicated ? 200 : 201, result);
      emitEvent("capture", {
        kind: "job",
        applicationId: result.applicationId,
        eventId: result.eventId,
        deduplicated: result.deduplicated,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/captures/conversation") {
      const result = await captureApi.captureConversation(await readJsonBody(request));
      writeJson(response, result.deduplicated ? 200 : 201, result);
      emitEvent("capture", {
        kind: "conversation",
        applicationId: result.applicationId,
        eventId: result.eventId,
        deduplicated: result.deduplicated,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/analyses/conversation") {
      const result = await captureApi.analyzeConversation(await readJsonBody(request));
      writeJson(response, 200, result);
      emitEvent("analysis", { eventId: result.eventId, mode: result.mode, status: "completed" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      response.flushHeaders();
      eventStreams.add(response);
      response.write(sseMessage("ready", { runtimeMode: options.runtimeMode }));
      request.once("close", () => eventStreams.delete(response));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/applications") {
      const applicationIds = await store.listApplicationIds();
      const applications = await Promise.all(
        applicationIds.map(async (applicationId) => {
          const events = await store.list(applicationId);
          const job = [...events].reverse().find((event) => event.type === "job_description_captured");
          return {
            applicationId,
            company: job?.type === "job_description_captured" ? job.payload.company : "未命名公司",
            role: job?.type === "job_description_captured" ? job.payload.role : "未命名岗位",
          };
        }),
      );
      writeJson(response, 200, { applicationIds, applications });
      return;
    }

    const artifactMatch = url.pathname.match(/^\/api\/v1\/artifacts\/([^/]+)$/u);
    if (request.method === "GET" && artifactMatch !== null) {
      const artifact = store.getArtifact(decodeURIComponent(artifactMatch[1] ?? ""));
      if (artifact === undefined) throw new ApiError(404, "artifact_not_found");
      writeJson(response, 200, artifact);
      return;
    }

    const applicationMatch = url.pathname.match(/^\/api\/v1\/applications\/([^/]+)$/u);
    if (request.method === "GET" && applicationMatch !== null) {
      const applicationId = decodeURIComponent(applicationMatch[1] ?? "");
      const [events, artifacts] = await Promise.all([
        store.list(applicationId),
        store.listArtifacts(applicationId),
      ]);
      if (events.length === 0 && artifacts.length === 0) throw new ApiError(404, "application_not_found");
      writeJson(response, 200, {
        applicationId,
        events,
        artifacts: artifacts.map(({ content: _content, ...summary }) => summary),
      });
      return;
    }

    throw new ApiError(404, "route_not_found");
  }

  return {
    pairingCode,
    pairingExpiresAt,
    async start({ port = 4318 } = {}): Promise<LocalApiAddress> {
      if (closed) throw new Error("local_api_server_closed");
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, HOSTNAME);
      });
      const address = httpServer.address() as AddressInfo;
      return { hostname: HOSTNAME, port: address.port, origin: `http://${HOSTNAME}:${address.port}` };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const stream of eventStreams) stream.end();
      eventStreams.clear();
      httpServer.closeAllConnections();
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      }
      store.close();
    },
  };

  function emitEvent(event: string, data: unknown): void {
    const message = sseMessage(event, data);
    for (const stream of eventStreams) stream.write(message);
  }

  function discardExpiredResumeUploadSessions(timestamp: number): void {
    discardExpiredUploadSessions(resumeUploadSessions, timestamp);
  }
}

type ResumeUploadSession = { expiresAt: number; uploads: number };

function resumeUploadSession(
  request: IncomingMessage,
  sessions: Map<string, ResumeUploadSession>,
  timestamp: number,
): ResumeUploadSession {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new ApiError(401, "resume_upload_unauthorized");
  }
  const token = authorization.slice("Bearer ".length).trim();
  const session = sessions.get(token);
  if (session === undefined || session.expiresAt <= timestamp) {
    sessions.delete(token);
    throw new ApiError(401, "resume_upload_session_expired");
  }
  if (session.uploads >= MAX_RESUME_UPLOADS_PER_SESSION) {
    throw new ApiError(429, "resume_upload_limit_reached");
  }
  return session;
}

function progressSignalUploadSession(
  request: IncomingMessage,
  sessions: Map<string, ResumeUploadSession>,
  timestamp: number,
): ResumeUploadSession {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new ApiError(401, "progress_signal_upload_unauthorized");
  }
  const token = authorization.slice("Bearer ".length).trim();
  const session = sessions.get(token);
  if (session === undefined || session.expiresAt <= timestamp) {
    sessions.delete(token);
    throw new ApiError(401, "progress_signal_upload_session_expired");
  }
  if (session.uploads >= MAX_RESUME_UPLOADS_PER_SESSION) {
    throw new ApiError(429, "progress_signal_upload_limit_reached");
  }
  return session;
}

function discardExpiredUploadSessions(sessions: Map<string, ResumeUploadSession>, timestamp: number): void {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= timestamp) sessions.delete(token);
  }
}

function resumeUploadFileName(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new ApiError(400, "resume_file_name_required");
  let normalized: string;
  try {
    normalized = decodeURIComponent(value.trim());
  } catch {
    throw new ApiError(400, "invalid_resume_file_name");
  }
  const extension = extname(normalized).toLowerCase();
  const containsControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 180 ||
    normalized !== basename(normalized) ||
    containsControlCharacter ||
    !RESUME_MEDIA_TYPES.has(extension)
  )
    throw new ApiError(400, "unsupported_resume_file_type");
  return normalized;
}

function progressSignalUploadFileName(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new ApiError(400, "progress_signal_file_name_required");
  let normalized: string;
  try {
    normalized = decodeURIComponent(value.trim());
  } catch {
    throw new ApiError(400, "invalid_progress_signal_file_name");
  }
  const extension = extname(normalized).toLowerCase();
  const containsControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 180 ||
    normalized !== basename(normalized) ||
    containsControlCharacter ||
    !PROGRESS_SIGNAL_MEDIA_TYPES.has(extension)
  ) {
    throw new ApiError(400, "unsupported_progress_signal_file_type");
  }
  return normalized;
}

async function stageResumeFile(
  root: string,
  fileName: string,
  bytes: Buffer,
): Promise<{
  fileName: string;
  displayName: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
}> {
  if (bytes.byteLength === 0) throw new ApiError(400, "resume_file_empty");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const extension = extname(fileName).toLowerCase();
  const mediaType = RESUME_MEDIA_TYPES.get(extension);
  if (mediaType === undefined) throw new ApiError(400, "unsupported_resume_file_type");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stagedFileName = `dsh-${contentHash}-${fileName}`;
  const target = resolve(root, stagedFileName);
  if (dirname(target) !== resolve(root)) throw new ApiError(400, "file_outside_resume_root");
  try {
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (!isNodeError(error, "EEXIST")) throw error;
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new ApiError(409, "resume_staged_path_invalid");
    const existing = await readFile(target);
    if (createHash("sha256").update(existing).digest("hex") !== contentHash) {
      throw new ApiError(409, "resume_staged_hash_conflict");
    }
  }
  return {
    fileName: stagedFileName,
    displayName: basename(fileName, extension),
    mediaType,
    byteSize: bytes.byteLength,
    contentHash,
  };
}

async function stageProgressSignalFile(
  root: string,
  fileName: string,
  bytes: Buffer,
): Promise<{
  fileName: string;
  displayName: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
}> {
  if (bytes.byteLength === 0) throw new ApiError(400, "progress_signal_file_empty");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const extension = extname(fileName).toLowerCase();
  const mediaType = PROGRESS_SIGNAL_MEDIA_TYPES.get(extension);
  if (mediaType === undefined) throw new ApiError(400, "unsupported_progress_signal_file_type");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stagedFileName = `dsh-${contentHash}-${fileName}`;
  const target = resolve(root, stagedFileName);
  if (dirname(target) !== resolve(root)) throw new ApiError(400, "file_outside_progress_signal_root");
  try {
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (!isNodeError(error, "EEXIST")) throw error;
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ApiError(409, "progress_signal_staged_path_invalid");
    }
    const existing = await readFile(target);
    if (createHash("sha256").update(existing).digest("hex") !== contentHash) {
      throw new ApiError(409, "progress_signal_staged_hash_conflict");
    }
  }
  return {
    fileName: stagedFileName,
    displayName: basename(fileName, extension),
    mediaType,
    byteSize: bytes.byteLength,
    contentHash,
  };
}

function authenticate(request: IncomingMessage, store: SqliteApplicationStore): string | undefined {
  const originExtensionId = extensionIdFromOrigin(request.headers.origin);
  const declaredExtensionId = extensionIdFromHeader(request.headers["x-boss-watch-extension-id"]);
  if (
    originExtensionId !== undefined &&
    declaredExtensionId !== undefined &&
    originExtensionId !== declaredExtensionId
  ) {
    return undefined;
  }
  const extensionId = originExtensionId ?? declaredExtensionId;
  const authorization = request.headers.authorization;
  if (extensionId === undefined || authorization === undefined || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  return store.isExtensionClientAuthorized(extensionId, sha256(token)) ? extensionId : undefined;
}

function authenticateService(request: IncomingMessage, serviceToken: string | undefined): boolean {
  if (serviceToken === undefined || request.headers.origin !== undefined) return false;
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return false;
  const actual = Buffer.from(sha256(authorization.slice("Bearer ".length)), "hex");
  const expected = Buffer.from(sha256(serviceToken), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function extensionIdFromOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  return EXTENSION_ORIGIN_PATTERN.exec(origin)?.[1];
}

function extensionIdFromHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[a-p]{32}$/u.test(value) ? value : undefined;
}

function setCorsHeaders(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, x-boss-watch-extension-id, x-boss-watch-file-name",
  );
  response.setHeader("access-control-max-age", "600");
  response.setHeader("vary", "Origin");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let totalBytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

async function readBytesBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  let totalBytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw new ApiError(413, "payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function normalizeDshWebOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_dsh_web_origin");
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw new Error("invalid_dsh_web_origin");
  return parsed.origin;
}

function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
