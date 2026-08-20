import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { relative, resolve } from "node:path";
import { createPageRevision } from "../capture/page-snapshot.js";
import type { CaptureResult } from "../server/capture-api.js";
import {
  BOSS_SEARCH_MIN_NAVIGATION_INTERVAL_MS,
  BOSS_SEARCH_RISK_COOLDOWN_MS,
  BOSS_SEARCH_RUN_COOLDOWN_MS,
  type BrowserJobSearchInput,
  type BrowserJobSearchItem,
  type BrowserJobSearchResult,
  bossSearchUrl,
  createBrowserJobSearchPlan,
  isBossSearchUrl,
} from "./job-search.js";

const BOSS_HOST = "www.zhipin.com";
const JOB_DETAIL_PATTERN = /^\/job_detail\/([a-zA-Z0-9_-]+)(?:\.html)?/u;
const LOGIN_PATH_PATTERN = /\/web\/user\//u;
const VERIFICATION_PATH_PATTERN = /(captcha|verify|verification)/iu;
const RISK_CONTROL_PATH_PATTERN = /(security|risk)/iu;
const OFFICIAL_LOGIN_PATH_PATTERN = /\/(?:login|sign-?in|auth)(?:\/|$)/iu;
const OFFICIAL_VERIFICATION_PATH_PATTERN = /\/(?:captcha|verify|verification|security|risk)(?:\/|$)/iu;
const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const MAX_APPLICATION_FORM_FIELDS = 150;
const SEARCH_LIST_INSPECTION_ATTEMPTS = 6;
const SEARCH_LIST_INSPECTION_INTERVAL_MS = 1_000;

export interface BossHunterBrowserRuntime {
  health(): Promise<BossHunterRuntimeHealth | undefined>;
  targets(): Promise<BossHunterBrowserTarget[]>;
  evaluate(targetId: string, expression: string): Promise<unknown>;
  newTab(url: string): Promise<string>;
  close(targetId: string): Promise<void>;
  waitForLoad?(targetId: string, timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  scroll?(targetId: string, y: number): Promise<void>;
  setFiles?(targetId: string, selector: string, files: readonly string[]): Promise<void>;
}

export interface BossHunterRuntimeHealth {
  readonly status: string;
  readonly runtime: string;
  readonly connected: boolean;
}

export interface BossHunterBrowserTarget {
  readonly targetId: string;
  readonly type: string;
  readonly title?: string;
  readonly url?: string;
}

export interface BrowserTargetSummary {
  readonly pageKind: "job_detail";
  readonly title?: string;
  readonly url: string;
}

export interface ConversationTargetSummary {
  readonly pageKind: "conversation";
  readonly title?: string;
  readonly url: string;
}

export interface BrowserJobSummary {
  readonly externalJobId: string;
  readonly role: string;
  readonly company?: string;
  readonly salary?: string;
  readonly salaryStatus: "available" | "obfuscated" | "missing";
  readonly experience?: string;
  readonly education?: string;
  readonly location?: string;
  readonly jobUrl: string;
}

export type BrowserApplicationFormControlType =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "date"
  | "month"
  | "textarea"
  | "select"
  | "combobox"
  | "checkbox"
  | "radio"
  | "file"
  | "other";

export interface BrowserApplicationFormField {
  readonly fieldId: string;
  readonly ordinal: number;
  readonly controlType: BrowserApplicationFormControlType;
  readonly inputType: string;
  readonly label: string;
  readonly name?: string;
  readonly autocomplete?: string;
  readonly required: boolean;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly currentState: "empty" | "present" | "checked" | "unchecked";
  readonly options?: readonly { readonly label: string; readonly value?: string }[];
  readonly metadataTrust: "untrusted_page";
}

export type InspectApplicationFormResult =
  | {
      readonly status: "ready";
      readonly targetCount: 1;
      readonly page: {
        readonly pageKind: "application_form";
        readonly title?: string;
        readonly url: string;
        readonly hostname: string;
        readonly formHash: string;
        readonly metadataTrust: "untrusted_page";
      };
      readonly fields: readonly BrowserApplicationFormField[];
    }
  | {
      readonly status: "no_supported_tab";
      readonly reason: "official_page_not_open" | "no_application_form";
      readonly targetCount: 0 | 1;
    }
  | {
      readonly status: "target_ambiguous";
      readonly reason: "multiple_official_tabs";
      readonly targetCount: number;
    }
  | {
      readonly status: "human_required";
      readonly reason: "login" | "verification" | "risk_control" | "page_identity_mismatch";
      readonly targetCount: number;
    }
  | {
      readonly status: "page_adapter_mismatch";
      readonly reason: "application_form";
      readonly targetCount: 1;
    }
  | {
      readonly status: "invalid_request";
      readonly reason: "unsupported_official_url";
      readonly targetCount: 0;
    }
  | {
      readonly status: "environment_interrupted";
      readonly reason: "runtime_unavailable" | "browser_disconnected";
      readonly targetCount: 0;
    };

export interface FillApplicationFormInput {
  readonly expectedUrl: string;
  readonly expectedFormHash: string;
  readonly fields: readonly {
    readonly fieldId: string;
    readonly value: string;
  }[];
  readonly resumeUpload?: {
    readonly filePath: string;
    readonly contentHash: string;
    readonly fieldId: string;
  };
}

export type FillApplicationFormResult =
  | Exclude<InspectApplicationFormResult, { readonly status: "ready" }>
  | {
      readonly status: "conflict";
      readonly reason: "form_changed" | "field_state_changed" | "fill_plan_mismatch";
      readonly targetCount: 1;
      readonly currentFormHash?: string;
    }
  | {
      readonly status: "filled";
      readonly targetCount: 1;
      readonly page: Extract<InspectApplicationFormResult, { readonly status: "ready" }>["page"];
      readonly formHash: string;
      readonly filledFieldIds: readonly string[];
      readonly filledCount: number;
      readonly requiresHumanReview: true;
      readonly submitted: false;
      readonly uploadedResume: boolean;
      readonly nextAction: "review_before_submit" | "next_step_handoff";
    };

export type BrowserRunStatus =
  | {
      readonly status: "ready";
      readonly targetCount: 1;
      readonly target: BrowserTargetSummary;
    }
  | {
      readonly status: "no_supported_tab";
      readonly reason: "no_boss_page";
      readonly targetCount: 0;
    }
  | {
      readonly status: "target_ambiguous";
      readonly reason: "multiple_job_tabs";
      readonly targetCount: number;
    }
  | {
      readonly status: "human_required";
      readonly reason: "login" | "verification" | "risk_control";
      readonly targetCount: number;
    }
  | {
      readonly status: "environment_interrupted";
      readonly reason: "runtime_unavailable" | "browser_disconnected";
      readonly targetCount: 0;
    };

export type BrowserSearchGuardStatus =
  | {
      readonly state: "ready";
      readonly guarded: false;
      readonly observedAt: string;
      readonly scope: "controller_process";
      readonly resetsOnRestart: true;
    }
  | {
      readonly state: "search_in_progress" | "search_cooldown" | "risk_cooldown";
      readonly guarded: true;
      readonly retryAfterMs: number;
      readonly observedAt: string;
      readonly scope: "controller_process";
      readonly resetsOnRestart: true;
    };

export type CaptureCurrentJobResult =
  | BrowserRunStatus
  | (CaptureResult & {
      readonly status: "ok";
      readonly job: {
        readonly externalJobId: string;
        readonly company: string;
        readonly role: string;
        readonly jobUrl: string;
        readonly pageRevision: string;
      };
    })
  | {
      readonly status: "page_adapter_mismatch";
      readonly reason: "job_detail";
      readonly targetCount: 1;
    };

export type CaptureCurrentConversationResult =
  | {
      readonly status: "no_supported_tab";
      readonly reason: "no_boss_page" | "no_conversation";
      readonly targetCount: 0;
    }
  | {
      readonly status: "target_ambiguous";
      readonly reason: "multiple_conversation_tabs";
      readonly targetCount: number;
    }
  | {
      readonly status: "human_required";
      readonly reason: "login" | "verification" | "risk_control";
      readonly targetCount: number;
    }
  | {
      readonly status: "environment_interrupted";
      readonly reason: "runtime_unavailable" | "browser_disconnected";
      readonly targetCount: 0;
    }
  | {
      readonly status: "page_adapter_mismatch";
      readonly reason: "conversation";
      readonly targetCount: 1;
    }
  | (CaptureResult & {
      readonly status: "ok";
      readonly conversation: {
        readonly conversationId: string;
        readonly messageId: string;
        readonly recruiterName: string;
        readonly pageRevision: string;
      };
    });

export type BrowserJobDiscoveryResult =
  | {
      readonly status: "ready";
      readonly discoveryId: string;
      readonly targetCount: 1;
      readonly target: {
        readonly pageKind: "job_list";
        readonly title?: string;
        readonly url: string;
      };
      readonly jobs: readonly BrowserJobSummary[];
    }
  | {
      readonly status: "no_supported_tab";
      readonly reason: "no_boss_page" | "no_job_cards" | "no_job_list";
      readonly targetCount: 0 | 1;
    }
  | {
      readonly status: "target_ambiguous";
      readonly reason: "multiple_boss_tabs";
      readonly targetCount: number;
    }
  | {
      readonly status: "human_required";
      readonly reason: "login" | "verification" | "risk_control";
      readonly targetCount: number;
    }
  | {
      readonly status: "environment_interrupted";
      readonly reason: "runtime_unavailable" | "browser_disconnected";
      readonly targetCount: 0;
    };

export type CaptureDiscoveredJobResult =
  | CaptureCurrentJobResult
  | {
      readonly status: "invalid_request";
      readonly reason: "discovery_expired" | "job_not_found";
      readonly targetCount: 0;
    };

export type PollFixedJobResult =
  | CaptureCurrentJobResult
  | {
      readonly status: "invalid_request";
      readonly reason: "unsupported_job_url" | "external_job_id_mismatch";
      readonly targetCount: 0;
    };

export interface BossBrowserRunControllerOptions {
  readonly runtime: BossHunterBrowserRuntime;
  readonly captureJob: (snapshot: unknown) => Promise<CaptureResult>;
  readonly captureConversation?: (snapshot: unknown) => Promise<CaptureResult>;
  readonly now?: () => Date;
  readonly captureIdFactory?: () => string;
  readonly discoveryIdFactory?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly searchMinNavigationIntervalMs?: number;
  readonly searchRunCooldownMs?: number;
  readonly searchRiskCooldownMs?: number;
  readonly allowedResumeRoot?: string;
}

interface ReadyJobInspection {
  readonly status: "ready";
  readonly sourceUrl: string;
  readonly externalJobId: string;
  readonly company: string;
  readonly role: string;
  readonly description: string;
}

interface HumanRequiredInspection {
  readonly status: "human_required";
  readonly reason: "login" | "verification" | "risk_control";
  readonly sourceUrl?: string;
}

interface MismatchInspection {
  readonly status: "page_adapter_mismatch";
}

interface ReadyJobListInspection {
  readonly status: "ready";
  readonly sourceUrl: string;
  readonly jobs: readonly BrowserJobSummary[];
}

interface ReadyConversationInspection {
  readonly status: "ready";
  readonly sourceUrl: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly recruiterName: string;
  readonly messageText: string;
}

interface ReadyApplicationFormInspection {
  readonly status: "ready";
  readonly sourceUrl: string;
  readonly title?: string;
  readonly fields: readonly Omit<BrowserApplicationFormField, "fieldId" | "metadataTrust">[];
}

interface ApplicationFormHumanRequiredInspection {
  readonly status: "human_required";
  readonly reason: "login" | "verification" | "risk_control";
  readonly sourceUrl?: string;
}

interface ApplicationFormFillRequest {
  readonly fieldId: string;
  readonly ordinal: number;
  readonly controlType: BrowserApplicationFormControlType;
  readonly inputType: string;
  readonly label: string;
  readonly name: string;
  readonly value: string;
}

type ApplicationFormFillInspection =
  | {
      readonly status: "filled";
      readonly sourceUrl: string;
      readonly ordinals: readonly number[];
      readonly nextAction: "review_before_submit" | "next_step_handoff";
    }
  | {
      readonly status: "human_required";
      readonly reason: "login" | "verification" | "risk_control";
    }
  | { readonly status: "fill_plan_mismatch" };

interface DiscoveryEntry {
  readonly targetId: string;
  readonly jobs: readonly BrowserJobSummary[];
  readonly expiresAt: number;
}

type JobInspection = ReadyJobInspection | HumanRequiredInspection | MismatchInspection;
type JobListInspection = ReadyJobListInspection | HumanRequiredInspection | MismatchInspection;
type ConversationInspection = ReadyConversationInspection | HumanRequiredInspection | MismatchInspection;
type ApplicationFormInspection =
  | ReadyApplicationFormInspection
  | ApplicationFormHumanRequiredInspection
  | MismatchInspection;

export class BossBrowserRunController {
  readonly #runtime: BossHunterBrowserRuntime;
  readonly #captureJob: (snapshot: unknown) => Promise<CaptureResult>;
  readonly #captureConversation?: (snapshot: unknown) => Promise<CaptureResult>;
  readonly #now: () => Date;
  readonly #captureIdFactory: () => string;
  readonly #discoveryIdFactory: () => string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #searchMinNavigationIntervalMs: number;
  readonly #searchRunCooldownMs: number;
  readonly #searchRiskCooldownMs: number;
  readonly #allowedResumeRoot?: string;
  #searchInProgress = false;
  #lastSearchNavigationAt?: number;
  #searchNavigationCount = 0;
  #nextSearchAllowedAt = 0;
  #riskCooldownUntil = 0;
  readonly #discoveries = new Map<string, DiscoveryEntry>();

