import type { GitRef, RefKind } from '../../src/git/ref-list.ts'
import type { GitInfo } from '../../src/server/branches.ts'
import { shortCommit, WORKING_KEY } from './source.ts'
import { CHECKED_OUT, headOptionLabel, LOCAL_BRANCHES, relativeTime, REMOTE_BRANCHES, TAGS, WORKING_TREE } from './vocabulary.ts'

export const PICKER_LIMIT = 100

export type PickerOption = { key: string; value: string; label: string; detail: string; checkedOut: boolean }
export type PickerGroup = { label: string; options: PickerOption[] }
export type PickerModel = { groups: PickerGroup[]; hiddenCount: number; optionCount: number }

type AvailableInfo = Extract<GitInfo, { available: true }>

const HEAD_VALUE = 'HEAD'
const REF_GROUPS: readonly [RefKind, string][] = [
  ['branch', LOCAL_BRANCHES],
  ['remote', REMOTE_BRANCHES],
  ['tag', TAGS],
]

function refOption(ref: GitRef, checkedOutBranch: string | undefined, now: number): PickerOption {
  const checkedOut = ref.name === checkedOutBranch
  return { key: `ref:${ref.name}`, value: ref.name, label: ref.short, detail: checkedOut ? CHECKED_OUT : relativeTime(ref.committedAt, now), checkedOut }
}

function workingGroupOptions(info: AvailableInfo, includeWorking: boolean): PickerOption[] {
  const options: PickerOption[] = []
  if (includeWorking) options.push({ key: 'working', value: WORKING_KEY, label: WORKING_TREE, detail: '', checkedOut: false })
  if (info.head !== undefined) options.push({ key: 'head', value: HEAD_VALUE, label: headOptionLabel(shortCommit(info.head.commit)), detail: '', checkedOut: false })
  return options
}

export function pickerModel(info: AvailableInfo, filter: string, options: { includeWorking: boolean; now: number }): PickerModel {
  const needle = filter.trim().toLowerCase()
  const matches = (option: PickerOption) => needle === '' || option.label.toLowerCase().includes(needle)
  const candidates: PickerGroup[] = [
    { label: WORKING_TREE, options: workingGroupOptions(info, options.includeWorking) },
    ...REF_GROUPS.map(([kind, label]) => ({
      label,
      options: info.refs.filter((ref) => ref.kind === kind).map((ref) => refOption(ref, info.head?.branch, options.now)),
    })),
  ]
  const groups: PickerGroup[] = []
  let optionCount = 0
  let hiddenCount = 0
  for (const candidate of candidates) {
    const shown: PickerOption[] = []
    for (const option of candidate.options.filter(matches)) {
      if (optionCount < PICKER_LIMIT) {
        shown.push(option)
        optionCount += 1
      } else {
        hiddenCount += 1
      }
    }
    if (shown.length > 0) groups.push({ label: candidate.label, options: shown })
  }
  return { groups, hiddenCount, optionCount }
}
