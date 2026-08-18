import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { LocalInterviewNoteClient } from "../src/interview-note-client.ts";

test("uses the local service token for preview and apply without exposing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boss-watch-interview-client-"));
  const tokenPath = join(directory, "dsh-service-token");
  const token = "service-token-interview-client-1234567890";
  await writeFile(tokenPath, token, "utf8");
  const requests: Array<{ path: string; authorization: string | undefined; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.endsWith("/preview")) {
      response.end(
        JSON.stringify({
          previewToken: "interview-note-preview:fixture",
          applicationId: "application-001",
          interviewId: "interview-001",
          stage: "first_interview",
          contentHash: "a".repeat(64),
          contentLength: 10,
          expiresAt: "2026-08-18T03:15:00.000Z",
          requiresConfirmation: true,
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        applicationId: "application-001",
        eventId: "event-001",
        artifactId: "artifact-001",
        artifactRef: "local-artifact://application/artifact-001",
        contentHash: "a".repeat(64),
        savedAt: "2026-08-18T03:00:00.000Z",
        deduplicated: false,
        interviewId: "interview-001",
        stage: "first_interview",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing_server_address");

  try {
    const client = new LocalInterviewNoteClient(`http://127.0.0.1:${address.port}`, tokenPath);
    assert.equal(
      (
        await client.preview({
          applicationId: "application-001",
          interviewId: "interview-001",
          stage: "first_interview",
          content: "fixture note",
        })
      ).requiresConfirmation,
      true,
    );
    assert.equal((await client.apply("interview-note-preview:fixture", true)).deduplicated, false);
    assert.deepEqual(requests, [
      {
        path: "/api/v1/interview-notes/preview",
        authorization: `Bearer ${token}`,
        body: JSON.stringify({
          applicationId: "application-001",
          interviewId: "interview-001",
          stage: "first_interview",
          content: "fixture note",
        }),
      },
      {
        path: "/api/v1/interview-notes/apply",
        authorization: `Bearer ${token}`,
        body: JSON.stringify({ previewToken: "interview-note-preview:fixture", confirmed: true }),
      },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
