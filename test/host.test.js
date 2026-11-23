import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'

import { apply, deleteSession, isInsideDirectory, isValidSessionId, removalCommand, resolveDshHome } from '../index.js'

function createMockResponse() {
  let statusCode = 0
  let headers = {}
  let rawBody = ''
  return {
    writeHead(status, h) {
      statusCode = status
      headers = h
    },
    end(chunk = '') {
      rawBody += String(chunk)
    },
    get result() {
      return {
        status: statusCode,
        headers,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      }
    },
  }
}

function createMockRequest({ method = 'POST', headers = {}, body = '' } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  const stream = Readable.from(payload.length > 0 ? [Buffer.from(payload)] : [])
  stream.method = method
  stream.headers = {
    host: '127.0.0.1:4321',
    'content-type': 'application/json',
    'x-dsh-plugin': 'session-delete',
    'sec-fetch-site': 'same-origin',
    origin: 'http://127.0.0.1:4321',
    ...headers,
  }
  return stream
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('resolveDshHome', () => {
  it('expands leading ~ and resolves configured path', () => {
    assert.equal(resolveDshHome('~/custom-dsh'), resolve(join(homedir(), 'custom-dsh')))
    assert.equal(resolveDshHome('~'), resolve(homedir()))
  })

  it('resolves relative configured path', () => {
    assert.equal(resolveDshHome('./rel-dsh'), resolve('./rel-dsh'))
  })
})

describe('isValidSessionId', () => {
  it('accepts normal session ids', () => {
    assert.equal(isValidSessionId('sess_123-abc.01'), true)
  })

  it('rejects empty, traversal, path separator, and control chars', () => {
    for (const bad of ['', '.', '..', '../a', 'a/b', 'a\\b', 'a..b', 'abc\0def', 'abc\ndef', 123, null]) {
      assert.equal(isValidSessionId(bad), false, `expected invalid: ${JSON.stringify(bad)}`)
    }
  })
})

describe('removalCommand', () => {
  it('uses POSIX rm -rf on non-win32 even when path contains backslashes', () => {
    const cmd = removalCommand("/tmp/dir\\with\\bs/o'ne", 'darwin')
    assert.equal(cmd, `rm -rf -- '/tmp/dir\\with\\bs/o'\\''ne'`)
  })

  it('uses PowerShell Remove-Item on win32 and escapes single quotes', () => {
    const cmd = removalCommand("C:\\Users\\o'ne\\sess", 'win32')
    assert.equal(cmd, `Remove-Item -LiteralPath 'C:\\Users\\o''ne\\sess' -Recurse -Force -ErrorAction Stop`)
  })
})

describe('deleteSession', () => {
  it('removes session files, projection cache, matching PRTS stores, and detaches from ALL workspaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsd-host-test-'))
    try {
      const home = join(root, 'dsh-home')
      const sessionId = 'sess-001'
      const projectDir = join(home, 'sessions', 'proj-a')
      const sessionDir = join(projectDir, sessionId)
      const logFile = join(sessionDir, 'log.jsonl')
      const projCache = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
      const prtsMatch = join(home, 'storages', 'prts_inv_match.json')
      const prtsOther = join(home, 'storages', 'prts_inv_other.json')

      await mkdir(sessionDir, { recursive: true })
      await writeFile(logFile, '{}')
      await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
      await writeFile(projCache, '{}')
      await writeFile(prtsMatch, JSON.stringify({ tables: { portfolios: { state: { sessionId } } } }))
      await writeFile(prtsOther, JSON.stringify({ tables: { portfolios: { state: { sessionId: 'other' } } } }))

      const archived = []
      const detached = []
      const executedSpecs = []

      const services = {
        sessions: { get: () => undefined },
        sessionPersistence: {
          list: async () => [{ header: { id: sessionId } }],
          locate: () => ({ path: logFile }),
        },
        shell: {
          resolve: (spec) => spec,
          execute: async (spec) => {
            executedSpecs.push(spec)
            await rm(sessionDir, { recursive: true, force: true })
            return { result: async () => ({ exitCode: 0, stderr: '' }) }
          },
        },
        workspaceRegistry: {
          archiveSession: async (id) => archived.push(id),
          list: () => [
            { id: 'ws-1', sessionIds: [sessionId], detachSession: async (id) => detached.push(['ws-1', id]) },
            { id: 'ws-2', sessionIds: ['other'], detachSession: async (id) => detached.push(['ws-2', id]) },
            { id: 'ws-3', sessionIds: [sessionId], detachSession: async (id) => detached.push(['ws-3', id]) },
          ],
        },
      }

      const outcome = await deleteSession({ home, services, inFlight: new Set() }, sessionId)
      assert.equal(outcome.status, 'deleted')
      assert.ok(outcome.freedBytes > 0)
      assert.deepEqual(outcome.warnings, [])
      assert.equal(executedSpecs.length, 1)
      assert.equal(executedSpecs[0].sandboxPolicy.workspaceRoot, projectDir)
      assert.equal(await exists(sessionDir), false)
      assert.equal(await exists(projCache), false)
      assert.equal(await exists(prtsMatch), false)
      assert.equal(await exists(prtsOther), true)
      assert.deepEqual(archived, [sessionId])
      assert.deepEqual(detached, [
        ['ws-1', sessionId],
        ['ws-3', sessionId],
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects paths outside <home>/sessions and symlink targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsd-guard-test-'))
    try {
      const home = join(root, 'dsh-home')
      const outsideLog = join(root, 'elsewhere', 'sess-out', 'log.jsonl')
      const realTarget = join(root, 'real-dir')
      const projectDir = join(home, 'sessions', 'proj-a')
      const linkDir = join(projectDir, 'sess-link')

      await mkdir(realTarget, { recursive: true })
      await mkdir(projectDir, { recursive: true })
      await symlink(realTarget, linkDir)

      const baseServices = {
        sessions: { get: () => undefined },
        shell: { resolve: (s) => s, execute: async () => ({ result: async () => ({ exitCode: 0 }) }) },
        workspaceRegistry: { archiveSession: async () => {}, list: () => [] },
      }

      const outRes = await deleteSession(
        {
          home,
          services: {
            ...baseServices,
            sessionPersistence: {
              list: async () => [{ header: { id: 'sess-out' } }],
              locate: () => ({ path: outsideLog }),
            },
          },
          inFlight: new Set(),
        },
        'sess-out',
      )
      assert.equal(outRes.status, 'failed')
      assert.equal(outRes.code, 'outside-sessions-root')

      const symRes = await deleteSession(
        {
          home,
          services: {
            ...baseServices,
            sessionPersistence: {
              list: async () => [{ header: { id: 'sess-link' } }],
              locate: () => ({ path: join(linkDir, 'log.jsonl') }),
            },
          },
          inFlight: new Set(),
        },
        'sess-link',
      )
      assert.equal(symRes.status, 'failed')
      assert.equal(symRes.code, 'symlink-refused')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('closes explicitly idle sessions before deleting, but refuses running or opaque ones', async () => {
    const home = '/tmp/dsh-idle-test'
    let handle = { status: 'idle' }
    let closedId = null
    const services = {
      sessions: {
        get: () => handle,
        close: async (id) => {
          closedId = id
          handle = undefined
        },
      },
      sessionPersistence: {
        list: async () => [{ header: { id: 'sess-idle' }, sizeBytes: 2048 }],
        locate: () => ({ path: join(home, 'sessions', 'proj', 'sess-idle', 'log.jsonl') }),
      },
      shell: { resolve: (s) => s, execute: async () => ({ result: async () => ({ exitCode: 0 }) }) },
      workspaceRegistry: { archiveSession: async () => {}, list: () => [] },
    }

    const resIdle = await deleteSession({ home, services, inFlight: new Set() }, 'sess-idle')
    assert.equal(closedId, 'sess-idle')
    assert.equal(resIdle.status, 'deleted')
    assert.equal(resIdle.freedBytes, 2048)

    // Running session must be refused
    handle = { status: 'running', isRunning: true }
    const resRunning = await deleteSession({ home, services, inFlight: new Set() }, 'sess-idle')
    assert.deepEqual(resRunning, { status: 'live' })

    // Opaque session handle without idle indicator must be refused
    handle = { id: 'sess-idle' }
    const resOpaque = await deleteSession({ home, services, inFlight: new Set() }, 'sess-idle')
    assert.deepEqual(resOpaque, { status: 'live' })
  })

  it('reports non-fatal bookkeeping warnings without failing the delete', async () => {
    const home = '/tmp/dsh-warn-test'
    const services = {
      sessions: { get: () => undefined },
      sessionPersistence: {
        list: async () => [{ header: { id: 'sess-warn' }, sizeBytes: 512 }],
        locate: () => ({ path: join(home, 'sessions', 'proj', 'sess-warn', 'log.jsonl') }),
      },
      shell: { resolve: (s) => s, execute: async () => ({ result: async () => ({ exitCode: 0 }) }) },
      workspaceRegistry: {
        archiveSession: async () => {},
        list: () => [
          {
            id: 'ws-1',
            sessionIds: ['sess-warn'],
            detachSession: async () => { throw new Error('detach boom') },
          },
        ],
      },
    }

    const res = await deleteSession({ home, services, inFlight: new Set() }, 'sess-warn')
    assert.equal(res.status, 'deleted')
    assert.deepEqual(res.warnings, ['workspace-detach'])
  })

  it('refuses when session becomes live during async list (TOCTOU guard)', async () => {
    const home = '/tmp/home'
    let live = false
    let shellCalled = false
    const services = {
      sessions: { get: () => (live ? { id: 'sess-toctou' } : undefined) },
      sessionPersistence: {
        list: async () => {
          live = true
          return [{ header: { id: 'sess-toctou' } }]
        },
        locate: () => ({ path: join(home, 'sessions', 'proj', 'sess-toctou', 'log.jsonl') }),
      },
      shell: {
        resolve: (spec) => spec,
        execute: async () => {
          shellCalled = true
          return { result: async () => ({ exitCode: 0 }) }
        },
      },
      workspaceRegistry: { archiveSession: async () => {}, list: () => [] },
    }

    const outcome = await deleteSession({ home, services, inFlight: new Set() }, 'sess-toctou')
    assert.deepEqual(outcome, { status: 'live' })
    assert.equal(shellCalled, false)
  })

  it('rejects concurrent duplicate deletes with in-progress', async () => {
    let releaseList
    const services = {
      sessions: { get: () => undefined },
      sessionPersistence: {
        list: () => new Promise((resolveList) => { releaseList = () => resolveList([]) }),
        locate: () => ({ path: '' }),
      },
      shell: { resolve: (s) => s, execute: async () => ({ result: async () => ({ exitCode: 0 }) }) },
      workspaceRegistry: { archiveSession: async () => {}, list: () => [] },
    }
    const inFlight = new Set()
    const first = deleteSession({ home: '/tmp/home', services, inFlight }, 'sess-dup')
    const second = await deleteSession({ home: '/tmp/home', services, inFlight }, 'sess-dup')
    assert.deepEqual(second, { status: 'in-progress' })

    releaseList()
    assert.deepEqual(await first, { status: 'missing' })
    assert.equal(inFlight.size, 0)
  })

  it('does not touch bookkeeping if file removal fails', async () => {
    const home = '/tmp/home'
    let archived = false
    const services = {
      sessions: { get: () => undefined },
      sessionPersistence: {
        list: async () => [{ header: { id: 'sess-fail' } }],
        locate: () => ({ path: join(home, 'sessions', 'proj', 'sess-fail', 'log.jsonl') }),
      },
      shell: {
        resolve: (s) => s,
        execute: async () => ({ result: async () => ({ exitCode: 1, sandbox: { denied: true }, stderr: 'EACCES' }) }),
      },
      workspaceRegistry: {
        archiveSession: async () => { archived = true },
        list: () => [],
      },
    }

    const outcome = await deleteSession({ home, services, inFlight: new Set() }, 'sess-fail')
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.code, 'sandbox-denied')
    assert.equal(archived, false)
  })
})

describe('isInsideDirectory', () => {
  it('detects strict nesting and rejects root itself or traversal', () => {
    assert.equal(isInsideDirectory('/a/b', '/a/b/c'), true)
    assert.equal(isInsideDirectory('/a/b', '/a/b'), false)
    assert.equal(isInsideDirectory('/a/b', '/a/bc'), false)
    assert.equal(isInsideDirectory('/a/b', '/a/b/../c'), false)
  })
})

describe('HTTP route security and validation', () => {
  function mountRoute(overrides = {}) {
    let routeHandler
    const ctx = {
      sessions: { get: () => undefined },
      sessionPersistence: { list: async () => [], locate: () => ({ path: '' }) },
      workspaceRegistry: { archiveSession: async () => {}, list: () => [] },
      shell: { resolve: (s) => s, execute: async () => ({ result: async () => ({ exitCode: 0 }) }) },
      webServer: {
        register: (entry) => {
          routeHandler = entry.handler
          return () => {}
        },
      },
      effect: (fn) => fn(),
      ...overrides,
    }
    apply(ctx, { home: '~/test-dsh-home' })
    return routeHandler
  }

  it('rejects non-POST with 405', async () => {
    const handler = mountRoute()
    const res = createMockResponse()
    await handler(createMockRequest({ method: 'GET' }), res)
    assert.equal(res.result.status, 405)
    assert.equal(res.result.body.code, 'method-not-allowed')
  })

  it('rejects non-JSON Content-Type with 415', async () => {
    const handler = mountRoute()
    const res = createMockResponse()
    await handler(createMockRequest({ headers: { 'content-type': 'text/plain' }, body: { sessionId: 'abc' } }), res)
    assert.equal(res.result.status, 415)
    assert.equal(res.result.body.code, 'unsupported-media-type')
  })

  it('rejects missing custom plugin header with 403', async () => {
    const handler = mountRoute()
    const res = createMockResponse()
    await handler(createMockRequest({ headers: { 'x-dsh-plugin': '' }, body: { sessionId: 'abc' } }), res)
    assert.equal(res.result.status, 403)
    assert.equal(res.result.body.code, 'forbidden')
  })

  it('rejects cross-site Origin and Sec-Fetch-Site with 403', async () => {
    const handler = mountRoute()
    const res1 = createMockResponse()
    await handler(createMockRequest({ headers: { 'sec-fetch-site': 'cross-site' }, body: { sessionId: 'abc' } }), res1)
    assert.equal(res1.result.status, 403)

    const res2 = createMockResponse()
    await handler(createMockRequest({ headers: { origin: 'https://evil.example' }, body: { sessionId: 'abc' } }), res2)
    assert.equal(res2.result.status, 403)
  })

  it('rejects oversized body with 413', async () => {
    const handler = mountRoute()
    const res = createMockResponse()
    const huge = JSON.stringify({ sessionId: 'a'.repeat(20_000) })
    await handler(createMockRequest({ body: huge }), res)
    assert.equal(res.result.status, 413)
    assert.equal(res.result.body.code, 'payload-too-large')
  })

  it('rejects traversal sessionId with 400 and returns 404 for valid missing session', async () => {
    const handler = mountRoute()
    const resBad = createMockResponse()
    await handler(createMockRequest({ body: { sessionId: '../secret' } }), resBad)
    assert.equal(resBad.result.status, 400)
    assert.equal(resBad.result.body.code, 'bad-arguments')

    const resMissing = createMockResponse()
    await handler(createMockRequest({ body: { sessionId: 'valid-id' } }), resMissing)
    assert.equal(resMissing.result.status, 404)
    assert.equal(resMissing.result.body.code, 'missing')
  })
})
