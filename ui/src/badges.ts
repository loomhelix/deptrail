import type { Severity } from '../../src/enrich/types.ts'
import type { NodeDecoration } from '../../src/query/decorations.ts'
import type { IssueKind, IssueRow } from '../../src/query/issues.ts'
import {
  DEPRECATED,
  DEPRECATED_TITLE,
  knownVulnerabilitiesTitle,
  MALICIOUS,
  updateBadgeTitle,
  updateLabelText,
  updateLevelTitle,
  vulnerableBelowShortText,
  vulnerableBelowText,
  vulnerableBelowTitle,
} from './vocabulary.ts'

export type BadgeTone = 'danger' | 'warn' | 'info' | 'neutral' | 'ok'
export type Badge = { key: string; label: string; tone: BadgeTone; outlined: boolean; title: string }
export type BadgeContext = { isDirect: boolean; compact: boolean; version: string }

const SEVERITY_TONES: Record<Severity, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  moderate: 'warn',
  low: 'neutral',
  unknown: 'neutral',
}

export function severityTone(severity: Severity): BadgeTone {
  return SEVERITY_TONES[severity]
}

export function vulnerabilityTone(vuln: NonNullable<NodeDecoration['vuln']>): BadgeTone {
  return vuln.malicious ? 'danger' : severityTone(vuln.severity)
}

function vulnerabilityBadge(vuln: NonNullable<NodeDecoration['vuln']>): Badge {
  return {
    key: 'vuln',
    label: vuln.malicious ? MALICIOUS : vuln.severity,
    tone: vulnerabilityTone(vuln),
    outlined: false,
    title: knownVulnerabilitiesTitle(vuln.count, vuln.severity),
  }
}

function rollUpBadge(below: NonNullable<NodeDecoration['below']>, compact: boolean): Badge {
  const { count, worst } = below
  const fullText = vulnerableBelowText(count, worst)
  return {
    key: 'below',
    label: compact ? vulnerableBelowShortText(count) : fullText,
    tone: severityTone(worst),
    outlined: true,
    title: compact ? fullText : vulnerableBelowTitle(count, worst),
  }
}

function deprecatedBadge(): Badge {
  return { key: 'deprecated', label: DEPRECATED, tone: 'warn', outlined: false, title: DEPRECATED_TITLE }
}

function outdatedBadge(outdated: NonNullable<NodeDecoration['outdated']>, version: string): Badge {
  return {
    key: 'outdated',
    label: updateLabelText(outdated.latest, outdated.level),
    tone: 'info',
    outlined: false,
    title: updateBadgeTitle(outdated.level, version, outdated.latest),
  }
}

export function nodeBadges(decoration: NodeDecoration | undefined, context: BadgeContext): Badge[] {
  if (decoration === undefined) return []
  const badges: Badge[] = []
  if (decoration.vuln) badges.push(vulnerabilityBadge(decoration.vuln))
  if (decoration.below) badges.push(rollUpBadge(decoration.below, context.compact))
  if (decoration.deprecated) badges.push(deprecatedBadge())
  if (decoration.outdated && context.isDirect) badges.push(outdatedBadge(decoration.outdated, context.version))
  return badges
}

export function issueProblemBadges(kind: IssueKind, row: IssueRow): Badge[] {
  if (kind === 'vulnerability' && row.severity !== undefined) {
    const vuln = { severity: row.severity, count: row.vulnIds.length, ...(row.malicious ? { malicious: true as const } : {}) }
    return nodeBadges({ vuln }, { isDirect: false, compact: false, version: row.version })
  }
  if (kind === 'deprecated') return nodeBadges({ deprecated: true }, { isDirect: false, compact: false, version: row.version })
  if (row.outdatedLevel === undefined) return []
  return [{ key: 'level', label: row.outdatedLevel, tone: 'info', outlined: false, title: updateLevelTitle(row.outdatedLevel) }]
}
