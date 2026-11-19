/**
 * dsh-plugin-session-delete — Client (browser) half.
 *
 * Registers one entry into the sidebar's session-row menu through the official
 * slot API, so no DOM cloning or MutationObserver is involved:
 *
 *   sidebar.workspaces.session.menu.item   — the "..." menu on a session row
 *
 * The entry renders a plain `<button role="menuitem">` styled with the host's
 * `--dsw-alias-*` design tokens, matching the neighbouring menu rows. Selecting
 * it closes the menu, asks for confirmation, then calls the Host route
 * `POST /dsh-plugin-session-delete/delete` (see `index.js`).
 *
 * Why a native button instead of the host's `MenuItemButton`: a plugin must not
 * import `@deepseek-ai/dsh-client-ui-primitives` (the module is not part of the
 * stable client surface), so the markup and spacing are reproduced locally.
 *
 * React arrives from the platform module table via `require('react')`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-delete',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** Route served by this plugin's Host half. */
    const DELETE_ROUTE = '/dsh-plugin-session-delete/delete'

    /**
     * Plugin-scoped class names; kept off the host's hashed class space.
     *
     * Every color goes through a `--dsw-alias-*` token that this DSH build
     * actually defines on `body` / `body[data-ds-dark-theme]`:
     *
     *   bg-layer-1/2/3   surface ramp (light: white → light grey,
     *                    dark: #232324 → #2c2c2e → #38383a)
     *   label-primary    primary text (dark theme flips it to near-white)
     *   border-l1/l2/l3  hairline borders, inverted per theme
     *
     * A token that does not exist silently falls back to the literal, which is
     * exactly how this dialog once ended up white-on-white in dark mode
     * (`--dsw-alias-bg-elevated` is not part of the alias set). The fallbacks
     * below are therefore the LIGHT values only, and the explicit
     * `body[data-ds-dark-theme]` block repaints the surface for dark mode so a
     * renamed or missing token can never produce unreadable text again.
     */
    const CSS = `
.dsd-modal-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24))}
.dsd-modal{box-sizing:border-box;width:min(420px,calc(100vw - 32px));padding:20px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));box-shadow:0 16px 48px rgba(0,0,0,.28);font-size:13px;line-height:20px}
.dsd-modal-title{margin:0 0 8px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}
.dsd-modal-body{margin:0;color:var(--dsw-alias-label-secondary,#5a5f63);white-space:pre-wrap;word-break:break-word}
.dsd-modal-error{margin:10px 0 0;color:var(--dsw-alias-state-error-primary,#ec1313);white-space:pre-wrap;word-break:break-word;font-weight:500}
.dsd-modal-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.dsd-btn{min-width:76px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;cursor:pointer}
.dsd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dsd-btn:disabled{opacity:.55;cursor:default}
.dsd-btn-primary{border-color:transparent;background:var(--dsw-alias-state-error-primary,#ec1313);color:#fff}
.dsd-menu-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:0 8px;height:30px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-state-error-primary,#ec1313);font-size:13px;text-align:left;cursor:pointer;font-family:inherit}
.dsd-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dsd-menu-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-2px}
.dsd-menu-item svg{flex:none}
/* Dark theme: pin the surface and text to the dark ramp so the dialog can never
   inherit a light literal fallback. These values mirror the host's own
   body[data-ds-dark-theme] alias definitions. */
body[data-ds-dark-theme] .dsd-modal{background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#f9fafb);border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
body[data-ds-dark-theme] .dsd-modal-title{color:var(--dsw-alias-label-primary,#f9fafb)}
body[data-ds-dark-theme] .dsd-modal-body{color:var(--dsw-alias-label-secondary,#cfd3d6)}
body[data-ds-dark-theme] .dsd-modal-error{color:var(--dsw-static-red-100,#fee2e2)}
body[data-ds-dark-theme] .dsd-btn{color:var(--dsw-alias-label-primary,#f9fafb);border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
body[data-ds-dark-theme] .dsd-btn-primary{color:#fff;border-color:transparent}
body[data-ds-dark-theme] .dsd-menu-item{color:var(--dsw-alias-state-error-primary,#f25a5a)}
`

    /** Trash glyph drawn as a 16×16 outline path, matching the host's icon weight. */
    const TRASH_PATH = 'M2.5 4.2h11M6.3 2h3.4M4.2 4.2l.6 8.6c0 .7.6 1.2 1.2 1.2h4c.7 0 1.2-.5 1.2-1.2l.6-8.6M6.5 7v4.2M9.5 7v4.2'

    /**
     * Every string this plugin shows, in both supported languages.
     *
     * The client locale service is read at mount time; an English UI gets the
     * English column. Keys are lowercase here because the host's dictionary
     * convention is lowercase-with-English, and this plugin keeps its own
     * table rather than registering a namespace (one word of UI does not
     * justify a dictionary round-trip).
     */
    const TEXT = {
      zh: {
        deleteSession: '删除会话',
        confirmTitle: '删除会话',
        confirmBody: (title) => `将永久删除会话「${title}」的全部本地记录，包括会话日志、派生缓存与检索数据。此操作不可恢复。`,
        confirm: '删除',
        cancel: '取消',
        working: '删除中…',
        doneTitle: '已删除',
        doneBody: (title) => `会话「${title}」已删除。`,
        close: '关闭',
        errorLive: '该会话正在运行或已被打开，无法删除。请先关闭它，或重启 DSH 后再试。',
        errorMissing: '未找到该会话的本地记录，可能已被删除。',
        errorSandbox: '沙箱拒绝了删除操作。',
        errorRemove: '删除会话文件失败。',
        errorNetwork: '请求失败：无法连接到 DSH 服务。',
        errorUnknown: '删除失败。',
      },
      en: {
        deleteSession: 'Delete session',
        confirmTitle: 'Delete session',
        confirmBody: (title) => `Permanently delete every local record of “${title}”, including its session log, derived caches, and retrieval data. This cannot be undone.`,
        confirm: 'Delete',
        cancel: 'Cancel',
        working: 'Deleting…',
        doneTitle: 'Deleted',
        doneBody: (title) => `Session “${title}” was deleted.`,
        close: 'Close',
        errorLive: 'This session is running or open, so it cannot be deleted. Close it, or restart DSH and try again.',
        errorMissing: 'No local record of this session was found; it may already be deleted.',
        errorSandbox: 'The sandbox denied the deletion.',
        errorRemove: 'Failed to remove the session files.',
        errorNetwork: 'Request failed: the DSH service is unreachable.',
        errorUnknown: 'The deletion failed.',
      },
    }

    /**
     * Pick the text table for the active UI language.
     * @param {object} ctx - the client context, providing the locale service.
     * @returns {object} the chosen table.
     */
    function textFor(ctx) {
      try {
        const locale = ctx.get('locale')
        const snapshot = locale !== undefined && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined
        const id = typeof snapshot === 'string' ? snapshot : snapshot?.id ?? snapshot?.language
        if (typeof id === 'string' && id.toLowerCase().startsWith('en')) return TEXT.en
      } catch {
        /* A missing locale service simply falls back to Chinese. */
      }
      return TEXT.zh
    }

    /**
     * Map one Host failure to user-facing text.
     * @param {object} text - the active text table.
     * @param {object|undefined} payload - the decoded response body.
     * @returns {string} the message to show.
     */
    function errorText(text, payload) {
      switch (payload?.code) {
        case 'live':
          return text.errorLive
        case 'missing':
          return text.errorMissing
        case 'sandbox-denied':
          return text.errorSandbox
        case 'remove-failed':
        case 'run-error':
        case 'list-failed':
        case 'locate-failed':
        case 'no-location':
        case 'bad-path':
        case 'unexpected-path':
          return `${text.errorRemove}${payload?.detail ? `\n${String(payload.detail).slice(0, 300)}` : ''}`
        default:
          return payload?.code === undefined ? text.errorUnknown : `${text.errorUnknown} (${payload.code})`
      }
    }

    /**
     * Ask the Host to delete one session.
     * @param {string} sessionId - the session to delete.
     * @returns {Promise<{ok: boolean, payload?: object}>} the decoded outcome.
     */
    async function requestDelete(sessionId) {
      let response
      try {
        response = await fetch(DELETE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId }),
        })
      } catch {
        return { ok: false, payload: { code: 'network' } }
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      return { ok: response.ok && payload?.ok === true, payload }
    }

    /**
     * The confirmation dialog, rendered into `document.body` so it is not
     * clipped by the sidebar's scroll container. Focus is moved to the
     * destructive button and restored on close.
     * @param {object} options - dialog text, the session, and the completion hook.
     */
    function openConfirm({ text, sessionId, displayTitle, onDeleted }) {
      const previouslyFocused = document.activeElement
      const overlay = document.createElement('div')
      overlay.className = 'dsd-modal-overlay'
      overlay.setAttribute('data-plugin', 'dsh-plugin-session-delete')

      const modal = document.createElement('div')
      modal.className = 'dsd-modal'
      modal.setAttribute('role', 'dialog')
      modal.setAttribute('aria-modal', 'true')
      modal.setAttribute('aria-labelledby', 'dsd-title')

      const title = document.createElement('h2')
      title.className = 'dsd-modal-title'
      title.id = 'dsd-title'
      title.textContent = text.confirmTitle

      const body = document.createElement('p')
      body.className = 'dsd-modal-body'
      body.textContent = text.confirmBody(displayTitle)

      const error = document.createElement('p')
      error.className = 'dsd-modal-error'
      error.setAttribute('role', 'alert')

      const footer = document.createElement('div')
      footer.className = 'dsd-modal-footer'

      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'dsd-btn'
      cancel.textContent = text.cancel

      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'dsd-btn dsd-btn-primary'
      confirm.textContent = text.confirm

      footer.append(cancel, confirm)
      modal.append(title, body, error, footer)
      overlay.append(modal)

      /** Remove the dialog and restore focus. */
      function close() {
        document.removeEventListener('keydown', onKeyDown, true)
        overlay.remove()
        if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
      }

      /** Trap Escape and keep Tab inside the dialog. */
      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
          return
        }
        if (event.key !== 'Tab') return
        const focusable = [cancel, confirm].filter((button) => !button.disabled)
        if (focusable.length === 0) return
        const index = focusable.indexOf(document.activeElement)
        const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length
        event.preventDefault()
        focusable[next].focus()
      }

      cancel.addEventListener('click', close)
      overlay.addEventListener('pointerdown', (event) => {
        if (event.target === overlay) close()
      })

      confirm.addEventListener('click', async () => {
        confirm.disabled = true
        cancel.disabled = true
        confirm.textContent = text.working
        error.textContent = ''
        const outcome = await requestDelete(sessionId)
        if (outcome.ok) {
          /* Report success in place, then let the sidebar drop the row. */
          title.textContent = text.doneTitle
          body.textContent = text.doneBody(displayTitle)
          footer.replaceChildren()
          const closeButton = document.createElement('button')
          closeButton.type = 'button'
          closeButton.className = 'dsd-btn'
          closeButton.textContent = text.close
          closeButton.addEventListener('click', close)
          footer.append(closeButton)
          closeButton.focus()
          try {
            onDeleted?.()
          } catch {
            /* A failed refresh must not turn a completed delete into an error. */
          }
          return
        }
        error.textContent = errorText(text, outcome.payload)
        confirm.disabled = false
        cancel.disabled = false
        confirm.textContent = text.confirm
      })

      document.addEventListener('keydown', onKeyDown, true)
      document.body.append(overlay)
      confirm.focus()
    }

    /**
     * The session-row menu entry.
     *
     * Slot props: `sessionId` and `displayTitle` come from the row, `text` and
     * `refresh` from this entry's own `inject`, and `useMenuOpenState` from the
     * seat's standard hooks — the same way the built-in archive and fork rows
     * receive it. The setter closes the host menu before the dialog opens.
     *
     * The hook is treated as optional: if a future release stops publishing it,
     * the row still renders and works, and the host menu closes on the next
     * outside click instead.
     * @param {object} props - slot props.
     * @returns {object} the menu button.
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, text, refresh } = props
      const openState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
      const setMenuOpen = typeof openState?.[1] === 'function' ? openState[1] : () => {}

      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'dsd-menu-item',
          onClick: () => {
            setMenuOpen(false)
            openConfirm({
              text,
              sessionId,
              displayTitle: displayTitle === '' || displayTitle === undefined ? sessionId : displayTitle,
              onDeleted: refresh,
            })
          },
        },
        h(
          'svg',
          { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none' },
          h('path', {
            d: TRASH_PATH,
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
        h('span', null, text.deleteSession),
      )
    }

    /**
     * Mount the browser half.
     * @param {object} ctx - the client context.
     */
    function apply(ctx) {
      /* One stylesheet per mount; the disposer removes it. */
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-plugin-session-delete')
        style.textContent = CSS
        document.head.append(style)
        return () => style.remove()
      }, 'dsh-plugin-session-delete: stylesheet')

      /*
       * The row menu is a `list` slot, so registration is a child of the
       * owning plugin's seat. `inject` waits for the workspace UI to publish
       * the seat and drops this entry again when it goes away.
       *
       * `inject` here is the entry's own prop share: the slot framework passes
       * `hooks.menuOpenState` through to the component as `useMenuOpenState`,
       * which is how the host's own menu rows receive it.
       */
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
            ctx.slots.register(
              {
                name: 'sidebar.workspaces.session.menu.item',
                id: 'dsh-plugin-session-delete',
                order: 500,
                inject: () => ({
                  text: textFor(ctx),
                  refresh: () => {
                    try {
                      ctx.sessions?.refresh?.()
                    } catch {
                      /* A missing refresh seam only delays the row disappearing. */
                    }
                  },
                }),
              },
              DeleteSessionMenuItem,
            ),
          ),
        'dsh-plugin-session-delete: session menu entry',
      )

      console.info('[dsh-plugin-session-delete] client ready')
    }

    exports.inject = ['slots', 'sessions', 'locale']
    exports.apply = apply
    return module.exports
  },
})
