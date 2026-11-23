/**
 * dsh-plugin-session-delete — Host half.
 *
 * Adds a "Delete session" capability to the DSH sidebar. The Host exposes one
 * same-origin HTTP route, `POST /dsh-plugin-session-delete/delete`, which the
 * browser half (see `lib/client.js`) calls after the user confirms.
 *
 * What one delete does, in order:
 *
 *   1. Refuse if the session is live in this process. A live Session owns an
 *      open log handle and an Agent; deleting its files underneath them would
 *      corrupt the running turn. The user can archive it instead, or restart
 *      DSH and delete afterwards.
 *   2. Locate the session's stored log through `ctx.sessionPersistence` and
 *      remove that one session directory inside the sandbox, with the
 *      session's project directory as the sandbox root. Removal is confined to
 *      `<root>/<sessionId>/`; the project directory itself is never removed
 *      here (the bootstrap may legitimately want it back for other sessions).
 *   3. Drop derived records that would otherwise resurrect a ghost row:
 *      the persisted projection cache record (`session_projcache`) and any
 *      PRTS investigation store whose `sessionId` names this session.
 *   4. Bookkeeping: archive the id and detach it from every Workspace account,
 *      so no surface can render the deleted session even if a stale frame
 *      arrives. This runs after the files are gone, so a failure here leaves a
 *      visibly-broken row rather than a silently-deleted one.
 *
 * Everything is idempotent: deleting an already-deleted session reports
 * `missing` instead of failing, and the bookkeeping steps tolerate races.
 *
 * @module dsh-plugin-session-delete
 */

import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Resolve the DeepSeek Harness home directory.
 *
 * This mirrors `@deepseek-ai/dsh-home-paths` rather than importing it. That
 * package ships inside the DSH application archive, so a plugin that imports it
 * only resolves while it happens to sit under a tree the host's loader searches.
 * A third-party install (a tarball, git checkout, or a different DSH layout) can
 * fail that resolution and take the whole plugin down, for a value this small.
 * The precedence is the documented one: an explicit config path, then
 * `$DSH_HOME`, then `~/.dsh`.
 * @param {string} [configured] - explicit override from plugin config.
 * @returns {string} the absolute harness home.
 */
export function resolveDshHome(configured) {
  const fromEnv = process.env.DSH_HOME
  const chosen = configured ?? (typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
  return resolve(expandHome(chosen))
}

/**
 * Expand a leading `~` against the OS home.
 * @param {string} path - path that may start with `~`.
 * @returns {string} the expanded path.
 */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Stable Cordis plugin name; must match the `insert` row in `cordis.patch.yml`. */
export const name = 'dsh-plugin-session-delete'

/**
 * Services this plugin needs before it can mount. `webServer` carries the
 * route, `sessionPersistence` locates stored logs, `workspaceRegistry` owns
 * archive/account bookkeeping, and `sessions` answers "is this session live?".
 */
export const inject = ['webServer', 'shell', 'sessionPersistence', 'workspaceRegistry', 'sessions']

/** HTTP route the browser half posts to. */
const DELETE_ROUTE = '/dsh-plugin-session-delete/delete'

/** Custom header required on every request to force CORS preflight on cross-origin calls. */
const PLUGIN_HEADER = 'x-dsh-plugin'
const PLUGIN_HEADER_VALUE = 'session-delete'

/** Maximum accepted request body size in bytes. */
const MAX_BODY_BYTES = 16 * 1024

/** Refuse to wait longer than this on one directory removal. */
const REMOVE_TIMEOUT_MS = 30_000

/** Control characters (including NUL, CR, LF) that must never appear in IDs or shell paths. */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

/**
 * Validate a session identifier before using it in path lookups or storage cleanup.
 * @param {unknown} sessionId - candidate session id from the HTTP body.
 * @returns {sessionId is string} true when the id is a safe single path segment.
 */
export function isValidSessionId(sessionId) {
  if (typeof sessionId !== 'string') return false
  if (sessionId.length === 0 || sessionId.length > 256) return false
  if (sessionId === '.' || sessionId === '..') return false
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) return false
  if (CONTROL_CHAR_RE.test(sessionId)) return false
  return true
}

