import { startShopMonorepo } from '../e2e/shop-monorepo.ts'

const monorepo = await startShopMonorepo({ npmRoot: true, git: true })

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await monorepo.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

console.log(`url: ${monorepo.url}`)
console.log(`repo: ${monorepo.repoDir}`)
