import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { UpdateActions, UpdateImporter } from '../src/actions/types.ts'
import {
  defaultUpdateVersion,
  importerChangeText,
  newerVersions,
  nothingToDoText,
  newSpecifier,
  selectableVersions,
  updateChoiceFor,
  updateWarnings,
  versionLabel,
} from '../ui/src/update-choice.ts'

function importer(fields: Partial<UpdateImporter> & Pick<UpdateImporter, 'id'>): UpdateImporter {
  return { field: 'dependencies', specifier: '^2.0.0', editable: true, template: '^<version>', ...fields }
}

function toolkitUpdate(fields: Partial<UpdateActions> = {}): UpdateActions {
  return {
    name: 'toolkit',
    current: '2.0.0',
    wanted: '2.1.0',
    latest: '3.0.0',
    versions: [{ version: '3.0.0' }, { version: '2.1.0' }, { version: '2.0.0' }],
    importers: [importer({ id: 'importer:web' }), importer({ id: 'importer:api' })],
    ...fields,
  }
}

function parentLibUpdate(fields: Partial<UpdateActions> = {}): UpdateActions {
  return {
    name: 'parent-lib',
    current: '1.0.0',
    wanted: '1.0.0',
    latest: '1.1.0',
    versions: [{ version: '1.1.0' }, { version: '1.0.0' }],
    importers: [importer({ id: 'importer:web', specifier: '1.0.0', template: '<version>' })],
    ...fields,
  }
}

describe('defaultUpdateVersion', () => {
  it('picks the newest version in the current major over a newer major', () => {
    const update = toolkitUpdate()
    assert.equal(defaultUpdateVersion(update, selectableVersions(update, false)), '2.1.0')
  })

  it('picks the newest version when only majors are newer', () => {
    const update = toolkitUpdate({ wanted: undefined, versions: [{ version: '3.0.0' }, { version: '2.0.0' }] })
    assert.equal(defaultUpdateVersion(update, selectableVersions(update, false)), '3.0.0')
  })

  it('picks the newest of several versions in the current major', () => {
    const update = toolkitUpdate({ versions: [{ version: '3.1.0' }, { version: '3.0.0' }, { version: '2.2.0' }, { version: '2.1.0' }, { version: '2.0.0' }] })
    assert.equal(defaultUpdateVersion(update, selectableVersions(update, false)), '2.2.0')
  })

  it('treats a prerelease of the current major as the current major once prereleases are shown', () => {
    const update = toolkitUpdate({ versions: [{ version: '3.0.0' }, { version: '2.2.0-beta.1', prerelease: true }, { version: '2.1.0' }, { version: '2.0.0' }] })
    assert.equal(defaultUpdateVersion(update, selectableVersions(update, true)), '2.2.0-beta.1')
    assert.equal(defaultUpdateVersion(update, selectableVersions(update, false)), '2.1.0')
  })

  it('falls back to the newest version when the current version cannot be read', () => {
    const update = toolkitUpdate({ current: 'not-a-version', versions: [{ version: '3.0.0' }, { version: '2.1.0' }] })
    assert.equal(defaultUpdateVersion(update, update.versions), '3.0.0')
  })

  it('has no default without a selectable version', () => {
    assert.equal(defaultUpdateVersion(toolkitUpdate(), []), '')
  })
})

describe('newerVersions and selectableVersions', () => {
  it('lists the versions newer than the current one, newest first', () => {
    assert.deepEqual(
      newerVersions(toolkitUpdate()).map((entry) => entry.version),
      ['3.0.0', '2.1.0'],
    )
  })

  it('hides prereleases until they are shown', () => {
    const update = toolkitUpdate({ versions: [{ version: '3.0.0-rc.1', prerelease: true }, { version: '2.1.0' }, { version: '2.0.0' }] })
    assert.deepEqual(selectableVersions(update, false).map((entry) => entry.version), ['2.1.0'])
    assert.deepEqual(selectableVersions(update, true).map((entry) => entry.version), ['3.0.0-rc.1', '2.1.0'])
  })
})

