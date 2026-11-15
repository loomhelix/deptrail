import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { problemHint, problemLine, progressLine } from '../ui/src/insight-text.ts'

describe('problemLine and progressLine', () => {
  it('formats a problem with its origin, message and package count', () => {
    assert.equal(
      problemLine({ source: 'registry', origin: 'https://npm.example.com', message: 'rejected credentials (401)', count: 37 }),
      'npm.example.com rejected credentials (401) · 37 packages',
    )
    assert.equal(
      problemLine({ source: 'osv', origin: 'http://127.0.0.1:4000', message: 'timed out', count: 1 }),
      '127.0.0.1:4000 timed out · 1 package',
    )
  })

  it('hints at the npmrc token only for rejected credentials', () => {
    assert.equal(
      problemHint({ source: 'registry', origin: 'https://npm.example.com', message: 'rejected credentials (403)', count: 2 }),
      'Check the token for this registry in .npmrc.',
    )
    assert.equal(problemHint({ source: 'registry', origin: 'https://npm.example.com', message: 'responded with HTTP 500', count: 2 }), undefined)
  })

  it('groups the progress numbers', () => {
    assert.equal(
      progressLine({
        state: 'running',
        revision: 1,
        registry: { total: 3980, done: 2470, failed: 0 },
        osv: { total: 0, done: 0, skipped: 0, failed: 0 },
        problems: [],
      }),
      'Checking packages: 2,470 of 3,980',
    )
  })
})
