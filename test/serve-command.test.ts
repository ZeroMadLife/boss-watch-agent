import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServeCommand } from "../src/server/serve-command.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("boss-watch serve", () => {
  it("starts a persistent local service with an explicit data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "boss-watch-serve-"));
    temporaryDirectories.push(dataDir);
    const messages: string[] = [];
    const running = await startServeCommand(
      ["--port", "0", "--data-dir", dataDir],
      (message) => messages.push(message),
      { pairingCode: "123456", serviceToken: "service-token-for-serve-command-test" },
    );

    try {
      const response = await fetch(`${running.address.origin}/api/v1/health`);
      expect(response.status).toBe(200);
      expect(running.address.hostname).toBe("127.0.0.1");
      expect(running.databasePath).toBe(join(dataDir, "boss-watch.sqlite3"));
      expect(running.serviceTokenPath).toBe(join(dataDir, "dsh-service-token"));
      expect(await readFile(running.serviceTokenPath, "utf8")).toBe("service-token-for-serve-command-test");
      expect((await stat(running.serviceTokenPath)).mode & 0o777).toBe(0o600);
      expect(messages).toContain("Analysis mode: baseline_ready (Pi model is not configured)");
      expect(messages.some((message) => message.startsWith("Pairing code: 123456"))).toBe(true);
      expect(messages.join("\n")).not.toContain("service-token-for-serve-command-test");
    } finally {
      await running.server.close();
    }
  });

  it("rejects invalid ports before opening the database", async () => {
    await expect(startServeCommand(["--port", "70000"])).rejects.toThrow("invalid_port:70000");
  });
});
