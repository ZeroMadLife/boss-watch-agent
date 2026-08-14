import type {
  ConversationAnalysis,
  ConversationEvidence,
  ConversationMessage,
  ConversationSnapshot,
  HrIntent,
  ReplyDraft,
} from "../domain/conversation.js";

const intentRules: readonly {
  intent: Exclude<HrIntent, "other" | "no_recruiter_message">;
  patterns: RegExp[];
}[] = [
  {
    intent: "resume_request",
    patterns: [/简历/u, /发一份/u, /投递/u, /附件/u],
  },
  {
    intent: "interview_invite",
    patterns: [/面试/u, /初试/u, /复试/u, /约.*时间/u],
  },
  {
    intent: "rejection",
    patterns: [/不匹配/u, /不合适/u, /暂不/u, /感谢关注/u],
  },
  {
    intent: "job_detail",
    patterns: [/岗位/u, /职位/u, /薪资/u, /工作内容/u, /职责/u],
  },
  {
    intent: "status_update",
    patterns: [/流程/u, /反馈/u, /结果/u, /进展/u],
  },
];

function latestRecruiterMessage(messages: ConversationMessage[]): ConversationMessage | undefined {
  return [...messages].reverse().find((message) => message.actor === "recruiter");
}

function classify(text: string): Exclude<HrIntent, "no_recruiter_message"> {
  const match = intentRules.find((rule) => rule.patterns.some((pattern) => pattern.test(text)));
  return match?.intent ?? "other";
}

function createDraft(intent: Exclude<HrIntent, "no_recruiter_message">): ReplyDraft {
  const drafts: Record<Exclude<HrIntent, "no_recruiter_message">, string> = {
    resume_request: "收到，我会先核对岗位信息并准备匹配版本的简历，确认后发送。",
    interview_invite: "收到面试安排，我会先确认时间和形式，确认后回复。",
    rejection: "收到，感谢告知。我会保留这次沟通记录，后续继续关注合适的机会。",
    job_detail: "收到岗位信息，我会先核对职责和要求，再决定是否继续沟通。",
    status_update: "收到流程进展，我会先记录并等待后续通知。",
    other: "收到，我会先核对上下文，再决定是否需要回复。",
  };

  return { status: "draft_only", text: drafts[intent] };
}

export function analyzeConversation(snapshot: ConversationSnapshot): ConversationAnalysis {
  const message = latestRecruiterMessage(snapshot.messages);
  if (!message) {
    return {
      conversationId: snapshot.conversationId,
      intent: "no_recruiter_message",
      draft: { status: "no_action", text: "" },
    };
  }

  const intent = classify(message.text);
  const evidence: ConversationEvidence = {
    messageId: message.id,
    quote: message.text,
  };

  return {
    conversationId: snapshot.conversationId,
    intent,
    evidence,
    draft: createDraft(intent),
  };
}
