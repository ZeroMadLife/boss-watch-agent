import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalBossJobSearchService } from '../src/boss-job-search.ts'
import type { BossWatchBrowserController } from '../src/domain.ts'

test('previews a bounded BOSS search and consumes the token only after confirmation', async () => {
  let now = new Date('2026-08-19T00:00:00.000Z')
  const calls: unknown[] = []
  const browser = {
    async searchJobs(input) {
      calls.push(input)
      return { status: 'ok' as const, plan: { ...input, maxPages: input.maxPages ?? 1, maxJobs: input.maxJobs ?? 5 }, pagesVisited: 1, items: [] }
    },
  } as unknown as BossWatchBrowserController
  const service = new LocalBossJobSearchService({
    browser,
    now: () => now,
    tokenFactory: () => 'search-preview-fixture',
  })

  const preview = service.preview({ keyword: 'Agent', city: '上海', maxPages: 2, maxJobs: 5 })
  assert.deepEqual(preview.plan, { keyword: 'Agent', city: '上海', maxPages: 2, maxJobs: 5 })
  await assert.rejects(() => service.run(preview.previewToken, false), /confirmation_required/)
  await service.run(preview.previewToken, true)
  assert.deepEqual(calls, [{ keyword: 'Agent', city: '上海', maxPages: 2, maxJobs: 5 }])
  await assert.rejects(() => service.run(preview.previewToken, true), /search_preview_expired/)

  const expired = service.preview({ keyword: 'Agent', city: '上海' })
  now = new Date('2026-08-19T00:11:00.000Z')
  await assert.rejects(() => service.run(expired.previewToken, true), /search_preview_expired/)
})

test('rejects unsupported cities before touching the browser', () => {
  const browser = { searchJobs: async () => { throw new Error('must_not_call') } } as unknown as BossWatchBrowserController
  const service = new LocalBossJobSearchService({ browser })
  assert.throws(() => service.preview({ keyword: 'Agent', city: '火星' }), /unsupported_boss_search_city/)
})
