import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  PartialWriteError,
  RevertConflictError,
  changedSinceWrite,
  changedSources,
  revertWrittenFiles,
  writePreviewFiles,
} from '../src/actions/apply.ts'
import { OutsideScopeError, hashSources, type FileScope } from '../src/actions/file-scope.ts'
import { LockingOriginals } from './helpers/locking-originals.ts'

const tempDirs: string[] = []
const lockedDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deptrail-apply-test-'))
  tempDirs.push(dir)
  return dir
}

async function writeRelative(root: string, relative: string, text: string) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
}

async function makeRoot(): Promise<{ parent: string; root: string }> {
  const parent = await makeTempDir()
  const root = path.join(parent, 'root')
  await mkdir(root)
  await writeRelative(root, 'package.json', '{"name":"root"}\n')
  await writeRelative(root, 'storefront/package.json', '{"name":"storefront"}\n')
  await writeRelative(root, 'pnpm-lock.yaml', 'lock: old\n')
  return { parent, root }
}

async function readOriginals(root: string, paths: string[]): Promise<Map<string, string | null>> {
  return new Map(
    await Promise.all(paths.map(async (relative) => [relative, await readFile(path.join(root, relative), 'utf8').catch(() => null)] as const)),
  )
}

function scopeOf(root: string, outsideManifests: readonly string[] = []): FileScope {
  return { rootDir: root, repoDir: path.dirname(root), outsideManifests }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

afterEach(async () => {
  for (const dir of lockedDirs.splice(0)) await chmod(dir, 0o755).catch(() => undefined)
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('changedSources', () => {
  it('reports nothing when sources are unchanged', async () => {
    const { root } = await makeRoot()
    await writeRelative(root, '.npmrc', 'a=b\n')
    const sources = await hashSources(scopeOf(root), ['.npmrc', 'pnpm-workspace.yaml', 'package.json'])
    assert.deepEqual(await changedSources(scopeOf(root), sources), [])
  })

  it('reports an edited source and a created one', async () => {
    const { root } = await makeRoot()
    await writeRelative(root, '.npmrc', 'a=b\n')
    const sources = await hashSources(scopeOf(root), ['.npmrc', 'pnpm-workspace.yaml'])
    await writeRelative(root, '.npmrc', 'a=c\n')
    assert.deepEqual(await changedSources(scopeOf(root), sources), ['.npmrc'])
    await writeRelative(root, 'pnpm-workspace.yaml', 'packages: []\n')
    assert.deepEqual(await changedSources(scopeOf(root), sources), ['.npmrc', 'pnpm-workspace.yaml'])
  })
})

describe('writePreviewFiles', () => {
  it('writes the files and reports their hashes', async () => {
    const { root } = await makeRoot()
    const paths = ['package.json', 'storefront/package.json', 'pnpm-lock.yaml']
    const originals = await readOriginals(root, paths)
    const written = new Map([
      ['pnpm-lock.yaml', 'lock: new\n'],
      ['storefront/package.json', '{"name":"storefront","v":2}\n'],
      ['package.json', '{"name":"root","v":2}\n'],
    ])
    const files = await writePreviewFiles(scopeOf(root), written, 'pnpm-lock.yaml', originals)
    assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), '{"name":"root","v":2}\n')
    assert.equal(await readFile(path.join(root, 'storefront/package.json'), 'utf8'), '{"name":"storefront","v":2}\n')
    assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: new\n')
    assert.deepEqual([...files.hashes.keys()], ['package.json', 'storefront/package.json', 'pnpm-lock.yaml'])
    assert.deepEqual(files.hashes, await hashSources(scopeOf(root), paths))
    assert.deepEqual(files.originals, originals)
    assert.deepEqual(await changedSinceWrite(scopeOf(root), files), [])
  })

  it('keeps the mode of an existing file', async () => {
    const { root } = await makeRoot()
    await chmod(path.join(root, 'package.json'), 0o640)
    const originals = await readOriginals(root, ['package.json', 'pnpm-lock.yaml'])
    await writePreviewFiles(scopeOf(root), new Map([['package.json', '{}\n'], ['pnpm-lock.yaml', 'x\n']]), 'pnpm-lock.yaml', originals)
    assert.equal((await stat(path.join(root, 'package.json'))).mode & 0o777, 0o640)
  })

  it('writes through a symlink that points inside the root', async () => {
    const { root } = await makeRoot()
    await mkdir(path.join(root, 'web'))
    await symlink('../storefront/package.json', path.join(root, 'web/package.json'))
    const originals = await readOriginals(root, ['web/package.json', 'pnpm-lock.yaml'])
    await writePreviewFiles(scopeOf(root), new Map([['web/package.json', '{"linked":true}\n'], ['pnpm-lock.yaml', 'x\n']]), 'pnpm-lock.yaml', originals)
    assert.equal((await lstat(path.join(root, 'web/package.json'))).isSymbolicLink(), true)
    assert.equal(await readFile(path.join(root, 'storefront/package.json'), 'utf8'), '{"linked":true}\n')
  })

  it('refuses paths outside the root and writes nothing', async () => {
    const { parent, root } = await makeRoot()
    await mkdir(path.join(parent, 'outside'))
    await writeRelative(parent, 'outside/package.json', 'outside\n')
    await writeRelative(parent, 'outside/target.json', 'target\n')
    await symlink('../outside/target.json', path.join(root, 'escape.json'))
    const originals = new Map<string, string | null>([['package.json', '{"name":"root"}\n'], ['pnpm-lock.yaml', 'lock: old\n']])
    for (const escaping of ['../outside/package.json', 'escape.json']) {
      await assert.rejects(
        writePreviewFiles(scopeOf(root), new Map([['package.json', 'changed\n'], [escaping, 'changed\n'], ['pnpm-lock.yaml', 'changed\n']]), 'pnpm-lock.yaml', originals),
        OutsideScopeError,
      )
      assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), '{"name":"root"}\n')
      assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: old\n')
      assert.equal(await readFile(path.join(parent, 'outside/package.json'), 'utf8'), 'outside\n')
      assert.equal(await readFile(path.join(parent, 'outside/target.json'), 'utf8'), 'target\n')
    }
  })

  it('restores written files when a later write fails', async () => {
    const { root } = await makeRoot()
    const originals = await readOriginals(root, ['package.json', 'storefront/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    const lockedDir = path.join(root, 'storefront')
    await chmod(lockedDir, 0o555)
    lockedDirs.push(lockedDir)
    await assert.rejects(
      writePreviewFiles(
        scopeOf(root),
        new Map([
          ['package.json', 'changed\n'],
          ['pnpm-workspace.yaml', 'packages: []\n'],
          ['storefront/package.json', 'changed\n'],
          ['pnpm-lock.yaml', 'changed\n'],
        ]),
        'pnpm-lock.yaml',
        originals,
      ),
      { code: 'EACCES' },
    )
    assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), '{"name":"root"}\n')
    assert.equal(await stat(path.join(root, 'pnpm-workspace.yaml')).catch(() => null), null)
    assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: old\n')
    assert.equal(await readFile(path.join(root, 'storefront/package.json'), 'utf8'), '{"name":"storefront"}\n')
  })

  it('names the files it could not restore and keeps them for a revert', async () => {
    const { root } = await makeRoot()
    await writeRelative(root, 'packages/one/package.json', '{"name":"one"}\n')
    const read = await readOriginals(root, ['package.json', 'packages/one/package.json', 'storefront/package.json', 'pnpm-lock.yaml'])
    const stuckDir = path.join(root, 'packages/one')
    const lockedDir = path.join(root, 'storefront')
    lockedDirs.push(stuckDir, lockedDir)
    await chmod(lockedDir, 0o555)
    const originals = new LockingOriginals(read, 'packages/one/package.json', stuckDir)
    const written = new Map([
      ['package.json', 'changed root\n'],
      ['packages/one/package.json', 'changed one\n'],
      ['storefront/package.json', 'changed storefront\n'],
      ['pnpm-lock.yaml', 'changed lock\n'],
    ])
    let unrestored: PartialWriteError['unrestored'] | undefined
    await assert.rejects(writePreviewFiles(scopeOf(root), written, 'pnpm-lock.yaml', originals), (failure: unknown) => {
      assert.ok(failure instanceof PartialWriteError, String(failure))
      assert.equal(failure.name, 'PartialWriteError')
      assert.match(failure.message, /^could not write storefront\/package\.json: EACCES: permission denied, .+; could not restore packages\/one\/package\.json$/)
      unrestored = failure.unrestored
      return true
    })
    assert.deepEqual(unrestored?.originals, new Map([['packages/one/package.json', '{"name":"one"}\n']]))
    assert.deepEqual(unrestored?.hashes, new Map([['packages/one/package.json', sha256('changed one\n')]]))
    assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), '{"name":"root"}\n')
    assert.equal(await readFile(path.join(root, 'packages/one/package.json'), 'utf8'), 'changed one\n')
    assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: old\n')
    await chmod(stuckDir, 0o755)
    await revertWrittenFiles(scopeOf(root), unrestored as PartialWriteError['unrestored'])
    assert.equal(await readFile(path.join(root, 'packages/one/package.json'), 'utf8'), '{"name":"one"}\n')
  })
})

