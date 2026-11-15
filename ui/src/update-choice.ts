import type { NodeActions, UpdateActions, UpdateChoice, UpdateImporter, UpdateVersion } from '../../src/actions/types.ts'
import type { NodeId } from '../../src/model.ts'
import type { OutdatedLevel } from '../../src/query/versions.ts'
import {
  CURRENT,
  DEPRECATED,
  IN_RANGE,
  LATEST,
  MAJOR_UPDATE,
  NO_UPDATE_AVAILABLE,
  NOT_A_DIRECT_DEPENDENCY_UPDATE,
  nothingToFixText,
  peerRangeUnchangedText,
  staysInRangeText,
} from './vocabulary.ts'

type VersionParts = { major: number; minor: number; patch: number }

const VERSION_PLACEHOLDER = '<version>'
const LABEL_SEPARATOR = ' · '
const CHANGE_ARROW = ' → '
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

function partsOf(version: string): VersionParts | undefined {
  const match = VERSION_PATTERN.exec(version)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function updateLevel(current: string, target: string): OutdatedLevel | undefined {
  const from = partsOf(current)
  const to = partsOf(target)
  if (from === undefined || to === undefined) return undefined
  if (to.major !== from.major) return to.major > from.major ? 'major' : undefined
  if (to.minor !== from.minor) return to.minor > from.minor ? 'minor' : undefined
  return to.patch > from.patch ? 'patch' : undefined
}

function isMajorUpdate(current: string, target: string): boolean {
  return updateLevel(current, target) === 'major'
}

export function newerVersions(update: UpdateActions): UpdateVersion[] {
  const currentPosition = update.versions.findIndex((entry) => entry.version === update.current)
  return currentPosition === -1 ? update.versions : update.versions.slice(0, currentPosition)
}

export function selectableVersions(update: UpdateActions, showPrereleases: boolean): UpdateVersion[] {
  return newerVersions(update).filter((entry) => showPrereleases || !entry.prerelease)
}

export function nothingToDoText(actions: NodeActions): string | undefined {
  if (actions.unavailable !== undefined || actions.fix !== undefined) return undefined
  const update = actions.update
  if (update === undefined) return NOT_A_DIRECT_DEPENDENCY_UPDATE
  if (newerVersions(update).length > 0) return undefined
  const isPublished = update.versions.some((entry) => entry.version === update.current)
  return isPublished ? nothingToFixText(update.current) : NO_UPDATE_AVAILABLE
}

export function defaultUpdateVersion(update: UpdateActions, selectable: readonly UpdateVersion[]): string {
  const currentMajor = partsOf(update.current)?.major
  const inCurrentMajor = selectable.find((entry) => currentMajor !== undefined && partsOf(entry.version)?.major === currentMajor)
  return (inCurrentMajor ?? selectable[0])?.version ?? ''
}

function isInRange(version: string, update: UpdateActions): boolean {
  return update.wanted !== undefined && update.wanted !== update.current && version === update.wanted
}

function sizeMark(version: string, update: UpdateActions): OutdatedLevel | undefined {
  const level = updateLevel(update.current, version)
  return version === update.latest || level === 'major' ? level : undefined
}

export function versionLabel(version: UpdateVersion, update: UpdateActions): string {
  const marks = [
    version.version === update.latest ? LATEST : undefined,
    sizeMark(version.version, update),
    isInRange(version.version, update) ? IN_RANGE : undefined,
    version.version === update.current ? CURRENT : undefined,
    version.severity,
    version.deprecated ? DEPRECATED : undefined,
  ]
  return [version.version, ...marks.filter((mark) => mark !== undefined)].join(LABEL_SEPARATOR)
}

export function newSpecifier(importer: UpdateImporter, target: string): string | undefined {
  return importer.template?.replaceAll(VERSION_PLACEHOLDER, target)
}

export function importerChangeText(importer: UpdateImporter, target: string, relocksOnly: boolean): string {
  if (relocksOnly) return staysInRangeText(target)
  const next = newSpecifier(importer, target)
  return next === undefined ? importer.specifier : `${importer.specifier}${CHANGE_ARROW}${next}`
}

export function updateChoiceFor(update: UpdateActions, version: string): UpdateChoice {
  if (version === update.wanted) return 'wanted'
  return version === update.latest ? 'latest' : 'version'
}

export function updateWarnings(update: UpdateActions, target: string, selected: readonly NodeId[]): string[] {
  const majorWarnings = isMajorUpdate(update.current, target) ? [MAJOR_UPDATE] : []
  if (updateChoiceFor(update, target) === 'wanted') return majorWarnings
  const chosen = new Set(selected)
  const peerWarnings = update.importers.flatMap((importer) =>
    chosen.has(importer.id) && importer.peerRange !== undefined ? [peerRangeUnchangedText(importer.id, importer.peerRange)] : [],
  )
  return [...majorWarnings, ...peerWarnings]
}
