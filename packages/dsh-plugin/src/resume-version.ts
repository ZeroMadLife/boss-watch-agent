import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

const MAX_RESUME_BYTES = 20 * 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const SUPPORTED_MEDIA_TYPES = new Map([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".md", "text/markdown"],
  [".txt", "text/plain"],
] as const);
const SUPPORTED_MEDIA_TYPE_VALUES = new Set<string>(SUPPORTED_MEDIA_TYPES.values());
const MAX_EXTRACTED_RESUME_CHARS = 200_000;

export interface ResumeVersion {
  readonly resumeVersionId: string;
  readonly displayName: string;
  readonly localArtifactRef: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly supersedesResumeVersionId?: string;
}

export interface ResumeVersionStore {
  save(version: ResumeVersion): { readonly resumeVersion: ResumeVersion; readonly reused: boolean };
  count(): number;
  list(options?: { readonly limit?: number }): ResumeVersion[];
  get(resumeVersionId: string): ResumeVersion | undefined;
  getByArtifactRef(localArtifactRef: string): ResumeVersion | undefined;
  getByContentHash(contentHash: string): ResumeVersion | undefined;
  close(): void;
}

export interface ResumeImportPreview {
  readonly previewToken: string;
  readonly expiresAt: string;
  readonly fileName: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly localArtifactRef: string;
  readonly supersedesResumeVersionId?: string;
  readonly existingResumeVersionId?: string;
  readonly requiresConfirmation: true;
}

export interface ResumeImportResult {
  readonly resumeVersion: ResumeVersion;
  readonly reused: boolean;
}

export type ResumeTextExtractionStatus = "text_extracted" | "text_truncated";

export interface ResumeTextContent {
  readonly resumeVersion: ResumeVersion;
  readonly text: string;
  readonly extractionStatus: ResumeTextExtractionStatus;
  readonly characterCount: number;
  readonly sourceByteHash: string;
}

export interface ResumeArtifactContent {
  readonly resumeVersion: ResumeVersion;
  readonly filePath: string;
  readonly sourceByteHash: string;
}

interface ResumeImportInput {
  readonly fileName: string;
  readonly displayName?: string;
  readonly supersedesResumeVersionId?: string;
}

export type ResumeTextExtractor = (filePath: string, mediaType: string) => Promise<string>;

interface ResumeImportOptions {
  readonly resumeRoot: string;
  readonly store: ResumeVersionStore;
  readonly now?: () => Date;
  readonly extractText?: ResumeTextExtractor;
}

interface PreparedResume {
  readonly fileName: string;
  readonly filePath: string;
  readonly extension: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly localArtifactRef: string;
  readonly supersedesResumeVersionId?: string;
}

interface StoredPreview {
  readonly expiresAt: number;
  readonly prepared: PreparedResume;
}

interface ResumeVersionRow {
  resume_version_id: string;
  display_name: string;
  local_artifact_ref: string;
  content_hash: string;
  media_type: string;
  byte_size: number;
  created_at: string;
  supersedes_resume_version_id: string | null;
}

