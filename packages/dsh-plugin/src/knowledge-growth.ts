import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

export interface KnowledgeNoteSummary {
  readonly relativePath: string
  readonly title: string
  readonly matchedTerms: readonly string[]
}

export interface GrowthPlanPreview {
  readonly vaultAvailable: boolean
  readonly notes: readonly KnowledgeNoteSummary[]
  readonly missingSkills: readonly string[]
  readonly recommendations: readonly string[]
  readonly readOnly: true
}

export class LocalKnowledgeGrowthService {
  readonly #vaultRoot: string
  readonly #maxFiles: number

  constructor(input: { vaultRoot?: string; maxFiles?: number } = {}) {
    this.#vaultRoot = resolve(input.vaultRoot ?? join(process.env.HOME ?? '', 'Desktop', 'Obsidian-Knowledge-Base'))
    this.#maxFiles = input.maxFiles ?? 500
    if (this.#maxFiles < 1 || this.#maxFiles > 2_000) throw new Error('invalid_knowledge_file_limit')
  }

  async preview(input: { missingSkills?: readonly string[]; targetRoles?: readonly string[] }): Promise<GrowthPlanPreview> {
    const missingSkills = normalizeTerms(input.missingSkills ?? [])
    const targetRoles = normalizeTerms(input.targetRoles ?? [])
    const terms = [...new Set([...missingSkills, ...targetRoles])]
    const files = await collectMarkdown(this.#vaultRoot, this.#maxFiles)
    const notes: KnowledgeNoteSummary[] = []
    for (const file of files) {
      const title = relative(this.#vaultRoot, file).split('/').at(-1)?.replace(/\.md$/u, '') ?? ''
      const matchedTerms = terms.filter(term => title.toLocaleLowerCase().includes(term.toLocaleLowerCase()))
      if (matchedTerms.length === 0 && terms.length > 0) continue
      notes.push({ relativePath: relative(this.#vaultRoot, file), title, matchedTerms })
    }
    const recommendations = missingSkills.map(skill => notes.some(note => note.matchedTerms.includes(skill))
      ? `复习知识库中与“${skill}”相关的笔记，并补一个可讲项目案例`
      : `在知识库中新增“${skill}”的学习卡片，再安排一次小型实战验证`)
    return { vaultAvailable: files.length > 0, notes: notes.slice(0, 50), missingSkills, recommendations, readOnly: true }
  }
}

async function collectMarkdown(root: string, maxFiles: number): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    if (result.length >= maxFiles) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (result.length >= maxFiles || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(path)
    }
  }
  await visit(root)
  return result
}

function normalizeTerms(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(value => value.length > 0 && value.length <= 80))].slice(0, 20)
}
