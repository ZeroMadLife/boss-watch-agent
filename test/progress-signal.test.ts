import { describe, expect, it } from "vitest";
import { classifyProgressSignal } from "../src/application/progress-signal.js";

describe("progress signal classification", () => {
  it.each([
    ["面试邀请：邀请您参加第一轮面试，面试时间为周三 14:00。", "interview", "interview_scheduled"],
    ["很遗憾，您的申请未能通过本轮评估，招聘流程不再推进。", "rejected", "rejected"],
    ["恭喜您通过全部评估，我们将发放 offer letter。", "offer", "offer"],
  ] as const)("classifies high precision evidence", (content, outcome, proposedStatus) => {
    expect(classifyProgressSignal(content)).toMatchObject({ outcome, proposedStatus });
  });

  it("fails closed when a cancellation conflicts with an interview phrase", () => {
    expect(classifyProgressSignal("原面试邀请已取消，后续时间另行通知。")).toEqual({
      outcome: "needs_review",
      classifierVersion: "progress-signal-rules-v1",
      confidence: 0.4,
      reasonCodes: ["signal_canceled", "signal_rescheduled", "interview_invitation"],
    });
  });

  it("does not infer rejection from no response or a generic receipt notice", () => {
    expect(classifyProgressSignal("感谢投递，我们已经收到简历，后续如有进展将与你联系。")).toEqual({
      outcome: "needs_review",
      classifierVersion: "progress-signal-rules-v1",
      confidence: 0.25,
      reasonCodes: ["no_high_precision_signal"],
    });
  });

  it("accepts an explicit manual outcome without pretending it was inferred", () => {
    expect(classifyProgressSignal("用户已在官网人工核对结果。", "rejected")).toEqual({
      outcome: "rejected",
      classifierVersion: "progress-signal-rules-v1",
      confidence: 1,
      reasonCodes: ["human_declared_outcome"],
      proposedStatus: "rejected",
    });
  });
});