export class SqliteResumeVersionStore implements ResumeVersionStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error("invalid_database_path");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS resume_versions (
        resume_version_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        local_artifact_ref TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL UNIQUE CHECK (length(content_hash) = 64),
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size > 0),
        created_at TEXT NOT NULL,
        supersedes_resume_version_id TEXT
      );
      CREATE INDEX IF NOT EXISTS resume_versions_created_at
        ON resume_versions(created_at DESC, resume_version_id ASC);
    `);
  }

  save(version: ResumeVersion): ResumeImportResult {
    this.#ensureOpen();
    validateResumeVersion(version);
    if (
      version.supersedesResumeVersionId !== undefined &&
      this.get(version.supersedesResumeVersionId) === undefined
    )
      throw new Error("resume_supersedes_not_found");
    const existing = this.getByContentHash(version.contentHash);
    if (existing !== undefined) return { resumeVersion: existing, reused: true };
    this.#database
      .prepare(`
      INSERT INTO resume_versions (
        resume_version_id, display_name, local_artifact_ref, content_hash, media_type,
        byte_size, created_at, supersedes_resume_version_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        version.resumeVersionId,
        version.displayName,
        version.localArtifactRef,
        version.contentHash,
        version.mediaType,
        version.byteSize,
        version.createdAt,
        version.supersedesResumeVersionId ?? null,
      );
    return { resumeVersion: version, reused: false };
  }

  count(): number {
    this.#ensureOpen();
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM resume_versions").get() as unknown as {
      count: number;
    };
    return row.count;
  }

  list(options: { readonly limit?: number } = {}): ResumeVersion[] {
    this.#ensureOpen();
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_resume_version_limit");
    const rows = this.#database
      .prepare(`
      SELECT resume_version_id, display_name, local_artifact_ref, content_hash, media_type,
             byte_size, created_at, supersedes_resume_version_id
      FROM resume_versions
      ORDER BY created_at DESC, resume_version_id ASC
      LIMIT ?
    `)
      .all(limit) as unknown as ResumeVersionRow[];
    return rows.map(fromRow);
  }

  get(resumeVersionId: string): ResumeVersion | undefined {
    this.#ensureOpen();
    const normalized = normalizeResumeVersionId(resumeVersionId);
    const row = this.#database
      .prepare(`
      SELECT resume_version_id, display_name, local_artifact_ref, content_hash, media_type,
             byte_size, created_at, supersedes_resume_version_id
      FROM resume_versions WHERE resume_version_id = ?
    `)
      .get(normalized) as unknown as ResumeVersionRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  getByArtifactRef(localArtifactRef: string): ResumeVersion | undefined {
    this.#ensureOpen();
    const normalized = normalizeArtifactRef(localArtifactRef);
    const row = this.#database
      .prepare(`
      SELECT resume_version_id, display_name, local_artifact_ref, content_hash, media_type,
             byte_size, created_at, supersedes_resume_version_id
      FROM resume_versions WHERE local_artifact_ref = ?
    `)
      .get(normalized) as unknown as ResumeVersionRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  getByContentHash(contentHash: string): ResumeVersion | undefined {
    this.#ensureOpen();
    const normalized = normalizeHash(contentHash);
    const row = this.#database
      .prepare(`
      SELECT resume_version_id, display_name, local_artifact_ref, content_hash, media_type,
             byte_size, created_at, supersedes_resume_version_id
      FROM resume_versions WHERE content_hash = ?
    `)
      .get(normalized) as unknown as ResumeVersionRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("sqlite_resume_store_closed");
  }
}

export class LocalResumeImportService {
  readonly #resumeRoot: string;
  readonly #artifactRoot: string;
  readonly #store: ResumeVersionStore;
  readonly #now: () => Date;
  readonly #extractText: ResumeTextExtractor;
  readonly #previews = new Map<string, StoredPreview>();
  readonly #applied = new Map<string, ResumeImportResult>();
  readonly #textCache = new Map<string, ResumeTextContent>();
  readonly #textInFlight = new Map<string, Promise<ResumeTextContent>>();
  #applying = false;

  constructor(options: ResumeImportOptions) {
    if (options.resumeRoot.trim().length === 0) throw new Error("invalid_resume_root");
    this.#resumeRoot = resolve(options.resumeRoot);
    this.#artifactRoot = join(this.#resumeRoot, ".artifacts");
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#extractText = options.extractText ?? extractResumeText;
    mkdirSync(this.#resumeRoot, { recursive: true });
    mkdirSync(this.#artifactRoot, { recursive: true, mode: 0o700 });
  }

  async preview(input: ResumeImportInput): Promise<ResumeImportPreview> {
    const prepared = await this.#prepare(input);
    const existing = this.#store.getByContentHash(prepared.contentHash);
    const now = this.#now().getTime();
    const expiresAt = now + PREVIEW_TTL_MS;
    const previewToken = `resume-import-preview:${randomBytes(24).toString("hex")}`;
    this.#previews.set(previewToken, { expiresAt, prepared });
    this.#discardExpired(now);
    return {
      previewToken,
      expiresAt: new Date(expiresAt).toISOString(),
      fileName: prepared.fileName,
      displayName: prepared.displayName,
      mediaType: prepared.mediaType,
      byteSize: prepared.byteSize,
      contentHash: prepared.contentHash,
      localArtifactRef: prepared.localArtifactRef,
      ...(prepared.supersedesResumeVersionId === undefined
        ? {}
        : { supersedesResumeVersionId: prepared.supersedesResumeVersionId }),
      ...(existing === undefined ? {} : { existingResumeVersionId: existing.resumeVersionId }),
      requiresConfirmation: true,
    };
  }

  async apply(previewToken: string): Promise<ResumeImportResult> {
    const reused = this.#applied.get(previewToken);
    if (reused !== undefined) return reused;
    const preview = this.#previews.get(previewToken);
    if (preview === undefined) throw new Error("resume_preview_not_found");
    if (preview.expiresAt <= this.#now().getTime()) {
      this.#previews.delete(previewToken);
      throw new Error("resume_preview_stale");
    }
    if (this.#applying) throw new Error("resume_import_in_progress");
    this.#applying = true;
    try {
      const current = await this.#prepare({
        fileName: preview.prepared.fileName,
        displayName: preview.prepared.displayName,
        ...(preview.prepared.supersedesResumeVersionId === undefined
          ? {}
          : { supersedesResumeVersionId: preview.prepared.supersedesResumeVersionId }),
      });
      if (!samePreparedResume(preview.prepared, current)) {
        this.#previews.delete(previewToken);
        throw new Error("resume_preview_stale");
      }
      const existing = this.#store.getByContentHash(current.contentHash);
      if (existing !== undefined) {
        const result = { resumeVersion: existing, reused: true };
        this.#previews.delete(previewToken);
        this.#applied.set(previewToken, result);
        return result;
      }
      const bytes = await readFile(current.filePath);
      if (hash(bytes) !== current.contentHash) throw new Error("resume_preview_stale");
      await this.#writeArtifact(current, bytes);
      const result = this.#store.save({
        resumeVersionId: `resume-version:${current.contentHash}`,
        displayName: current.displayName,
        localArtifactRef: current.localArtifactRef,
        contentHash: current.contentHash,
        mediaType: current.mediaType,
        byteSize: current.byteSize,
        createdAt: this.#now().toISOString(),
        ...(current.supersedesResumeVersionId === undefined
          ? {}
          : { supersedesResumeVersionId: current.supersedesResumeVersionId }),
      });
      this.#previews.delete(previewToken);
      this.#applied.set(previewToken, result);
      return result;
    } finally {
      this.#applying = false;
    }
  }

  /**
   * Read a registered resume only inside the local plugin process.
   * Callers must keep the returned text in-memory and must not put it in a
   * transcript, log, SQLite row, or tool response.
   */
  async readText(resumeVersionId: string): Promise<ResumeTextContent> {
    const resumeVersion = this.#store.get(resumeVersionId);
    if (resumeVersion === undefined) throw new Error("resume_version_not_found");
    const cached = this.#textCache.get(resumeVersion.resumeVersionId);
    if (cached !== undefined && cached.resumeVersion.contentHash === resumeVersion.contentHash) {
      await this.#assertArtifactIdentity(resumeVersion);
      return cached;
    }
    const current = this.#textInFlight.get(resumeVersion.resumeVersionId);
    if (current !== undefined) return current;
    const pending = this.#extractRegisteredResume(resumeVersion);
    this.#textInFlight.set(resumeVersion.resumeVersionId, pending);
    try {
      const extracted = await pending;
      this.#textCache.set(resumeVersion.resumeVersionId, extracted);
      return extracted;
    } finally {
      this.#textInFlight.delete(resumeVersion.resumeVersionId);
    }
  }

  async #extractRegisteredResume(resumeVersion: ResumeVersion): Promise<ResumeTextContent> {
    const artifactPath = await this.#findArtifactPath(resumeVersion.contentHash);
    const bytes = await readFile(artifactPath);
    const sourceByteHash = hash(bytes);
    if (sourceByteHash !== resumeVersion.contentHash) throw new Error("resume_artifact_hash_mismatch");
    const rawText = await this.#extractText(artifactPath, resumeVersion.mediaType);
    const normalized = normalizeExtractedText(rawText);
    if (normalized.length === 0) throw new Error("resume_text_empty");
    const truncated = normalized.length > MAX_EXTRACTED_RESUME_CHARS;
    const text = truncated ? normalized.slice(0, MAX_EXTRACTED_RESUME_CHARS) : normalized;
    return {
      resumeVersion,
      text,
      extractionStatus: truncated ? "text_truncated" : "text_extracted",
      characterCount: text.length,
      sourceByteHash,
    };
  }

  async #assertArtifactIdentity(resumeVersion: ResumeVersion): Promise<void> {
    const artifactPath = await this.#findArtifactPath(resumeVersion.contentHash);
    const bytes = await readFile(artifactPath);
    if (hash(bytes) !== resumeVersion.contentHash) throw new Error("resume_artifact_hash_mismatch");
  }

  /** Resolve a hash-verified artifact for trusted local browser upload only. */
  async readArtifact(resumeVersionId: string): Promise<ResumeArtifactContent> {
    const resumeVersion = this.#store.get(resumeVersionId);
    if (resumeVersion === undefined) throw new Error("resume_version_not_found");
    const filePath = await this.#findArtifactPath(resumeVersion.contentHash);
    const bytes = await readFile(filePath);
    const sourceByteHash = hash(bytes);
    if (sourceByteHash !== resumeVersion.contentHash) throw new Error("resume_artifact_hash_mismatch");
    return { resumeVersion, filePath, sourceByteHash };
  }

  async #prepare(input: ResumeImportInput): Promise<PreparedResume> {
    const fileName = normalizeFileName(input.fileName);
    const extension = extname(fileName).toLowerCase();
    const mediaType = SUPPORTED_MEDIA_TYPES.get(extension as ".pdf" | ".docx" | ".md" | ".txt");
    if (mediaType === undefined) throw new Error("unsupported_resume_file_type");
    const filePath = resolve(this.#resumeRoot, fileName);
    if (dirname(filePath) !== this.#resumeRoot) throw new Error("file_outside_resume_root");
    let info;
    try {
      info = await lstat(filePath);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) throw new Error("resume_file_not_found");
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("resume_file_symlink_not_allowed");
    if (!info.isFile()) throw new Error("resume_file_not_found");
    if (info.size === 0) throw new Error("resume_file_empty");
    if (info.size > MAX_RESUME_BYTES) throw new Error("resume_file_too_large");
    const bytes = await readFile(filePath);
    if (bytes.byteLength === 0) throw new Error("resume_file_empty");
    if (bytes.byteLength > MAX_RESUME_BYTES) throw new Error("resume_file_too_large");
    const contentHash = hash(bytes);
    const supersedesResumeVersionId =
      input.supersedesResumeVersionId === undefined
        ? undefined
        : normalizeResumeVersionId(input.supersedesResumeVersionId);
    if (supersedesResumeVersionId !== undefined && this.#store.get(supersedesResumeVersionId) === undefined) {
      throw new Error("resume_supersedes_not_found");
    }
    return {
      fileName,
      filePath,
      extension,
      displayName: normalizeDisplayName(input.displayName ?? basename(fileName, extension)),
      mediaType,
      byteSize: bytes.byteLength,
      contentHash,
      localArtifactRef: `local-resume://sha256:${contentHash}`,
      ...(supersedesResumeVersionId === undefined ? {} : { supersedesResumeVersionId }),
    };
  }

  async #writeArtifact(prepared: PreparedResume, bytes: Buffer): Promise<void> {
    const artifactPath = join(this.#artifactRoot, `${prepared.contentHash}${prepared.extension}`);
    try {
      await writeFile(artifactPath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const info = await lstat(artifactPath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("resume_artifact_path_invalid");
      const existing = await readFile(artifactPath);
      if (hash(existing) !== prepared.contentHash) throw new Error("resume_artifact_hash_conflict");
    }
  }

  async #findArtifactPath(contentHash: string): Promise<string> {
    const entries = await readdir(this.#artifactRoot);
    const candidates = entries
      .filter((entry) => entry.startsWith(`${contentHash}.`))
      .map((entry) => join(this.#artifactRoot, entry));
    if (candidates.length !== 1) throw new Error("resume_artifact_not_found");
    const candidate = candidates[0] as string;
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("resume_artifact_path_invalid");
    return candidate;
  }

  #discardExpired(now: number): void {
    for (const [token, preview] of this.#previews) {
      if (preview.expiresAt <= now) this.#previews.delete(token);
    }
  }
}

async function extractResumeText(filePath: string, mediaType: string): Promise<string> {
  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    return readFile(filePath, "utf8");
  }
  if (mediaType === "application/pdf") {
    return runTextCommand("pdftotext", ["-layout", filePath, "-"]);
  }
  if (mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      return await runTextCommand("textutil", ["-convert", "txt", "-stdout", filePath]);
    } catch (error: unknown) {
      if (!isCommandUnavailable(error)) throw error;
      const xml = await runTextCommand("unzip", ["-p", filePath, "word/document.xml"]);
      return xmlToText(xml);
    }
  }
  throw new Error("unsupported_resume_text_type");
}

async function runTextCommand(command: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFile(command, [...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error: unknown) {
    if (isCommandUnavailable(error)) throw new Error("resume_text_extraction_unavailable");
    throw new Error("resume_text_extraction_failed");
  }
}

function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\s*\/?>/gu, "\t")
    .replace(/<w:br\s*\/?>/gu, "\n")
    .replace(/<\/w:p>/gu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u0000/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isCommandUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.message === "resume_text_extraction_unavailable")
  );
}

