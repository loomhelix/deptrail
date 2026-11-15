import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Advisory, PackageMeta } from '../src/enrich/types.ts'
import { isAffected, normalizeRange, outdatedLevel, safeVersions, wantedVersion } from '../src/query/versions.ts'

function advisoryWith(affected: Advisory['affected']): Advisory {
  return { id: 'GHSA-x', aliases: [], summary: '', severity: 'high', malicious: false, url: '', fixedIn: [], modified: '', affected }
}

function rangeAdvisory(events: Advisory['affected'][number]['ranges'][number]['events']): Advisory {
  return advisoryWith([{ versions: [], ranges: [{ events }] }])
}

describe('normalizeRange', () => {
  const context = { name: 'vue', catalogs: { default: { vue: '^3.5.0' }, legacy: { vue: '^2.7.0' } } }

  it('resolves catalogs', () => {
    assert.equal(normalizeRange('catalog:', context), '^3.5.0')
    assert.equal(normalizeRange('catalog:legacy', context), '^2.7.0')
    assert.equal(normalizeRange('catalog:missing', context), undefined)
  })

  it('unwraps npm aliases', () => {
    assert.equal(normalizeRange('npm:string-width@^4.2.0', context), '^4.2.0')
    assert.equal(normalizeRange('npm:@scope/x@~1.0.0', context), '~1.0.0')
    assert.equal(normalizeRange('npm:other', { ...context, distTags: { latest: '2.0.0' } }), '2.0.0')
  })

  it('resolves dist-tags', () => {
    assert.equal(normalizeRange('latest', { ...context, distTags: { latest: '2.0.0' } }), '2.0.0')
    assert.equal(normalizeRange('latest', context), undefined)
  })

  it('drops non-registry specs', () => {
    assert.equal(normalizeRange('workspace:*', context), undefined)
    assert.equal(normalizeRange('link:../a', context), undefined)
    assert.equal(normalizeRange('github:u/r', context), undefined)
  })

  it('keeps valid ranges', () => {
    assert.equal(normalizeRange('^1.2.3', context), '^1.2.3')
  })
})

describe('wantedVersion', () => {
  it('picks the highest satisfying version', () => {
    assert.equal(wantedVersion(['1.0.0', '1.2.0', '2.0.0'], '^1.0.0'), '1.2.0')
    assert.equal(wantedVersion(['1.0.0'], undefined), undefined)
  })
})

describe('outdatedLevel', () => {
  it('classifies the gap', () => {
    assert.equal(outdatedLevel('5.4.2', '6.0.7'), 'major')
    assert.equal(outdatedLevel('3.4.38', '3.5.13'), 'minor')
    assert.equal(outdatedLevel('1.0.0', '1.0.1'), 'patch')
  })

  it('ignores prereleases, downgrades and invalid input', () => {
    assert.equal(outdatedLevel('2.0.0-beta.1', '2.0.0'), undefined)
    assert.equal(outdatedLevel('2.0.0', '1.9.0'), undefined)
    assert.equal(outdatedLevel('^1.0.0', '2.0.0'), undefined)
    assert.equal(outdatedLevel('1.0.0', undefined), undefined)
  })
})

describe('isAffected', () => {
  it('walks introduced and fixed events', () => {
    const advisory = rangeAdvisory([{ introduced: '0' }, { fixed: '5.7.3' }])
    assert.equal(isAffected('5.7.2', advisory), true)
    assert.equal(isAffected('5.7.3', advisory), false)
  })

  it('honors last_affected', () => {
    const advisory = rangeAdvisory([{ introduced: '6.0.0' }, { last_affected: '6.3.0' }])
    assert.equal(isAffected('6.3.0', advisory), true)
    assert.equal(isAffected('6.3.1', advisory), false)
    assert.equal(isAffected('5.0.0', advisory), false)
  })

  it('honors explicit versions', () => {
    assert.equal(isAffected('1.0.0', advisoryWith([{ versions: ['1.0.0'], ranges: [] }])), true)
  })

  it('skips invalid events and versions without throwing', () => {
    const advisory = rangeAdvisory([{ introduced: 'garbage' }, { fixed: '1.0.0' }])
    assert.equal(isAffected('0.5.0', advisory), false)
    assert.equal(isAffected('1.0.0', rangeAdvisory([{ introduced: '0' }, { fixed: '0' }])), true)
    assert.equal(isAffected('1.0.0', rangeAdvisory([{ introduced: '0' }, { last_affected: '0' }])), true)
    assert.equal(isAffected('not-a-version', rangeAdvisory([{ introduced: '0' }])), false)
  })
})

describe('safeVersions', () => {
  it('drops prereleases and affected versions', () => {
    const meta: PackageMeta = { distTags: {}, versions: ['6.3.1', '5.7.2', '5.7.3', '7.0.0-rc.1', 'junk', '6.3.0'], deprecated: {}, manifests: {} }
    const advisories = [rangeAdvisory([{ introduced: '0' }, { fixed: '5.7.3' }]), rangeAdvisory([{ introduced: '6.0.0' }, { last_affected: '6.3.0' }])]
    assert.deepEqual(safeVersions(meta, advisories), ['5.7.3', '6.3.1'])
  })

  it('does not throw on zero fixed or last_affected events', () => {
    const meta: PackageMeta = { distTags: {}, versions: ['1.0.0', '2.0.0'], deprecated: {}, manifests: {} }
    const advisories = [rangeAdvisory([{ introduced: '0' }, { fixed: '0' }]), rangeAdvisory([{ introduced: '0' }, { last_affected: '0' }])]
    assert.deepEqual(safeVersions(meta, advisories), [])
  })
})
