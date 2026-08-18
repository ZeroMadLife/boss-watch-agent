import type { ApplicationStatus, ProgressSignalOutcome } from "../domain/application-event.js";

export type { ProgressSignalOutcome } from "../domain/application-event.js";

export const PROGRESS_SIGNAL_CLASSIFIER_VERSION = "progress-signal-rules-v1" as const;

export interface ProgressSignalClassification {
  readonly outcome: ProgressSignalOutcome;
  readonly classifierVersion: typeof PROGRESS_SIGNAL_CLASSIFIER_VERSION;
  readonly confidence: number;
  readonly reasonCodes: string[];
  readonly proposedStatus?: ApplicationStatus;
}

interface SignalRule {
  readonly code: string;
  readonly pattern: RegExp;
}

const RULES: Readonly<Record<Exclude<ProgressSignalOutcome, "needs_review">, readonly SignalRule[]>> = {
  offer: [
    { code: "offer_formal_admission", pattern: /(?:正式|拟)录用(?:通知|意向)?/u },
    { code: "offer_congratulations", pattern: /(?:恭喜|祝贺)(?:您|你)?.{0,18}(?:获得|通过|录用|offer)/iu },
    { code: "offer_letter_issued", pattern: /offer\s*(?:letter|通知|已发送|已发放)/iu },
  ],
  rejected: [
    { code: "rejection_regret", pattern: /很遗憾.{0,36}(?:未能|无法|不再|暂不|没有)/u },
    { code: "rejection_not_passed", pattern: /(?:申请|面试|简历|评估).{0,20}(?:未能?通过|不通过|未被录用)/u },
    { code: "rejection_process_stopped", pattern: /(?:暂不匹配|不再推进|终止(?:本次)?招聘流程|岗位已关闭)/u },
  ],
  interview: [
    { code: "interview_invitation", pattern: /面试邀请/u },
    { code: "interview_attendance", pattern: /邀请(?:您|你).{0,20}(?:参加|进行).{0,10}(?:面试|面谈|交流)/u },
    { code: "interview_schedule", pattern: /(?:面试时间|面试安排|面试地点|面试链接|面试会议)/u },
  ],
};

const CANCELLATION_RULES: readonly SignalRule[] = [
  {
    code: "signal_canceled",
    pattern:
      /(?:(?:取消|撤销|作废).{0,12}(?:面试|offer|录用|邀请)|(?:面试|offer|录用|邀请).{0,12}(?:取消|撤销|作废))/iu,
  },
  { code: "signal_rescheduled", pattern: /(?:改期|延期|时间待定|另行通知)/u },
];

const OUTCOME_STATUS: Readonly<Partial<Record<ProgressSignalOutcome, ApplicationStatus>>> = {
  interview: "interview_scheduled",
  rejected: "rejected",
  offer: "offer",
};

/**
 * Conservative local classifier for user-supplied recruiting evidence. It
 * intentionally returns needs_review when categories conflict or a message
 * only contains generic recruiting language.
 */
export function classifyProgressSignal(
  content: string,
  declaredOutcome?: ProgressSignalOutcome,
): ProgressSignalClassification {
  const normalized = normalizeSignalText(content);
  if (normalized.length === 0) throw new Error("invalid_progress_signal_content");

  if (declaredOutcome !== undefined) {
    return {
      outcome: declaredOutcome,
      classifierVersion: PROGRESS_SIGNAL_CLASSIFIER_VERSION,
      confidence: 1,
      reasonCodes: ["human_declared_outcome"],
      ...statusFor(declaredOutcome),
    };
  }

  const cancellations = matchedCodes(normalized, CANCELLATION_RULES);
  const matches = (Object.keys(RULES) as Array<Exclude<ProgressSignalOutcome, "needs_review">>)
    .map((outcome) => ({ outcome, reasonCodes: matchedCodes(normalized, RULES[outcome]) }))
    .filter((match) => match.reasonCodes.length > 0);

  if (cancellations.length > 0 || matches.length !== 1) {
    return {
      outcome: "needs_review",
      classifierVersion: PROGRESS_SIGNAL_CLASSIFIER_VERSION,
      confidence: matches.length === 0 ? 0.25 : 0.4,
      reasonCodes:
        cancellations.length > 0
          ? [...cancellations, ...matches.flatMap((match) => match.reasonCodes)]
          : matches.length === 0
            ? ["no_high_precision_signal"]
            : ["conflicting_signal_categories", ...matches.flatMap((match) => match.reasonCodes)],
    };
  }

  const [match] = matches;
  if (match === undefined) throw new Error("progress_signal_classifier_invariant");
  const confidence = match.outcome === "offer" ? 0.94 : match.outcome === "rejected" ? 0.91 : 0.87;
  return {
    outcome: match.outcome,
    classifierVersion: PROGRESS_SIGNAL_CLASSIFIER_VERSION,
    confidence,
    reasonCodes: match.reasonCodes,
    ...statusFor(match.outcome),
  };
}

export function normalizeSignalText(content: string): string {
  return content
    .replaceAll("\u0000", "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll(/[\t ]+/gu, " ")
    .trim();
}

function matchedCodes(content: string, rules: readonly SignalRule[]): string[] {
  return rules.filter((rule) => rule.pattern.test(content)).map((rule) => rule.code);
}

function statusFor(outcome: ProgressSignalOutcome): { proposedStatus?: ApplicationStatus } {
  const proposedStatus = OUTCOME_STATUS[outcome];
  return proposedStatus === undefined ? {} : { proposedStatus };
}