describe('revertWrittenFiles', () => {
  async function applyEdits(root: string) {
    const originals = await readOriginals(root, ['package.json', 'storefront/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    const files = await writePreviewFiles(
      scopeOf(root),
      new Map([
        ['package.json', 'edited root\n'],
        ['storefront/package.json', 'edited storefront\n'],
        ['pnpm-workspace.yaml', 'packages: []\n'],
        ['pnpm-lock.yaml', 'lock: new\n'],
      ]),
      'pnpm-lock.yaml',
      originals,
    )
    return files
  }

  it('restores originals and deletes created files', async () => {
    const { root } = await makeRoot()
    const files = await applyEdits(root)
    await revertWrittenFiles(scopeOf(root), files)
    assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), '{"name":"root"}\n')
    assert.equal(await readFile(path.join(root, 'storefront/package.json'), 'utf8'), '{"name":"storefront"}\n')
    assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: old\n')
    assert.equal(await stat(path.join(root, 'pnpm-workspace.yaml')).catch(() => null), null)
  })

  it('refuses and changes nothing after a user edit', async () => {
    const { root } = await makeRoot()
    const files = await applyEdits(root)
    await writeRelative(root, 'storefront/package.json', 'user edit\n')
    await assert.rejects(revertWrittenFiles(scopeOf(root), files), (failure: unknown) => {
      assert.ok(failure instanceof RevertConflictError)
      assert.deepEqual(failure.paths, ['storefront/package.json'])
      return true
    })
    assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), 'edited root\n')
    assert.equal(await readFile(path.join(root, 'storefront/package.json'), 'utf8'), 'user edit\n')
    assert.equal(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'), 'packages: []\n')
  })
})

