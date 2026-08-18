import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { BossWatchDataSource, JobDetails } from '../src/domain.ts'
import { LocalResumeImportService, SqliteResumeVersionStore } from '../src/resume-version.ts'
import { LocalResumeMatchingService } from '../src/resume-matching.ts'
import { registerBossWatchTools } from '../src/tools.ts'

const JOB: JobDetails = {
  applicationId: 'application:fixture-match',
  company: '虚构科技',
  role: 'Agent 平台工程师',
  jobUrl: 'https://www.zhipin.com/job_detail/fixture',
  capturedAt: '2026-08-18T01:00:00.000Z',
  contentHash: 'a'.repeat(64),
  description: '2027届招聘，本科及以上，工作地点上海。要求 TypeScript、React、Node.js、Redis、Docker、Agent 和 RAG。',
  artifactRef: 'local-artifact://fixture-jd',
}

async function setup(resumeText: string) {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-resume-match-'))
  const store = new SqliteResumeVersionStore(':memory:')
  const importer = new LocalResumeImportService({ resumeRoot: root, store })
  await writeFile(join(root, 'candidate.md'), resumeText)
  const preview = await importer.preview({ fileName: 'candidate.md', displayName: '候选人简历' })
  const applied = await importer.apply(preview.previewToken)
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob(applicationId) { return applicationId === JOB.applicationId ? JOB : undefined },
    async listTimeline() { return [] },
  }
  const matcher = new LocalResumeMatchingService({
    source,
    resumes: importer,
    now: () => new Date('2026-08-18T02:00:00.000Z'),
  })
  return { root, store, importer, matcher, resumeVersionId: applied.resumeVersion.resumeVersionId }
}

test('matches locally and returns evidence without resume content', async () => {
  const fixture = await setup('姓名：候选人甲\n2027届，本科，上海\nTypeScript React Node.js Redis Docker Agent RAG')
  try {
    const result = await fixture.matcher.match({
      applicationId: JOB.applicationId,
      resumeVersionId: fixture.resumeVersionId,
    })
    assert.equal(result.strategyVersion, 'local-evidence-match-v2')
    assert.equal(result.createdAt, '2026-08-18T02:00:00.000Z')
    assert.equal(result.extraction.status, 'text_extracted')
    assert.deepEqual(result.skills.missing, [])
    assert.deepEqual(result.hardConstraints.map((item) => item.status), ['matched', 'matched', 'matched'])
    assert.equal(result.matchLevel, 'strong')
    assert.equal(result.requiresGateA, true)
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('候选人甲'), false)
    assert.equal(serialized.includes('上海'), true)
  } finally {
    fixture.store.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('reports missing skills and hard-constraint gaps without guessing', async () => {
  const fixture = await setup('姓名：候选人乙\n2026届，硕士，广州\nJava Spring')
  try {
    const result = await fixture.matcher.match({
      applicationId: JOB.applicationId,
      resumeVersionId: fixture.resumeVersionId,
    })
    assert.ok(result.skills.missing.includes('TypeScript'))
    assert.equal(result.hardConstraints.find((item) => item.field === 'cohort')?.status, 'unmatched')
    assert.equal(result.hardConstraints.find((item) => item.field === 'location')?.status, 'unmatched')
    assert.ok(result.gaps.includes('missing_skill:TypeScript'))
    assert.ok(result.risks.includes('hard_constraint_not_observed') === false)
    assert.equal(result.matchLevel, 'insufficient_evidence')
    assert.equal(result.requiresGateA, true)
  } finally {
    fixture.store.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('fails closed when the captured JD or local resume is missing', async () => {
  const fixture = await setup('TypeScript')
  try {
    await assert.rejects(
      fixture.matcher.match({ applicationId: 'application:missing', resumeVersionId: fixture.resumeVersionId }),
      /resume_match_job_not_found/u,
    )
    await assert.rejects(
      fixture.matcher.match({ applicationId: JOB.applicationId, resumeVersionId: `resume-version:${'b'.repeat(64)}` }),
      /resume_version_not_found/u,
    )
  } finally {
    fixture.store.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('exposes local matching through DSH without returning resume content', async () => {
  const fixture = await setup('姓名：候选人丙\n2027届，本科，上海\nTypeScript React Node.js Redis Docker Agent RAG')
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const dispose = registerBossWatchTools(
    context,
    {
      async listJobs() { return [] },
      async listApplicationOverviews() { return [] },
      async getApplicationOverview() { return undefined },
      async getJob(applicationId) { return applicationId === JOB.applicationId ? JOB : undefined },
      async listTimeline() { return [] },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fixture.matcher,
  )
  try {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('resume-match-tool'),
      name: 'boss_watch_resume_match',
      arguments: { applicationId: JOB.applicationId, resumeVersionId: fixture.resumeVersionId },
    })
    const content = result.content[0]
    assert.equal(content?.type, 'text')
    if (content?.type !== 'text') throw new Error('expected_text_tool_result')
    const payload = JSON.parse(content.text) as { status: string; match: { score: number } }
    assert.equal(payload.status, 'ok')
    assert.equal(typeof payload.match.score, 'number')
    assert.equal(content.text.includes('候选人丙'), false)
  } finally {
    dispose()
    await context.fiber.dispose()
    fixture.store.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
