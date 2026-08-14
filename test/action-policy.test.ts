import { describe, expect, it } from "vitest";
import { decideAction } from "../src/policy/action-policy.js";

describe("decideAction", () => {
  it.each(["capture_conversation", "analyze_conversation", "draft_reply"])(
    "allows observation-only action %s",
    (action) => {
      expect(decideAction(action).decision).toBe("allow");
    },
  );

  it.each(["send_message", "send_resume", "schedule_follow_up", "accept_interview"])(
    "requires approval for side effect %s",
    (action) => {
      expect(decideAction(action).decision).toBe("require_approval");
    },
  );

  it("denies unknown actions by default", () => {
    expect(decideAction("open_arbitrary_url")).toEqual({
      decision: "deny",
      reason: "unknown_action",
    });
  });
});