describe('declared outside manifests', () => {
  const outside = '../libs/ui/package.json'

  async function makeWorkspace() {
    const layout = await makeRoot()
    await writeRelative(layout.parent, 'libs/ui/package.json', '{"name":"ui"}\n')
    return layout
  }

  it('writes a declared outside manifest and reverts it', async () => {
    const { root } = await makeWorkspace()
    const scope = scopeOf(root, [outside])
    const originals = await readOriginals(root, [outside, 'pnpm-lock.yaml'])
    const files = await writePreviewFiles(scope, new Map([[outside, 'ui new\n'], ['pnpm-lock.yaml', 'lock: new\n']]), 'pnpm-lock.yaml', originals)
    assert.equal(await readFile(path.join(root, outside), 'utf8'), 'ui new\n')
    assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: new\n')
    await revertWrittenFiles(scope, files)
    assert.equal(await readFile(path.join(root, outside), 'utf8'), '{"name":"ui"}\n')
    assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: old\n')
  })

  it('refuses an undeclared outside manifest and writes nothing', async () => {
    const { root } = await makeWorkspace()
    const originals = await readOriginals(root, [outside, 'pnpm-lock.yaml'])
    await assert.rejects(
      writePreviewFiles(scopeOf(root), new Map([[outside, 'ui new\n'], ['pnpm-lock.yaml', 'lock: new\n']]), 'pnpm-lock.yaml', originals),
      OutsideScopeError,
    )
    assert.equal(await readFile(path.join(root, outside), 'utf8'), '{"name":"ui"}\n')
    assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: old\n')
  })

  it('refuses to write a declared outside manifest without an original and writes nothing', async () => {
    const { root } = await makeWorkspace()
    const originals = await readOriginals(root, ['pnpm-lock.yaml'])
    await assert.rejects(
      writePreviewFiles(scopeOf(root, [outside]), new Map([[outside, 'ui new\n'], ['pnpm-lock.yaml', 'lock: new\n']]), 'pnpm-lock.yaml', originals),
      (failure: unknown) => failure instanceof OutsideScopeError && failure.message.includes(outside),
    )
    assert.equal(await readFile(path.join(root, outside), 'utf8'), '{"name":"ui"}\n')
    assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: old\n')
  })

  it('reports an edited outside manifest as changed since the preview', async () => {
    const { root } = await makeWorkspace()
    const scope = scopeOf(root, [outside])
    const sources = await hashSources(scope, [outside])
    await writeRelative(root, outside, 'edited\n')
    assert.deepEqual(await changedSources(scope, sources), [outside])
  })

  it('refuses to revert when a declared package directory became a symlink out of the repository', async () => {
    const { parent, root } = await makeWorkspace()
    const scope = scopeOf(root, [outside])
    const originals = await readOriginals(root, [outside, 'pnpm-lock.yaml'])
    const files = await writePreviewFiles(scope, new Map([[outside, 'ui new\n'], ['pnpm-lock.yaml', 'lock: new\n']]), 'pnpm-lock.yaml', originals)
    const elsewhere = await makeTempDir()
    await writeRelative(elsewhere, 'package.json', 'ui new\n')
    await rm(path.join(parent, 'libs/ui'), { recursive: true })
    await symlink(elsewhere, path.join(parent, 'libs/ui'))
    await assert.rejects(revertWrittenFiles(scope, files), OutsideScopeError)
    assert.equal(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'), 'lock: new\n')
    assert.equal(await readFile(path.join(elsewhere, 'package.json'), 'utf8'), 'ui new\n')
  })
})
