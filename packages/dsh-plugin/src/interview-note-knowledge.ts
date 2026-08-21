import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface InterviewKnowledgePreview {
  readonly previewToken: string
  readonly applicationId: string
  readonly company: string
  readonly role: string
  readonly interviewId: string
  readonly stage: string
  readonly contentHash: string
  readonly contentLength: number
  readonly relativePath: string
  readonly expiresAt: string
  readonly requiresConfirmation: true
}

export interface InterviewKnowledgeApplyResult {
  readonly previewToken: string
  readonly applicationId: string
  readonly relativePath: string
  readonly contentHash: string
  readonly deduplicated: boolean
  readonly savedAt: string
}

interface PendingPreview {
  readonly preview: InterviewKnowledgePreview
  readonly content: string
  readonly createdAtMs: number
  readonly occurredAt: string
  readonly applied?: InterviewKnowledgeApplyResult
}

const TTL_MS = 15 * 60 * 1000

export class LocalInterviewKnowledgeService {
  readonly #vaultRoot: string
  readonly #previews = new Map<string, PendingPreview>()

  constructor(input: { vaultRoot: string }) {
    this.#vaultRoot = resolve(input.vaultRoot)
    if (this.#vaultRoot === resolve('/')) throw new Error('invalid_knowledge_vault')
  }

  preview(input: {
    applicationId: string
    company: string
    role: string
    interviewId: string
    stage: string
    content: string
    occurredAt: string
  }): InterviewKnowledgePreview {
    const applicationId = requireText(input.applicationId, 'application_id')
    const company = requireText(input.company, 'company')
    const role = requireText(input.role, 'role')
    const interviewId = requireText(input.interviewId, 'interview_id')
    const stage = requireText(input.stage, 'stage')
    const content = requireText(input.content, 'content')
    const occurredAt = requireTimestamp(input.occurredAt)
    const contentHash = sha256(content)
    const relativePath = join('求职', '面经', sanitizePathPart(company), `${dateKey(occurredAt)}-${sanitizePathPart(stage)}-${sanitizePathPart(interviewId)}-${contentHash.slice(0, 12)}.md`)
    const previewToken = `interview-knowledge-preview:${randomBytes(24).toString('hex')}`
    const preview: InterviewKnowledgePreview = {
      previewToken,
      applicationId,
      company,
      role,
      interviewId,
      stage,
      contentHash,
      contentLength: content.length,
      relativePath,
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      requiresConfirmation: true,
    }
    this.#previews.set(previewToken, { preview, content, createdAtMs: Date.now(), occurredAt })
    this.#prune()
    return preview
  }

  async apply(previewToken: string, confirmed: boolean): Promise<InterviewKnowledgeApplyResult> {
    if (!confirmed) throw new Error('knowledge_confirmation_required')
    const pending = this.#get(previewToken)
    if (pending.applied !== undefined) return pending.applied
    const target = resolve(this.#vaultRoot, pending.preview.relativePath)
    if (!target.startsWith(`${this.#vaultRoot}/`)) throw new Error('invalid_knowledge_path')
    await mkdir(resolve(target, '..'), { recursive: true })
    let deduplicated = false
    try {
      const existing = await readFile(target, 'utf8')
      deduplicated = existing.includes(`contentHash: ${pending.preview.contentHash}`)
      if (!deduplicated) throw new Error('knowledge_path_conflict')
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error
    }
    if (!deduplicated) {
      const markdown = renderMarkdown(pending.preview, pending.content, pending.occurredAt)
      const temporary = `${target}.${process.pid}.tmp`
      await writeFile(temporary, markdown, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
    }
    const result: InterviewKnowledgeApplyResult = {
      previewToken,
      applicationId: pending.preview.applicationId,
      relativePath: pending.preview.relativePath,
      contentHash: pending.preview.contentHash,
      deduplicated,
      savedAt: new Date().toISOString(),
    }
    this.#previews.set(previewToken, { ...pending, applied: result })
    return result
  }

  #get(token: string): PendingPreview {
    const pending = this.#previews.get(token)
    if (pending === undefined) throw new Error('knowledge_preview_not_found')
    if (Date.now() - pending.createdAtMs >= TTL_MS) {
      this.#previews.delete(token)
      throw new Error('knowledge_preview_stale')
    }
    return pending
  }

  #prune(): void {
    const cutoff = Date.now() - TTL_MS
    for (const [token, pending] of this.#previews) if (pending.createdAtMs < cutoff) this.#previews.delete(token)
  }
}

function renderMarkdown(preview: InterviewKnowledgePreview, content: string, occurredAt: string): string {
  return `---\ncompany: ${yamlScalar(preview.company)}\nrole: ${yamlScalar(preview.role)}\napplicationId: ${yamlScalar(preview.applicationId)}\ninterviewId: ${yamlScalar(preview.interviewId)}\nstage: ${yamlScalar(preview.stage)}\noccurredAt: ${yamlScalar(occurredAt)}\ncontentHash: ${preview.contentHash}\n---\n\n# ${preview.company} · ${preview.role}\n\n## ${preview.stage}\n\n${content.trim()}\n`
}

function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

function sanitizePathPart(value: string): string {
  const normalized = value.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').replace(/\s+/gu, ' ').trim()
  return normalized.length > 80 ? normalized.slice(0, 80) : normalized
}

function dateKey(value: string): string {
  return value.slice(0, 10)
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 500_000 || /[\u0000-\u001f]/u.test(normalized)) throw new Error(`invalid_${name}`)
  return normalized
}

function requireTimestamp(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error('invalid_interview_timestamp')
  return new Date(time).toISOString()
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