  constructor(options: BossBrowserRunControllerOptions) {
    this.#runtime = options.runtime;
    this.#captureJob = options.captureJob;
    this.#captureConversation = options.captureConversation;
    this.#now = options.now ?? (() => new Date());
    this.#captureIdFactory = options.captureIdFactory ?? randomUUID;
    this.#discoveryIdFactory = options.discoveryIdFactory ?? randomUUID;
    this.#sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#searchMinNavigationIntervalMs = nonNegativeDuration(
      options.searchMinNavigationIntervalMs,
      BOSS_SEARCH_MIN_NAVIGATION_INTERVAL_MS,
    );
    this.#searchRunCooldownMs = nonNegativeDuration(options.searchRunCooldownMs, BOSS_SEARCH_RUN_COOLDOWN_MS);
    this.#searchRiskCooldownMs = nonNegativeDuration(
      options.searchRiskCooldownMs,
      BOSS_SEARCH_RISK_COOLDOWN_MS,
    );
    this.#allowedResumeRoot =
      options.allowedResumeRoot === undefined ? undefined : resolve(options.allowedResumeRoot);
  }

  async discoverJobs(): Promise<BrowserJobDiscoveryResult> {
    const health = await this.#readHealth();
    if (health === undefined) {
      return { status: "environment_interrupted", reason: "runtime_unavailable", targetCount: 0 };
    }

    let targets: BossHunterBrowserTarget[];
    try {
      targets = await this.#runtime.targets();
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    const targetResult = selectJobListTarget(targets);
    if (targetResult.kind === "result") return targetResult.value;
    const target = targetResult.target;

    let inspected: JobListInspection;
    try {
      inspected = parseJobListInspection(
        await this.#runtime.evaluate(target.targetId, JOB_LIST_INSPECTION_EXPRESSION),
      );
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    if (inspected.status === "human_required") {
      return { status: "human_required", reason: inspected.reason, targetCount: 1 };
    }
    if (inspected.status === "page_adapter_mismatch") {
      return { status: "no_supported_tab", reason: "no_job_cards", targetCount: 1 };
    }
    if (!isBossUrl(inspected.sourceUrl) || target.url === undefined || !isBossUrl(target.url)) {
      return { status: "no_supported_tab", reason: "no_boss_page", targetCount: 0 };
    }
    if (inspected.jobs.length === 0) {
      return { status: "no_supported_tab", reason: "no_job_cards", targetCount: 1 };
    }

    this.#pruneExpiredDiscoveries();
    const discoveryId = this.#discoveryIdFactory();
    this.#discoveries.set(discoveryId, {
      targetId: target.targetId,
      jobs: inspected.jobs,
      expiresAt: this.#now().getTime() + DISCOVERY_TTL_MS,
    });
    return {
      status: "ready",
      discoveryId,
      targetCount: 1,
      target: {
        pageKind: "job_list",
        title: target.title,
        url: normalizeUrl(inspected.sourceUrl),
      },
      jobs: inspected.jobs,
    };
  }

  /**
   * Search a bounded set of BOSS result pages and capture each new detail page
   * serially. Navigation is restricted to URLs generated by job-search.ts;
   * login, verification, risk or browser failures stop the run and preserve a
   * human handoff instead of retrying around platform controls.
   */
  async searchJobs(input: BrowserJobSearchInput, signal?: AbortSignal): Promise<BrowserJobSearchResult> {
    let plan: ReturnType<typeof createBrowserJobSearchPlan>;
    try {
      plan = createBrowserJobSearchPlan(input);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "invalid_boss_search_keyword";
      if (
        reason === "unsupported_boss_search_city" ||
        reason === "invalid_boss_search_pages" ||
        reason === "invalid_boss_search_jobs"
      ) {
        return { status: "invalid_request", reason, targetCount: 0 };
      }
      return { status: "invalid_request", reason: "invalid_boss_search_keyword", targetCount: 0 };
    }

    const emptyItems: BrowserJobSearchItem[] = [];
    const currentTime = this.#now().getTime();
    if (this.#searchInProgress) {
      return {
        status: "guarded",
        reason: "search_in_progress",
        retryAfterMs: this.#searchMinNavigationIntervalMs,
        targetCount: 0,
        plan,
        pagesVisited: 0,
        items: [],
      };
    }
    if (currentTime < this.#riskCooldownUntil) {
      return {
        status: "guarded",
        reason: "risk_cooldown",
        retryAfterMs: this.#riskCooldownUntil - currentTime,
        targetCount: 0,
        plan,
        pagesVisited: 0,
        items: [],
      };
    }
    if (currentTime < this.#nextSearchAllowedAt) {
      return {
        status: "guarded",
        reason: "search_cooldown",
        retryAfterMs: this.#nextSearchAllowedAt - currentTime,
        targetCount: 0,
        plan,
        pagesVisited: 0,
        items: [],
      };
    }
    this.#searchInProgress = true;
    this.#lastSearchNavigationAt = undefined;
    this.#searchNavigationCount = 0;
    try {
      const health = await this.#readHealth();
      if (health === undefined) {
        return {
          status: "environment_interrupted",
          reason: "runtime_unavailable",
          targetCount: 0,
          plan,
          pagesVisited: 0,
          items: emptyItems,
        };
      }

      const items: BrowserJobSearchItem[] = [];
      const seen = new Set<string>();
      let pagesVisited = 0;
      for (let page = 1; page <= plan.maxPages && items.length < plan.maxJobs; page += 1) {
        if (signal?.aborted) return { status: "cancelled", plan, pagesVisited, items };
        let listTargetId: string | undefined;
        try {
          await this.#paceSearchNavigation(signal);
          if (signal?.aborted) return { status: "cancelled", plan, pagesVisited, items };
          listTargetId = await this.#runtime.newTab(bossSearchUrl(plan, page));
          await this.#runtime.waitForLoad?.(listTargetId, 15_000, signal);
          if (signal?.aborted) {
            await this.#closeQuietly(listTargetId);
            return { status: "cancelled", plan, pagesVisited, items };
          }
        } catch {
          if (listTargetId !== undefined) await this.#closeQuietly(listTargetId);
          return {
            status: "environment_interrupted",
            reason: "browser_disconnected",
            targetCount: 0,
            plan,
            pagesVisited,
            items,
          };
        }
        if (listTargetId === undefined) throw new Error("browser_target_missing");

        let inspected: JobListInspection;
        try {
          inspected = await this.#inspectJobList(listTargetId, signal);
        } catch {
          await this.#closeQuietly(listTargetId);
          return {
            status: "environment_interrupted",
            reason: "browser_disconnected",
            targetCount: 0,
            plan,
            pagesVisited,
            items,
          };
        }
        if (signal?.aborted) {
          await this.#closeQuietly(listTargetId);
          return { status: "cancelled", plan, pagesVisited, items };
        }
        if (inspected.status === "human_required") {
          this.#recordSearchRisk(inspected.reason);
          return {
            status: "human_required",
            reason: inspected.reason,
            targetCount: 1,
            plan,
            pagesVisited,
            items,
          };
        }
        if (inspected.status === "page_adapter_mismatch") {
          await this.#closeQuietly(listTargetId);
          return {
            status: "no_supported_tab",
            reason: "no_job_list",
            targetCount: 1,
            plan,
            pagesVisited,
            items,
          };
        }
        if (!isBossSearchUrl(inspected.sourceUrl)) {
          const handoffReason = bossHandoffReason(inspected.sourceUrl);
          if (handoffReason !== undefined) {
            this.#recordSearchRisk(handoffReason);
            return {
              status: "human_required",
              reason: handoffReason,
              targetCount: 1,
              plan,
              pagesVisited,
              items,
            };
          }
          await this.#closeQuietly(listTargetId);
          return {
            status: "no_supported_tab",
            reason: "no_boss_page",
            targetCount: 0,
            plan,
            pagesVisited,
            items,
          };
        }
        pagesVisited += 1;
        if (inspected.jobs.length === 0) {
          await this.#closeQuietly(listTargetId);
          return items.length === 0
            ? {
                status: "no_supported_tab",
                reason: "no_job_cards",
                targetCount: 1,
                plan,
                pagesVisited,
                items,
              }
            : { status: "partial", plan, pagesVisited, items };
        }

        for (const job of inspected.jobs) {
          if (items.length >= plan.maxJobs) break;
          if (signal?.aborted) {
            await this.#closeQuietly(listTargetId);
            return { status: "cancelled", plan, pagesVisited, items };
          }
          if (seen.has(job.externalJobId)) continue;
          seen.add(job.externalJobId);

          let detailTargetId: string | undefined;
          try {
            await this.#paceSearchNavigation(signal);
            if (signal?.aborted) {
              await this.#closeQuietly(listTargetId);
              return { status: "cancelled", plan, pagesVisited, items };
            }
            detailTargetId = await this.#runtime.newTab(job.jobUrl);
            await this.#runtime.waitForLoad?.(detailTargetId, 15_000, signal);
            if (signal?.aborted) {
              await this.#closeQuietly(detailTargetId);
              await this.#closeQuietly(listTargetId);
              return { status: "cancelled", plan, pagesVisited, items };
            }
          } catch {
            if (detailTargetId !== undefined) await this.#closeQuietly(detailTargetId);
            await this.#closeQuietly(listTargetId);
            return {
              status: "environment_interrupted",
              reason: "browser_disconnected",
              targetCount: 0,
              plan,
              pagesVisited,
              items,
            };
          }
          if (detailTargetId === undefined) throw new Error("browser_target_missing");
          const captured = await this.#captureJobTarget({
            targetId: detailTargetId,
            type: "page",
            url: job.jobUrl,
          });
          if (captured.status === "ok") {
            await this.#closeQuietly(detailTargetId);
            items.push({ status: "captured", job, applicationId: captured.applicationId });
            continue;
          }
          if (captured.status === "human_required") {
            this.#recordSearchRisk(captured.reason);
            await this.#closeQuietly(listTargetId);
            return {
              status: "human_required",
              reason: captured.reason,
              targetCount: 1,
              plan,
              pagesVisited,
              items,
            };
          }
          if (captured.status === "environment_interrupted") {
            await this.#closeQuietly(detailTargetId);
            await this.#closeQuietly(listTargetId);
            return {
              status: "environment_interrupted",
              reason: captured.reason,
              targetCount: 0,
              plan,
              pagesVisited,
              items,
            };
          }
          await this.#closeQuietly(detailTargetId);
          items.push({
            status: "failed",
            job,
            reason: captured.status === "page_adapter_mismatch" ? "page_adapter_mismatch" : captured.status,
          });
        }
        await this.#closeQuietly(listTargetId);
      }
      return { status: items.length === 0 ? "partial" : "ok", plan, pagesVisited, items };
    } finally {
      this.#searchInProgress = false;
      if (this.#searchNavigationCount > 0) {
        this.#nextSearchAllowedAt = Math.max(
          this.#nextSearchAllowedAt,
          this.#now().getTime() + this.#searchRunCooldownMs,
        );
      }
    }
  }

  searchGuardStatus(): BrowserSearchGuardStatus {
    const now = this.#now();
    const currentTime = now.getTime();
    if (this.#searchInProgress) {
      return searchGuarded("search_in_progress", this.#searchMinNavigationIntervalMs, now);
    }
    if (currentTime < this.#riskCooldownUntil) {
      return searchGuarded("risk_cooldown", this.#riskCooldownUntil - currentTime, now);
    }
    if (currentTime < this.#nextSearchAllowedAt) {
      return searchGuarded("search_cooldown", this.#nextSearchAllowedAt - currentTime, now);
    }
    return {
      state: "ready",
      guarded: false,
      observedAt: now.toISOString(),
      scope: "controller_process",
      resetsOnRestart: true,
    };
  }

  async captureDiscoveredJob(
    discoveryId: string,
    externalJobId: string,
  ): Promise<CaptureDiscoveredJobResult> {
    const discovery = this.#discoveries.get(discoveryId);
    if (discovery === undefined || this.#now().getTime() >= discovery.expiresAt) {
      this.#discoveries.delete(discoveryId);
      return { status: "invalid_request", reason: "discovery_expired", targetCount: 0 };
    }
    const job = discovery.jobs.find((candidate) => candidate.externalJobId === externalJobId);
    if (job === undefined) return { status: "invalid_request", reason: "job_not_found", targetCount: 0 };

    let targets: BossHunterBrowserTarget[];
    try {
      targets = await this.#runtime.targets();
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    const target = targets.find((candidate) => candidate.targetId === discovery.targetId);
    if (target === undefined || !isBossUrl(target.url)) {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    let detailTargetId: string;
    try {
      detailTargetId = await this.#runtime.newTab(job.jobUrl);
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    const result = await this.#captureJobTarget({
      targetId: detailTargetId,
      type: "page",
      url: job.jobUrl,
    });
    if (result.status === "ok") {
      try {
        await this.#runtime.close(detailTargetId);
      } catch {
        // A failed cleanup must not overwrite a completed local capture.
      }
    }
    return result;
  }

  async status(): Promise<BrowserRunStatus> {
    const health = await this.#readHealth();
    if (health === undefined) {
      return { status: "environment_interrupted", reason: "runtime_unavailable", targetCount: 0 };
    }
    let targets: BossHunterBrowserTarget[];
    try {
      targets = await this.#runtime.targets();
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    return summarizeTargets(targets);
  }

  async captureCurrentJob(): Promise<CaptureCurrentJobResult> {
    const health = await this.#readHealth();
    if (health === undefined) {
      return { status: "environment_interrupted", reason: "runtime_unavailable", targetCount: 0 };
    }
    let targets: BossHunterBrowserTarget[];
    try {
      targets = await this.#runtime.targets();
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    const targetResult = selectTarget(targets);
    if (targetResult.kind === "result") return targetResult.value;
    return this.#captureJobTarget(targetResult.target);
  }

  async captureCurrentConversation(applicationId: string): Promise<CaptureCurrentConversationResult> {
    if (this.#captureConversation === undefined) {
      return { status: "environment_interrupted", reason: "runtime_unavailable", targetCount: 0 };
    }
    const health = await this.#readHealth();
    if (health === undefined) {
      return { status: "environment_interrupted", reason: "runtime_unavailable", targetCount: 0 };
    }
    let targets: BossHunterBrowserTarget[];
    try {
      targets = await this.#runtime.targets();
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    const targetResult = selectConversationTarget(targets);
    if (targetResult.kind === "result") return targetResult.value;

    let inspected: ConversationInspection;
    try {
      inspected = parseConversationInspection(
        await this.#runtime.evaluate(targetResult.target.targetId, CONVERSATION_INSPECTION_EXPRESSION),
      );
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    if (inspected.status === "human_required") {
      return { status: "human_required", reason: inspected.reason, targetCount: 1 };
    }
    if (inspected.status === "page_adapter_mismatch") {
      return { status: "page_adapter_mismatch", reason: "conversation", targetCount: 1 };
    }
    if (!isConversationUrl(inspected.sourceUrl) || !isConversationUrl(targetResult.target.url)) {
      return { status: "page_adapter_mismatch", reason: "conversation", targetCount: 1 };
    }

    const visible = {
      pageKind: "conversation" as const,
      captureId: this.#captureIdFactory(),
      capturedAt: this.#now().toISOString(),
      sourceUrl: normalizeUrl(inspected.sourceUrl),
      applicationId,
      conversationId: inspected.conversationId,
      messageId: inspected.messageId,
      recruiterName: inspected.recruiterName,
      messageText: inspected.messageText,
    };
    const pageRevision = createPageRevision(visible);
    const result = await this.#captureConversation({ ...visible, pageRevision });
    return {
      status: "ok",
      ...result,
      conversation: {
        conversationId: visible.conversationId,
        messageId: visible.messageId,
        recruiterName: visible.recruiterName,
        pageRevision,
      },
    };
  }

  /**
   * Inspect a user-opened official/ATS form without navigating or mutating the page.
   * The expected URL comes from a verified local JobLead; model callers never
   * select a target, expression, or arbitrary navigation URL.
   */
  async inspectApplicationForm(expectedUrl: string): Promise<InspectApplicationFormResult> {
    const expected = parseSafeOfficialUrl(expectedUrl);
    if (expected === undefined) {
      return { status: "invalid_request", reason: "unsupported_official_url", targetCount: 0 };
    }
    const health = await this.#readHealth();
    if (health === undefined) {
      return { status: "environment_interrupted", reason: "runtime_unavailable", targetCount: 0 };
    }
    let targets: BossHunterBrowserTarget[];
    try {
      targets = await this.#runtime.targets();
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    const selected = selectApplicationFormTarget(targets, expected);
    if (selected.kind === "result") return selected.value;

    let inspected: ApplicationFormInspection;
    try {
      inspected = parseApplicationFormInspection(
        await this.#runtime.evaluate(selected.target.targetId, APPLICATION_FORM_INSPECTION_EXPRESSION),
      );
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    if (inspected.status === "human_required") {
      return { status: "human_required", reason: inspected.reason, targetCount: 1 };
    }
    if (inspected.status === "page_adapter_mismatch") {
      return { status: "page_adapter_mismatch", reason: "application_form", targetCount: 1 };
    }
    const actual = parseSafeOfficialUrl(inspected.sourceUrl);
    const targetUrl = parseSafeOfficialUrl(selected.target.url ?? "");
    if (
      actual === undefined ||
      targetUrl === undefined ||
      !sameOfficialOrigin(expected, actual) ||
      !sameOfficialOrigin(expected, targetUrl)
    ) {
      return { status: "human_required", reason: "page_identity_mismatch", targetCount: 1 };
    }

    const pageUrl = redactUrl(actual);
    const fields = inspected.fields.map((field) => ({
      ...field,
      fieldId: `form-field:${createHash("sha256")
        .update(
          `${field.ordinal}\u0000${field.controlType}\u0000${field.inputType}\u0000${field.label}\u0000${field.name ?? ""}`,
        )
        .digest("hex")}`,
      metadataTrust: "untrusted_page" as const,
    }));
    const formHash = createHash("sha256").update(JSON.stringify({ pageUrl, fields })).digest("hex");
    return {
      status: "ready",
      targetCount: 1,
      page: {
        pageKind: "application_form",
        title: inspected.title,
        url: pageUrl,
        hostname: actual.hostname,
        formHash,
        metadataTrust: "untrusted_page",
      },
      fields,
    };
  }

  /**
   * Fill only an exact, freshly re-inspected standard-form plan. The caller
   * supplies field ids created by inspectApplicationForm; CSS, JavaScript,
   * file controls, consent controls, navigation and submit are not accepted.
   */
  async fillApplicationForm(input: FillApplicationFormInput): Promise<FillApplicationFormResult> {
    if (
      !/^[a-f0-9]{64}$/u.test(input.expectedFormHash) ||
      (input.fields.length === 0 && input.resumeUpload === undefined) ||
      input.fields.length > 50 ||
      !uniqueFillFields(input.fields)
    ) {
      return { status: "invalid_request", reason: "unsupported_official_url", targetCount: 0 };
    }
    const inspected = await this.inspectApplicationForm(input.expectedUrl);
    if (inspected.status !== "ready") return inspected;
    if (inspected.page.formHash !== input.expectedFormHash) {
      return {
        status: "conflict",
        reason: "form_changed",
        targetCount: 1,
        currentFormHash: inspected.page.formHash,
      };
    }
    const requested = input.fields.map((request) => {
      const field = inspected.fields.find((candidate) => candidate.fieldId === request.fieldId);
      if (
        field === undefined ||
        field.disabled ||
        field.readOnly ||
        field.currentState !== "empty" ||
        !isFillableControl(field.controlType) ||
        request.value.trim().length === 0 ||
        request.value.length > 2_000 ||
        request.value.includes("\u0000")
      )
        return undefined;
      return {
        fieldId: field.fieldId,
        ordinal: field.ordinal,
        controlType: field.controlType,
        inputType: field.inputType,
        label: field.label,
        name: field.name ?? "",
        value: request.value,
      };
    });
    if (requested.some((field) => field === undefined)) {
      return { status: "conflict", reason: "field_state_changed", targetCount: 1 };
    }
    let uploadField: { fieldId: string; ordinal: number } | undefined;
    if (input.resumeUpload !== undefined) {
      const field = inspected.fields.find((candidate) => candidate.fieldId === input.resumeUpload?.fieldId);
      if (
        field === undefined ||
        field.controlType !== "file" ||
        inspected.fields.filter((candidate) => candidate.controlType === "file" && !candidate.disabled)
          .length !== 1 ||
        field.disabled ||
        field.readOnly ||
        field.currentState !== "empty"
      ) {
        return { status: "conflict", reason: "field_state_changed", targetCount: 1 };
      }
      if (!/^[a-f0-9]{64}$/u.test(input.resumeUpload.contentHash)) {
        return { status: "conflict", reason: "fill_plan_mismatch", targetCount: 1 };
      }
      try {
        if (this.#allowedResumeRoot !== undefined) {
          const resolvedFile = resolve(input.resumeUpload.filePath);
          const pathFromRoot = relative(this.#allowedResumeRoot, resolvedFile);
          if (pathFromRoot === "" || pathFromRoot.startsWith("..") || pathFromRoot.includes("\u0000")) {
            return { status: "conflict", reason: "fill_plan_mismatch", targetCount: 1 };
          }
        }
        const info = await lstat(input.resumeUpload.filePath);
        if (!info.isFile() || info.isSymbolicLink())
          return { status: "conflict", reason: "fill_plan_mismatch", targetCount: 1 };
        const bytes = await readFile(input.resumeUpload.filePath);
        if (createHash("sha256").update(bytes).digest("hex") !== input.resumeUpload.contentHash) {
          return { status: "conflict", reason: "fill_plan_mismatch", targetCount: 1 };
        }
      } catch {
        return { status: "conflict", reason: "fill_plan_mismatch", targetCount: 1 };
      }
      uploadField = { fieldId: field.fieldId, ordinal: field.ordinal };
    }
    let targets: BossHunterBrowserTarget[];
    try {
      targets = await this.#runtime.targets();
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    const expected = parseSafeOfficialUrl(input.expectedUrl);
    if (expected === undefined) {
      return { status: "invalid_request", reason: "unsupported_official_url", targetCount: 0 };
    }
    const selected = selectApplicationFormTarget(targets, expected);
    if (selected.kind === "result") {
      return selected.value.status === "ready"
        ? { status: "conflict", reason: "fill_plan_mismatch", targetCount: 1 }
        : selected.value;
    }
    let filled: ApplicationFormFillInspection;
    try {
      filled = parseApplicationFormFillInspection(
        await this.#runtime.evaluate(
          selected.target.targetId,
          createApplicationFormFillExpression(requested as ApplicationFormFillRequest[]),
        ),
      );
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    if (filled.status === "human_required") {
      return { status: "human_required", reason: filled.reason, targetCount: 1 };
    }
    if (filled.status !== "filled") {
      return { status: "conflict", reason: "fill_plan_mismatch", targetCount: 1 };
    }
    const actual = parseSafeOfficialUrl(filled.sourceUrl);
    if (actual === undefined || !sameOfficialOrigin(expected, actual)) {
      return { status: "human_required", reason: "page_identity_mismatch", targetCount: 1 };
    }
    const filledFieldIds = filled.ordinals.map(
      (ordinal) => requested.find((field) => field?.ordinal === ordinal)?.fieldId,
    );
    if (
      filledFieldIds.some((fieldId) => fieldId === undefined) ||
      filledFieldIds.length !== requested.length
    ) {
      return { status: "conflict", reason: "fill_plan_mismatch", targetCount: 1 };
    }
    let uploadedResume = false;
    if (uploadField !== undefined) {
      if (typeof this.#runtime.setFiles !== "function")
        return { status: "human_required", reason: "risk_control", targetCount: 1 };
      try {
        await this.#runtime.setFiles(selected.target.targetId, 'input[type="file"]', [
          input.resumeUpload?.filePath as string,
        ]);
        uploadedResume = true;
      } catch {
        return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
      }
    }
    return {
      status: "filled",
      targetCount: 1,
      page: inspected.page,
      formHash: inspected.page.formHash,
      filledFieldIds: filledFieldIds as string[],
      filledCount: filledFieldIds.length,
      requiresHumanReview: true,
      submitted: false,
      uploadedResume,
      nextAction: filled.nextAction,
    };
  }

  async pollFixedJob(jobUrl: string, externalJobId: string): Promise<PollFixedJobResult> {
    if (!isSupportedJobUrl(jobUrl)) {
      return { status: "invalid_request", reason: "unsupported_job_url", targetCount: 0 };
    }
    if (!sameJobId(undefined, jobUrl, externalJobId)) {
      return { status: "invalid_request", reason: "external_job_id_mismatch", targetCount: 0 };
    }

    const health = await this.#readHealth();
    if (health === undefined) {
      return { status: "environment_interrupted", reason: "runtime_unavailable", targetCount: 0 };
    }
    let detailTargetId: string;
    const normalizedUrl = normalizeJobUrl(jobUrl);
    try {
      detailTargetId = await this.#runtime.newTab(normalizedUrl);
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    const result = await this.#captureJobTarget({
      targetId: detailTargetId,
      type: "page",
      url: normalizedUrl,
    });
    if (result.status === "ok") {
      try {
        await this.#runtime.close(detailTargetId);
      } catch {
        // A failed cleanup must not overwrite a completed local observation.
      }
    }
    return result;
  }

  async #captureJobTarget(target: BossHunterBrowserTarget): Promise<CaptureCurrentJobResult> {
    let inspected: JobInspection;
    try {
      inspected = parseInspection(await this.#runtime.evaluate(target.targetId, JOB_INSPECTION_EXPRESSION));
    } catch {
      return { status: "environment_interrupted", reason: "browser_disconnected", targetCount: 0 };
    }
    if (inspected.status === "human_required") {
      return { status: "human_required", reason: inspected.reason, targetCount: 1 };
    }
    if (inspected.status === "page_adapter_mismatch") {
      return { status: "page_adapter_mismatch", reason: "job_detail", targetCount: 1 };
    }
    if (
      !isSupportedJobUrl(inspected.sourceUrl) ||
      !sameJobId(target.url, inspected.sourceUrl, inspected.externalJobId)
    ) {
      return { status: "page_adapter_mismatch", reason: "job_detail", targetCount: 1 };
    }

    const capturedAt = this.#now().toISOString();
    const visible = {
      pageKind: "job_detail" as const,
      captureId: this.#captureIdFactory(),
      capturedAt,
      sourceUrl: normalizeJobUrl(inspected.sourceUrl),
      externalJobId: inspected.externalJobId,
      company: inspected.company,
      role: inspected.role,
      description: inspected.description,
    };
    const pageRevision = createPageRevision(visible);
    const result = await this.#captureJob({ ...visible, pageRevision });
    return {
      status: "ok",
      ...result,
      job: {
        externalJobId: visible.externalJobId,
        company: visible.company,
        role: visible.role,
        jobUrl: visible.sourceUrl,
        pageRevision,
      },
    };
  }

  async #readHealth(): Promise<BossHunterRuntimeHealth | undefined> {
    try {
      const health = await this.#runtime.health();
      if (health?.status !== "ok" || health.runtime !== "bosshunter") return undefined;
      return health;
    } catch {
      return undefined;
    }
  }

  #pruneExpiredDiscoveries(): void {
    const currentTime = this.#now().getTime();
    for (const [discoveryId, discovery] of this.#discoveries) {
      if (currentTime >= discovery.expiresAt) this.#discoveries.delete(discoveryId);
    }
  }

  async #closeQuietly(targetId: string): Promise<void> {
    try {
      await this.#runtime.close(targetId);
    } catch {
      // Cleanup is best effort; local captures already committed remain valid.
    }
  }

  /**
   * BOSS hydrates result cards after the document reports `complete`. Match
   * BossHunter's bounded DOM polling so a normal async render is not mistaken
   * for an empty or unsupported page. Login/verification remains an immediate
   * handoff and never triggers a retry loop.
   */
  async #inspectJobList(targetId: string, signal?: AbortSignal): Promise<JobListInspection> {
    let inspected: JobListInspection = { status: "page_adapter_mismatch" };
    for (let attempt = 0; attempt < SEARCH_LIST_INSPECTION_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) return inspected;
      inspected = parseJobListInspection(
        await this.#runtime.evaluate(targetId, JOB_LIST_INSPECTION_EXPRESSION),
      );
      if (inspected.status === "human_required") return inspected;
      if (inspected.status === "ready" && inspected.jobs.length > 0) return inspected;
      if (attempt < SEARCH_LIST_INSPECTION_ATTEMPTS - 1) {
        await this.#sleep(SEARCH_LIST_INSPECTION_INTERVAL_MS);
      }
    }
    return inspected;
  }

  async #paceSearchNavigation(signal?: AbortSignal): Promise<void> {
    const currentTime = this.#now().getTime();
    const remaining =
      this.#lastSearchNavigationAt === undefined
        ? 0
        : Math.max(0, this.#searchMinNavigationIntervalMs - (currentTime - this.#lastSearchNavigationAt));
    if (remaining > 0 && !signal?.aborted) await this.#sleep(remaining);
    if (signal?.aborted) return;
    this.#lastSearchNavigationAt = this.#now().getTime();
    this.#searchNavigationCount += 1;
  }

  #recordSearchRisk(reason: "login" | "verification" | "risk_control"): void {
    if (reason !== "risk_control") return;
    this.#riskCooldownUntil = Math.max(
      this.#riskCooldownUntil,
      this.#now().getTime() + this.#searchRiskCooldownMs,
    );
  }
}

function searchGuarded(
  state: "search_in_progress" | "search_cooldown" | "risk_cooldown",
  retryAfterMs: number,
  now: Date,
): BrowserSearchGuardStatus {
  return {
    state,
    guarded: true,
    retryAfterMs: Math.max(0, retryAfterMs),
    observedAt: now.toISOString(),
    scope: "controller_process",
    resetsOnRestart: true,
  };
}

export const JOB_INSPECTION_EXPRESSION = `(() => {
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
  if (document.querySelector('.login-register-content, .login-dialog, [class*=login-dialog]')) {
    return { status: 'human_required', reason: 'login', sourceUrl: location.href };
  }
  if (document.querySelector('.captcha, [class*=captcha], [class*=verify-dialog]')) {
    return { status: 'human_required', reason: 'verification', sourceUrl: location.href };
  }
  if (document.querySelector('[class*=risk-control], [class*=security-check], [class*=abnormal]')) {
    return { status: 'human_required', reason: 'risk_control', sourceUrl: location.href };
  }
  const match = location.pathname.match(/^\\/job_detail\\/([a-zA-Z0-9_-]+)(?:\\.html)?/u);
  if (!match) return { status: 'page_adapter_mismatch' };
  const role = text('.info-primary .name h1') || text('.job-banner .name h1') || text('.name h1');
  const company = text('.company-info a + a') || text('.company-info a[ka="job-detail-company_custompage"]')
    || text('.sider-company .company-info a') || text('.job-sider .company-info a') || text('.company-info .company-name');
  const description = text('.job-sec-text') || text('.job-detail-section .text') || text('.job-detail .job-sec');
  if (!role || !company || !description) return { status: 'page_adapter_mismatch' };
  return { status: 'ready', sourceUrl: location.href, externalJobId: match[1], company, role, description };
})()`;

export const CONVERSATION_INSPECTION_EXPRESSION = `(() => {
  const text = (root, selectors) => {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const value = element?.innerText?.trim() || element?.textContent?.trim() || '';
      if (value) return value;
    }
    return '';
  };
  if (document.querySelector('.login-register-content, .login-dialog, [class*=login-dialog]')) {
    return { status: 'human_required', reason: 'login', sourceUrl: location.href };
  }
  if (document.querySelector('.captcha, [class*=captcha], [class*=verify-dialog]')) {
    return { status: 'human_required', reason: 'verification', sourceUrl: location.href };
  }
  if (document.querySelector('[class*=risk-control], [class*=security-check], [class*=abnormal]')) {
    return { status: 'human_required', reason: 'risk_control', sourceUrl: location.href };
  }
  if (location.pathname !== '/web/geek/chat') return { status: 'page_adapter_mismatch' };
  const items = Array.from(document.querySelectorAll('.message-item, .chat-message'));
  const recruiterItems = items.filter((item) =>
    !item.classList.contains('is-self') &&
    !item.classList.contains('message-self') &&
    !item.classList.contains('item-myself') &&
    !item.classList.contains('item-system') &&
    !item.classList.contains('system-message') &&
    item.querySelector('.msg-self, .system-message') === null
  );
  const latest = recruiterItems.at(-1);
  if (!latest) return { status: 'page_adapter_mismatch' };
  const messageText = text(latest, ['.msg-text', '.message-text', '.message-content', '.text', '.card', '.message-card'])
    || latest.innerText?.trim() || latest.textContent?.trim() || '';
  const recruiterName = text(document, ['.chat-info .name', '.chat-title .name', '.friend-content.selected .name-text', 'li[role=listitem].active .name-text', 'li[role=listitem][aria-selected=true] .name-text']) || '当前招聘方';
  if (!messageText) return { status: 'page_adapter_mismatch' };
  const selected = document.querySelector('.friend-content.selected, li[role=listitem].active, li[role=listitem][aria-selected=true], .chat-conversation.active');
  const visibleKey = (value) => Array.from(value).map((character) => character.codePointAt(0).toString(16)).join('').slice(0, 24);
  const conversationId = selected?.dataset?.conversationId || selected?.dataset?.id || 'visible-' + visibleKey(recruiterName + '\\n' + location.href);
  const messageId = latest.dataset?.messageId || latest.dataset?.mid || latest.id || 'visible-' + visibleKey(messageText);
  return { status: 'ready', sourceUrl: location.href, conversationId, messageId, recruiterName, messageText };
})()`;

export const APPLICATION_FORM_INSPECTION_EXPRESSION = `(() => {
  const clean = (value, max = 160) => String(value || '')
    .replace(/[\\u0000-\\u001f\\u007f]/gu, ' ')
    .replace(/\\s+/gu, ' ')
    .trim()
    .slice(0, max);
  const sourceUrl = location.href;
  if (document.querySelector('input[type=password], form[action*=login i], [class*=login-form i], [id*=login-form i]')) {
    return { status: 'human_required', reason: 'login', sourceUrl };
  }
  if (document.querySelector('[class*=captcha i], [id*=captcha i], iframe[src*=captcha i], [class*=verify i], [id*=verify i]')) {
    return { status: 'human_required', reason: 'verification', sourceUrl };
  }
  if (document.querySelector('[class*=risk-control i], [id*=risk-control i], [class*=security-check i], [id*=security-check i]')) {
    return { status: 'human_required', reason: 'risk_control', sourceUrl };
  }
  const isVisible = (element) => {
    if (element.hidden || element.closest('[hidden], [aria-hidden=true]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const labelledBy = (element) => clean((element.getAttribute('aria-labelledby') || '')
    .split(/\\s+/u)
    .map((id) => document.getElementById(id)?.textContent || '')
    .join(' '));
  const labelFor = (element) => {
    const explicit = Array.from(document.querySelectorAll('label')).find((label) =>
      element.id && label.getAttribute('for') === element.id
    );
    const wrapping = element.closest('label');
    const container = element.closest('[class*=form-item i], [class*=form-field i], .form-group, fieldset');
    const nearby = container?.querySelector('label, legend, [class*=label i]');
    return clean(
      explicit?.textContent || wrapping?.textContent || element.getAttribute('aria-label') ||
      labelledBy(element) || nearby?.textContent || element.getAttribute('placeholder') ||
      element.getAttribute('name') || ''
    );
  };
  const controlType = (element) => {
    if (element.tagName === 'TEXTAREA') return 'textarea';
    if (element.tagName === 'SELECT') return 'select';
    if (element.matches('[role=combobox], [aria-haspopup=listbox]')) return 'combobox';
    const type = clean(element.getAttribute('type') || 'text', 32).toLowerCase();
    return ['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'checkbox', 'radio', 'file'].includes(type)
      ? type
      : 'other';
  };
  const state = (element, type) => {
    if (type === 'checkbox' || type === 'radio') return element.checked ? 'checked' : 'unchecked';
    if (type === 'file') return element.files && element.files.length > 0 ? 'present' : 'empty';
    if (type === 'combobox') {
      const value = clean(element.value || element.getAttribute('aria-valuetext') || element.textContent || '', 500);
      return value && !/^(请选择|选择|please select|select)$/iu.test(value) ? 'present' : 'empty';
    }
    return String(element.value || '').length > 0 ? 'present' : 'empty';
  };
  const isCustomSelect = (element) => element.matches('[role=combobox], [aria-haspopup=listbox]');
  const rawControls = Array.from(document.querySelectorAll('input, textarea, select, [role=combobox], [aria-haspopup=listbox]'));
  const controls = rawControls
    .filter((element) => {
      const type = clean(element.getAttribute('type') || 'text', 32).toLowerCase();
      return isVisible(element) && (isCustomSelect(element) || !['hidden', 'submit', 'reset', 'button', 'image'].includes(type));
    })
    .filter((element, index, visibleControls) => !visibleControls.some((candidate, candidateIndex) =>
      candidateIndex !== index && isCustomSelect(candidate) && candidate.contains(element)
    ));
  if (controls.length === 0 || document.querySelector('form, [role=form]') === null) {
    return { status: 'page_adapter_mismatch' };
  }
  if (controls.length > ${MAX_APPLICATION_FORM_FIELDS}) return { status: 'page_adapter_mismatch' };
  const fields = controls.map((element, ordinal) => {
    const type = controlType(element);
    const controlledListbox = element.getAttribute('aria-controls');
    const optionRoot = controlledListbox ? document.getElementById(controlledListbox) : document.querySelector('[role=listbox]');
    const options = type === 'select'
      ? Array.from(element.options).slice(0, 100).map((option) => ({ label: clean(option.textContent, 120), value: clean(option.value, 120) }))
      : type === 'combobox' && optionRoot && isVisible(optionRoot)
        ? Array.from(optionRoot.querySelectorAll('[role=option]')).filter(isVisible).slice(0, 100).map((option) => ({
            label: clean(option.textContent, 120),
            value: clean(option.getAttribute('data-value') || option.getAttribute('value') || '', 120),
          }))
        : [];
    return {
      ordinal,
      controlType: type,
      inputType: type === 'combobox' ? 'combobox' : clean(element.getAttribute('type') || element.tagName.toLowerCase(), 32).toLowerCase(),
      label: labelFor(element),
      name: clean(element.getAttribute('name') || '', 120),
      autocomplete: clean(element.getAttribute('autocomplete') || '', 80),
      required: element.required === true || element.getAttribute('aria-required') === 'true',
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      readOnly: element.readOnly === true || element.getAttribute('aria-readonly') === 'true',
      currentState: state(element, type),
      ...(options.length === 0 ? {} : { options }),
    };
  });
  return { status: 'ready', sourceUrl, title: clean(document.title), fields };
})()`;

export function createApplicationFormFillExpression(fields: readonly ApplicationFormFillRequest[]): string {
  const payload = JSON.stringify(fields)
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
  return `(() => {
  const requested = ${payload};
  const clean = (value, max = 160) => String(value || '')
    .replace(/[\\u0000-\\u001f\\u007f]/gu, ' ')
    .replace(/\\s+/gu, ' ')
    .trim()
    .slice(0, max);
  const sourceUrl = location.href;
  if (document.querySelector('input[type=password], form[action*=login i], [class*=login-form i], [id*=login-form i]')) {
    return { status: 'human_required', reason: 'login' };
  }
  if (document.querySelector('[class*=captcha i], [id*=captcha i], iframe[src*=captcha i], [class*=verify i], [id*=verify i]')) {
    return { status: 'human_required', reason: 'verification' };
  }
  if (document.querySelector('[class*=risk-control i], [id*=risk-control i], [class*=security-check i], [id*=security-check i]')) {
    return { status: 'human_required', reason: 'risk_control' };
  }
  const isVisible = (element) => {
    if (element.hidden || element.closest('[hidden], [aria-hidden=true]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const labelledBy = (element) => clean((element.getAttribute('aria-labelledby') || '')
    .split(/\\s+/u)
    .map((id) => document.getElementById(id)?.textContent || '')
    .join(' '));
  const labelFor = (element) => {
    const explicit = Array.from(document.querySelectorAll('label')).find((label) =>
      element.id && label.getAttribute('for') === element.id
    );
    const wrapping = element.closest('label');
    const container = element.closest('[class*=form-item i], [class*=form-field i], .form-group, fieldset');
    const nearby = container?.querySelector('label, legend, [class*=label i]');
    return clean(
      explicit?.textContent || wrapping?.textContent || element.getAttribute('aria-label') ||
      labelledBy(element) || nearby?.textContent || element.getAttribute('placeholder') ||
      element.getAttribute('name') || ''
    );
  };
  const controlType = (element) => {
    if (element.tagName === 'TEXTAREA') return 'textarea';
    if (element.tagName === 'SELECT') return 'select';
    if (element.matches('[role=combobox], [aria-haspopup=listbox]')) return 'combobox';
    const type = clean(element.getAttribute('type') || 'text', 32).toLowerCase();
    return ['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'checkbox', 'radio', 'file'].includes(type)
      ? type
      : 'other';
  };
  const isCustomSelect = (element) => element.matches('[role=combobox], [aria-haspopup=listbox]');
  const controls = Array.from(document.querySelectorAll('input, textarea, select, [role=combobox], [aria-haspopup=listbox]'))
    .filter((element) => {
      const type = clean(element.getAttribute('type') || 'text', 32).toLowerCase();
      return isVisible(element) && (isCustomSelect(element) || !['hidden', 'submit', 'reset', 'button', 'image'].includes(type));
    })
    .filter((element, index, visibleControls) => !visibleControls.some((candidate, candidateIndex) =>
      candidateIndex !== index && isCustomSelect(candidate) && candidate.contains(element)
    ));
  const normalizeOption = (value) => clean(value, 500).toLocaleLowerCase('zh-CN');
  const optionMatches = (wanted, label, value) => {
    if (label === wanted || value === wanted) return true;
    if (wanted === '硕士' && label === '硕士研究生') return true;
    if (wanted === '本科' && label === '大学本科') return true;
    const withoutCitySuffix = (text) => text.replace(/市$/u, '');
    return wanted.length >= 2 && withoutCitySuffix(label) === withoutCitySuffix(wanted);
  };
  const prepared = requested.map((request) => {
    const element = controls[request.ordinal];
    if (
      !element || element.disabled || element.readOnly ||
      controlType(element) !== request.controlType ||
      (controlType(element) === 'combobox' ? 'combobox' : clean(element.getAttribute('type') || element.tagName.toLowerCase(), 32).toLowerCase()) !== request.inputType ||
      labelFor(element) !== request.label ||
      clean(element.getAttribute('name') || '', 120) !== request.name ||
      String(element.value || '').length > 0
    ) return null;
    if (element.tagName === 'SELECT') {
      const wanted = normalizeOption(request.value);
      const option = Array.from(element.options).find((candidate) => optionMatches(
        wanted,
        normalizeOption(candidate.textContent),
        normalizeOption(candidate.value),
      ));
      return option ? { request, element, option } : null;
    }
    if (controlType(element) === 'combobox') return { request, element };
    if (!['INPUT', 'TEXTAREA'].includes(element.tagName)) return null;
    return { request, element };
  });
  if (prepared.some((entry) => entry === null)) return { status: 'fill_plan_mismatch' };
  for (const entry of prepared) {
    const { element, option, request } = entry;
    if (element.tagName === 'SELECT') {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (!setter || !option) return { status: 'fill_plan_mismatch' };
      setter.call(element, option.value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (controlType(element) === 'combobox') {
      element.click();
      const listboxId = element.getAttribute('aria-controls');
      const listbox = listboxId ? document.getElementById(listboxId) : document.querySelector('[role=listbox]');
      if (!listbox || !isVisible(listbox)) return { status: 'fill_plan_mismatch' };
      const wanted = normalizeOption(request.value);
      const option = Array.from(listbox.querySelectorAll('[role=option]')).find((candidate) => {
        const label = normalizeOption(candidate.textContent || '');
        const value = normalizeOption(candidate.getAttribute('data-value') || candidate.getAttribute('value') || '');
        return optionMatches(wanted, label, value);
      });
      if (!option) return { status: 'fill_plan_mismatch' };
      option.click();
    } else {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) return { status: 'fill_plan_mismatch' };
      setter.call(element, request.value);
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const actions = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]')).filter(isVisible);
  const actionText = actions.map((element) => clean(element.textContent || element.value || element.getAttribute('aria-label') || '', 80));
  const hasFinalSubmit = actionText.some((text) => /^(提交|确认提交|投递|申请|submit|apply)$/iu.test(text));
  const hasNextStep = actionText.some((text) => /(下一步|保存并继续|继续|next|save and continue)/iu.test(text));
  return {
    status: 'filled',
    sourceUrl,
    ordinals: prepared.map((entry) => entry.request.ordinal),
    nextAction: hasFinalSubmit ? 'review_before_submit' : hasNextStep ? 'next_step_handoff' : 'review_before_submit',
  };
})()`;
}

export const JOB_LIST_INSPECTION_EXPRESSION = `(() => {
  const text = (root, selectors) => {
    for (const selector of selectors) {
      const value = root.querySelector(selector)?.textContent?.trim() || '';
      if (value) return value;
    }
    return '';
  };
  if (document.querySelector('.login-register-content, .login-dialog, [class*=login-dialog]')) {
    return { status: 'human_required', reason: 'login', sourceUrl: location.href };
  }
  if (document.querySelector('.captcha, [class*=captcha], [class*=verify-dialog]')) {
    return { status: 'human_required', reason: 'verification', sourceUrl: location.href };
  }
  if (document.querySelector('[class*=risk-control], [class*=security-check], [class*=abnormal]')) {
    return { status: 'human_required', reason: 'risk_control', sourceUrl: location.href };
  }
  const jobs = [];
  const seen = new Set();
  const addJob = (anchor, box) => {
    if (!anchor) return;
    const href = anchor.href || anchor.getAttribute('href') || '';
    const url = new URL(href, location.origin);
    const match = url.pathname.match(/^\\/job_detail\\/([a-zA-Z0-9_-]+)(?:\\.html)?/u);
    const role = (anchor.textContent || '').trim() || text(box, ['.job-name', '.name']);
    if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || !match || !role || seen.has(match[1])) return;
    if (role.includes('查看更多') || role.includes('更多职位')) return;
    const tags = Array.from(box?.querySelectorAll('.tag-list li, [class*=tag] li, .tag-list span') || [])
      .map((item) => item.textContent?.trim() || '').filter(Boolean);
    seen.add(match[1]);
    jobs.push({
      externalJobId: match[1],
      role,
      company: text(box, ['.boss-name', '.company-name']) || text(box, ['a[href*="/gongsi/"]']),
      salary: text(box, ['.job-salary', '[class*=salary]']),
      experience: tags[0] || '',
      education: tags[1] || '',
      location: text(box, ['.company-location', '[class*=location]']),
      jobUrl: url.toString().split('#')[0],
    });
  };
  for (const wrap of document.querySelectorAll('.job-card-wrap, .job-card-wrapper, .job-card-box')) {
    const box = wrap.querySelector('.job-card-box') || wrap;
    addJob(box.querySelector('.job-name, a[href*="/job_detail/"]'), box);
  }
  if (jobs.length === 0) {
    for (const anchor of document.querySelectorAll('a[href*="/job_detail/"]')) {
      addJob(anchor, anchor.closest('li') || anchor.parentElement);
    }
  }
  return { status: 'ready', sourceUrl: location.href, jobs };
})()`;

function selectTarget(
  targets: readonly BossHunterBrowserTarget[],
): { kind: "ready"; target: BossHunterBrowserTarget } | { kind: "result"; value: BrowserRunStatus } {
  const bossTargets = targets.filter((target) => target.type === "page" && isBossUrl(target.url));
  const loginTarget = bossTargets.find((target) =>
    LOGIN_PATH_PATTERN.test(new URL(target.url ?? "").pathname),
  );
  if (loginTarget !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "login", targetCount: 0 } };
  }
  const verificationTarget = bossTargets.find((target) =>
    VERIFICATION_PATH_PATTERN.test(new URL(target.url ?? "").pathname),
  );
  if (verificationTarget !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "verification", targetCount: 0 } };
  }
  const riskTarget = bossTargets.find((target) =>
    RISK_CONTROL_PATH_PATTERN.test(new URL(target.url ?? "").pathname),
  );
  if (riskTarget !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "risk_control", targetCount: 0 } };
  }
  const jobs = bossTargets.filter((target) => isJobDetailUrl(target.url));
  if (jobs.length === 0)
    return { kind: "result", value: { status: "no_supported_tab", reason: "no_boss_page", targetCount: 0 } };
  if (jobs.length > 1)
    return {
      kind: "result",
      value: { status: "target_ambiguous", reason: "multiple_job_tabs", targetCount: jobs.length },
    };
  const target = jobs[0];
  return target === undefined
    ? { kind: "result", value: { status: "no_supported_tab", reason: "no_boss_page", targetCount: 0 } }
    : { kind: "ready", target };
}

