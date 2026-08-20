export type ApplicationEventActor = "agent" | "human" | "system";

export type ApplicationStatus =
  | "discovered"
  | "scored"
  | "gate_a_approved"
  | "material_prepared"
  | "awaiting_gate_b"
  | "submitted"
  | "assessment_scheduled"
  | "assessment_completed"
  | "recruiter_replied"
  | "interview_scheduled"
  | "rejected"
  | "offer"
  | "no_response"
  | "closed";

export type ProgressSignalSourceKind =
  | "recruitment_email"
  | "interview_invitation"
  | "recruiter_message"
  | "manual_update";

export type ProgressSignalOutcome = "interview" | "rejected" | "offer" | "needs_review";

interface ApplicationEventBase {
  schemaVersion: 1;
  eventId: string;
  applicationId: string;
  idempotencyKey: string;
  traceId: string;
  occurredAt: string;
  actor: ApplicationEventActor;
}

export type ApplicationEvent = ApplicationEventBase &
  (
    | {
        type: "job_description_captured";
        payload: {
          platform: "boss" | "liepin" | "official_portal" | "other";
          externalJobId: string;
          company: string;
          role: string;
          jobUrl?: string;
          contentHash: string;
          artifactRef: string;
        };
      }
    | {
        type: "recruiter_message_captured";
        payload: {
          conversationId: string;
          messageId: string;
          contentHash: string;
          artifactRef: string;
        };
      }
    | {
        type: "interview_note_recorded";
        payload: {
          interviewId: string;
          stage: "screening" | "first_interview" | "second_interview" | "final_interview" | "other";
          contentHash: string;
          artifactRef: string;
        };
      }
    | {
        type: "progress_signal_recorded";
        payload: {
          signalId: string;
          sourceKind: ProgressSignalSourceKind;
          outcome: ProgressSignalOutcome;
          classifierVersion: string;
          confidence: number;
          reasonCodes: string[];
          contentHash: string;
          artifactRef: string;
        };
      }
    | {
        type: "status_change_proposed";
        payload: {
          proposalId: string;
          from?: ApplicationStatus;
          to: ApplicationStatus;
          evidenceEventIds: string[];
        };
      }
    | {
        type: "status_change_confirmed";
        payload: {
          to: ApplicationStatus;
          source: "user_manual_confirmation";
        };
      }
  );

export type StoredApplicationEvent = ApplicationEvent & {
  sequence: number;
};

export type ApplicationArtifactEvent = Extract<
  ApplicationEvent,
  {
    type:
      | "job_description_captured"
      | "recruiter_message_captured"
      | "interview_note_recorded"
      | "progress_signal_recorded";
  }
>;

export function isApplicationArtifactEvent(event: ApplicationEvent): event is ApplicationArtifactEvent {
  return (
    event.type === "job_description_captured" ||
    event.type === "recruiter_message_captured" ||
    event.type === "interview_note_recorded" ||
    event.type === "progress_signal_recorded"
  );
}
