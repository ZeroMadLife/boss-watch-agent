import { randomUUID } from "node:crypto";
import { link, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { StoredApplicationArtifact } from "../domain/application-artifact.js";
import type { StoredApplicationEvent } from "../domain/application-event.js";

export type ApplicationExportFormat = "json" | "markdown";

export interface ApplicationArchiveReader {
  list(applicationId: string): Promise<StoredApplicationEvent[]>;
  listArtifacts(applicationId: string): Promise<StoredApplicationArtifact[]>;
  listApplicationIds(): Promise<string[]>;
}

export interface ApplicationExportGroup {
  applicationId: string;
  events: StoredApplicationEvent[];
  artifacts: StoredApplicationArtifact[];
}

export interface ApplicationExportBundle {
  schemaVersion: 1;
  exportedAt: string;
  applicationFilter: string | null;
  applications: ApplicationExportGroup[];
}

export interface WriteApplicationExportOptions {
  outputPath: string;
  format: ApplicationExportFormat;
  applicationId?: string;
  exportedAt?: string;
  force?: boolean;
}

export async function writeApplicationExport(
  store: ApplicationArchiveReader,
  options: WriteApplicationExportOptions,
): Promise<ApplicationExportBundle> {
  const bundle = await buildApplicationExport(store, options.applicationId, options.exportedAt);
  const serialized = options.format === "json" ? renderJson(bundle) : renderMarkdown(bundle);
  await writeExportFile(options.outputPath, serialized, options.force ?? false);
  return bundle;
}

export async function buildApplicationExport(
  store: ApplicationArchiveReader,
  applicationId?: string,
  exportedAt = new Date().toISOString(),
): Promise<ApplicationExportBundle> {
  if (!Number.isFinite(Date.parse(exportedAt))) throw new Error("invalid_export_timestamp");
  const availableApplicationIds = await store.listApplicationIds();
  if (applicationId !== undefined && !availableApplicationIds.includes(applicationId)) {
    throw new Error(`application_not_found:${applicationId}`);
  }
  const applicationIds = applicationId === undefined ? availableApplicationIds : [applicationId];
  const applications = await Promise.all(
    applicationIds.map(async (id) => ({
      applicationId: id,
      events: await store.list(id),
      artifacts: await store.listArtifacts(id),
    })),
  );
  return {
    schemaVersion: 1,
    exportedAt,
    applicationFilter: applicationId ?? null,
    applications,
  };
}

function renderJson(bundle: ApplicationExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

function renderMarkdown(bundle: ApplicationExportBundle): string {
  const lines = [
    "# Boss Watch Application Export",
    "",
    `- Schema version: ${bundle.schemaVersion}`,
    `- Exported at: ${bundle.exportedAt}`,
    `- Application filter: ${bundle.applicationFilter ?? "all"}`,
    "",
  ];

  if (bundle.applications.length === 0) {
    lines.push("No applications found.", "");
    return lines.join("\n");
  }

  for (const application of bundle.applications) {
    lines.push(`## Application ${inlineCode(application.applicationId)}`, "", "### Events", "");
    if (application.events.length === 0) lines.push("No events.", "");
    for (const event of application.events) {
      lines.push(
        `#### ${event.sequence}. ${inlineCode(event.type)}`,
        "",
        `- Event ID: ${inlineCode(event.eventId)}`,
        `- Idempotency key: ${inlineCode(event.idempotencyKey)}`,
        `- Trace ID: ${inlineCode(event.traceId)}`,
        `- Occurred at: ${event.occurredAt}`,
        "",
        fencedBlock("json", JSON.stringify(event, null, 2)),
        "",
      );
    }

    lines.push("### Artifacts", "");
    if (application.artifacts.length === 0) lines.push("No artifacts.", "");
    for (const artifact of application.artifacts) {
      lines.push(
        `#### ${inlineCode(artifact.kind)} ${inlineCode(artifact.artifactId)}`,
        "",
        `- Artifact ref: ${inlineCode(artifact.artifactRef)}`,
        `- SHA-256: ${inlineCode(artifact.contentHash)}`,
        `- Created at: ${artifact.createdAt}`,
        `- Metadata: ${inlineCode(JSON.stringify(artifact.metadata ?? {}))}`,
        "",
        fencedBlock("text", artifact.content),
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function fencedBlock(language: string, content: string): string {
  const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

function inlineCode(value: string): string {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(Math.max(1, longestRun + 1));
  return `${fence}${value}${fence}`;
}

async function writeExportFile(outputPath: string, content: string, force: boolean): Promise<void> {
  if (outputPath.trim().length === 0) throw new Error("invalid_export_path");
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (force) {
      await rename(temporaryPath, outputPath);
    } else {
      try {
        await link(temporaryPath, outputPath);
      } catch (error) {
        if (isFileExistsError(error)) throw new Error("export_path_exists");
        throw error;
      }
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
