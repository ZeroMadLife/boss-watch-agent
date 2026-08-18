// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App as VueApp } from "vue";
import App from "../extension/src/App.vue";
import { LocalApiError } from "../extension/src/api.js";

const apiMocks = vi.hoisted(() => ({
  health: vi.fn(),
  applications: vi.fn(),
  watchEvents: vi.fn(),
}));

vi.mock("../extension/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extension/src/api.js")>();
  return {
    ...actual,
    LocalApiClient: class {
      readonly baseUrl = "http://127.0.0.1:4318";
      setToken = vi.fn();
      health = apiMocks.health;
      applications = apiMocks.applications;
      watchEvents = apiMocks.watchEvents;
    },
  };
});

let app: VueApp<Element> | undefined;
let clientToken: string | undefined;
const storageRemove = vi.fn(async (key: string) => {
  if (key === "clientToken") clientToken = undefined;
});

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  clientToken = "stale-client-token";
  apiMocks.health.mockResolvedValue({
    service: "ready",
    database: "ready",
    runtimeMode: "baseline_ready",
    version: "0.1.0",
  });
  apiMocks.applications.mockResolvedValue({ applicationIds: [], applications: [] });
  apiMocks.watchEvents.mockRejectedValue(new LocalApiError(401, "event_stream_failed"));
  storageRemove.mockClear();

  Object.assign(globalThis, {
    chrome: {
      runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
      storage: {
        local: {
          get: vi.fn(async () => ({ clientToken })),
          set: vi.fn(),
          remove: storageRemove,
        },
      },
      tabs: {
        query: vi.fn(async () => []),
        sendMessage: vi.fn(),
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    },
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.clearAllMocks();
});

describe("Boss Watch side-panel authentication", () => {
  it("returns to pairing when the authenticated event stream rejects the saved token", async () => {
    const root = document.querySelector("#app");
    if (root === null) throw new Error("missing_test_root");
    app = createApp(App);
    app.mount(root);

    await settleMountedWork();

    expect(storageRemove).toHaveBeenCalledWith("clientToken");
    expect(root.textContent).toContain("连接本地服务");
    expect(root.textContent).not.toContain("请求失败：event_stream_failed");
  });
});

async function settleMountedWork(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve();
    await nextTick();
  }
}
