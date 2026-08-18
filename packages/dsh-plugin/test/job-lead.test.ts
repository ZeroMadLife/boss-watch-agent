import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { BossWatchDataSource } from '../src/domain.ts'
import { GankInterviewCampusAdapter, SqliteJobLeadStore, type JobLead } from '../src/job-lead.ts'
import { registerBossWatchTools } from '../src/tools.ts'

test('normalizes and persists GankInterview campus leads with source-only confidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-gank-'))
  const databasePath = join(dir, 'boss-watch.sqlite3')
  const calls: Array<{ url: string; authorization: string | null }> = []
  const store = new SqliteJobLeadStore(databasePath)
  const adapter = new GankInterviewCampusAdapter({
    token: 'fixture-token',
    baseUrl: 'https://gank.example.invalid/api/v1',
    now: () => new Date('2026-08-17T08:00:00.000Z'),
    fetch: async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
      return new Response(JSON.stringify({
        data: [{
          id: 'gank-campus-001',
          companyName: '虚构科技',
          positionText: 'Agent 平台工程师',
          locationText: '北京,远程',
          target: '2027届',
          recruitmentType: '秋招',
          deadlineText: '招满为止',
          announcementUrl: 'https://example.invalid/announcement/1',
          applyUrl: 'https://example.invalid/apply/1',
          sourceUpdatedAt: '2026-08-16T00:00:00.000Z',
        }],
        pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    store,
  })

  try {
    const leads = await adapter.search({ keyword: 'Agent', page: 1, limit: 20 })
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.url ?? '', /[?&]keyword=Agent/u)
    assert.match(calls[0]?.url ?? '', /[?&]page=1/u)
    assert.match(calls[0]?.url ?? '', /[?&]pageSize=20/u)
    assert.doesNotMatch(calls[0]?.url ?? '', /[?&]limit=/u)
    assert.equal(calls[0]?.authorization, 'Bearer fixture-token')
    assert.deepEqual(leads.map(({ leadId, sourceKind, sourceRecordId, company, role, confidence }) => ({
      leadId, sourceKind, sourceRecordId, company, role, confidence,
    })), [{
      leadId: leads[0]?.leadId,
      sourceKind: 'gankinterview_campus',
      sourceRecordId: 'gank-campus-001',
      company: '虚构科技',
      role: 'Agent 平台工程师',
      confidence: 'source_only',
    }])
    assert.match(leads[0]?.contentHash ?? '', /^[a-f0-9]{64}$/u)
    assert.deepEqual(await store.list({ limit: 20 }), leads)

    const refreshed = await adapter.search({ keyword: 'Agent', page: 1, limit: 20 })
    assert.equal(refreshed.length, 1)
    assert.deepEqual(await store.list({ limit: 20 }), refreshed)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('returns bounded source errors without fabricating leads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-gank-error-'))
  const databasePath = join(dir, 'boss-watch.sqlite3')
  const store = new SqliteJobLeadStore(databasePath)
  const adapter = new GankInterviewCampusAdapter({
    token: 'fixture-token',
    baseUrl: 'https://gank.example.invalid/api/v1',
    fetch: async () => new Response('rate limited', { status: 429 }),
    store,
  })

  try {
    await assert.rejects(() => adapter.search({ keyword: 'Agent' }), /gankinterview_rate_limited/u)
    assert.deepEqual(await store.list({ limit: 20 }), [])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('keeps append-only source observations across unchanged refreshes, changes, and reverts', async () => {
  const store = new SqliteJobLeadStore(':memory:')
  const original: JobLead = {
    leadId: 'lead:gankinterview_campus:observation-1',
    sourceKind: 'gankinterview_campus',
    sourceRecordId: 'observation-1',
    company: '虚构快照公司',
    role: '后端工程师',
    channelUrl: 'https://careers.example.invalid/jobs/observation-1',
    fetchedAt: '2026-08-17T08:00:00.000Z',
    rawRef: 'gankinterview://campus/observation-1',
    contentHash: '1'.repeat(64),
    confidence: 'source_only',
  }

  try {
    store.upsert([original])
    store.upsert([original])
    store.upsert([{ ...original, fetchedAt: '2026-08-17T08:05:00.000Z' }])
    store.confirmCandidateUrl({ leadId: original.leadId, expectedContentHash: original.contentHash })
    store.confirmJd({ leadId: original.leadId, expectedContentHash: original.contentHash })

    const changed: JobLead = {
      ...original,
      role: '平台工程师',
      fetchedAt: '2026-08-17T08:10:00.000Z',
      contentHash: '2'.repeat(64),
    }
    store.upsert([changed])
    store.upsert([{
      ...original,
      fetchedAt: '2026-08-17T08:15:00.000Z',
    }])

    const observations = store.listObservations({ includeUnchanged: true, limit: 10 })
    assert.equal(observations.length, 4)
    assert.deepEqual(observations.map((observation) => ({
      observedAt: observation.observedAt,
      changeKind: observation.changeKind,
      contentHash: observation.contentHash,
      previousContentHash: observation.previousContentHash,
      previousConfidence: observation.previousConfidence,
      verificationInvalidated: observation.verificationInvalidated,
      isCurrent: observation.isCurrent,
    })), [
      {
        observedAt: '2026-08-17T08:15:00.000Z',
        changeKind: 'changed',
        contentHash: '1'.repeat(64),
        previousContentHash: '2'.repeat(64),
        previousConfidence: 'source_only',
        verificationInvalidated: false,
        isCurrent: true,
      },
      {
        observedAt: '2026-08-17T08:10:00.000Z',
        changeKind: 'changed',
        contentHash: '2'.repeat(64),
        previousContentHash: '1'.repeat(64),
        previousConfidence: 'human_confirmed',
        verificationInvalidated: true,
        isCurrent: false,
      },
      {
        observedAt: '2026-08-17T08:05:00.000Z',
        changeKind: 'unchanged',
        contentHash: '1'.repeat(64),
        previousContentHash: '1'.repeat(64),
        previousConfidence: 'source_only',
        verificationInvalidated: false,
        isCurrent: false,
      },
      {
        observedAt: '2026-08-17T08:00:00.000Z',
        changeKind: 'new',
        contentHash: '1'.repeat(64),
        previousContentHash: undefined,
        previousConfidence: undefined,
        verificationInvalidated: false,
        isCurrent: false,
      },
    ])
    assert.equal(store.listObservations({ limit: 10 }).length, 3)
    assert.equal(store.listObservations({ since: '2026-08-17T08:10:00.000Z', limit: 10 }).length, 2)
  } finally {
    store.close()
  }
})

test('promotes lead verification monotonically and invalidates it when source content changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-lead-verification-'))
  const databasePath = join(dir, 'boss-watch.sqlite3')
  const store = new SqliteJobLeadStore(databasePath)
  const lead: JobLead = {
    leadId: 'lead:gankinterview_campus:verification-1',
    sourceKind: 'gankinterview_campus',
    sourceRecordId: 'verification-1',
    company: '虚构核验公司',
    role: 'Agent 工程师',
    channelUrl: 'https://careers.example.invalid/jobs/verification-1#apply',
    fetchedAt: '2026-08-17T08:00:00.000Z',
    rawRef: 'gankinterview://campus/verification-1',
    contentHash: 'a'.repeat(64),
    confidence: 'source_only',
  }
  store.upsert([lead])

  try {
    assert.throws(
      () => store.confirmJd({
        leadId: lead.leadId,
        expectedContentHash: lead.contentHash,
        confirmedAt: '2026-08-17T08:05:00.000Z',
      }),
      /lead_url_not_verified/u,
    )

    const urlConfirmation = store.confirmCandidateUrl({
      leadId: lead.leadId,
      expectedContentHash: lead.contentHash,
      confirmedAt: '2026-08-17T08:06:00.000Z',
    })
    assert.equal(urlConfirmation.lead.confidence, 'url_verified')
    assert.equal(urlConfirmation.lead.officialApplyUrl, 'https://careers.example.invalid/jobs/verification-1')
    assert.deepEqual(urlConfirmation.verification, {
      verificationId: urlConfirmation.verification.verificationId,
      leadId: lead.leadId,
      contentHash: lead.contentHash,
      kind: 'candidate_url_confirmed',
      officialApplyUrl: 'https://careers.example.invalid/jobs/verification-1',
      confirmedAt: '2026-08-17T08:06:00.000Z',
    })

    const repeated = store.confirmCandidateUrl({
      leadId: lead.leadId,
      expectedContentHash: lead.contentHash,
      confirmedAt: '2026-08-17T08:07:00.000Z',
    })
    assert.deepEqual(repeated, urlConfirmation)

    const jdConfirmation = store.confirmJd({
      leadId: lead.leadId,
      expectedContentHash: lead.contentHash,
      confirmedAt: '2026-08-17T08:08:00.000Z',
    })
    assert.equal(jdConfirmation.lead.confidence, 'human_confirmed')
    assert.equal(jdConfirmation.verification.kind, 'jd_human_confirmed')

    store.upsert([{ ...lead, fetchedAt: '2026-08-17T09:00:00.000Z' }])
    assert.equal(store.get(lead.leadId)?.confidence, 'human_confirmed')
    assert.equal(store.get(lead.leadId)?.officialApplyUrl, 'https://careers.example.invalid/jobs/verification-1')

    store.upsert([{
      ...lead,
      role: 'Agent 平台工程师',
      fetchedAt: '2026-08-17T10:00:00.000Z',
      contentHash: 'b'.repeat(64),
    }])
    assert.equal(store.get(lead.leadId)?.confidence, 'source_only')
    assert.equal(store.get(lead.leadId)?.officialApplyUrl, undefined)
    assert.throws(
      () => store.confirmCandidateUrl({
        leadId: lead.leadId,
        expectedContentHash: lead.contentHash,
      }),
      /lead_content_changed/u,
    )
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects non-HTTPS candidate links during lead verification', async () => {
  const store = new SqliteJobLeadStore(':memory:')
  const lead: JobLead = {
    leadId: 'lead:gankinterview_campus:unsafe-url',
    sourceKind: 'gankinterview_campus',
    sourceRecordId: 'unsafe-url',
    company: '虚构链接公司',
    role: '测试工程师',
    channelUrl: 'http://careers.example.invalid/jobs/unsafe-url',
    fetchedAt: '2026-08-17T08:00:00.000Z',
    rawRef: 'gankinterview://campus/unsafe-url',
    contentHash: 'c'.repeat(64),
    confidence: 'source_only',
  }
  store.upsert([lead])

  try {
    assert.throws(
      () => store.confirmCandidateUrl({ leadId: lead.leadId, expectedContentHash: lead.contentHash }),
      /lead_candidate_url_not_https/u,
    )
  } finally {
    store.close()
  }
})

test('exposes explicit local URL and JD confirmation tools without accepting an arbitrary URL', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const leadStore = new SqliteJobLeadStore(':memory:')
  const lead: JobLead = {
    leadId: 'lead:gankinterview_campus:tool-verification',
    sourceKind: 'gankinterview_campus',
    sourceRecordId: 'tool-verification',
    company: '虚构工具公司',
    role: '全栈工程师',
    channelUrl: 'https://jobs.example.invalid/tool-verification',
    fetchedAt: '2026-08-17T08:00:00.000Z',
    rawRef: 'gankinterview://campus/tool-verification',
    contentHash: 'd'.repeat(64),
    confidence: 'source_only',
  }
  leadStore.upsert([lead])
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const dispose = registerBossWatchTools(context, source, undefined, undefined, leadStore)

  try {
    const execute = (name: string, args: Record<string, unknown>, suffix: string) => context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`lead-verification-${suffix}`),
      name,
      arguments: args,
    })
    const premature = await execute('boss_watch_lead_jd_confirm', {
      leadId: lead.leadId,
      contentHash: lead.contentHash,
    }, 'premature')
    const prematureText = premature.content[0]
    if (prematureText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(prematureText.text), { status: 'conflict', message: 'lead_url_not_verified' })

    const arbitraryUrl = await execute('boss_watch_lead_url_confirm', {
      leadId: lead.leadId,
      contentHash: lead.contentHash,
      officialApplyUrl: 'https://attacker.example.invalid/jobs/other',
    }, 'arbitrary-url')
    const arbitraryUrlText = arbitraryUrl.content[0]
    if (arbitraryUrlText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(arbitraryUrlText.text), {
      status: 'invalid_request',
      message: 'unexpected_lead_confirmation_parameter',
    })

    const urlResult = await execute('boss_watch_lead_url_confirm', {
      leadId: lead.leadId,
      contentHash: lead.contentHash,
    }, 'url')
    const urlText = urlResult.content[0]
    if (urlText?.type !== 'text') throw new Error('expected_text_tool_result')
    const urlConfirmation = JSON.parse(urlText.text) as { status: string; lead: JobLead }
    assert.equal(urlConfirmation.status, 'ok')
    assert.equal(urlConfirmation.lead.confidence, 'url_verified')
    assert.equal(urlConfirmation.lead.officialApplyUrl, lead.channelUrl)

    const arbitraryJdUrl = await execute('boss_watch_lead_jd_confirm', {
      leadId: lead.leadId,
      contentHash: lead.contentHash,
      pageUrl: 'https://attacker.example.invalid/jobs/other',
    }, 'arbitrary-jd-url')
    const arbitraryJdUrlText = arbitraryJdUrl.content[0]
    if (arbitraryJdUrlText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(arbitraryJdUrlText.text), {
      status: 'invalid_request',
      message: 'unexpected_lead_confirmation_parameter',
    })

    const jdResult = await execute('boss_watch_lead_jd_confirm', {
      leadId: lead.leadId,
      contentHash: lead.contentHash,
    }, 'jd')
    const jdText = jdResult.content[0]
    if (jdText?.type !== 'text') throw new Error('expected_text_tool_result')
    const jdConfirmation = JSON.parse(jdText.text) as { status: string; lead: JobLead }
    assert.equal(jdConfirmation.status, 'ok')
    assert.equal(jdConfirmation.lead.confidence, 'human_confirmed')

    const observationsResult = await execute('boss_watch_lead_observation_list', {
      includeUnchanged: true,
      limit: 10,
    }, 'observations')
    const observationsText = observationsResult.content[0]
    if (observationsText?.type !== 'text') throw new Error('expected_text_tool_result')
    const observations = JSON.parse(observationsText.text) as {
      status: string
      count: number
      newCount: number
      changedCount: number
      unchangedCount: number
      observations: Array<{ leadId: string; changeKind: string }>
    }
    assert.equal(observations.status, 'ok')
    assert.equal(observations.count, 1)
    assert.equal(observations.newCount, 1)
    assert.equal(observations.changedCount, 0)
    assert.equal(observations.unchangedCount, 0)
    assert.deepEqual(observations.observations.map(({ leadId, changeKind }) => ({ leadId, changeKind })), [{
      leadId: lead.leadId,
      changeKind: 'new',
    }])
  } finally {
    dispose()
    await context.fiber.dispose()
    leadStore.close()
  }
})

