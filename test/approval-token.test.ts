import { describe, expect, it } from "vitest";
import {
  type ApprovalScope,
  hashMessageContent,
  issueApprovalToken,
  verifyApprovalToken,
} from "../src/policy/approval-token.js";

const signingSecret = "fictional-test-secret-at-least-32-bytes";
const now = Date.parse("2026-08-14T01:00:00.000Z");
const scope: ApprovalScope = {
  sessionId: "session-demo-001",
  conversationId: "conversation-demo-001",
  recipientId: "recruiter-demo-001",
  contentHash: hashMessageContent("收到，我确认后发送简历。"),
  expiresAt: now + 60_000,
};

describe("approval token", () => {
  it("accepts the exact approved action scope", () => {
    const token = issueApprovalToken(scope, signingSecret);

    expect(verifyApprovalToken(token, scope, signingSecret, now)).toEqual({ valid: true });
  });

  it("rejects a different message body", () => {
    const token = issueApprovalToken(scope, signingSecret);
    const changedScope = {
      ...scope,
      contentHash: hashMessageContent("已经替换成另一条消息。"),
    };

    expect(verifyApprovalToken(token, changedScope, signingSecret, now)).toEqual({
      valid: false,
      reason: "scope_mismatch",
    });
  });

  it("rejects an expired approval", () => {
    const token = issueApprovalToken(scope, signingSecret);

    expect(verifyApprovalToken(token, scope, signingSecret, scope.expiresAt + 1)).toEqual({
      valid: false,
      reason: "expired",
    });
  });
});
