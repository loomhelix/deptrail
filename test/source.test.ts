import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../ui/src/api.ts'
import {
  defaultBase,
  navigationUrl,
  openShownSource,
  reloadForDroppedSource,
  shortCommit,
  shortRef,
  sourceKey,
  WORKING_KEY,
  type ShownSource,
} from '../ui/src/source.ts'
import { sourceLabel } from '../ui/src/vocabulary.ts'
import type { GitInfo, OpenSourceRequest } from '../src/server/branches.ts'

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const WORKING: ShownSource = { kind: 'working' }

function info(defaultBranch?: string): GitInfo {
  return { available: true, refs: [], ...(defaultBranch === undefined ? {} : { defaultBranch }) }
}

function commitSource(ref: string): ShownSource {
  return { kind: 'commit', ref, commit: COMMIT }
}

describe('shown source', () => {
  it('names refs, commits and sources', () => {
    assert.equal(shortRef('refs/heads/maintenance/6.1'), 'maintenance/6.1')
    assert.equal(shortRef('refs/remotes/origin/main'), 'origin/main')
    assert.equal(shortRef('refs/tags/v1.0.0'), 'v1.0.0')
    assert.equal(shortRef('HEAD'), 'HEAD')
    assert.equal(shortCommit(COMMIT), 'abcdef1')
    assert.equal(sourceLabel(WORKING), 'Working tree')
    assert.equal(sourceLabel(commitSource('refs/heads/fix/a')), 'fix/a')
    assert.equal(sourceKey(WORKING), WORKING_KEY)
    assert.equal(WORKING_KEY, 'work')
    assert.equal(sourceKey(commitSource('refs/heads/fix/a')), COMMIT)
  })

  it('builds navigation URLs that keep the other parameters', () => {
    assert.equal(navigationUrl('/', '?root=shop&ref=refs/heads/a', { ref: null }), '/?root=shop')
    assert.equal(navigationUrl('/', '?ref=refs/heads/a', { ref: null }), '/')
    assert.equal(navigationUrl('/', '?root=shop&view=compare', { ref: 'refs/heads/b', base: 'work' }), '/?root=shop&view=compare&ref=refs/heads/b&base=work')
    const unusual = navigationUrl('/', '?view=explore', { ref: 'refs/heads/fix/@scope#1' })
    assert.equal(new URLSearchParams(unusual.slice(unusual.indexOf('?'))).get('ref'), 'refs/heads/fix/@scope#1')
    assert.equal(unusual.includes('#'), false)
    const umlaut = navigationUrl('/', '', { ref: 'refs/heads/ü' })
    assert.equal(new URLSearchParams(umlaut.slice(umlaut.indexOf('?'))).get('ref'), 'refs/heads/ü')
  })

  it('picks the default base', () => {
    assert.equal(defaultBase({ available: false, reason: 'x', quiet: true }, WORKING), 'work')
    assert.equal(defaultBase(info('refs/remotes/origin/main'), WORKING), 'refs/remotes/origin/main')
    assert.equal(defaultBase(info('refs/remotes/origin/main'), commitSource('refs/heads/fix/a')), 'refs/remotes/origin/main')
    assert.equal(defaultBase(info('refs/remotes/origin/main'), commitSource('refs/remotes/origin/main')), 'work')
    assert.equal(defaultBase(info(), WORKING), 'HEAD')
    assert.equal(defaultBase(info(), commitSource('refs/heads/fix/a')), 'work')
  })

  it('reloads for a dropped source at most once in a short interval', () => {
    const stored = new Map<string, string>()
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    }
    const reloads: number[] = []
    const reload = (now: number) => reloadForDroppedSource(storage, now, () => reloads.push(now))
    reload(NOW)
    reload(NOW + 1_000)
    reload(NOW + 60_000)
    assert.deepEqual(reloads, [NOW, NOW + 60_000])
    const failing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    reloadForDroppedSource(failing, NOW, () => reloads.push(-1))
    assert.equal(reloads.at(-1), -1)
  })

  it('opens the source named in the URL', async () => {
    const requests: OpenSourceRequest[] = []
    const api = {
      openSource: async (request: OpenSourceRequest) => {
        requests.push(request)
        if ('ref' in request && request.ref === 'refs/heads/gone') throw new ApiError(404, 'Unknown ref refs/heads/gone')
        if ('ref' in request && request.ref === 'refs/heads/vendored') return { key: COMMIT, commit: COMMIT, ref: request.ref, skippedSubmodules: ['vendor/sub'] }
        return { key: COMMIT, commit: COMMIT, ref: 'refs/heads/main', committedAt: '2026-10-20T10:00:00.000Z' }
      },
    }
    assert.deepEqual(await openShownSource(api, ''), { source: { kind: 'working' } })
    assert.deepEqual(await openShownSource(api, '?ref='), { source: { kind: 'working' } })
    assert.deepEqual(requests, [])
    assert.deepEqual(await openShownSource(api, '?root=shop&ref=refs/heads/main'), {
      source: { kind: 'commit', ref: 'refs/heads/main', commit: COMMIT, committedAt: '2026-10-20T10:00:00.000Z' },
    })
    assert.deepEqual(await openShownSource(api, '?ref=refs/heads/vendored'), {
      source: { kind: 'commit', ref: 'refs/heads/vendored', commit: COMMIT, skippedSubmodules: ['vendor/sub'] },
    })
    assert.deepEqual(await openShownSource(api, '?ref=refs/heads/gone'), {
      source: { kind: 'working' },
      notice: 'Could not open refs/heads/gone: Unknown ref refs/heads/gone. Showing the working tree.',
    })
  })
})
