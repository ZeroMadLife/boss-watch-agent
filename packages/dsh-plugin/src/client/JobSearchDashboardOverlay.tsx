import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseOutline16, IconLinkOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { DASHBOARD_TOGGLE_EVENT, DASHBOARD_TRIGGER_ID } from './JobSearchDashboardButton.tsx'
import { DASHBOARD_DRAFT_EVENT, isDashboardDraftRequest } from './dashboard-client.ts'
import { NS } from './locales.ts'
import css from './JobSearchDashboardOverlay.module.css'

export type JobSearchDashboardOverlayProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS>

/** Mount the full workbench over the DSH shell while keeping the conversation alive underneath. */
export function JobSearchDashboardOverlay({ t }: JobSearchDashboardOverlayProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [frameLoading, setFrameLoading] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const wasOpenRef = useRef(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const toggle = (): void => { setOpen(value => !value) }
    const close = (): void => { setOpen(false) }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!open) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])')
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener(DASHBOARD_TOGGLE_EVENT, toggle)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener(DASHBOARD_TOGGLE_EVENT, toggle)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (
        !open
        || event.origin !== window.location.origin
        || event.source !== frameRef.current?.contentWindow
        || !isDashboardDraftRequest(event.data)
      ) return
      window.dispatchEvent(new CustomEvent(DASHBOARD_DRAFT_EVENT, { detail: event.data }))
      setOpen(false)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open])

  useEffect(() => {
    if (!open || frameLoading) return
    const frameWindow = frameRef.current?.contentWindow
    if (frameWindow === undefined || frameWindow === null) return
    const onFrameKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    frameWindow.addEventListener('keydown', onFrameKeyDown)
    return () => frameWindow.removeEventListener('keydown', onFrameKeyDown)
  }, [frameLoading, open])

  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setFrameLoading(true)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      closeButtonRef.current?.focus({ preventScroll: true })
      return
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false
      ;(returnFocusRef.current ?? document.getElementById(DASHBOARD_TRIGGER_ID))?.focus({ preventScroll: true })
    }
  }, [open])

  if (!open) return null
  return (
    <section ref={dialogRef} className={css.overlay} role="dialog" aria-modal="true" aria-labelledby="boss-watch-dashboard-title" aria-describedby="boss-watch-dashboard-caption">
      <div className={css.topbar}>
        <div className={css.titleGroup}>
          <span className={css.mark}>BW</span>
          <span className={css.title} id="boss-watch-dashboard-title">{t('dashboard.title')}</span>
          <span className={css.caption} id="boss-watch-dashboard-caption">{t('dashboard.integratedCaption')}</span>
        </div>
        <div className={css.actions}>
          <a className={css.externalLink} href="/boss-watch/" target="_blank" rel="noopener noreferrer">
            <IconLinkOutline16 size={14} />
            {t('dashboard.openStandalone')}
          </a>
          <button ref={closeButtonRef} type="button" className={css.close} aria-label={t('dashboard.close')} onClick={() => setOpen(false)}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>
      </div>
      <div className={css.frameShell} aria-busy={frameLoading}>
        {frameLoading ? <div className={css.loading} role="status">{t('dashboard.loading')}</div> : null}
        <iframe
          ref={frameRef}
          className={css.frame}
          src="/boss-watch/?embedded=1"
          title={t('dashboard.title')}
          onLoad={() => setFrameLoading(false)}
        />
      </div>
    </section>
  )
}
