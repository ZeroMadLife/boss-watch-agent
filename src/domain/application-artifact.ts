export type ApplicationArtifactKind =
  | "job_description"
  | "recruiter_message"
  | "interview_note"
  | "progress_signal";

export type ArtifactMetadataValue =
  | string
  | number
  | boolean
  | null
  | ArtifactMetadataValue[]
  | { [key: string]: ArtifactMetadataValue };

export interface ApplicationArtifactInput {
  artifactId: string;
  applicationId: string;
  kind: ApplicationArtifactKind;
  content: string;
  createdAt: string;
  metadata?: Record<string, ArtifactMetadataValue>;
}

export interface StoredApplicationArtifact extends ApplicationArtifactInput {
  contentHash: string;
  artifactRef: string;
}

export function applicationArtifactRef(artifactId: string): string {
  if (artifactId.trim().length === 0) throw new Error("invalid_artifact_id");
  return `local-artifact://application/${encodeURIComponent(artifactId)}`;
}
