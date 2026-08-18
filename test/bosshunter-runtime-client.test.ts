import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HttpBossHunterBrowserRuntime } from "../src/browser/bosshunter-runtime-client.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe("BossHunter Browser Runtime HTTP client", () => {
  it("uses the documented health, targets, and fixed-evaluation endpoints", async () => {
    const evaluations: Array<{ target: string | null; expression: string }> = [];
    const openedUrls: Array<string | null> = [];
    const closedTargets: Array<string | null> = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/health") {
        response.end(JSON.stringify({ status: "ok", runtime: "bosshunter", connected: true }));
        return;
      }
      if (url.pathname === "/targets") {
        response.end(
          JSON.stringify([
            {
              targetId: "target-contract-1",
              type: "page",
              title: "虚构岗位",
              url: "https://www.zhipin.com/job_detail/fixture-contract-001.html",
            },
          ]),
        );
        return;
      }
      if (url.pathname === "/eval") {
        let expression = "";
        for await (const chunk of request) expression += String(chunk);
        evaluations.push({ target: url.searchParams.get("target"), expression });
        response.end(JSON.stringify({ value: { status: "page_adapter_mismatch" } }));
        return;
      }
      if (url.pathname === "/new") {
        openedUrls.push(url.searchParams.get("url"));
        response.end(JSON.stringify({ targetId: "target-opened-1" }));
        return;
      }
      if (url.pathname === "/close") {
        closedTargets.push(url.searchParams.get("target"));
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not_found" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing_server_address");
    const client = new HttpBossHunterBrowserRuntime(`http://127.0.0.1:${address.port}`);

    await expect(client.health()).resolves.toEqual({
      status: "ok",
      runtime: "bosshunter",
      connected: true,
    });
    await expect(client.targets()).resolves.toEqual([
      {
        targetId: "target-contract-1",
        type: "page",
        title: "虚构岗位",
        url: "https://www.zhipin.com/job_detail/fixture-contract-001.html",
      },
    ]);
    await expect(client.evaluate("target-contract-1", "fixed-expression")).resolves.toEqual({
      status: "page_adapter_mismatch",
    });
    await expect(client.newTab("https://www.zhipin.com/job_detail/fixture-contract-001.html")).resolves.toBe(
      "target-opened-1",
    );
    await expect(client.close("target-opened-1")).resolves.toBeUndefined();
    expect(evaluations).toEqual([{ target: "target-contract-1", expression: "fixed-expression" }]);
    expect(openedUrls).toEqual(["https://www.zhipin.com/job_detail/fixture-contract-001.html"]);
    expect(closedTargets).toEqual(["target-opened-1"]);
    await expect(client.newTab("https://example.test/")).rejects.toThrow(
      "browser_navigation_url_not_allowed",
    );
  });

  it("rejects non-loopback Browser Runtime origins", () => {
    expect(() => new HttpBossHunterBrowserRuntime("https://example.test")).toThrow(
      "browser_runtime_must_be_loopback_http",
    );
  });
});