function bossHandoffReason(sourceUrl: string): "login" | "verification" | "risk_control" | undefined {
  try {
    const url = new URL(sourceUrl);
    if (!isBossUrl(sourceUrl)) return undefined;
    if (LOGIN_PATH_PATTERN.test(url.pathname)) return "login";
    if (VERIFICATION_PATH_PATTERN.test(url.pathname)) return "verification";
    if (RISK_CONTROL_PATH_PATTERN.test(url.pathname)) return "risk_control";
  } catch {
    return undefined;
  }
  return undefined;
}

function selectJobListTarget(
  targets: readonly BossHunterBrowserTarget[],
): { kind: "ready"; target: BossHunterBrowserTarget } | { kind: "result"; value: BrowserJobDiscoveryResult } {
  const bossTargets = targets.filter((target) => target.type === "page" && isBossUrl(target.url));
  const loginTarget = bossTargets.find((target) =>
    LOGIN_PATH_PATTERN.test(new URL(target.url ?? "").pathname),
  );
  if (loginTarget !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "login", targetCount: 1 } };
  }
  const verificationTarget = bossTargets.find((target) =>
    VERIFICATION_PATH_PATTERN.test(new URL(target.url ?? "").pathname),
  );
  if (verificationTarget !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "verification", targetCount: 1 } };
  }
  const riskTarget = bossTargets.find((target) =>
    RISK_CONTROL_PATH_PATTERN.test(new URL(target.url ?? "").pathname),
  );
  if (riskTarget !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "risk_control", targetCount: 1 } };
  }
  if (bossTargets.length === 0) {
    return { kind: "result", value: { status: "no_supported_tab", reason: "no_boss_page", targetCount: 0 } };
  }
  const listTargets = bossTargets.filter((target) => !isJobDetailUrl(target.url));
  if (listTargets.length > 1) {
    return {
      kind: "result",
      value: { status: "target_ambiguous", reason: "multiple_boss_tabs", targetCount: listTargets.length },
    };
  }
  const target = listTargets[0];
  if (target === undefined) {
    return { kind: "result", value: { status: "no_supported_tab", reason: "no_job_list", targetCount: 0 } };
  }
  return { kind: "ready", target };
}

