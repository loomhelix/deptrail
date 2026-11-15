import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { RootSummary, SearchHit } from '../ui/src/api.ts'
import {
  finishedJobOf,
  followLinkAction,
  followLinks,
  followOutcome,
  jobBehindChange,
  missingSelectionText,
  movedVariants,
  shouldFollow,
} from '../ui/src/follow-selection.ts'
import { followNotice } from '../ui/src/vocabulary.ts'

const HELPER_IN_SHOP_NPM = { root: 'shop-npm', node: 'helper@1.0.0' }
const CHILD_IN_SHOP = { root: 'shop', node: 'child-lib@1.0.0' }
const SHOWN_IN_ROOT = { wasShownInRoot: true }
const NEVER_SHOWN_IN_ROOT = { wasShownInRoot: false }

function rootSummary(overrides: Partial<RootSummary> = {}): RootSummary {
  return {
    id: 'shop-npm',
    path: 'shop-npm',
    manager: 'npm',
    source: 'lockfile',
    status: 'ready',
    warnings: [],
    importers: [],
    packageCount: 0,
    duplicateCount: 0,
    hasAuth: false,
    actions: { available: true, changeCount: 0, revertable: false },
    ...overrides,
  }
}

function withJob(job: RootSummary['actions']['job']): RootSummary {
  return rootSummary({ actions: { available: true, changeCount: 0, revertable: true, job } })
}

