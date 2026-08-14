import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeConversation } from "../src/application/analyze-conversation.js";
import type { ConversationSnapshot } from "../src/domain/conversation.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/resume-request.json", import.meta.url), "utf8"),
) as ConversationSnapshot;

describe("analyzeConversation", () => {
  it("classifies a resume request and preserves the exact source evidence", () => {
    const result = analyzeConversation(fixture);

    expect(result.intent).toBe("resume_request");
    expect(result.evidence).toEqual({
      messageId: "message-demo-002",
      quote: "你好，可以先发一份简历给我吗？",
    });
    expect(result.draft.status).toBe("draft_only");
    expect(result.draft.text).toContain("确认后发送");
  });

  it("returns no-action when no recruiter message exists", () => {
    const result = analyzeConversation({
      ...fixture,
      messages: fixture.messages.filter((message) => message.actor === "candidate"),
    });

    expect(result.intent).toBe("no_recruiter_message");
    expect(result.evidence).toBeUndefined();
    expect(result.draft.text).toBe("");
  });
});
