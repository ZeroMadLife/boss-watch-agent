import { describe, expect, it } from "vitest";
import { completePlanStep, createConversationPlan } from "../src/domain/execution-plan.js";

describe("conversation execution plan", () => {
  it("requires the observation-to-approval steps to complete in order", () => {
    const initial = createConversationPlan("plan-demo-001", "conversation-demo-001");

    expect(() => completePlanStep(initial, "analyze")).toThrow("previous_plan_step_incomplete:capture");

    const captured = completePlanStep(initial, "capture");
    const analyzed = completePlanStep(captured, "analyze");
    const drafted = completePlanStep(analyzed, "draft");
    const gated = completePlanStep(drafted, "approval_gate");

    expect(gated.steps.every((step) => step.status === "completed")).toBe(true);
  });

  it("is idempotent when a completed step is replayed", () => {
    const initial = createConversationPlan("plan-demo-002", "conversation-demo-002");
    const captured = completePlanStep(initial, "capture");

    expect(completePlanStep(captured, "capture")).toEqual(captured);
  });
});