describe('followOutcome', () => {
  it('moves to the only version of the package left in the root', () => {
    const hits: SearchHit[] = [
      { name: 'helper', versions: [{ version: '1.1.0', roots: [{ rootId: 'shop-npm', nodeId: 'helper@1.1.0' }] }, { version: '1.0.0', roots: [{ rootId: 'shop', nodeId: 'helper@1.0.0' }] }] },
      { name: 'helper-utils', versions: [{ version: '2.0.0', roots: [{ rootId: 'shop-npm', nodeId: 'helper-utils@2.0.0' }] }] },
    ]
    assert.deepEqual(followOutcome(HELPER_IN_SHOP_NPM, hits, SHOWN_IN_ROOT), { kind: 'moved', node: 'helper@1.1.0', version: '1.1.0' })
  })

  it('follows a scoped package of a pnpm v6 lockfile by its name without the slash', () => {
    const hits: SearchHit[] = [
      { name: '@types/node', versions: [{ version: '20.17.10', roots: [{ rootId: 'legacy', nodeId: '/@types/node@20.17.10' }] }] },
    ]
    assert.deepEqual(followOutcome({ root: 'legacy', node: '/@types/node@20.17.9' }, hits, SHOWN_IN_ROOT), {
      kind: 'moved',
      node: '/@types/node@20.17.10',
      version: '20.17.10',
    })
  })

  it('never moves to the node it left when the search still lists it', () => {
    const hits: SearchHit[] = [
      {
        name: 'helper',
        versions: [
          { version: '1.1.0', roots: [{ rootId: 'shop-npm', nodeId: 'helper@1.1.0' }] },
          { version: '1.0.0', roots: [{ rootId: 'shop-npm', nodeId: 'helper@1.0.0' }] },
        ],
      },
    ]
    assert.deepEqual(followOutcome(HELPER_IN_SHOP_NPM, hits, SHOWN_IN_ROOT), { kind: 'moved', node: 'helper@1.1.0', version: '1.1.0' })
  })

  it('offers a choice when two versions are left in the root', () => {
    const hits: SearchHit[] = [
      {
        name: 'helper',
        versions: [
          { version: '1.2.0', roots: [{ rootId: 'shop-npm', nodeId: 'helper@1.2.0' }] },
          { version: '1.1.0', roots: [{ rootId: 'shop', nodeId: 'helper@1.1.0' }, { rootId: 'shop-npm', nodeId: 'helper@1.1.0' }] },
        ],
      },
    ]
    assert.deepEqual(followOutcome(HELPER_IN_SHOP_NPM, hits, SHOWN_IN_ROOT), {
      kind: 'choose',
      options: [
        { node: 'helper@1.2.0', version: '1.2.0' },
        { node: 'helper@1.1.0', version: '1.1.0' },
      ],
    })
  })

  it('treats two peer variants of one version as two choices', () => {
    const selection = { root: 'shop', node: 'vue-router@4.4.5(vue@3.5.12)' }
    const hits: SearchHit[] = [
      {
        name: 'vue-router',
        versions: [
          {
            version: '4.4.5',
            roots: [
              { rootId: 'shop', nodeId: 'vue-router@4.4.5(vue@3.5.13)' },
              { rootId: 'shop', nodeId: 'vue-router@4.4.5(vue@3.5.14)' },
            ],
          },
        ],
      },
    ]
    assert.deepEqual(followOutcome(selection, hits, SHOWN_IN_ROOT), {
      kind: 'choose',
      options: [
        { node: 'vue-router@4.4.5(vue@3.5.13)', version: '4.4.5' },
        { node: 'vue-router@4.4.5(vue@3.5.14)', version: '4.4.5' },
      ],
    })
  })

  it('lists the other roots with the same version first when the root has none left', () => {
    const hits: SearchHit[] = [
      {
        name: 'child-lib',
        versions: [
          { version: '2.0.0', roots: [{ rootId: 'shop-npm', nodeId: 'child-lib@2.0.0' }] },
          { version: '1.0.0', roots: [{ rootId: 'legacy', nodeId: 'child-lib@1.0.0' }, { rootId: 'shop-npm', nodeId: 'child-lib@1.0.0' }] },
        ],
      },
    ]
    assert.deepEqual(followOutcome(CHILD_IN_SHOP, hits, SHOWN_IN_ROOT), {
      kind: 'elsewhere',
      roots: [
        { root: 'legacy', node: 'child-lib@1.0.0', version: '1.0.0' },
        { root: 'shop-npm', node: 'child-lib@1.0.0', version: '1.0.0' },
        { root: 'shop-npm', node: 'child-lib@2.0.0', version: '2.0.0' },
      ],
    })
  })

  it('lists this root first, then the same version elsewhere, then the rest', () => {
    const hits: SearchHit[] = [
      {
        name: 'child-lib',
        versions: [
          { version: '2.0.0', roots: [{ rootId: 'legacy', nodeId: 'child-lib@2.0.0' }] },
          { version: '1.0.0', roots: [{ rootId: 'legacy', nodeId: 'child-lib@1.0.0' }, { rootId: 'shop-npm', nodeId: 'child-lib@1.0.0' }] },
          { version: '0.9.0', roots: [{ rootId: 'shop', nodeId: 'child-lib@0.9.0' }] },
        ],
      },
    ]
    const outcome = followOutcome({ root: 'shop', node: 'child-lib@1.0.0' }, hits, NEVER_SHOWN_IN_ROOT)
    assert.deepEqual(outcome, {
      kind: 'elsewhere',
      roots: [
        { root: 'shop', node: 'child-lib@0.9.0', version: '0.9.0' },
        { root: 'legacy', node: 'child-lib@1.0.0', version: '1.0.0' },
        { root: 'shop-npm', node: 'child-lib@1.0.0', version: '1.0.0' },
        { root: 'legacy', node: 'child-lib@2.0.0', version: '2.0.0' },
      ],
    })
  })

  it('reports the package as gone when no root has it', () => {
    const hits: SearchHit[] = [{ name: 'helper-utils', versions: [{ version: '2.0.0', roots: [{ rootId: 'shop-npm', nodeId: 'helper-utils@2.0.0' }] }] }]
    assert.deepEqual(followOutcome(HELPER_IN_SHOP_NPM, hits, SHOWN_IN_ROOT), { kind: 'gone' })
    assert.deepEqual(followOutcome(HELPER_IN_SHOP_NPM, [], SHOWN_IN_ROOT), { kind: 'gone' })
  })

  it('never follows a workspace package', () => {
    assert.deepEqual(followOutcome({ root: 'shop', node: 'importer:api' }, [], SHOWN_IN_ROOT), { kind: 'choose', options: [] })
  })

  describe('for a selection the root never showed, such as one carried over by a root switch', () => {
    const childAfterApply = { root: 'shop', node: 'child-lib@1.0.1' }
    const childHits: SearchHit[] = [
      {
        name: 'child-lib',
        versions: [
          { version: '1.0.1', roots: [{ rootId: 'shop-npm', nodeId: 'child-lib@1.0.1' }] },
          { version: '1.0.0', roots: [{ rootId: 'shop', nodeId: 'child-lib@1.0.0' }] },
        ],
      },
    ]

    it('never moves to the only other version in the root and lists where the package is instead', () => {
      assert.deepEqual(followOutcome(childAfterApply, childHits, NEVER_SHOWN_IN_ROOT), {
        kind: 'elsewhere',
        roots: [
          { root: 'shop', node: 'child-lib@1.0.0', version: '1.0.0' },
          { root: 'shop-npm', node: 'child-lib@1.0.1', version: '1.0.1' },
        ],
      })
    })

    it('never says a version is no longer in the root when it was never there', () => {
      const hits: SearchHit[] = [
        {
          name: 'helper',
          versions: [
            { version: '1.2.0', roots: [{ rootId: 'shop-npm', nodeId: 'helper@1.2.0' }] },
            { version: '1.1.0', roots: [{ rootId: 'shop-npm', nodeId: 'helper@1.1.0' }] },
          ],
        },
      ]
      assert.deepEqual(followOutcome(HELPER_IN_SHOP_NPM, hits, NEVER_SHOWN_IN_ROOT), {
        kind: 'elsewhere',
        roots: [
          { root: 'shop-npm', node: 'helper@1.2.0', version: '1.2.0' },
          { root: 'shop-npm', node: 'helper@1.1.0', version: '1.1.0' },
        ],
      })
    })

    it('reports the package as gone when no root has it', () => {
      assert.deepEqual(followOutcome(childAfterApply, [], NEVER_SHOWN_IN_ROOT), { kind: 'gone' })
    })

    it('says a workspace package is not in the root', () => {
      const selection = { root: 'shop', node: 'importer:api' }
      const outcome = followOutcome(selection, [], NEVER_SHOWN_IN_ROOT)
      assert.deepEqual(outcome, { kind: 'elsewhere', roots: [] })
    })

    it('says the version is not in the root and links the other version there and the root that has it', () => {
      const outcome = followOutcome(childAfterApply, childHits, NEVER_SHOWN_IN_ROOT)
      assert.notEqual(outcome.kind, 'moved')
      if (outcome.kind === 'moved') return
      assert.equal(missingSelectionText(childAfterApply, outcome), 'child-lib 1.0.1 is not in shop.')
      assert.deepEqual(followLinks(childAfterApply, outcome), [
        { label: 'child-lib 1.0.0', selection: { root: 'shop', node: 'child-lib@1.0.0' }, opensRoot: false },
        { label: 'Open in shop-npm', selection: { root: 'shop-npm', node: 'child-lib@1.0.1' }, opensRoot: true },
      ])
    })
  })
})

