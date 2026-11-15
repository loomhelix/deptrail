import { chmodSync } from 'node:fs'

export class LockingOriginals extends Map<string, string | null> {
  private readonly lockOn: string
  private readonly dirToLock: string

  constructor(entries: ReadonlyMap<string, string | null>, lockOn: string, dirToLock: string) {
    super(entries)
    this.lockOn = lockOn
    this.dirToLock = dirToLock
  }

  override get(key: string): string | null | undefined {
    if (key === this.lockOn) chmodSync(this.dirToLock, 0o555)
    return super.get(key)
  }
}