describe('versionLabel', () => {
  it('marks the latest version with its update size', () => {
    assert.equal(versionLabel({ version: '1.1.0' }, parentLibUpdate()), '1.1.0 · latest · minor')
    assert.equal(versionLabel({ version: '3.0.0' }, toolkitUpdate()), '3.0.0 · latest · major')
    assert.equal(versionLabel({ version: '2.0.1' }, toolkitUpdate({ latest: '2.0.1' })), '2.0.1 · latest · patch')
  })

  it('marks the version in range only when it differs from the current one', () => {
    assert.equal(versionLabel({ version: '2.1.0' }, toolkitUpdate()), '2.1.0 · in range')
    assert.equal(versionLabel({ version: '1.0.0' }, parentLibUpdate()), '1.0.0 · current')
    assert.equal(versionLabel({ version: '1.1.0' }, parentLibUpdate({ wanted: undefined })), '1.1.0 · latest · minor')
  })

  it('marks a major update that is not the latest version', () => {
    const update = toolkitUpdate({ latest: '3.1.0' })
    assert.equal(versionLabel({ version: '3.0.0' }, update), '3.0.0 · major')
    assert.equal(versionLabel({ version: '2.0.5' }, update), '2.0.5')
  })

  it('marks the current version', () => {
    assert.equal(versionLabel({ version: '2.0.0' }, toolkitUpdate()), '2.0.0 · current')
  })

  it('adds the severity and deprecated after the marks', () => {
    assert.equal(versionLabel({ version: '3.0.0', severity: 'moderate', deprecated: true }, toolkitUpdate()), '3.0.0 · latest · major · moderate · deprecated')
    assert.equal(versionLabel({ version: '2.1.0', severity: 'low' }, toolkitUpdate()), '2.1.0 · in range · low')
    assert.equal(versionLabel({ version: '2.0.0', severity: 'high' }, toolkitUpdate()), '2.0.0 · current · high')
    assert.equal(versionLabel({ version: '1.9.0', deprecated: true }, toolkitUpdate()), '1.9.0 · deprecated')
  })

  it('names the latest and in range version once with both marks', () => {
    const helper: UpdateActions = { ...parentLibUpdate(), name: 'helper', wanted: '1.1.0' }
    assert.equal(versionLabel({ version: '1.1.0' }, helper), '1.1.0 · latest · minor · in range')
  })
})

describe('importerChangeText', () => {
  it('shows the range change of a workspace package', () => {
    assert.equal(importerChangeText(importer({ id: 'importer:api', specifier: '^1.0.0' }), '1.1.0', false), '^1.0.0 → ^1.1.0')
    assert.equal(importerChangeText(importer({ id: 'importer:web', specifier: '1.0.0', template: '<version>' }), '1.1.0', false), '1.0.0 → 1.1.0')
  })

  it('says the range stays for a re-lock', () => {
    assert.equal(importerChangeText(importer({ id: 'importer:api', specifier: '^1.0.0' }), '1.1.0', true), 'unchanged (1.1.0 is in range)')
  })

  it('keeps the range of a workspace package that cannot be edited', () => {
    const fixed = importer({ id: 'importer:web', specifier: 'workspace:*', editable: false, template: undefined, reason: 'workspace:* has no version range' })
    assert.equal(importerChangeText(fixed, '3.0.0', false), 'workspace:*')
  })
})

describe('newSpecifier', () => {
  it('puts the target version into the template', () => {
    assert.equal(newSpecifier(importer({ id: 'importer:web' }), '3.0.0'), '^3.0.0')
    assert.equal(newSpecifier(importer({ id: 'importer:web', template: 'npm:rolldown-vite@~<version>' }), '7.1.2'), 'npm:rolldown-vite@~7.1.2')
  })

  it('has no new specifier for an importer that cannot be edited', () => {
    assert.equal(newSpecifier({ id: 'importer:web', field: 'dependencies', specifier: 'workspace:*', editable: false, reason: 'workspace:* has no version range' }, '3.0.0'), undefined)
  })
})

