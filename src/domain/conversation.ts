export type ConversationActor = "candidate" | "recruiter";

export interface ConversationMessage {
  id: string;
  actor: ConversationActor;
  text: string;
  sentAt: string;
}

export interface ConversationSnapshot {
  conversationId: string;
  candidateId: string;
  recruiterId: string;
  messages: ConversationMessage[];
}

export type HrIntent =
  | "resume_request"
  | "interview_invite"
  | "rejection"
  | "job_detail"
  | "status_update"
  | "other"
  | "no_recruiter_message";

export interface ConversationEvidence {
  messageId: string;
  quote: string;
}

export interface ReplyDraft {
  status: "draft_only" | "no_action";
  text: string;
}

export interface ConversationAnalysis {
  conversationId: string;
  intent: HrIntent;
  evidence?: ConversationEvidence;
  draft: ReplyDraft;
}
