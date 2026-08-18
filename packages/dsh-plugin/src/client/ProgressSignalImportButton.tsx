import { useRef, useState, type ChangeEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconPaperclipOutline16, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { buildProgressSignalImportDraft, ProgressSignalUploadClient } from './progress-signal-upload-client.ts'
import { NS } from './locales.ts'
import css from './ResumeImportButton.module.css'

export type ProgressSignalImportButtonProps =
  PropsRuntime<'conversation.input.left'> & PropsLocale<typeof NS>

const ACCEPT = '.eml,.txt,message/rfc822,text/plain'

/** Composer control for staging an exported recruiting email or text notice. */
export function ProgressSignalImportButton({ input, inputActions, t }: ProgressSignalImportButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null)
  const toastSeq = useRef(0)
  const client = useRef(new ProgressSignalUploadClient()).current

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
      inputActions.setDraft(buildProgressSignalImportDraft(input.draft, result))
      showToast(t('signal.status.staged'))
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : 'unknown_error'
      showToast(t('signal.error.upload', { code }))
    } finally {
      picker.value = ''
      setBusy(false)
    }
  }

  const disabled = busy || input.phase !== 'plain'
  return (
    <>
      <Tooltip label={busy ? t('signal.action.importing') : t('signal.action.import')} side="bottom" delayMs={500}>
        <Button
          className={css.button}
          variant="toolbar"
          size="sm"
          icon={<IconPaperclipOutline16 size={16} />}
          aria-label={busy ? t('signal.action.importing') : t('signal.action.import')}
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
      {toast !== null ? <Toast key={toast.seq} text={toast.text} onDone={() => setToast(null)} /> : null}
    </>
  )
}
