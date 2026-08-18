import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalApiServer } from "../src/server/local-api-server.js";

const temporaryDirectories: string[] = [];
const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const dshOrigin = "http://127.0.0.1:3080";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "boss-watch-server-"));
  temporaryDirectories.push(directory);
  return join(directory, "boss-watch.sqlite3");
}

describe("Boss Watch local API", () => {
  it("explains the supported entry point when opened directly in a browser", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
    });

    try {
      const address = await server.start({ port: 0 });
      const response = await fetch(address.origin);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        service: "ready",
        message: "Boss Watch local API is running. Use DSH Web or the optional Chrome Side Panel.",
      });
    } finally {
      await server.close();
    }
  });

  it("starts on loopback and reports an honest baseline runtime mode", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
    });

    try {
      const address = await server.start({ port: 0 });
      expect(address.hostname).toBe("127.0.0.1");

      const response = await fetch(`${address.origin}/api/v1/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        service: "ready",
        database: "ready",
        runtimeMode: "baseline_ready",
        version: "0.1.0",
      });
    } finally {
      await server.close();
    }
  });

  it("pairs one Chrome extension origin and rejects ordinary web origins", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      tokenFactory: () => "client-token-for-test",
      runtimeMode: "baseline_ready",
    });

    try {
      const address = await server.start({ port: 0 });
      const rejected = await fetch(`${address.origin}/api/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.test" },
        body: JSON.stringify({ code: "123456" }),
      });
      expect(rejected.status).toBe(403);

      const paired = await fetch(`${address.origin}/api/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: extensionOrigin },
        body: JSON.stringify({ code: "123456" }),
      });
      expect(paired.status).toBe(200);
      expect(paired.headers.get("access-control-allow-origin")).toBe(extensionOrigin);
      expect(await paired.json()).toEqual({ token: "client-token-for-test" });
    } finally {
      await server.close();
    }
  });

  it("persists only the client token hash and accepts it after a service restart", async () => {
    const path = await databasePath();
    const first = createLocalApiServer({
      databasePath: path,
      pairingCode: "123456",
      tokenFactory: () => "client-token-for-test",
      runtimeMode: "baseline_ready",
    });
    const firstAddress = await first.start({ port: 0 });
    const paired = await fetch(`${firstAddress.origin}/api/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: extensionOrigin },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(paired.status).toBe(200);
    await first.close();

    const second = createLocalApiServer({
      databasePath: path,
      pairingCode: "654321",
      runtimeMode: "baseline_ready",
    });
    try {
      const secondAddress = await second.start({ port: 0 });
      const authenticated = await fetch(`${secondAddress.origin}/api/v1/applications/missing`, {
        headers: { authorization: "Bearer client-token-for-test", origin: extensionOrigin },
      });
      expect(authenticated.status).toBe(404);

      const wrongOrigin = await fetch(`${secondAddress.origin}/api/v1/applications/missing`, {
        headers: {
          authorization: "Bearer client-token-for-test",
          origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba",
        },
      });
      expect(wrongOrigin.status).toBe(401);
    } finally {
      await second.close();
    }
  });

  it("accepts an authenticated extension request when Chrome omits the Origin header", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      tokenFactory: () => "client-token-for-test",
      runtimeMode: "baseline_ready",
    });

    try {
      const address = await server.start({ port: 0 });
      await fetch(`${address.origin}/api/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: extensionOrigin },
        body: JSON.stringify({ code: "123456" }),
      });

      const authenticated = await fetch(`${address.origin}/api/v1/applications`, {
        headers: {
          authorization: "Bearer client-token-for-test",
          "x-boss-watch-extension-id": "abcdefghijklmnopabcdefghijklmnop",
        },
      });

      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual({ applicationIds: [], applications: [] });
    } finally {
      await server.close();
    }
  });

  it("expires the pairing code and locks it after five failed attempts", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      pairingExpiresAt: new Date("2026-08-14T08:05:00.000Z"),
      now: () => new Date("2026-08-14T08:00:00.000Z"),
      runtimeMode: "baseline_ready",
    });

    try {
      const address = await server.start({ port: 0 });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(`${address.origin}/api/v1/pair`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: extensionOrigin },
          body: JSON.stringify({ code: "000000" }),
        });
        expect(response.status).toBe(401);
      }

      const locked = await fetch(`${address.origin}/api/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: extensionOrigin },
        body: JSON.stringify({ code: "123456" }),
      });
      expect(locked.status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it("streams authenticated status events without exposing captured content", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      tokenFactory: () => "client-token-for-test",
      runtimeMode: "baseline_ready",
    });

    try {
      const address = await server.start({ port: 0 });
      await fetch(`${address.origin}/api/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: extensionOrigin },
        body: JSON.stringify({ code: "123456" }),
      });
      const controller = new AbortController();
      const response = await fetch(`${address.origin}/api/v1/events`, {
        headers: { authorization: "Bearer client-token-for-test", origin: extensionOrigin },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("missing_event_stream_body");
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("event: ready");
      expect(text).toContain('"runtimeMode":"baseline_ready"');
      expect(text).not.toContain("client-token-for-test");
      controller.abort();
    } finally {
      await server.close();
    }
  });

  it("stages a PDF from DSH Web into the controlled resume directory", async () => {
    const database = await databasePath();
    const server = createLocalApiServer({
      databasePath: database,
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
    });

    try {
      const address = await server.start({ port: 0 });
      const rejected = await fetch(`${address.origin}/api/v1/resumes/upload-session`, {
        method: "POST",
        headers: { origin: "https://example.test" },
      });
      expect(rejected.status).toBe(403);

      const sessionResponse = await fetch(`${address.origin}/api/v1/resumes/upload-session`, {
        method: "POST",
        headers: { origin: dshOrigin },
      });
      expect(sessionResponse.status).toBe(200);
      expect(sessionResponse.headers.get("access-control-allow-origin")).toBe(dshOrigin);
      const session = (await sessionResponse.json()) as { token: string; maxBytes: number };
      expect(session.token).toMatch(/^[A-Za-z0-9_-]{20,}$/u);
      expect(session.maxBytes).toBe(20 * 1024 * 1024);

      const bytes = Buffer.from("%PDF-local-test");
      const uploaded = await fetch(`${address.origin}/api/v1/resumes/upload`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          origin: dshOrigin,
          "x-boss-watch-file-name": encodeURIComponent("示例候选人-AI应用开发.pdf"),
          "content-type": "application/pdf",
        },
        body: bytes,
      });
      expect(uploaded.status).toBe(201);
      const result = (await uploaded.json()) as {
        status: string;
        fileName: string;
        displayName: string;
        mediaType: string;
        byteSize: number;
        contentHash: string;
        requiresPreview: boolean;
      };
      expect(result).toMatchObject({
        status: "ok",
        displayName: "示例候选人-AI应用开发",
        mediaType: "application/pdf",
        byteSize: bytes.byteLength,
        requiresPreview: true,
      });
      expect(result.fileName).toMatch(/^dsh-[a-f0-9]{64}-示例候选人-AI应用开发\.pdf$/u);
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(await readFile(join(dirname(database), "resumes", result.fileName))).toEqual(bytes);
    } finally {
      await server.close();
    }
  });

  it("bounds active sessions and reserves concurrent upload slots before file I/O", async () => {
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
    });

    try {
      const address = await server.start({ port: 0 });
      const sessions = await Promise.all(
        Array.from({ length: 32 }, () =>
          fetch(`${address.origin}/api/v1/resumes/upload-session`, {
            method: "POST",
            headers: { origin: dshOrigin },
          }),
        ),
      );
      expect(sessions.every((response) => response.status === 200)).toBe(true);
      const rejectedSession = await fetch(`${address.origin}/api/v1/resumes/upload-session`, {
        method: "POST",
        headers: { origin: dshOrigin },
      });
      expect(rejectedSession.status).toBe(429);

      const session = (await sessions[0]?.json()) as { token: string };
      const uploads = await Promise.all(
        Array.from({ length: 21 }, (_, index) =>
          fetch(`${address.origin}/api/v1/resumes/upload`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${session.token}`,
              origin: dshOrigin,
              "x-boss-watch-file-name": encodeURIComponent(`resume-${index}.pdf`),
            },
            body: Buffer.from(`%PDF-${index}`),
          }),
        ),
      );
      expect(uploads.filter((response) => response.status === 201)).toHaveLength(20);
      expect(uploads.filter((response) => response.status === 429)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("expires upload sessions and rejects unsafe or overlong file names", async () => {
    let timestamp = Date.parse("2026-08-18T08:00:00.000Z");
    const server = createLocalApiServer({
      databasePath: await databasePath(),
      pairingCode: "123456",
      runtimeMode: "baseline_ready",
      now: () => new Date(timestamp),
    });

    try {
      const address = await server.start({ port: 0 });
      const sessionResponse = await fetch(`${address.origin}/api/v1/resumes/upload-session`, {
        method: "POST",
        headers: { origin: dshOrigin },
      });
      const session = (await sessionResponse.json()) as { token: string };
      const upload = (fileName: string) =>
        fetch(`${address.origin}/api/v1/resumes/upload`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.token}`,
            origin: dshOrigin,
            "x-boss-watch-file-name": encodeURIComponent(fileName),
          },
          body: Buffer.from("%PDF-test"),
        });

      expect((await upload("../outside.pdf")).status).toBe(400);
      expect((await upload(`${"简".repeat(61)}.pdf`)).status).toBe(400);
      expect((await upload("resume.exe")).status).toBe(400);

      timestamp += 10 * 60 * 1000;
      expect((await upload("resume.pdf")).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
