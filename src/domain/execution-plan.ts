export type PlanStepId = "capture" | "analyze" | "draft" | "approval_gate";
export type PlanStepStatus = "pending" | "completed";

export interface PlanStep {
  id: PlanStepId;
  status: PlanStepStatus;
}

export interface ConversationExecutionPlan {
  planId: string;
  conversationId: string;
  steps: PlanStep[];
}

const stepOrder: readonly PlanStepId[] = ["capture", "analyze", "draft", "approval_gate"];

export function createConversationPlan(planId: string, conversationId: string): ConversationExecutionPlan {
  return {
    planId,
    conversationId,
    steps: stepOrder.map((id) => ({ id, status: "pending" })),
  };
}

export function completePlanStep(
  plan: ConversationExecutionPlan,
  stepId: PlanStepId,
): ConversationExecutionPlan {
  const index = plan.steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error(`unknown_plan_step:${stepId}`);

  const step = plan.steps[index];
  if (step.status === "completed") return plan;
  const previousStep = plan.steps[index - 1];
  if (previousStep && previousStep.status !== "completed") {
    throw new Error(`previous_plan_step_incomplete:${previousStep.id}`);
  }

  return {
    ...plan,
    steps: plan.steps.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...candidate, status: "completed" } : candidate,
    ),
  };
}