test('exposes lead search, local lead list, and lead get as separate DSH tools', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const lead = {
    leadId: 'lead:gankinterview_campus:fixture-1',
    sourceKind: 'gankinterview_campus' as const,
    sourceRecordId: 'fixture-1',
    company: '虚构公司',
    role: 'Agent 工程师',
    city: '北京',
    fetchedAt: '2026-08-17T08:00:00.000Z',
    rawRef: 'gankinterview://campus/fixture-1',
    contentHash: 'c'.repeat(64),
    confidence: 'source_only' as const,
  }
  let query: unknown
  const leadSource = {
    async search(input: unknown) {
      query = input
      return [lead]
    },
  }
  const leadStore = {
    upsert() {},
    list() { return [lead] },
    get(leadId: string) { return leadId === lead.leadId ? lead : undefined },
    close() {},
  }
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const dispose = registerBossWatchTools(context, source, undefined, leadSource, leadStore)

  try {
    const execute = (name: string, args: Record<string, unknown>, suffix: string) => context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`lead-${suffix}`),
      name,
      arguments: args,
    })
    const searched = await execute('boss_watch_lead_search', { keyword: 'Agent', limit: 10 }, 'search')
    const listed = await execute('boss_watch_lead_list', {}, 'list')
    const fetched = await execute('boss_watch_lead_get', { leadId: lead.leadId }, 'get')
    assert.equal(searched.isError, false)
    assert.equal(listed.isError, false)
    assert.equal(fetched.isError, false)
    const searchText = searched.content[0]
    const listText = listed.content[0]
    const getText = fetched.content[0]
    if (searchText?.type !== 'text' || listText?.type !== 'text' || getText?.type !== 'text') throw new Error('expected_text_tool_result')
    assert.deepEqual(JSON.parse(searchText.text), { status: 'ok', leads: [lead], count: 1, persistedLocally: true })
    assert.deepEqual(JSON.parse(listText.text), { status: 'ok', leads: [lead], count: 1 })
    assert.deepEqual(JSON.parse(getText.text), { status: 'ok', lead })
    assert.deepEqual(query, { limit: 10, keyword: 'Agent' })
  } finally {
    dispose()
    await context.fiber.dispose()
  }
})
