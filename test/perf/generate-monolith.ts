import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type MonolithOptions = { roots: number; packagesPerRoot: number; seed: number }

type GeneratedPackage = { name: string; version: string; integrity: string; nodeEngine: string | null; deps: number[] }
type DirectDependency = { name: string; version: string; dev: boolean }
type Random = () => number

const SHARED_PACKAGE_NAME = 'tslib'
const SHARED_PACKAGE_SHARE = 0.3
const MAX_DEPENDENCIES = 8
const DIRECT_DEPENDENCY_COUNT = 20
const DEV_DEPENDENCY_COUNT = 5
const DIRECT_DEPENDENCY_POOL_SHARE = 0.05
const VARYING_VERSION_SHARE = 0.1
const VARYING_VERSION_SPREAD = 3
const NODE_ENGINE_SHARE = 0.4
const INTEGRITY_BYTES = 64
const NODE_ENGINES = ['>=8', '>=12', '>=14.17', '>=16', '>=18', '^18.18.0 || >=20.0.0']

function mulberry32(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function randomInt(random: Random, exclusiveMax: number): number {
  return Math.floor(random() * exclusiveMax)
}

function integrityOf(random: Random): string {
  const bytes = Buffer.alloc(INTEGRITY_BYTES)
  for (let index = 0; index < INTEGRITY_BYTES; index++) bytes[index] = randomInt(random, 256)
  return `sha512-${bytes.toString('base64')}`
}

function pickDistinct(random: Random, from: number, to: number, count: number): number[] {
  const available = to - from
  const picked = new Set<number>()
  while (picked.size < Math.min(count, available)) picked.add(from + randomInt(random, available))
  return [...picked]
}

function versionOf(index: number, rootIndex: number, varyingNames: ReadonlySet<number>): string {
  const minor = index % 10
  if (!varyingNames.has(index)) return `1.${minor}.0`
  return `${1 + (rootIndex % VARYING_VERSION_SPREAD)}.${minor}.0`
}

function generatePackages(random: Random, rootIndex: number, count: number, varyingNames: ReadonlySet<number>): GeneratedPackage[] {
  const sharedIndex = count - 1
  const packages: GeneratedPackage[] = []
  for (let index = 0; index < sharedIndex; index++) {
    const dependsOnShared = random() < SHARED_PACKAGE_SHARE
    const otherCount = randomInt(random, MAX_DEPENDENCIES + (dependsOnShared ? 0 : 1))
    const deps = pickDistinct(random, index + 1, sharedIndex, otherCount)
    if (dependsOnShared) deps.push(sharedIndex)
    packages.push({
      name: `pkg-${index}`,
      version: versionOf(index, rootIndex, varyingNames),
      integrity: integrityOf(random),
      nodeEngine: random() < NODE_ENGINE_SHARE ? NODE_ENGINES[randomInt(random, NODE_ENGINES.length)]! : null,
      deps,
    })
  }
  packages.push({
    name: SHARED_PACKAGE_NAME,
    version: `2.6.${rootIndex % VARYING_VERSION_SPREAD}`,
    integrity: integrityOf(random),
    nodeEngine: null,
    deps: [],
  })
  return packages
}

function pickDirectDependencies(random: Random, packages: GeneratedPackage[]): DirectDependency[] {
  const pool = Math.max(DIRECT_DEPENDENCY_COUNT, Math.floor(packages.length * DIRECT_DEPENDENCY_POOL_SHARE))
  return pickDistinct(random, 0, Math.min(pool, packages.length), DIRECT_DEPENDENCY_COUNT)
    .map((index, position) => ({ name: packages[index]!.name, version: packages[index]!.version, dev: position < DEV_DEPENDENCY_COUNT }))
    .sort((left, right) => compareText(left.name, right.name))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function importerBlock(heading: string, dependencies: DirectDependency[]): string[] {
  if (dependencies.length === 0) return []
  const lines = [`    ${heading}:`]
  for (const dependency of dependencies) {
    lines.push(`      ${dependency.name}:`, `        specifier: ^${dependency.version}`, `        version: ${dependency.version}`)
  }
  return lines
}

function lockfileText(packages: GeneratedPackage[], direct: DirectDependency[]): string {
  const sorted = [...packages].sort((left, right) => compareText(left.name, right.name))
  const lines = [
    `lockfileVersion: '9.0'`,
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    ...importerBlock('dependencies', direct.filter((dependency) => !dependency.dev)),
    ...importerBlock('devDependencies', direct.filter((dependency) => dependency.dev)),
    '',
    'packages:',
    '',
  ]
  for (const generated of sorted) {
    lines.push(`  ${generated.name}@${generated.version}:`, `    resolution: {integrity: ${generated.integrity}}`)
    if (generated.nodeEngine !== null) lines.push(`    engines: {node: '${generated.nodeEngine}'}`)
    lines.push('')
  }
  lines.push('snapshots:', '')
  for (const generated of sorted) {
    const key = `  ${generated.name}@${generated.version}:`
    if (generated.deps.length === 0) {
      lines.push(`${key} {}`, '')
      continue
    }
    lines.push(key, '    dependencies:')
    const targets = generated.deps.map((index) => packages[index]!).sort((left, right) => compareText(left.name, right.name))
    for (const target of targets) lines.push(`      ${target.name}: ${target.version}`)
    lines.push('')
  }
  return lines.join('\n')
}

function manifestText(rootIndex: number, direct: DirectDependency[]): string {
  const rangesOf = (dependencies: DirectDependency[]) =>
    Object.fromEntries(dependencies.map((dependency) => [dependency.name, `^${dependency.version}`]))
  const manifest = {
    name: `@perf/root-${rootIndex}`,
    private: true,
    dependencies: rangesOf(direct.filter((dependency) => !dependency.dev)),
    devDependencies: rangesOf(direct.filter((dependency) => dependency.dev)),
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function pickVaryingNames(random: Random, count: number): Set<number> {
  const varying = new Set<number>()
  for (let index = 0; index < count; index++) if (random() < VARYING_VERSION_SHARE) varying.add(index)
  return varying
}

export async function generateMonolith(dir: string, options: MonolithOptions): Promise<void> {
  const random = mulberry32(options.seed)
  const varyingNames = pickVaryingNames(random, options.packagesPerRoot)
  for (let rootIndex = 0; rootIndex < options.roots; rootIndex++) {
    const packages = generatePackages(random, rootIndex, options.packagesPerRoot, varyingNames)
    const direct = pickDirectDependencies(random, packages)
    const rootDir = path.join(dir, `root-${rootIndex}`)
    await mkdir(rootDir, { recursive: true })
    await writeFile(path.join(rootDir, 'package.json'), manifestText(rootIndex, direct))
    await writeFile(path.join(rootDir, 'pnpm-lock.yaml'), lockfileText(packages, direct))
  }
}
