export type VisiblePageRevisionInput =
  | {
      pageKind: "job_detail";
      sourceUrl: string;
      externalJobId: string;
      company: string;
      role: string;
      description: string;
    }
  | {
      pageKind: "conversation";
      sourceUrl: string;
      conversationId: string;
      messageId: string;
      recruiterName: string;
      messageText: string;
    };

export function createPageRevisionPayload(snapshot: VisiblePageRevisionInput): string {
  const visible =
    snapshot.pageKind === "job_detail"
      ? {
          pageKind: snapshot.pageKind,
          sourceUrl: normalizeUrl(snapshot.sourceUrl),
          externalJobId: normalizeText(snapshot.externalJobId),
          company: normalizeText(snapshot.company),
          role: normalizeText(snapshot.role),
          description: normalizeText(snapshot.description),
        }
      : {
          pageKind: snapshot.pageKind,
          sourceUrl: normalizeUrl(snapshot.sourceUrl),
          conversationId: normalizeText(snapshot.conversationId),
          messageId: normalizeText(snapshot.messageId),
          recruiterName: normalizeText(snapshot.recruiterName),
          messageText: normalizeText(snapshot.messageText),
        };
  return JSON.stringify(visible);
}

export function normalizeVisibleText(value: string): string {
  return normalizeText(value);
}

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}
