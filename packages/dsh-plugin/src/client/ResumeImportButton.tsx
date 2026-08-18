import { useRef, useState, type ChangeEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconPlusOutline16, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { buildResumeImportDraft, ResumeUploadClient } from './resume-upload-client.ts'
import { NS } from './locales.ts'
import css from './ResumeImportButton.module.css'

export type ResumeImportButtonProps =
  PropsRuntime<'conversation.input.left'> & PropsLocale<typeof NS>

const ACCEPT = '.pdf,.docx,.md,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain'

/** One-row DSH composer control that stages a local resume for tool preview. */
export function ResumeImportButton({ input, inputActions, t }: ResumeImportButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null)
  const toastSeq = useRef(0)
  const client = useRef(new ResumeUploadClient()).current

  const showToast = (text: string): void => {
    toastSeq.current += 1
    setToast({ text, seq: toastSeq.current })
  }

  const onChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const picker = event.currentTarget
    const file = picker.files?.[0]
    if (file === undefined || busy) return
    setBusy(true)
    try {
      const result = await client.upload(file)
      inputActions.setDraft(buildResumeImportDraft(input.draft, result))
      showToast(t('status.staged'))
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : 'unknown_error'
      showToast(t('error.upload', { code }))
    } finally {
      picker.value = ''
      setBusy(false)
    }
  }

  const disabled = busy || input.phase !== 'plain'

  return (
    <>
      <Tooltip label={busy ? t('action.importing') : t('action.import')} side="bottom" delayMs={500}>
        <Button
          className={css.button}
          variant="toolbar"
          size="sm"
          icon={<IconPlusOutline16 size={16} />}
          aria-label={busy ? t('action.importing') : t('action.import')}
          aria-busy={busy}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        />
      </Tooltip>
      <input
        ref={inputRef}
        className={css.fileInput}
        type="file"
        accept={ACCEPT}
        onChange={(event) => { void onChange(event) }}
        tabIndex={-1}
        aria-hidden="true"
      />
      {toast !== null
        ? <Toast key={toast.seq} text={toast.text} onDone={() => setToast(null)} />
        : null}
    </>
  )
}
