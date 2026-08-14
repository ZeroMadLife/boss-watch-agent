import { readFileSync } from "node:fs";
import { analyzeConversation } from "./application/analyze-conversation.js";
import type { ConversationSnapshot } from "./domain/conversation.js";

const fixture = JSON.parse(
  readFileSync(new URL("../test/fixtures/resume-request.json", import.meta.url), "utf8"),
) as ConversationSnapshot;

console.log(JSON.stringify(analyzeConversation(fixture), null, 2));