function selectConversationTarget(
  targets: readonly BossHunterBrowserTarget[],
):
  | { kind: "ready"; target: BossHunterBrowserTarget }
  | { kind: "result"; value: CaptureCurrentConversationResult } {
  const bossTargets = targets.filter((target) => target.type === "page" && isBossUrl(target.url));
  const loginTarget = bossTargets.find((target) =>
    LOGIN_PATH_PATTERN.test(new URL(target.url ?? "").pathname),
  );
  if (loginTarget !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "login", targetCount: 0 } };
  }
  const verificationTarget = bossTargets.find((target) =>
    VERIFICATION_PATH_PATTERN.test(new URL(target.url ?? "").pathname),
  );
  if (verificationTarget !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "verification", targetCount: 0 } };
  }
  const riskTarget = bossTargets.find((target) =>
    RISK_CONTROL_PATH_PATTERN.test(new URL(target.url ?? "").pathname),
  );
  if (riskTarget !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "risk_control", targetCount: 0 } };
  }
  const conversationTargets = bossTargets.filter((target) => isConversationUrl(target.url));
  if (conversationTargets.length === 0) {
    return {
      kind: "result",
      value: { status: "no_supported_tab", reason: "no_conversation", targetCount: 0 },
    };
  }
  if (conversationTargets.length > 1) {
    return {
      kind: "result",
      value: {
        status: "target_ambiguous",
        reason: "multiple_conversation_tabs",
        targetCount: conversationTargets.length,
      },
    };
  }
  const target = conversationTargets[0];
  return target === undefined
    ? { kind: "result", value: { status: "no_supported_tab", reason: "no_conversation", targetCount: 0 } }
    : { kind: "ready", target };
}