function fromRow(row: ResumeVersionRow): ResumeVersion {
  return {
    resumeVersionId: row.resume_version_id,
    displayName: row.display_name,
    localArtifactRef: row.local_artifact_ref,
    contentHash: row.content_hash,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    ...(row.supersedes_resume_version_id === null
      ? {}
      : { supersedesResumeVersionId: row.supersedes_resume_version_id }),
  };
}

function validateResumeVersion(version: ResumeVersion): void {
  const resumeVersionId = normalizeResumeVersionId(version.resumeVersionId);
  normalizeDisplayName(version.displayName);
  const localArtifactRef = normalizeArtifactRef(version.localArtifactRef);
  const contentHash = normalizeHash(version.contentHash);
  if (
    resumeVersionId !== `resume-version:${contentHash}` ||
    localArtifactRef !== `local-resume://sha256:${contentHash}`
  )
    throw new Error("resume_version_identity_mismatch");
  if (!SUPPORTED_MEDIA_TYPE_VALUES.has(version.mediaType)) throw new Error("invalid_resume_media_type");
  if (
    !Number.isSafeInteger(version.byteSize) ||
    version.byteSize < 1 ||
    version.byteSize > MAX_RESUME_BYTES
  ) {
    throw new Error("invalid_resume_byte_size");
  }
  if (!Number.isFinite(Date.parse(version.createdAt))) throw new Error("invalid_resume_created_at");
  if (version.supersedesResumeVersionId !== undefined)
    normalizeResumeVersionId(version.supersedesResumeVersionId);
}

function normalizeFileName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    normalized !== basename(normalized) ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("invalid_resume_file_name");
  }
  return normalized;
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("invalid_resume_display_name");
  }
  return normalized;
}

function normalizeResumeVersionId(value: string): string {
  const normalized = value.trim();
  if (!/^resume-version:[a-f0-9]{64}$/u.test(normalized)) throw new Error("invalid_resume_version_id");
  return normalized;
}

function normalizeArtifactRef(value: string): string {
  const normalized = value.trim();
  if (!/^local-resume:\/\/sha256:[a-f0-9]{64}$/u.test(normalized)) throw new Error("invalid_resume_ref");
  return normalized;
}

function normalizeHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error("invalid_resume_content_hash");
  return normalized;
}

function samePreparedResume(left: PreparedResume, right: PreparedResume): boolean {
  return (
    left.fileName === right.fileName &&
    left.displayName === right.displayName &&
    left.mediaType === right.mediaType &&
    left.byteSize === right.byteSize &&
    left.contentHash === right.contentHash &&
    left.localArtifactRef === right.localArtifactRef &&
    left.supersedesResumeVersionId === right.supersedesResumeVersionId
  );
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
