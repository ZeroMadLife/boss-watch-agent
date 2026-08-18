import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ResumeImportButton } from './ResumeImportButton.tsx'
import { ProgressSignalImportButton } from './ProgressSignalImportButton.tsx'
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
}

export { ResumeUploadClient } from './resume-upload-client.ts'
export type * from './resume-upload-client.ts'
export { ProgressSignalUploadClient } from './progress-signal-upload-client.ts'
export type * from './progress-signal-upload-client.ts'