function selectApplicationFormTarget(
  targets: readonly BossHunterBrowserTarget[],
  expectedUrl: URL,
):
  | { kind: "ready"; target: BossHunterBrowserTarget }
  | { kind: "result"; value: InspectApplicationFormResult } {
  const candidates = targets.filter((target) => {
    if (target.type !== "page" || target.url === undefined) return false;
    const url = parseSafeOfficialUrl(target.url);
    return url !== undefined && sameOfficialOrigin(expectedUrl, url);
  });
  const login = candidates.find((target) => {
    const url = parseSafeOfficialUrl(target.url ?? "");
    return url !== undefined && OFFICIAL_LOGIN_PATH_PATTERN.test(url.pathname);
  });
  if (login !== undefined) {
    return { kind: "result", value: { status: "human_required", reason: "login", targetCount: 1 } };
  }
  const verification = candidates.find((target) => {
    const url = parseSafeOfficialUrl(target.url ?? "");
    return url !== undefined && OFFICIAL_VERIFICATION_PATH_PATTERN.test(url.pathname);
  });
  if (verification !== undefined) {
    return {
      kind: "result",
      value: { status: "human_required", reason: "verification", targetCount: 1 },
    };
  }
  if (candidates.length === 0) {
    return {
      kind: "result",
      value: { status: "no_supported_tab", reason: "official_page_not_open", targetCount: 0 },
    };
  }
  if (candidates.length > 1) {
    return {
      kind: "result",
      value: { status: "target_ambiguous", reason: "multiple_official_tabs", targetCount: candidates.length },
    };
  }
  const target = candidates[0];
  return target === undefined
    ? {
        kind: "result",
        value: { status: "no_supported_tab", reason: "official_page_not_open", targetCount: 0 },
      }
    : { kind: "ready", target };
}

