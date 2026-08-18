export type BossAction =
  | "capture_conversation"
  | "capture_job_description"
  | "capture_interview_note"
  | "analyze_conversation"
  | "record_evidence"
  | "draft_reply"
  | "propose_status_change"
  | "sync_feishu"
  | "send_message"
  | "send_resume"
  | "schedule_follow_up"
  | "accept_interview";

export type ActionDecision =
  | { decision: "allow"; reason: "observation_only" }
  | { decision: "require_approval"; reason: "external_side_effect" }
  | { decision: "deny"; reason: "unknown_action" };

const observationActions = new Set<BossAction>([
  "capture_conversation",
  "capture_job_description",
  "capture_interview_note",
  "analyze_conversation",
  "record_evidence",
  "draft_reply",
  "propose_status_change",
]);

const approvalActions = new Set<BossAction>([
  "sync_feishu",
  "send_message",
  "send_resume",
  "schedule_follow_up",
  "accept_interview",
]);

export function decideAction(action: string): ActionDecision {
  if (observationActions.has(action as BossAction)) {
    return { decision: "allow", reason: "observation_only" };
  }
  if (approvalActions.has(action as BossAction)) {
    return { decision: "require_approval", reason: "external_side_effect" };
  }
  return { decision: "deny", reason: "unknown_action" };
}
