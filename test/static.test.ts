import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serveStatic } from '../src/server/static.ts'

describe('serveStatic', () => {
  let workDir: string
  let staticDir: string

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'deptrail-static-'))
    staticDir = path.join(workDir, 'ui')
    await mkdir(path.join(staticDir, 'assets'), { recursive: true })
    await writeFile(path.join(staticDir, 'index.html'), '<main></main>')
    await writeFile(path.join(staticDir, 'assets', 'app.js'), 'run()')
    await writeFile(path.join(workDir, 'secret.txt'), 'outside')
  })

  after(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('serves a file of the static directory with its content type', async () => {
    const response = await serveStatic(staticDir, '/assets/app.js')
    assert.equal(response.status, 200)
    assert.equal(response.contentType, 'text/javascript; charset=utf-8')
    assert.equal(response.body.toString(), 'run()')
  })

  it('serves index.html for a missing file, a directory and a path that leaves the directory', async () => {
    for (const pathname of ['/explore/semver', '/assets', '/../secret.txt', '/%2e%2e/secret.txt', '/%E0%A4%A']) {
      const response = await serveStatic(staticDir, pathname)
      assert.equal(response.status, 200, pathname)
      assert.equal(response.body.toString(), '<main></main>', pathname)
    }
  })

  it('answers 503 when the UI is not built', async () => {
    const response = await serveStatic(path.join(workDir, 'missing'), '/')
    assert.equal(response.status, 503)
  })
})