describe('shouldFollow', () => {
  it('waits for a missing, scanning or failed root', () => {
    assert.equal(shouldFollow(undefined), false)
    assert.equal(shouldFollow(rootSummary({ status: 'scanning' })), false)
    assert.equal(shouldFollow(rootSummary({ status: 'failed', error: 'broken lockfile' })), false)
  })

  it('waits while a job of the root runs', () => {
    assert.equal(shouldFollow(withJob({ id: 'apply-1', kind: 'apply', state: 'running', phase: 'rescanning' })), false)
  })

  it('follows in a ready root without a running job', () => {
    assert.equal(shouldFollow(rootSummary()), true)
    assert.equal(shouldFollow(withJob({ id: 'apply-1', kind: 'apply', state: 'done' })), true)
  })
})

describe('jobBehindChange', () => {
  it('names a job that finished after the selection was last loaded', () => {
    assert.equal(jobBehindChange(withJob({ id: 'apply-1', kind: 'apply', state: 'done' }), null), 'apply')
    assert.equal(jobBehindChange(withJob({ id: 'revert-2', kind: 'revert', state: 'done' }), 'apply-1'), 'revert')
  })

  it('names no verb for a job that failed or was cancelled', () => {
    assert.equal(jobBehindChange(withJob({ id: 'apply-1', kind: 'apply', state: 'failed' }), null), undefined)
    assert.equal(jobBehindChange(withJob({ id: 'revert-1', kind: 'revert', state: 'cancelled' }), null), undefined)
  })

  it('names no job when the latest one was already finished at the last load', () => {
    assert.equal(jobBehindChange(withJob({ id: 'apply-1', kind: 'apply', state: 'done' }), 'apply-1'), undefined)
  })

  it('names no job without an earlier load, without a job or while it runs', () => {
    assert.equal(jobBehindChange(withJob({ id: 'apply-1', kind: 'apply', state: 'done' }), undefined), undefined)
    assert.equal(jobBehindChange(rootSummary(), null), undefined)
    assert.equal(jobBehindChange(withJob({ id: 'apply-1', kind: 'apply', state: 'running' }), null), undefined)
  })
})