/**
 * Report a diagnostic without failing the operation it belongs to.
 * @param {unknown} error - the failure to record.
 * @param {string} what - short description of the step that failed.
 */
function warn(error, what) {
  console.error(`[dsh-plugin-session-delete] ${what} failed:`, error)
}

/**
 * Directory holding one session's stored artifacts.
 * @param {string} path - absolute path of the session's log file.
 * @returns {string} the normalized session directory, or `''` when the path is unusable.
 */
function sessionDirectory(path) {
  if (typeof path !== 'string' || path === '' || CONTROL_CHAR_RE.test(path)) return ''
  const directory = dirname(path)
  if (directory === '' || directory === '.') return ''
  return resolve(directory)
}

/**
 * Quote one path for the shell command that removes it.
 *
 * Windows uses PowerShell's `Remove-Item -LiteralPath`, so only single quotes
 * need doubling; POSIX platforms use `rm -rf --` with POSIX single-quote
 * escaping. Platform selection uses `process.platform` rather than inspecting
 * path separators, since POSIX paths may legitimately contain backslashes.
 * @param {string} path - absolute path to remove.
 * @param {string} [platform] - target OS platform (defaults to `process.platform`).
 * @returns {string} the removal command.
 */
export function removalCommand(path, platform = process.platform) {
  if (platform === 'win32') {
    return `Remove-Item -LiteralPath '${path.replaceAll("'", "''")}' -Recurse -Force -ErrorAction Stop`
  }
  return `rm -rf -- '${path.replaceAll("'", `'\\''`)}'`
}

/**
 * Read a JSON request body with a strict size cap.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @param {number} [maxBytes] - maximum allowed byte length.
 * @returns {Promise<{ok: true, value: unknown} | {ok: false, code: 'payload-too-large'|'invalid-json'}>}
 */
async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) return { ok: false, code: 'payload-too-large' }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, code: 'invalid-json' }
  }
}

/**
 * Reject cross-site or simple-request CSRF attempts.
 *
 * Requires:
 *  - `Content-Type: application/json` (cannot be sent by `no-cors` simple requests)
 *  - `X-DSH-Plugin: session-delete` (forces CORS preflight on any cross-origin call)
 *  - `Sec-Fetch-Site` (when present) must be `same-origin` or `none`
 *  - `Origin` (when present) must match the request `Host` header
 * @param {import('node:http').IncomingMessage} request
 * @returns {{ok: true} | {ok: false, status: number, code: string}}
 */
function checkRequestSafety(request) {
  const headers = request.headers ?? {}
  const contentType = String(headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    return { ok: false, status: 415, code: 'unsupported-media-type' }
  }

  if (String(headers[PLUGIN_HEADER] ?? '') !== PLUGIN_HEADER_VALUE) {
    return { ok: false, status: 403, code: 'forbidden' }
  }

  const secFetchSite = headers['sec-fetch-site']
  if (typeof secFetchSite === 'string' && secFetchSite !== '' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { ok: false, status: 403, code: 'forbidden' }
  }

  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '') {
    const host = headers.host
    if (typeof host !== 'string' || host === '') {
      return { ok: false, status: 403, code: 'forbidden' }
    }
    try {
      const parsed = new URL(origin)
      if (parsed.host !== host) {
        return { ok: false, status: 403, code: 'forbidden' }
      }
    } catch {
      return { ok: false, status: 403, code: 'forbidden' }
    }
  }

  return { ok: true }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the response to write.
 * @param {number} status - HTTP status code.
 * @param {unknown} value - JSON-serializable body.
 */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Check whether `target` is strictly inside `root` (and not `root` itself).
 * @param {string} root - allowed parent root directory.
 * @param {string} target - candidate path.
 * @returns {boolean} true when `target` is strictly nested under `root`.
 */
export function isInsideDirectory(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Recursively measure total file bytes under a directory without following symlinks.
 * @param {string} target - directory or file path.
 * @returns {Promise<number>} total bytes, or 0 if unreadable.
 */
async function measureBytes(target) {
  let info
  try {
    info = await lstat(target)
  } catch {
    return 0
  }
  if (info.isSymbolicLink()) return 0
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const child = join(target, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isFile()) {
      try {
        total += (await lstat(child)).size
      } catch {
        /* ignore unreadable child */
      }
    } else if (entry.isDirectory()) {
      total += await measureBytes(child)
    }
  }
  return total
}

/**
 * Determine if a loaded session handle is explicitly idle (not actively running),
 * and if the host exposes a close/dispose hook, attempt to close it cleanly.
 *
 * Conservative by design: an opaque handle with no known idle signal or no
 * close method is always treated as live so we never pull files out from under
 * an active writer.
 * @param {object} sessions - the Host `sessions` service.
 * @param {string} sessionId - target session id.
 * @returns {Promise<boolean>} true if the session is not live (or was safely closed).
 */
async function ensureNotLive(sessions, sessionId) {
  const handle = sessions.get(sessionId)
  if (handle === undefined) return true

  const runningFlag =
    handle?.isRunning === true ||
    handle?.running === true ||
    handle?.busy === true ||
    (typeof handle?.isRunning === 'function' && handle.isRunning() === true)
  if (runningFlag) return false

  const status = typeof handle?.status === 'string' ? handle.status.toLowerCase() : undefined
  const explicitlyIdle =
    handle?.isRunning === false ||
    handle?.running === false ||
    handle?.busy === false ||
    (typeof handle?.isRunning === 'function' && handle.isRunning() === false) ||
    (status !== undefined && (status === 'idle' || status === 'ready' || status === 'stopped' || status === 'closed'))
  if (!explicitlyIdle) return false

  try {
    if (typeof sessions.close === 'function') {
      await sessions.close(sessionId)
    } else if (typeof sessions.dispose === 'function') {
      await sessions.dispose(sessionId)
    } else if (typeof handle?.close === 'function') {
      await handle.close()
    } else if (typeof handle?.dispose === 'function') {
      await handle.dispose()
    } else {
      return false
    }
  } catch (error) {
    warn(error, 'idle session close')
    return false
  }

  return sessions.get(sessionId) === undefined
}

/**
 * Remove the persisted projection-cache record for one session.
 *
 * The record lives at `<storages>/session_projcache/sessions/<id>.json`; its
 * absence is the normal case for a session that never checkpointed.
 * @param {string} home - the DSH home directory.
 * @param {string} sessionId - session whose cache record should go.
 * @param {string[]} warnings - collector for non-fatal cleanup warnings.
 * @returns {Promise<number>} freed bytes from this record.
 */
async function removeProjectionCache(home, sessionId, warnings) {
  const record = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  const size = await measureBytes(record)
  try {
    await rm(record, { force: true })
    return size
  } catch (error) {
    warn(error, 'projection-cache removal')
    warnings.push('projection-cache')
    return 0
  }
}

/**
 * Remove PRTS investigation stores that belong to one session.
 *
 * PRTS keeps a per-session portfolio document under `<storages>/prts_inv_*.json`
 * carrying a `tables.portfolios.state.sessionId` field. Leaving one behind
 * would keep a deleted session's evidence reachable from a stale id, so each
 * document naming this session is removed. Files are small JSON documents, so
 * scanning them is cheap; unreadable or foreign files are left alone.
 * @param {string} home - the DSH home directory.
 * @param {string} sessionId - session whose stores should go.
 * @param {string[]} warnings - collector for non-fatal cleanup warnings.
 * @returns {Promise<number>} total freed bytes from removed PRTS stores.
 */
async function removePrtsStores(home, sessionId, warnings) {
  const root = join(home, 'storages')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let freed = 0
  let hadError = false
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('prts_inv_') || !entry.name.endsWith('.json')) continue
    const path = join(root, entry.name)
    let owner
    try {
      const document = JSON.parse(await readFile(path, 'utf8'))
      owner = document?.tables?.portfolios?.state?.sessionId
    } catch {
      continue
    }
    if (owner !== sessionId) continue
    const size = await measureBytes(path)
    try {
      await rm(path, { force: true })
      freed += size
    } catch (error) {
      warn(error, 'PRTS store removal')
      hadError = true
    }
  }
  if (hadError) warnings.push('prts-store')
  return freed
}

/**
 * Delete one session's local records.
 * @param {object} deps - resolved Host services.
 * @param {string} deps.home - the DSH home directory.
 * @param {object} deps.services - the Cordis services this plugin injected.
 * @param {Set<string>} [deps.inFlight] - set of session ids currently being deleted.
 * @param {string} sessionId - the session to delete.
 * @returns {Promise<{status: 'deleted'|'live'|'in-progress'|'missing'|'failed', code?: string, detail?: string, freedBytes?: number, warnings?: string[]}>} the outcome.
 */
export async function deleteSession(deps, sessionId) {
  const { home, services, inFlight } = deps
  const { sessions, sessionPersistence, workspaceRegistry, shell } = services

  if (!isValidSessionId(sessionId)) return { status: 'failed', code: 'bad-arguments' }
  if (inFlight?.has(sessionId)) return { status: 'in-progress' }
  inFlight?.add(sessionId)

  try {
    /* 1) A live Session owns an open log handle; only proceed if absent or safely closed when idle. */
    if (!(await ensureNotLive(sessions, sessionId))) return { status: 'live' }

    /*
     * 2) Locate the stored log; no artifact means the session never
     *    materialized. `list()` yields snapshots shaped `{ header, revision,
     *    formatStatus, sizeBytes }`, so the identity lives one level down; a
     *    bare header is also accepted because older builds returned those.
     */
    let header
    let snapshotSize = 0
    try {
      const entries = await sessionPersistence.list()
      if (Array.isArray(entries)) {
        const match = entries.find((entry) => {
          const candidate = entry?.header ?? entry
          return candidate?.id === sessionId
        })
        header = match?.header ?? match
        if (typeof match?.sizeBytes === 'number' && Number.isFinite(match.sizeBytes) && match.sizeBytes > 0) {
          snapshotSize = Math.floor(match.sizeBytes)
        }
      }
    } catch (error) {
      return { status: 'failed', code: 'list-failed', detail: String(error?.message ?? error) }
    }
    if (header === undefined) return { status: 'missing' }

    let location
    try {
      location = sessionPersistence.locate(header)
    } catch (error) {
      return { status: 'failed', code: 'locate-failed', detail: String(error?.message ?? error) }
    }
    const directory = sessionDirectory(location?.path ?? '')
    if (directory === '') return { status: 'failed', code: 'no-location' }

    /*
     * Hard path guards:
     *  - target must sit strictly inside `<home>/sessions/`
     *  - target basename must equal `sessionId` and have a distinct parent
     *  - if present on disk, target must be a real directory (never a symlink)
     */
    const sessionsRoot = join(home, 'sessions')
    if (!isInsideDirectory(sessionsRoot, directory)) {
      return { status: 'failed', code: 'outside-sessions-root', detail: directory }
    }
    const parent = dirname(directory)
    if (parent === '' || parent === '.' || parent === directory) {
      return { status: 'failed', code: 'bad-path' }
    }
    if (basename(directory) !== sessionId) {
      return { status: 'failed', code: 'unexpected-path', detail: directory }
    }

    try {
      const statInfo = await lstat(directory)
      if (statInfo.isSymbolicLink()) {
        return { status: 'failed', code: 'symlink-refused', detail: directory }
      }
      if (!statInfo.isDirectory()) {
        return { status: 'failed', code: 'not-a-directory', detail: directory }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { status: 'failed', code: 'stat-failed', detail: String(error?.message ?? error) }
      }
    }

    /*
     * Re-check liveness right before deleting: a session could have been opened
     * while `sessionPersistence.list()` was awaiting I/O (TOCTOU guard).
     */
    if (!(await ensureNotLive(sessions, sessionId))) return { status: 'live' }

    const measuredDirBytes = await measureBytes(directory)

    /* 3) Remove the files first: a failure here changes no bookkeeping at all. */
    let result
    try {
      const spec = shell.resolve({
        command: removalCommand(directory),
        timeoutMs: REMOVE_TIMEOUT_MS,
        dshEnv: {},
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: parent },
      })
      result = await (await shell.execute(spec)).result()
    } catch (error) {
      return { status: 'failed', code: 'run-error', detail: String(error?.message ?? error) }
    }
    if (result?.exitCode !== 0) {
      const denied = result?.sandbox?.denied === true
      return {
        status: 'failed',
        code: denied ? 'sandbox-denied' : 'remove-failed',
        detail: String(result?.stderr ?? '').slice(0, 500),
      }
    }

    /* 4) Derived records: projection cache and per-session PRTS stores. */
    const warnings = []
    const projBytes = await removeProjectionCache(home, sessionId, warnings)
    const prtsBytes = await removePrtsStores(home, sessionId, warnings)
    const freedBytes = (measuredDirBytes > 0 ? measuredDirBytes : snapshotSize) + projBytes + prtsBytes

    /* 5) Bookkeeping. Files are already gone, so failures only affect display. */
    try {
      await workspaceRegistry.archiveSession(sessionId)
    } catch {
      /* Already archived, or the id is unknown to the registry: both are fine. */
    }
    try {
      const workspaces = workspaceRegistry.list()
      if (Array.isArray(workspaces)) {
        for (const workspace of workspaces) {
          if (!Array.isArray(workspace?.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue
          if (typeof workspace.detachSession === 'function') {
            await workspace.detachSession(sessionId)
          }
        }
      }
    } catch (error) {
      warn(error, 'workspace detach')
      warnings.push('workspace-detach')
    }

    return { status: 'deleted', freedBytes, warnings }
  } finally {
    inFlight?.delete(sessionId)
  }
}

/**
 * Mount the Host half: one same-origin route, one confirmation per request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Cordis context.
 * @param {{home?: string}} [config] - optional deployment override.
 */
export function apply(ctx, config = {}) {
  const home = resolveDshHome(config.home)
  const inFlight = new Set()
  const services = {
    sessions: ctx.sessions,
    sessionPersistence: ctx.sessionPersistence,
    workspaceRegistry: ctx.workspaceRegistry,
    shell: ctx.shell,
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DELETE_ROUTE,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            sendJson(response, 405, { ok: false, code: 'method-not-allowed' })
            return
          }
          const safety = checkRequestSafety(request)
          if (!safety.ok) {
            sendJson(response, safety.status, { ok: false, code: safety.code })
            return
          }
          const parsed = await readJsonBody(request)
          if (!parsed.ok) {
            const status = parsed.code === 'payload-too-large' ? 413 : 400
            sendJson(response, status, { ok: false, code: parsed.code })
            return
          }
          const sessionId = parsed.value?.sessionId
          if (!isValidSessionId(sessionId)) {
            sendJson(response, 400, { ok: false, code: 'bad-arguments' })
            return
          }
          let outcome
          try {
            outcome = await deleteSession({ home, services, inFlight }, sessionId)
          } catch (error) {
            warn(error, 'delete')
            sendJson(response, 500, { ok: false, code: 'internal', detail: String(error?.message ?? error) })
            return
          }
          switch (outcome.status) {
            case 'deleted':
              sendJson(response, 200, {
                ok: true,
                sessionId,
                freedBytes: outcome.freedBytes ?? 0,
                ...(outcome.warnings && outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
              })
              return
            case 'live':
              sendJson(response, 409, { ok: false, code: 'live' })
              return
            case 'in-progress':
              sendJson(response, 409, { ok: false, code: 'in-progress' })
              return
            case 'missing':
              sendJson(response, 404, { ok: false, code: 'missing' })
              return
            default:
              sendJson(response, 500, { ok: false, code: outcome.code ?? 'unknown', detail: outcome.detail ?? '' })
          }
        },
      }),
    'dsh-plugin-session-delete: delete route',
  )

  console.error(`[dsh-plugin-session-delete] host ready: POST ${DELETE_ROUTE}`)
}

export default { name, inject, apply }