function summarizeTargets(targets: readonly BossHunterBrowserTarget[]): BrowserRunStatus {
  const selection = selectTarget(targets);
  if (selection.kind === "result") return selection.value;
  if (selection.target.url === undefined) {
    return { status: "no_supported_tab", reason: "no_boss_page", targetCount: 0 };
  }
  return {
    status: "ready",
    targetCount: 1,
    target: {
      pageKind: "job_detail",
      title: selection.target.title,
      url: normalizeJobUrl(selection.target.url),
    },
  };
}

function parseInspection(value: unknown): JobInspection {
  if (!isRecord(value) || typeof value.status !== "string") return { status: "page_adapter_mismatch" };
  if (
    value.status === "human_required" &&
    (value.reason === "login" || value.reason === "verification" || value.reason === "risk_control")
  ) {
    return { status: "human_required", reason: value.reason, sourceUrl: optionalString(value.sourceUrl) };
  }
  if (
    value.status === "ready" &&
    typeof value.sourceUrl === "string" &&
    typeof value.externalJobId === "string" &&
    typeof value.company === "string" &&
    typeof value.role === "string" &&
    typeof value.description === "string" &&
    value.externalJobId.length > 0 &&
    value.company.length > 0 &&
    value.role.length > 0 &&
    value.description.length > 0
  ) {
    return {
      status: "ready",
      sourceUrl: value.sourceUrl,
      externalJobId: value.externalJobId,
      company: value.company,
      role: value.role,
      description: value.description,
    };
  }
  return { status: "page_adapter_mismatch" };
}

