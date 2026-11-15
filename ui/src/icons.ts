export const ICON_NAMES = ['chevron-right', 'chevron-down', 'chevron-up', 'chevrons-left', 'chevrons-right', 'x', 'check', 'git-branch'] as const
export type IconName = (typeof ICON_NAMES)[number]

export const ICON_PATHS: Readonly<Record<IconName, string>> = {
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-up': 'm18 15-6-6-6 6',
  'chevrons-left': 'm11 17-5-5 5-5M18 17l-5-5 5-5',
  'chevrons-right': 'm6 17 5-5-5-5M13 17l5-5-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  'git-branch': 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
}
