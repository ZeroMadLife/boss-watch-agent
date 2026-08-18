import type { JobRevision } from './domain.js'

export interface JobDescriptionDiffSection {
  readonly text: string
  readonly lineStart: number
  readonly lineEnd: number
}

export interface JobDescriptionDiff {
  readonly applicationId: string
  readonly company: string
  readonly role: string
  readonly changed: boolean
  readonly from: Pick<JobRevision, 'contentHash' | 'capturedAt' | 'artifactRef'>
  readonly to: Pick<JobRevision, 'contentHash' | 'capturedAt' | 'artifactRef'>
  readonly added: readonly JobDescriptionDiffSection[]
  readonly removed: readonly JobDescriptionDiffSection[]
  readonly summary: {
    readonly addedSections: number
    readonly removedSections: number
    readonly addedCharacters: number
    readonly removedCharacters: number
    readonly truncated: boolean
  }
}

export interface JobRevisionSource {
  listJobRevisions(applicationId: string): Promise<readonly JobRevision[]>
}

const MAX_LINES = 400
const MAX_SECTIONS = 100
const MAX_SECTION_CHARS = 1_000
const MAX_OUTPUT_CHARS = 20_000

export class LocalJobDescriptionDiffService {
  readonly #source: JobRevisionSource

  constructor(source: JobRevisionSource) {
    this.#source = source
  }

  async diff(input: {
    applicationId: string
    fromContentHash?: string
    toContentHash?: string
  }): Promise<JobDescriptionDiff> {
    const applicationId = requireText(input.applicationId, 'application_id')
    const fromHash = optionalHash(input.fromContentHash, 'from_content_hash')
    const toHash = optionalHash(input.toContentHash, 'to_content_hash')
    const revisions = await this.#source.listJobRevisions(applicationId)
    const distinct = uniqueRevisions(revisions)
    if (distinct.length < 2 && (fromHash === undefined || toHash === undefined)) {
      throw new Error('jd_diff_baseline_missing')
    }
    const to = toHash === undefined ? distinct.at(-1) : distinct.find((revision) => revision.contentHash === toHash)
    const from = fromHash === undefined
      ? distinct.at(-2)
      : distinct.find((revision) => revision.contentHash === fromHash)
    if (from === undefined || to === undefined) throw new Error('jd_diff_revision_not_found')
    if (from.applicationId !== to.applicationId) throw new Error('jd_diff_revision_not_found')

    const before = splitLines(from.description)
    const after = splitLines(to.description)
    const operations = diffLines(before.lines, after.lines)
    const added = collectSections(operations, 'added')
    const removed = collectSections(operations, 'removed')
    const bounded = boundSections(added, removed)
    return {
      applicationId,
      company: to.company,
      role: to.role,
      changed: from.contentHash !== to.contentHash,
      from: pickRevision(from),
      to: pickRevision(to),
      added: bounded.added,
      removed: bounded.removed,
      summary: {
        addedSections: bounded.added.length,
        removedSections: bounded.removed.length,
        addedCharacters: bounded.added.reduce((total, section) => total + section.text.length, 0),
        removedCharacters: bounded.removed.reduce((total, section) => total + section.text.length, 0),
        truncated: bounded.truncated || before.truncated || after.truncated,
      },
    }
  }
}

type Operation =
  | { readonly kind: 'same'; readonly text: string; readonly line: number }
  | { readonly kind: 'added'; readonly text: string; readonly line: number }
  | { readonly kind: 'removed'; readonly text: string; readonly line: number }

function uniqueRevisions(revisions: readonly JobRevision[]): JobRevision[] {
  const latestByHash = new Map<string, JobRevision>()
  for (const revision of revisions) latestByHash.set(revision.contentHash, revision)
  return [...latestByHash.values()].sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
}

function pickRevision(revision: JobRevision): Pick<JobRevision, 'contentHash' | 'capturedAt' | 'artifactRef'> {
  return {
    contentHash: revision.contentHash,
    capturedAt: revision.capturedAt,
    artifactRef: revision.artifactRef,
  }
}

function splitLines(content: string): { readonly lines: string[]; readonly truncated: boolean } {
  const normalized = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const lines = normalized.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  return { lines: lines.slice(0, MAX_LINES), truncated: lines.length > MAX_LINES }
}

function diffLines(before: readonly string[], after: readonly string[]): Operation[] {
  const rows = before.length + 1
  const columns = after.length + 1
  const table = Array.from({ length: rows }, () => new Uint16Array(columns))
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      table[row]![column] = before[row]! === after[column]!
        ? table[row + 1]![column + 1]! + 1
        : Math.max(table[row + 1]![column]!, table[row]![column + 1]!)
    }
  }
  const operations: Operation[] = []
  let row = 0
  let column = 0
  while (row < before.length && column < after.length) {
    if (before[row]! === after[column]!) {
      operations.push({ kind: 'same', text: after[column]!, line: column + 1 })
      row += 1
      column += 1
    } else if (table[row + 1]![column]! >= table[row]![column + 1]!) {
      operations.push({ kind: 'removed', text: before[row]!, line: row + 1 })
      row += 1
    } else {
      operations.push({ kind: 'added', text: after[column]!, line: column + 1 })
      column += 1
    }
  }
  while (row < before.length) {
    operations.push({ kind: 'removed', text: before[row]!, line: row + 1 })
    row += 1
  }
  while (column < after.length) {
    operations.push({ kind: 'added', text: after[column]!, line: column + 1 })
    column += 1
  }
  return operations
}

function collectSections(operations: readonly Operation[], kind: 'added' | 'removed'): JobDescriptionDiffSection[] {
  const sections: JobDescriptionDiffSection[] = []
  for (const operation of operations) {
    if (operation.kind !== kind) continue
    const previous = sections.at(-1)
    if (previous !== undefined && previous.lineEnd + 1 === operation.line) {
      sections[sections.length - 1] = {
        ...previous,
        text: `${previous.text}\n${operation.text}`,
        lineEnd: operation.line,
      }
    } else {
      sections.push({ text: operation.text, lineStart: operation.line, lineEnd: operation.line })
    }
  }
  return sections
}

function boundSections(
  added: readonly JobDescriptionDiffSection[],
  removed: readonly JobDescriptionDiffSection[],
): { readonly added: JobDescriptionDiffSection[]; readonly removed: JobDescriptionDiffSection[]; readonly truncated: boolean } {
  let remaining = MAX_OUTPUT_CHARS
  let truncated = added.length > MAX_SECTIONS || removed.length > MAX_SECTIONS
  const bound = (sections: readonly JobDescriptionDiffSection[]): JobDescriptionDiffSection[] => sections.slice(0, MAX_SECTIONS).flatMap((section) => {
    const text = section.text.slice(0, Math.min(MAX_SECTION_CHARS, remaining))
    if (text.length < section.text.length || sections.indexOf(section) >= MAX_SECTIONS) truncated = true
    remaining -= text.length
    if (remaining < 0) {
      truncated = true
      return []
    }
    return text.length === 0 ? [] : [{ ...section, text }]
  })
  return { added: bound(added), removed: bound(removed), truncated }
}

function optionalHash(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`invalid_jd_diff_${name}`)
  return value
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`invalid_${name}`)
  return normalized
}
