import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

export type AxeException = { id: string; reason: string }

type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number]

const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const TARGET_SIZE_RULE = 'target-size'

function describeViolation(violation: AxeViolation): string {
  const targets = violation.nodes.map((node) => `    ${node.target.join(' ')}`)
  return [`${violation.id} (${violation.impact ?? 'unknown impact'}): ${violation.help}`, ...targets].join('\n')
}

export async function expectNoAxeViolations(page: Page, screen: string, exceptions: readonly AxeException[] = []): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(WCAG_AA_TAGS)
  if (exceptions.length > 0) builder.disableRules(exceptions.map((exception) => exception.id))
  const { violations, incomplete } = await builder.analyze()
  const report = violations.map(describeViolation).join('\n')
  expect(violations.map((violation) => violation.id), `axe found violations on ${screen}:\n${report}`).toEqual([])
  const unconfirmedTargets = incomplete.filter((result) => result.id === TARGET_SIZE_RULE)
  const targetReport = unconfirmedTargets.map(describeViolation).join('\n')
  expect(unconfirmedTargets.flatMap((result) => result.nodes.map((node) => node.target.join(' '))), `axe could not confirm 24 px targets on ${screen}:\n${targetReport}`).toEqual([])
}