function parseJobListInspection(value: unknown): JobListInspection {
  if (!isRecord(value) || typeof value.status !== "string") return { status: "page_adapter_mismatch" };
  if (
    value.status === "human_required" &&
    (value.reason === "login" || value.reason === "verification" || value.reason === "risk_control")
  ) {
    return { status: "human_required", reason: value.reason, sourceUrl: optionalString(value.sourceUrl) };
  }
  if (value.status !== "ready" || typeof value.sourceUrl !== "string" || !Array.isArray(value.jobs)) {
    return { status: "page_adapter_mismatch" };
  }
  return {
    status: "ready",
    sourceUrl: value.sourceUrl,
    jobs: value.jobs.flatMap(parseJobSummary),
  };
}

function parseConversationInspection(value: unknown): ConversationInspection {
  if (!isRecord(value) || typeof value.status !== "string") return { status: "page_adapter_mismatch" };
  if (
    value.status === "human_required" &&
    (value.reason === "login" || value.reason === "verification" || value.reason === "risk_control")
  ) {
    return { status: "human_required", reason: value.reason, sourceUrl: optionalString(value.sourceUrl) };
  }
  if (
    value.status === "ready" &&
    typeof value.sourceUrl === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.recruiterName === "string" &&
    typeof value.messageText === "string" &&
    value.conversationId.length > 0 &&
    value.messageId.length > 0 &&
    value.recruiterName.length > 0 &&
    value.messageText.length > 0
  ) {
    return {
      status: "ready",
      sourceUrl: value.sourceUrl,
      conversationId: value.conversationId,
      messageId: value.messageId,
      recruiterName: value.recruiterName,
      messageText: value.messageText,
    };
  }
  return { status: "page_adapter_mismatch" };
}

