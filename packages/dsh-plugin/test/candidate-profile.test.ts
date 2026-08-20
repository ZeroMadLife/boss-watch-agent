import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalCandidateProfileService, SqliteCandidateProfileStore } from '../src/candidate-profile.ts'
import type { BossWatchDataSource } from '../src/domain.ts'
import { registerBossWatchTools } from '../src/tools.ts'

test('previews and persists reusable candidate preferences without returning their values', () => {
  const store = new SqliteCandidateProfileStore(':memory:')
  const service = new LocalCandidateProfileService({
    store,
    now: () => new Date('2026-08-20T05:00:00.000Z'),
    token: () => 'candidate-profile-preview:fixture',
  })
  try {
    const preview = service.preview({
      preferredCity: '深圳',
      arrivalTime: '两周内',
      wechat: 'candidate_wechat',
      internshipDuration: '6个月',
      positionKeywords: 'AI 应用开发',
    })
    assert.equal(preview.valuesReturned, false)
    assert.deepEqual(preview.availableFields, [
      'preferredCity',
      'arrivalTime',
      'wechat',
      'internshipDuration',
      'positionKeywords',
    ])
    assert.doesNotMatch(JSON.stringify(preview), /candidate_wechat|两周内|AI 应用开发/u)
    assert.throws(() => service.apply(preview.previewToken, false), /candidate_profile_confirmation_required/u)

    const applied = service.apply(preview.previewToken, true)
    assert.equal(applied.valuesReturned, false)
    assert.equal(applied.availableFields.length, 5)
    assert.doesNotMatch(JSON.stringify(applied), /candidate_wechat|两周内|AI 应用开发/u)
    assert.deepEqual(store.get()?.values, {
      preferredCity: '深圳',
      arrivalTime: '两周内',
      wechat: 'candidate_wechat',
      internshipDuration: '6个月',
      positionKeywords: 'AI 应用开发',
    })
  } finally {
    store.close()
  }
})

test('merges a partial preference update and rejects control characters', () => {
  const store = new SqliteCandidateProfileStore(':memory:')
  const service = new LocalCandidateProfileService({ store })
  try {
    service.apply(service.preview({ preferredCity: '上海', arrivalTime: '一个月内' }).previewToken, true)
    service.apply(service.preview({ internshipDuration: '6个月以上' }).previewToken, true)
    assert.deepEqual(store.get()?.values, {
      preferredCity: '上海',
      arrivalTime: '一个月内',
      internshipDuration: '6个月以上',
    })
    assert.throws(() => service.preview({ wechat: 'bad\u0000value' }), /invalid_candidate_profile_wechat/u)
  } finally {
    store.close()
  }
})

test('exposes profile setup through session-bound preview and apply tools without echoing values', async () => {
  const store = new SqliteCandidateProfileStore(':memory:')
  const profile = new LocalCandidateProfileService({
    store,
    now: () => new Date('2026-08-20T05:00:00.000Z'),
    token: () => 'candidate-profile-preview:tool-fixture',
  })
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const register = registerBossWatchTools as unknown as (...args: unknown[]) => () => void
  const dispose = register(context, source, ...Array.from({ length: 28 }, () => undefined), profile)
  const execute = async (name: string, arguments_: Record<string, unknown>, session = 'profile-session') => {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`${name}:fixture`),
      name,
      arguments: arguments_,
      agent: { id: session } as never,
    })
    const content = result.content[0]
    if (content?.type !== 'text') throw new Error('expected_text_tool_result')
    return content.text
  }
  try {
    const previewText = await execute('boss_watch_candidate_profile_preview', {
      preferredCity: '深圳',
      arrivalTime: '两周内',
      wechat: 'candidate_wechat',
      internshipDuration: '6个月',
    })
    const preview = JSON.parse(previewText) as { status: string; preview: { previewToken: string } }
    assert.equal(preview.status, 'ok')
    assert.doesNotMatch(previewText, /candidate_wechat|两周内/u)

    assert.deepEqual(JSON.parse(await execute('boss_watch_candidate_profile_apply', {
      previewToken: preview.preview.previewToken,
      confirmed: true,
    }, 'different-session')), {
      status: 'conflict',
      message: 'candidate_profile_session_mismatch',
    })

    const appliedText = await execute('boss_watch_candidate_profile_apply', {
      previewToken: preview.preview.previewToken,
      confirmed: true,
    })
    assert.equal((JSON.parse(appliedText) as { status: string }).status, 'ok')
    assert.doesNotMatch(appliedText, /candidate_wechat|两周内/u)
    const getText = await execute('boss_watch_candidate_profile_get', {})
    assert.equal((JSON.parse(getText) as { status: string }).status, 'ok')
    assert.doesNotMatch(getText, /candidate_wechat|两周内/u)
  } finally {
    dispose()
    await context.fiber.dispose()
    store.close()
  }
})