describe('updateWarnings', () => {
  it('warns about a major update', () => {
    assert.deepEqual(updateWarnings(toolkitUpdate(), '3.0.0', ['importer:web']), ['major update'])
    assert.deepEqual(updateWarnings(toolkitUpdate(), '2.1.0', ['importer:web']), [])
    assert.deepEqual(updateWarnings(toolkitUpdate({ current: '0.9.0' }), '1.0.0-beta.1', []), ['major update'])
    assert.deepEqual(updateWarnings(toolkitUpdate({ current: 'not-a-version' }), '3.0.0', []), [])
  })

  it('names the selected importers whose peerDependencies range stays', () => {
    const update = toolkitUpdate({
      importers: [importer({ id: 'importer:web', peerRange: '^2' }), importer({ id: 'importer:api', peerRange: '>=2' }), importer({ id: 'importer:.' })],
    })
    assert.deepEqual(updateWarnings(update, '3.0.0', ['importer:web', 'importer:.']), ['major update', 'web: peerDependencies ^2 unchanged'])
    assert.deepEqual(updateWarnings(update, '2.2.0', ['importer:api', 'importer:web']), ['web: peerDependencies ^2 unchanged', 'api: peerDependencies >=2 unchanged'])
  })

  it('gives no peerDependencies warning for the wanted version, which only re-locks', () => {
    const importers = [importer({ id: 'importer:web', peerRange: '^2' })]
    assert.deepEqual(updateWarnings(toolkitUpdate({ importers }), '2.1.0', ['importer:web']), [])
    assert.deepEqual(updateWarnings(toolkitUpdate({ importers, wanted: '3.0.0' }), '3.0.0', ['importer:web']), ['major update'])
  })
})

describe('updateChoiceFor', () => {
  it('re-locks to the wanted version, raises ranges to latest and to any other version', () => {
    const update = toolkitUpdate()
    assert.equal(updateChoiceFor(update, '2.1.0'), 'wanted')
    assert.equal(updateChoiceFor(update, '3.0.0'), 'latest')
    assert.equal(updateChoiceFor(update, '2.0.5'), 'version')
  })

  it('prefers the re-lock when the wanted version is also the latest', () => {
    assert.equal(updateChoiceFor(toolkitUpdate({ wanted: '3.0.0' }), '3.0.0'), 'wanted')
  })

  it('picks a version when there is no wanted or latest version', () => {
    assert.equal(updateChoiceFor(toolkitUpdate({ wanted: undefined, latest: undefined }), '3.0.0'), 'version')
  })
})

describe('nothingToDoText', () => {
  it('names the current version of a direct dependency that is already the latest', () => {
    const atLatest = toolkitUpdate({ current: '3.0.0', wanted: undefined, latest: undefined })
    assert.equal(nothingToDoText({ update: atLatest }), 'Up to date: 3.0.0 is the latest version.')
  })

  it('says updates are offered for direct dependencies when the package is not one', () => {
    assert.equal(nothingToDoText({}), 'Updates are offered for direct dependencies of a workspace package.')
  })

  it('says no update is available without registry data', () => {
    const unknown = toolkitUpdate({ wanted: undefined, latest: undefined, versions: [] })
    assert.equal(nothingToDoText({ update: unknown }), 'No update available.')
  })

  it('never names a latest dist-tag older than a prerelease current version', () => {
    const prerelease = toolkitUpdate({
      current: '2.0.0-beta.1',
      wanted: undefined,
      latest: '1.9.0',
      versions: [{ version: '2.0.0-beta.1', prerelease: true }, { version: '1.9.0' }],
    })
    assert.equal(nothingToDoText({ update: prerelease }), 'Up to date: 2.0.0-beta.1 is the latest version.')
  })

  it('has no text when there is a fix, a newer version or a reason the actions are unavailable', () => {
    const fix = { goal: { kind: 'fix' as const, name: 'child-lib', version: '1.0.0', advisoryIds: [], severity: 'high' as const }, options: [], unavailable: [] }
    assert.equal(nothingToDoText({ fix }), undefined)
    assert.equal(nothingToDoText({ update: toolkitUpdate() }), undefined)
    assert.equal(nothingToDoText({ unavailable: 'Actions are off in offline mode' }), undefined)
  })
})