describe('finishedJobOf', () => {
  it('keeps the latest job only once it has finished', () => {
    assert.equal(finishedJobOf(undefined), null)
    assert.equal(finishedJobOf(rootSummary()), null)
    assert.equal(finishedJobOf(withJob({ id: 'apply-1', kind: 'apply', state: 'running' })), null)
    assert.equal(finishedJobOf(withJob({ id: 'apply-1', kind: 'apply', state: 'failed' })), 'apply-1')
  })
})

describe('missingSelectionText and followLinks', () => {
  it('offers one link per version left in the root', () => {
    const outcome = {
      kind: 'choose' as const,
      options: [
        { node: 'helper@1.2.0', version: '1.2.0' },
        { node: 'helper@1.1.0', version: '1.1.0' },
      ],
    }
    assert.equal(missingSelectionText(HELPER_IN_SHOP_NPM, outcome), 'helper 1.0.0 is no longer in shop-npm.')
    assert.deepEqual(followLinks(HELPER_IN_SHOP_NPM, outcome), [
      { label: 'helper 1.2.0', selection: { root: 'shop-npm', node: 'helper@1.2.0' }, opensRoot: false },
      { label: 'helper 1.1.0', selection: { root: 'shop-npm', node: 'helper@1.1.0' }, opensRoot: false },
    ])
  })

  it('tells peer variants of one version apart', () => {
    const selection = { root: 'shop', node: 'vue-router@4.4.5(vue@3.5.12)' }
    const outcome = {
      kind: 'choose' as const,
      options: [
        { node: 'vue-router@4.4.5(vue@3.5.13)', version: '4.4.5' },
        { node: 'vue-router@4.4.5(vue@3.5.14)', version: '4.4.5' },
      ],
    }
    assert.equal(missingSelectionText(selection, outcome), 'vue-router 4.4.5 is no longer in shop.')
    assert.deepEqual(
      followLinks(selection, outcome).map((link) => link.label),
      ['vue-router 4.4.5, variant 1 of 2 (vue 3.5.13)', 'vue-router 4.4.5, variant 2 of 2 (vue 3.5.14)'],
    )
  })

  it('numbers peer variants within each other root, not across roots', () => {
    const selection = { root: 'shop', node: 'vue-router@4.4.5(vue@3.5.12)' }
    const outcome = {
      kind: 'elsewhere' as const,
      roots: [
        { root: 'shop-npm', node: 'vue-router@4.4.5(vue@3.5.13)', version: '4.4.5' },
        { root: 'shop-npm', node: 'vue-router@4.4.5(vue@3.5.14)', version: '4.4.5' },
        { root: 'legacy', node: 'vue-router@4.4.5(vue@3.5.15)', version: '4.4.5' },
      ],
    }
    assert.deepEqual(
      followLinks(selection, outcome).map((link) => link.label),
      [
        'Open vue-router 4.4.5, variant 1 of 2 (vue 3.5.13) in shop-npm',
        'Open vue-router 4.4.5, variant 2 of 2 (vue 3.5.14) in shop-npm',
        'Open vue-router 4.4.5 in legacy',
      ],
    )
  })

  it('opens the same package in the other roots, naming any other version', () => {
    const outcome = {
      kind: 'elsewhere' as const,
      roots: [
        { root: 'shop-npm', node: 'child-lib@1.0.0', version: '1.0.0' },
        { root: 'legacy', node: 'child-lib@2.0.0', version: '2.0.0' },
      ],
    }
    assert.equal(missingSelectionText(CHILD_IN_SHOP, outcome), 'child-lib 1.0.0 is not in shop.')
    assert.deepEqual(followLinks(CHILD_IN_SHOP, outcome), [
      { label: 'Open in shop-npm', selection: { root: 'shop-npm', node: 'child-lib@1.0.0' }, opensRoot: true },
      { label: 'Open child-lib 2.0.0 in legacy', selection: { root: 'legacy', node: 'child-lib@2.0.0' }, opensRoot: true },
    ])
  })

  it('says the package is in no root and offers no link', () => {
    assert.equal(missingSelectionText(HELPER_IN_SHOP_NPM, { kind: 'gone' }), 'helper is not in any root.')
    assert.deepEqual(followLinks(HELPER_IN_SHOP_NPM, { kind: 'gone' }), [])
  })

  it('handles scoped names, peer suffixes and the repository root', () => {
    const choose = { kind: 'choose' as const, options: [] }
    assert.equal(missingSelectionText({ root: '.', node: '@vue/compiler-sfc@3.5.13(vue@3.5.13)' }, choose), '@vue/compiler-sfc 3.5.13 is no longer in repository root.')
    assert.equal(missingSelectionText({ root: 'legacy/admin', node: '@scope/pkg@2.0.0' }, choose), '@scope/pkg 2.0.0 is no longer in legacy/admin.')
    assert.equal(missingSelectionText({ root: 'shop', node: '@scope/pkg@2.0.0' }, { kind: 'gone' }), '@scope/pkg is not in any root.')
  })

  it('says a workspace package is no longer in its root', () => {
    const selection = { root: 'shop', node: 'importer:api' }
    assert.equal(missingSelectionText(selection, { kind: 'choose', options: [] }), 'api is no longer in shop.')
    assert.deepEqual(followLinks(selection, { kind: 'choose', options: [] }), [])
  })

  it('says a workspace package the root never had is not in it', () => {
    const selection = { root: 'shop', node: 'importer:api' }
    assert.equal(missingSelectionText(selection, { kind: 'elsewhere', roots: [] }), 'api is not in shop.')
    assert.deepEqual(followLinks(selection, { kind: 'elsewhere', roots: [] }), [])
  })
})

