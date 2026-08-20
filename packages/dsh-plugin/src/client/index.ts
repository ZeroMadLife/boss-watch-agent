import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ResumeImportButton } from './ResumeImportButton.tsx'
import { ProgressSignalImportButton } from './ProgressSignalImportButton.tsx'
import { JobSearchDashboardButton } from './JobSearchDashboardButton.tsx'
import { JobSearchDashboardOverlay } from './JobSearchDashboardOverlay.tsx'
import { en, NS, zh, type ResumeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'boss-watch.resume': ResumeKey
  }
}

export const inject = ['slots', 'locale']

/** Register the PDF/DOCX resume picker beside DSH's built-in image controls. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'boss-watch-resume: dictionaries')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'boss-watch-resume-import',
    order: -10,
    locale: NS,
  }, ResumeImportButton))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'boss-watch-progress-signal-import',
    order: -9,
    locale: NS,
  }, ProgressSignalImportButton))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'boss-watch-job-search-dashboard',
    order: -20,
    locale: NS,
  }, JobSearchDashboardButton))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'boss-watch-job-search-dashboard-overlay',
    order: 20,
    locale: NS,
  }, JobSearchDashboardOverlay))
}

export { ResumeUploadClient } from './resume-upload-client.ts'
export type * from './resume-upload-client.ts'
export { ProgressSignalUploadClient } from './progress-signal-upload-client.ts'
export type * from './progress-signal-upload-client.ts'
export { BossWatchDashboardClient, buildCandidateActionDraft } from './dashboard-client.ts'
export type * from './dashboard-client.ts'
