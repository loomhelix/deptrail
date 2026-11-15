import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { NodeDecoration } from '../src/query/decorations.ts'
import type { IssueRow } from '../src/query/issues.ts'
import { issueProblemBadges, nodeBadges, severityTone } from '../ui/src/badges.ts'

const DIRECT = { isDirect: true, compact: false, version: '7.0.1' }
const TRANSITIVE = { isDirect: false, compact: false, version: '7.0.1' }

describe('severityTone', () => {
  it('maps critical and high to danger, moderate to warn, low and unknown to neutral', () => {
    assert.equal(severityTone('critical'), 'danger')
    assert.equal(severityTone('high'), 'danger')
    assert.equal(severityTone('moderate'), 'warn')
    assert.equal(severityTone('low'), 'neutral')
    assert.equal(severityTone('unknown'), 'neutral')
  })
})

describe('nodeBadges', () => {
  it('returns nothing without a decoration', () => {
    assert.deepEqual(nodeBadges(undefined, DIRECT), [])
    assert.deepEqual(nodeBadges({}, DIRECT), [])
  })

  it('shows the own vulnerability as a filled badge with the severity label', () => {
    const [badge] = nodeBadges({ vuln: { severity: 'high', count: 1 } }, TRANSITIVE)
    assert.deepEqual(badge, {
      key: 'vuln',
      label: 'high',
      tone: 'danger',
      outlined: false,
      title: '1 known vulnerability; highest severity: high',
    })
    const [several] = nodeBadges({ vuln: { severity: 'moderate', count: 3 } }, TRANSITIVE)
    assert.equal(several!.tone, 'warn')
    assert.equal(several!.title, '3 known vulnerabilities; highest severity: moderate')
  })

  it('labels a malicious package malicious', () => {
    const [badge] = nodeBadges({ vuln: { severity: 'critical', count: 2, malicious: true } }, TRANSITIVE)
    assert.equal(badge!.label, 'malicious')
    assert.equal(badge!.tone, 'danger')
    assert.equal(badge!.outlined, false)
    assert.equal(badge!.title, '2 known vulnerabilities; highest severity: critical')
  })

  it('shows the roll-up as an outlined badge that reads how many are vulnerable below and the worst severity', () => {
    const decoration: NodeDecoration = { below: { count: 2, worst: 'high' } }
    const [full] = nodeBadges(decoration, TRANSITIVE)
    assert.deepEqual(full, {
      key: 'below',
      label: '2 vulnerable below · high',
      tone: 'danger',
      outlined: true,
      title: '2 vulnerable packages below; highest severity: high',
    })
    const [single] = nodeBadges({ below: { count: 1, worst: 'low' } }, TRANSITIVE)
    assert.equal(single!.title, '1 vulnerable package below; highest severity: low')
    assert.equal(single!.tone, 'neutral')
  })

  it('shortens the roll-up in compact places and keeps the full text in the title', () => {
    const [compact] = nodeBadges({ below: { count: 1, worst: 'high' } }, { ...TRANSITIVE, compact: true })
    assert.deepEqual(compact, {
      key: 'below',
      label: '1 vulnerable below',
      tone: 'danger',
      outlined: true,
      title: '1 vulnerable below · high',
    })
  })

  it('never shortens the roll-up to a bare count below', () => {
    for (const compact of [true, false]) {
      const [badge] = nodeBadges({ below: { count: 3, worst: 'moderate' } }, { ...TRANSITIVE, compact })
      assert.doesNotMatch(badge!.label, /^\d+ below/)
      assert.match(badge!.label, /^3 vulnerable below/)
    }
  })

  it('shows deprecated as a warn badge', () => {
    const [badge] = nodeBadges({ deprecated: true }, TRANSITIVE)
    assert.equal(badge!.key, 'deprecated')
    assert.equal(badge!.label, 'deprecated')
    assert.equal(badge!.tone, 'warn')
    assert.equal(badge!.outlined, false)
  })

  it('shows the update badge only for direct dependencies', () => {
    const decoration: NodeDecoration = { outdated: { level: 'major', latest: '11.0.0' } }
    const [badge] = nodeBadges(decoration, DIRECT)
    assert.deepEqual(badge, {
      key: 'outdated',
      label: '↑ 11.0.0 major',
      tone: 'info',
      outlined: false,
      title: 'major update: 7.0.1 → 11.0.0',
    })
    assert.deepEqual(nodeBadges(decoration, TRANSITIVE), [])
  })

  it('names the size of the update in compact places too', () => {
    const [badge] = nodeBadges({ outdated: { level: 'minor', latest: '1.1.0' } }, { ...DIRECT, compact: true, version: '1.0.0' })
    assert.equal(badge!.label, '↑ 1.1.0 minor')
    assert.equal(badge!.title, 'minor update: 1.0.0 → 1.1.0')
  })

  it('orders own vulnerability, roll-up, deprecated, then update', () => {
    const decoration: NodeDecoration = {
      vuln: { severity: 'high', count: 1 },
      below: { count: 1, worst: 'high' },
      deprecated: true,
      outdated: { level: 'minor', latest: '7.1.0' },
    }
    assert.deepEqual(
      nodeBadges(decoration, DIRECT).map((badge) => badge.key),
      ['vuln', 'below', 'deprecated', 'outdated'],
    )
  })
})

function issueRow(overrides: Partial<IssueRow>): IssueRow {
  return { name: 'helper', version: '1.0.0', kinds: [], vulnIds: [], locations: [], ...overrides }
}

describe('issueProblemBadges', () => {
  it('shows the severity of a vulnerable package, or malicious', () => {
    const row = issueRow({ kinds: ['vulnerability'], severity: 'high', vulnIds: ['GHSA-1', 'GHSA-2'] })
    assert.deepEqual(issueProblemBadges('vulnerability', row), [
      { key: 'vuln', label: 'high', tone: 'danger', outlined: false, title: '2 known vulnerabilities; highest severity: high' },
    ])
    const [malicious] = issueProblemBadges('vulnerability', { ...row, malicious: true })
    assert.equal(malicious!.label, 'malicious')
  })

  it('shows deprecated for a deprecated package', () => {
    assert.deepEqual(issueProblemBadges('deprecated', issueRow({ kinds: ['deprecated'] })), [
      { key: 'deprecated', label: 'deprecated', tone: 'warn', outlined: false, title: 'This version is deprecated' },
    ])
  })

  it('shows the size of an update with its explanation in the title', () => {
    const row = issueRow({ kinds: ['outdated'], latest: '1.1.0', outdatedLevel: 'minor' })
    assert.deepEqual(issueProblemBadges('outdated', row), [{ key: 'level', label: 'minor', tone: 'info', outlined: false, title: 'minor update' }])
    assert.deepEqual(issueProblemBadges('outdated', issueRow({ kinds: ['outdated'] })), [])
  })
})
