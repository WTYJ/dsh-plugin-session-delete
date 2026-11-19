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

import { readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

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
function resolveDshHome(configured) {
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

/** Refuse to wait longer than this on one directory removal. */
const REMOVE_TIMEOUT_MS = 30_000

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
 * @returns {string} the session directory, or `''` when the path is unusable.
 */
function sessionDirectory(path) {
  const directory = dirname(path)
  return directory === '' || directory === '.' ? '' : directory
}

/**
 * Quote one path for the shell command that removes it.
 *
 * Windows paths go through PowerShell's `Remove-Item -LiteralPath`, so only the
 * single quote needs doubling; POSIX paths go through `rm -rf --` with POSIX
 * single-quote escaping. Neither spelling interpolates the path into anything
 * the shell re-parses, so a session id containing quotes cannot escape the
 * command.
 * @param {string} path - absolute path to remove.
 * @returns {string} the removal command.
 */
function removalCommand(path) {
  if (path.includes('\\')) {
    return `Remove-Item -LiteralPath '${path.replaceAll("'", "''")}' -Recurse -Force -ErrorAction Stop`
  }
  return `rm -rf -- '${path.replaceAll("'", `'\\''`)}'`
}

/**
 * Read a JSON request body.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {Promise<unknown>} the parsed body, or `undefined` when absent/invalid.
 */
async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
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
 * Remove the persisted projection-cache record for one session.
 *
 * The record lives at `<storages>/session_projcache/sessions/<id>.json`; its
 * absence is the normal case for a session that never checkpointed.
 * @param {string} home - the DSH home directory.
 * @param {string} sessionId - session whose cache record should go.
 */
async function removeProjectionCache(home, sessionId) {
  const record = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  await rm(record, { force: true }).catch((error) => warn(error, 'projection-cache removal'))
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
 */
async function removePrtsStores(home, sessionId) {
  const root = join(home, 'storages')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
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
    await rm(path, { force: true }).catch((error) => warn(error, 'PRTS store removal'))
  }
}

/**
 * Delete one session's local records.
 * @param {object} deps - resolved Host services.
 * @param {string} deps.home - the DSH home directory.
 * @param {object} deps.services - the Cordis services this plugin injected.
 * @param {string} sessionId - the session to delete.
 * @returns {Promise<{status: 'deleted'|'live'|'missing'|'failed', code?: string, detail?: string}>} the outcome.
 */
async function deleteSession(deps, sessionId) {
  const { home, services } = deps
  const { sessions, sessionPersistence, workspaceRegistry, shell } = services

  /* 1) A live Session owns an open log handle; never pull its files away. */
  if (sessions.get(sessionId) !== undefined) return { status: 'live' }

  /*
   * 2) Locate the stored log; no artifact means the session never
   *    materialized. `list()` yields snapshots shaped `{ header, revision,
   *    formatStatus, sizeBytes }`, so the identity lives one level down; a
   *    bare header is also accepted because older builds returned those.
   */
  let header
  try {
    const entries = await sessionPersistence.list()
    if (Array.isArray(entries)) {
      const match = entries.find((entry) => {
        const candidate = entry?.header ?? entry
        return candidate?.id === sessionId
      })
      header = match?.header ?? match
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
   * The sandbox root is the project directory that holds the session
   * directory. Removal must never reach above it, so a session whose own
   * directory is the project directory itself is refused.
   */
  const parent = dirname(directory)
  if (parent === '' || parent === '.' || parent === directory) {
    return { status: 'failed', code: 'bad-path' }
  }
  if (!directory.endsWith(`${sep}${sessionId}`)) {
    return { status: 'failed', code: 'unexpected-path', detail: directory }
  }

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
  await removeProjectionCache(home, sessionId)
  await removePrtsStores(home, sessionId)

  /* 5) Bookkeeping. Files are already gone, so failures only affect display. */
  try {
    await workspaceRegistry.archiveSession(sessionId)
  } catch {
    /* Already archived, or the id is unknown to the registry: both are fine. */
  }
  try {
    for (const workspace of workspaceRegistry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue
      await workspace.detachSession(sessionId)
      break
    }
  } catch (error) {
    warn(error, 'workspace detach')
  }

  return { status: 'deleted' }
}

/**
 * Mount the Host half: one same-origin route, one confirmation per request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Cordis context.
 * @param {{home?: string}} [config] - optional deployment override.
 */
export function apply(ctx, config = {}) {
  const home = config.home ?? resolveDshHome()
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
          const body = await readJsonBody(request)
          const sessionId = body?.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') {
            sendJson(response, 400, { ok: false, code: 'bad-arguments' })
            return
          }
          let outcome
          try {
            outcome = await deleteSession({ home, services }, sessionId)
          } catch (error) {
            warn(error, 'delete')
            sendJson(response, 500, { ok: false, code: 'internal', detail: String(error?.message ?? error) })
            return
          }
          switch (outcome.status) {
            case 'deleted':
              sendJson(response, 200, { ok: true, sessionId })
              return
            case 'live':
              sendJson(response, 409, { ok: false, code: 'live' })
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
