import type {
  BossHunterBrowserRuntime,
  BossHunterBrowserTarget,
  BossHunterRuntimeHealth,
} from "./browser-run-controller.js";
import { isBossSearchUrl } from "./job-search.js";

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:3456";

export class HttpBossHunterBrowserRuntime implements BossHunterBrowserRuntime {
  readonly #baseUrl: string;

  constructor(baseUrl = process.env.BOSSHUNTER_BROWSER_RUNTIME_URL ?? DEFAULT_RUNTIME_URL) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
      throw new Error("browser_runtime_must_be_loopback_http");
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error("browser_runtime_origin_required");
    }
    this.#baseUrl = url.origin;
  }

  async health(): Promise<BossHunterRuntimeHealth | undefined> {
    try {
      const response = await fetch(`${this.#baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) return undefined;
      const value: unknown = await response.json();
      if (
        !isRecord(value) ||
        value.status !== "ok" ||
        value.runtime !== "bosshunter" ||
        typeof value.connected !== "boolean"
      ) {
        return undefined;
      }
      return {
        status: "ok",
        runtime: "bosshunter",
        connected: value.connected,
      };
    } catch {
      return undefined;
    }
  }

  async targets(): Promise<BossHunterBrowserTarget[]> {
    const value = await this.#getJson("/targets");
    if (!Array.isArray(value)) throw new Error("invalid_browser_targets");
    return value.flatMap((item) => {
      if (!isRecord(item) || typeof item.targetId !== "string" || typeof item.type !== "string") return [];
      return [
        {
          targetId: item.targetId,
          type: item.type,
          title: typeof item.title === "string" ? item.title : undefined,
          url: typeof item.url === "string" ? item.url : undefined,
        },
      ];
    });
  }

  async evaluate(targetId: string, expression: string): Promise<unknown> {
    const response = await fetch(`${this.#baseUrl}/eval?target=${encodeURIComponent(targetId)}`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: expression,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("browser_evaluation_failed");
    const value: unknown = await response.json();
    if (!isRecord(value) || !("value" in value)) throw new Error("invalid_browser_evaluation");
    return value.value;
  }

  async newTab(url: string): Promise<string> {
    const targetUrl = new URL(url);
    const isDetail =
      targetUrl.protocol === "https:" &&
      targetUrl.hostname === "www.zhipin.com" &&
      /^\/job_detail\/[a-zA-Z0-9_-]+(?:\.html)?/u.test(targetUrl.pathname);
    if (!isDetail && !isBossSearchUrl(targetUrl.toString())) {
      throw new Error("browser_navigation_url_not_allowed");
    }
    const response = await fetch(`${this.#baseUrl}/new?url=${encodeURIComponent(targetUrl.toString())}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("browser_navigation_failed");
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.targetId !== "string") throw new Error("invalid_browser_target");
    return value.targetId;
  }

  async close(targetId: string): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/close?target=${encodeURIComponent(targetId)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("browser_close_failed");
  }

  async setFiles(targetId: string, selector: string, files: readonly string[]): Promise<void> {
    if (!/^input\[type=["']?file["']?\]$/iu.test(selector) || files.length !== 1) {
      throw new Error("browser_file_upload_selector_invalid");
    }
    const response = await fetch(`${this.#baseUrl}/setFiles?target=${encodeURIComponent(targetId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selector, files }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("browser_file_upload_failed");
  }

  async waitForLoad(targetId: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      if (signal?.aborted) return;
      try {
        const value = await this.#getJson(`/info?target=${encodeURIComponent(targetId)}`, signal);
        if (isRecord(value) && value.ready === "complete") return;
      } catch {
        if (signal?.aborted) return;
        // A target can briefly be unavailable while Chrome creates the page.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
  }

  async #getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(5_000);
    const response = await fetch(`${this.#baseUrl}${path}`, {
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) throw new Error("browser_runtime_request_failed");
    return response.json();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