function parseApplicationFormInspection(value: unknown): ApplicationFormInspection {
  if (!isRecord(value) || typeof value.status !== "string") return { status: "page_adapter_mismatch" };
  if (
    value.status === "human_required" &&
    (value.reason === "login" || value.reason === "verification" || value.reason === "risk_control")
  ) {
    return {
      status: "human_required",
      reason: value.reason,
      sourceUrl: optionalString(value.sourceUrl),
    };
  }
  if (
    value.status !== "ready" ||
    typeof value.sourceUrl !== "string" ||
    !Array.isArray(value.fields) ||
    value.fields.length === 0 ||
    value.fields.length > MAX_APPLICATION_FORM_FIELDS
  ) {
    return { status: "page_adapter_mismatch" };
  }
  const fields = value.fields.flatMap(parseApplicationFormField);
  if (fields.length !== value.fields.length) return { status: "page_adapter_mismatch" };
  const title = optionalBoundedString(value.title, 160);
  return {
    status: "ready",
    sourceUrl: value.sourceUrl,
    ...(title === undefined ? {} : { title }),
    fields,
  };
}

function parseApplicationFormFillInspection(value: unknown): ApplicationFormFillInspection {
  if (!isRecord(value) || typeof value.status !== "string") return { status: "fill_plan_mismatch" };
  if (
    value.status === "human_required" &&
    (value.reason === "login" || value.reason === "verification" || value.reason === "risk_control")
  ) {
    return { status: "human_required", reason: value.reason };
  }
  if (
    value.status !== "filled" ||
    typeof value.sourceUrl !== "string" ||
    !Array.isArray(value.ordinals) ||
    value.ordinals.length > 50 ||
    !value.ordinals.every(
      (ordinal) => Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < MAX_APPLICATION_FORM_FIELDS,
    ) ||
    new Set(value.ordinals).size !== value.ordinals.length
  )
    return { status: "fill_plan_mismatch" };
  return {
    status: "filled",
    sourceUrl: value.sourceUrl,
    ordinals: value.ordinals as number[],
    nextAction: value.nextAction === "next_step_handoff" ? "next_step_handoff" : "review_before_submit",
  };
}

function parseApplicationFormField(
  value: unknown,
): Array<Omit<BrowserApplicationFormField, "fieldId" | "metadataTrust">> {
  if (!isRecord(value)) return [];
  const controlTypes = new Set<BrowserApplicationFormControlType>([
    "text",
    "email",
    "tel",
    "url",
    "number",
    "date",
    "month",
    "textarea",
    "select",
    "combobox",
    "checkbox",
    "radio",
    "file",
    "other",
  ]);
  const currentStates = new Set<BrowserApplicationFormField["currentState"]>([
    "empty",
    "present",
    "checked",
    "unchecked",
  ]);
  if (
    !Number.isSafeInteger(value.ordinal) ||
    (value.ordinal as number) < 0 ||
    (value.ordinal as number) >= MAX_APPLICATION_FORM_FIELDS ||
    typeof value.controlType !== "string" ||
    !controlTypes.has(value.controlType as BrowserApplicationFormControlType) ||
    typeof value.inputType !== "string" ||
    value.inputType.length > 32 ||
    typeof value.label !== "string" ||
    value.label.length > 160 ||
    hasControlCharacter(value.label) ||
    typeof value.required !== "boolean" ||
    typeof value.disabled !== "boolean" ||
    typeof value.readOnly !== "boolean" ||
    typeof value.currentState !== "string" ||
    !currentStates.has(value.currentState as BrowserApplicationFormField["currentState"])
  ) {
    return [];
  }
  const name = optionalBoundedString(value.name, 120, true);
  const autocomplete = optionalBoundedString(value.autocomplete, 80, true);
  const options = Array.isArray(value.options)
    ? value.options
        .flatMap((option): { label: string; value?: string }[] => {
          if (!isRecord(option) || typeof option.label !== "string") return [];
          const label = optionalBoundedString(option.label, 120, true);
          if (label === undefined) return [];
          const optionValue = optionalBoundedString(option.value, 120, true);
          return [{ label, ...(optionValue === undefined ? {} : { value: optionValue }) }];
        })
        .slice(0, 100)
    : undefined;
  return [
    {
      ordinal: value.ordinal as number,
      controlType: value.controlType as BrowserApplicationFormControlType,
      inputType: value.inputType,
      label: value.label,
      ...(name === undefined ? {} : { name }),
      ...(autocomplete === undefined ? {} : { autocomplete }),
      required: value.required,
      disabled: value.disabled,
      readOnly: value.readOnly,
      currentState: value.currentState as BrowserApplicationFormField["currentState"],
      ...(options === undefined || options.length === 0 ? {} : { options }),
    },
  ];
}

function parseJobSummary(value: unknown): BrowserJobSummary[] {
  if (!isRecord(value)) return [];
  if (
    typeof value.externalJobId !== "string" ||
    typeof value.role !== "string" ||
    typeof value.jobUrl !== "string" ||
    value.externalJobId.length === 0 ||
    value.role.length === 0 ||
    !sameJobId(undefined, value.jobUrl, value.externalJobId)
  ) {
    return [];
  }
  const salary = parseSalary(value.salary);
  return [
    {
      externalJobId: value.externalJobId,
      role: value.role,
      company: optionalString(value.company),
      ...salary,
      experience: optionalString(value.experience),
      education: optionalString(value.education),
      location: optionalString(value.location),
      jobUrl: normalizeJobUrl(value.jobUrl),
    },
  ];
}

function parseSalary(
  value: unknown,
): Pick<BrowserJobSummary, "salary" | "salaryStatus"> | Pick<BrowserJobSummary, "salaryStatus"> {
  const salary = optionalString(value)?.trim();
  if (!salary) return { salaryStatus: "missing" };
  if (containsPrivateUseCharacter(salary)) return { salaryStatus: "obfuscated" };
  return { salary, salaryStatus: "available" };
}

function containsPrivateUseCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
        (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
        (codePoint >= 0x100000 && codePoint <= 0x10fffd))
    ) {
      return true;
    }
  }
  return false;
}

function isBossUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === BOSS_HOST;
  } catch {
    return false;
  }
}

function isSupportedJobUrl(value: string): boolean {
  return isBossUrl(value) && isJobDetailUrl(value);
}

function isConversationUrl(value: string | undefined): boolean {
  if (value === undefined || !isBossUrl(value)) return false;
  return new URL(value).pathname === "/web/geek/chat";
}

function isJobDetailUrl(value: string | undefined): boolean {
  if (value === undefined || !isBossUrl(value)) return false;
  return JOB_DETAIL_PATTERN.test(new URL(value).pathname);
}

function sameJobId(expectedUrl: string | undefined, actualUrl: string, externalJobId: string): boolean {
  if (!isSupportedJobUrl(actualUrl)) return false;
  const expectedMatch =
    expectedUrl === undefined ? undefined : JOB_DETAIL_PATTERN.exec(new URL(expectedUrl).pathname);
  const actualMatch = JOB_DETAIL_PATTERN.exec(new URL(actualUrl).pathname);
  return (
    actualMatch?.[1] === externalJobId &&
    (expectedMatch === undefined || expectedMatch?.[1] === externalJobId)
  );
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function normalizeJobUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString();
}

function parseSafeOfficialUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443") ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      isIP(hostname) !== 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function sameOfficialOrigin(expected: URL, actual: URL): boolean {
  return (
    expected.protocol === actual.protocol &&
    expected.hostname === actual.hostname &&
    expected.port === actual.port
  );
}

function isFillableControl(controlType: BrowserApplicationFormControlType): boolean {
  return new Set<BrowserApplicationFormControlType>([
    "text",
    "email",
    "tel",
    "url",
    "number",
    "date",
    "month",
    "textarea",
    "select",
    "combobox",
  ]).has(controlType);
}

function uniqueFillFields(fields: FillApplicationFormInput["fields"]): boolean {
  const ids = new Set<string>();
  for (const field of fields) {
    if (!/^form-field:[a-f0-9]{64}$/u.test(field.fieldId) || ids.has(field.fieldId)) return false;
    ids.add(field.fieldId);
  }
  return true;
}

function redactUrl(value: URL): string {
  const redacted = new URL(value.toString());
  redacted.hash = "";
  redacted.search = "";
  return redacted.toString();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeDuration(value: number | undefined, fallback: number): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration < 0) throw new Error("invalid_search_guard_duration");
  return duration;
}

function optionalBoundedString(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || value.length > maximum || hasControlCharacter(value)) return undefined;
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) return undefined;
  return normalized.length === 0 ? undefined : normalized;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
