import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { analyzeConversation } from "../application/analyze-conversation.js";
import type { ConversationSnapshot } from "../domain/conversation.js";

const conversationMessageSchema = Type.Object({
  id: Type.String(),
  actor: Type.Union([Type.Literal("candidate"), Type.Literal("recruiter")]),
  text: Type.String(),
  sentAt: Type.String(),
});

const conversationSchema = Type.Object({
  conversationId: Type.String(),
  candidateId: Type.String(),
  recruiterId: Type.String(),
  messages: Type.Array(conversationMessageSchema),
});

export const analyzeConversationTool: AgentTool<typeof conversationSchema, { intent: string }> = {
  name: "analyze_conversation",
  label: "Analyze conversation",
  description: "Analyze a captured recruiter conversation without sending or changing anything.",
  parameters: conversationSchema,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    const result = analyzeConversation(params as ConversationSnapshot);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: { intent: result.intent },
      terminate: false,
    };
  },
};