describe('followLinkAction', () => {
  const sameRootLink = { label: 'helper 1.2.0', selection: { root: 'shop-npm', node: 'helper@1.2.0' }, opensRoot: false }
  const otherRootLink = { label: 'Open in shop', selection: { root: 'shop', node: 'helper@1.2.0' }, opensRoot: true }
  const choose = { kind: 'choose' as const, options: [{ node: 'helper@1.2.0', version: '1.2.0' }] }
  const elsewhere = { kind: 'elsewhere' as const, roots: [{ root: 'shop-npm', node: 'helper@1.2.0', version: '1.2.0' }] }

  it('moves the anchor with the selection for a link under a choose outcome', () => {
    assert.equal(followLinkAction(choose, sameRootLink), 'choose')
  })

  it('only selects for a link under any other outcome', () => {
    assert.equal(followLinkAction(elsewhere, sameRootLink), 'select')
    assert.equal(followLinkAction(null, sameRootLink), 'select')
  })

  it('opens the other root for a link that opens a root', () => {
    assert.equal(followLinkAction(choose, otherRootLink), 'open-in-root')
    assert.equal(followLinkAction(elsewhere, otherRootLink), 'open-in-root')
  })
})

describe('movedVariants', () => {
  const OLD_NODE = 'react-dom@18.3.1(react@18.2.0)'
  const NEW_NODE = 'react-dom@18.3.1(react@18.3.1)'
  const hitsAfterMove: SearchHit[] = [{ name: 'react-dom', versions: [{ version: '18.3.1', roots: [{ rootId: 'shop', nodeId: NEW_NODE }] }] }] as SearchHit[]

  it('numbers the old and the new node together when the hits no longer hold the old one', () => {
    const variants = movedVariants(hitsAfterMove, 'react-dom', 'shop', OLD_NODE, NEW_NODE)
    assert.equal(variants?.from.position, 1)
    assert.equal(variants?.to.position, 2)
    assert.equal(variants?.to.count, 2)
  })

  it('produces the spec notice for a same-version move', () => {
    const variants = movedVariants(hitsAfterMove, 'react-dom', 'shop', OLD_NODE, NEW_NODE)
    assert.equal(
      followNotice(undefined, 'shop', 'react-dom', '18.3.1', '18.3.1', variants),
      'Changed in shop: react-dom 18.3.1 variant 1 of 2 (react 18.2.0) → variant 2 of 2 (react 18.3.1). Showing the new variant.',
    )
  })

  it('has no variants when the versions differ', () => {
    assert.equal(movedVariants(hitsAfterMove, 'react-dom', 'shop', 'react-dom@18.2.0', NEW_NODE), undefined)
  })
})
