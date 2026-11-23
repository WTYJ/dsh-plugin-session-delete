import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

class FakeElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase()
    this._doc = doc
    this.className = ''
    this.id = ''
    this.textContent = ''
    this.type = ''
    this.disabled = false
    this.style = {}
    this.attributes = new Map()
    this.children = []
    this.parentNode = null
    this.listeners = new Map()
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.get(name)
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this
      this.children.push(node)
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this.append(...nodes)
  }

  remove() {
    if (!this.parentNode) return
    const idx = this.parentNode.children.indexOf(this)
    if (idx !== -1) this.parentNode.children.splice(idx, 1)
    this.parentNode = null
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  async dispatch(type, event = {}) {
    const list = this.listeners.get(type) ?? []
    for (const fn of [...list]) {
      await fn({ target: this, preventDefault() {}, ...event })
    }
  }

  focus() {
    this._doc.activeElement = this
  }

  querySelectorAll(selector) {
    const tag = selector.toUpperCase()
    const matches = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName === tag) matches.push(child)
        walk(child)
      }
    }
    walk(this)
    return matches
  }
}

function createFakeDom() {
  const docListeners = new Map()
  const doc = {
    activeElement: null,
    head: null,
    body: null,
    createElement(tag) {
      return new FakeElement(tag, doc)
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, [])
      docListeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type)
      if (!list) return
      const idx = list.indexOf(fn)
      if (idx !== -1) list.splice(idx, 1)
    },
    dispatchKeyDown(event) {
      const list = docListeners.get('keydown') ?? []
      for (const fn of [...list]) {
        fn({ preventDefault() {}, ...event })
      }
    },
    get keydownListenerCount() {
      return (docListeners.get('keydown') ?? []).length
    },
  }
  doc.head = new FakeElement('head', doc)
  doc.body = new FakeElement('body', doc)
  return doc
}

async function loadClient({ fetchImpl, localeRef = { current: 'zh-CN' } }) {
  const source = await readFile(clientPath, 'utf8')
  const document = createFakeDom()
  let registered = null
  const disposers = []

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
  }

  let exportedModule = null
  const sandbox = {
    console: { info() {}, error() {} },
    document,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          exportedModule = factory((id) => {
            if (id === 'react') return React
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
    },
  }

  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })

  const ctx = {
    get(service) {
      if (service === 'locale') return { getLocale: () => localeRef.current }
      return undefined
    },
    sessions: { refreshCount: 0, refresh() { this.refreshCount += 1 } },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject(_name, fn) {
        return fn()
      },
      register(meta, Component) {
        registered = { meta, Component }
        return () => {}
      },
    },
  }

  exportedModule.apply(ctx)

  function openMenuDialog(sessionId = 'sess-1', displayTitle = 'Demo') {
    const injected = registered.meta.inject()
    const el = registered.Component({
      sessionId,
      displayTitle,
      useMenuOpenState: () => [true, () => {}],
      ...injected,
    })
    el.props.onClick()
    const overlay = document.body.children[document.body.children.length - 1]
    const modal = overlay.children[0]
    const [title, body, error, footer] = modal.children
    const [cancel, confirm] = footer.children
    return { el, overlay, modal, title, body, error, footer, cancel, confirm }
  }

  return {
    document,
    ctx,
    openMenuDialog,
    disposeAll() {
      for (const d of disposers) d()
    },
  }
}

describe('client plugin', () => {
  it('focuses cancel by default, sets aria-describedby & scroll lock, blocks dismiss while busy, and auto-closes into a toast', async () => {
    const requests = []
    let finishFetch
    const fetchImpl = (url, init) => {
      requests.push({ url, init })
      return new Promise((resolveFetch) => {
        finishFetch = () =>
          resolveFetch({
            ok: true,
            json: async () => ({ ok: true, freedBytes: 2048, warnings: ['prts-store'] }),
          })
      })
    }

    const { document, ctx, openMenuDialog, disposeAll } = await loadClient({ fetchImpl })
    document.body.style.overflow = 'auto'
    const { overlay, modal, body, cancel, confirm } = openMenuDialog('sess-42', 'Test Session')

    // Accessibility attributes & scroll lock
    assert.equal(modal.getAttribute('aria-describedby'), 'dsd-body')
    assert.equal(body.id, 'dsd-body')
    assert.equal(document.body.style.overflow, 'hidden')

    // Default focus is the safe Cancel button
    assert.equal(document.activeElement, cancel)

    // Start delete
    const clickPromise = confirm.dispatch('click')
    assert.equal(confirm.disabled, true)
    assert.equal(cancel.disabled, true)

    // While busy, Escape and backdrop pointerdown must not close the modal
    document.dispatchKeyDown({ key: 'Escape' })
    await overlay.dispatch('pointerdown', { target: overlay })
    assert.equal(document.body.children.includes(overlay), true)

    // Complete request
    finishFetch()
    await clickPromise

    // Request included CSRF protection header and JSON content type
    assert.equal(requests.length, 1)
    assert.equal(requests[0].init.headers['content-type'], 'application/json')
    assert.equal(requests[0].init.headers['x-dsh-plugin'], 'session-delete')
    assert.equal(ctx.sessions.refreshCount, 1)

    // Modal auto-closed, scroll restored, and toast shown with freed size & warning suffix
    assert.equal(document.body.children.includes(overlay), false)
    assert.equal(document.body.style.overflow, 'auto')
    assert.equal(document.keydownListenerCount, 0)

    const toast = document.body.children.find((el) => el.className === 'dsd-toast')
    assert.ok(toast)
    assert.equal(toast.getAttribute('role'), 'status')
    assert.match(toast.textContent, /2\.00 KB/)
    assert.match(toast.textContent, /部分衍生缓存清理失败/)

    // Clicking toast dismisses it immediately
    await toast.dispatch('click')
    assert.equal(document.body.children.includes(toast), false)
    disposeAll()
  })

  it('maps network and in-progress errors to localized messages', async () => {
    let mode = 'network'
    const fetchImpl = async () => {
      if (mode === 'network') throw new TypeError('Failed to fetch')
      return { ok: false, json: async () => ({ ok: false, code: 'in-progress' }) }
    }

    const { openMenuDialog } = await loadClient({ fetchImpl, localeRef: { current: 'zh-CN' } })
    const { error, confirm } = openMenuDialog('sess-net', 'Net Test')

    await confirm.dispatch('click')
    assert.equal(error.textContent, '请求失败：无法连接到 DSH 服务。')

    mode = 'in-progress'
    await confirm.dispatch('click')
    assert.equal(error.textContent, '该会话正在删除中，请稍候。')
  })

  it('updates language dynamically and cleans up open dialogs on plugin dispose', async () => {
    const localeRef = { current: 'zh-CN' }
    const { document, openMenuDialog, disposeAll } = await loadClient({
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
      localeRef,
    })

    const first = openMenuDialog('sess-1', 'S1')
    assert.equal(first.title.textContent, '删除会话')

    // Switch locale to English at runtime and open again (should also replace previous dialog)
    localeRef.current = 'en-US'
    const second = openMenuDialog('sess-2', 'S2')
    assert.equal(second.title.textContent, 'Delete session')
    assert.equal(document.body.children.length, 1)

    // Disposing the plugin closes the open dialog and removes listeners
    disposeAll()
    assert.equal(document.body.children.length, 0)
    assert.equal(document.head.children.length, 0)
    assert.equal(document.keydownListenerCount, 0)
  })
})
