import { readFileSync } from 'node:fs'

const PACKAGE_MANIFEST = new URL('../../package.json', import.meta.url)

export function readPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(PACKAGE_MANIFEST, 'utf8')) as { version: string }
  return manifest.version
}
