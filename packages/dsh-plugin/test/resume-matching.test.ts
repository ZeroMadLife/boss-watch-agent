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
import { LocalResumeMatchingService, SqliteResumeMatchStore } from '../src/resume-matching.ts'
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
    assert.equal(result.strategyVersion, 'local-evidence-match-v3')
    assert.equal(result.createdAt, '2026-08-18T02:00:00.000Z')
    assert.equal(result.extraction.status, 'text_extracted')
    assert.deepEqual(result.skills.missing, [])
    assert.deepEqual(result.hardConstraints.map((item) => item.status), ['matched', 'matched', 'matched'])
    assert.equal(result.matchLevel, 'strong')
    assert.equal(result.requiresGateA, true)
    assert.deepEqual(result.resumeSummary.education, { highestLevel: '本科', status: 'observed' })
    assert.deepEqual(result.resumeSummary.cohorts, ['2027'])
    assert.deepEqual(result.resumeSummary.locations, ['上海'])
    assert.ok(result.resumeSummary.technologies.includes('TypeScript'))
    assert.ok(result.resumeSummary.capabilities.includes('AI Application'))
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('候选人甲'), false)
    assert.equal(serialized.includes('上海'), true)
  } finally {
    fixture.store.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('recognizes descriptive JD capabilities, summarizes project directions, and keeps location as a preference', async () => {
  const descriptiveJob: JobDetails = {
    ...JOB,
    applicationId: 'application:fixture-descriptive-match',
    role: '全栈软件开发工程师',
    contentHash: 'c'.repeat(64),
    description: '2027届招聘，本科及以上，工作地点深圳。负责前后端完整链路，要求 SSR/BFF、API 编排、性能调优、自动化测试和持续集成。',
  }
  const resumeText = [
    '姓名：候选人示例',
    '2027届，硕士，福州',
    '技能：Java、Spring Boot、React、Redis、Agent、RAG',
    '项目经历',
    '项目一：智能招聘工作台',
    'Agent RAG API 编排 性能优化 自动化测试 持续集成',
    '项目二：订单服务',
    'Java Spring Boot Redis API 开发 性能调优',
    '教育经历',
    '硕士',
  ].join('\n')
  const fixture = await setup(resumeText)
  const matcher = new LocalResumeMatchingService({
    source: {
      async getJob(applicationId) { return applicationId === descriptiveJob.applicationId ? descriptiveJob : undefined },
    },
    resumes: fixture.importer,
    now: () => new Date('2026-08-18T02:00:00.000Z'),
  })
  try {
    const result = await matcher.match({
      applicationId: descriptiveJob.applicationId,
      resumeVersionId: fixture.resumeVersionId,
    })

    assert.deepEqual(result.skills.requiredTechnologies, [])
    assert.deepEqual(result.skills.requiredCapabilities, [
      'Backend Engineering',
      'Full-stack Delivery',
      'Frontend Engineering',
      'API Integration',
      'Performance Optimization',
      'Test Automation',
      'CI/CD',
    ])
    assert.deepEqual(result.skills.missingCapabilities, [])
    assert.equal(result.resumeSummary.projects.total, 2)
    assert.equal(result.resumeSummary.projects.detection, 'section_blocks')
    assert.ok(result.resumeSummary.projects.directions.some((item) => item.label === 'AI Application' && item.count === 1))
    assert.ok(result.resumeSummary.projects.directions.some((item) => item.label === 'Backend Engineering' && item.count === 1))
    assert.deepEqual(result.hardConstraints.find((item) => item.field === 'location'), {
      field: 'location',
      constraintType: 'preference',
      status: 'unmatched',
      required: '深圳',
      observed: '福州',
      requiresUserConfirmation: true,
    })
    assert.ok(result.gaps.includes('preference_mismatch:location'))
    assert.ok(result.risks.includes('location_preference_needs_confirmation'))
    assert.equal(result.gaps.includes('hard_constraint:location'), false)
    assert.equal(result.matchLevel, 'strong')
    assert.equal(result.score, 90)
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('候选人示例'), false)
    assert.equal(serialized.includes('智能招聘工作台'), false)
    assert.equal(serialized.includes('订单服务'), false)
    assert.equal(serialized.includes('前后端完整链路'), false)
  } finally {
    fixture.store.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('persists sanitized match results by JD and resume hashes', async () => {
  const fixture = await setup('2027届，本科，上海\nTypeScript React Node.js Redis Docker Agent RAG')
  const matches = new SqliteResumeMatchStore(':memory:')
  const matcher = new LocalResumeMatchingService({
    source: {
      async getJob(applicationId) { return applicationId === JOB.applicationId ? JOB : undefined },
    },
    resumes: fixture.importer,
    store: matches,
    now: () => new Date('2026-08-18T02:00:00.000Z'),
  })
  try {
    const first = await matcher.match({ applicationId: JOB.applicationId, resumeVersionId: fixture.resumeVersionId })
    const second = await matcher.match({ applicationId: JOB.applicationId, resumeVersionId: fixture.resumeVersionId })

    assert.equal(second.matchId, first.matchId)
    assert.equal(first.strategyVersion, 'local-evidence-match-v3')
    assert.ok(first.matchId.startsWith('resume-match:'))
    assert.deepEqual(matches.get(first.matchId), first)
    assert.deepEqual(matches.list({ applicationId: JOB.applicationId }), [first])
    assert.equal(JSON.stringify(matches.list()).includes('候选人'), false)
  } finally {
    matches.close()
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
  const matchStore = new SqliteResumeMatchStore(':memory:')
  matchStore.save(await fixture.matcher.match({
    applicationId: JOB.applicationId,
    resumeVersionId: fixture.resumeVersionId,
  }))
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    matchStore,
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

    const historyResult = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('resume-match-history-tool'),
      name: 'boss_watch_resume_match_list',
      arguments: { applicationId: JOB.applicationId },
    })
    const historyContent = historyResult.content[0]
    assert.equal(historyContent?.type, 'text')
    if (historyContent?.type !== 'text') throw new Error('expected_text_tool_result')
    const history = JSON.parse(historyContent.text) as { status: string; count: number }
    assert.equal(history.status, 'ok')
    assert.equal(history.count, 1)
    assert.equal(historyContent.text.includes('候选人丙'), false)
  } finally {
    dispose()
    await context.fiber.dispose()
    matchStore.close()
    fixture.store.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
