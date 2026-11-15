import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const FIX_BRANCH = 'fix/child-lib'
export const FIX_REF = 'refs/heads/fix/child-lib'
export const DEFAULT_REF = 'refs/remotes/origin/main'
export const RELEASE_TAG = 'v1.0.0'

export type GitHistory = { initial: string; fix: string; main: string }

const FIXTURE_GIT_CONFIG = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null']

function fixtureEnvironment(home: string): Record<string, string> {
  const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_'))
  return { ...Object.fromEntries(inherited), HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
}

async function editDependencies(manifestPath: string, changes: Record<string, string>): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
  Object.assign(manifest.dependencies, changes)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function gitHomeOf(repoDir: string): string {
  return path.join(path.dirname(repoDir), 'git-home')
}

export function fixtureGit(repoDir: string): (args: string[]) => string {
  const env = fixtureEnvironment(gitHomeOf(repoDir))
  return (args) => execFileSync('git', [...FIXTURE_GIT_CONFIG, ...args], { cwd: repoDir, env, encoding: 'utf8' }).trim()
}

export async function initGitHistory(repoDir: string, shopDir: string, relock: () => Promise<void>, reveal: () => void): Promise<GitHistory> {
  await mkdir(gitHomeOf(repoDir), { recursive: true })
  const git = fixtureGit(repoDir)

  git(['init', '-q'])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  const initial = git(['rev-parse', 'HEAD'])
  git(['tag', '-a', RELEASE_TAG, '-m', RELEASE_TAG])
  reveal()

  git(['checkout', '-q', '-b', FIX_BRANCH])
  await editDependencies(path.join(shopDir, 'web', 'package.json'), { 'parent-lib': '1.1.0' })
  await editDependencies(path.join(shopDir, 'api', 'package.json'), { helper: '^1.1.0' })
  await relock()
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'fix child-lib'])
  const fix = git(['rev-parse', 'HEAD'])

  git(['checkout', '-q', 'main'])
  await editDependencies(path.join(shopDir, 'web', 'package.json'), { toolkit: '^3.0.0' })
  await relock()
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'toolkit 3'])
  const main = git(['rev-parse', 'HEAD'])
  git(['update-ref', DEFAULT_REF, main])
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', DEFAULT_REF])
  return { initial, fix, main }
}
