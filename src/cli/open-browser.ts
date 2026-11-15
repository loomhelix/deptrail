import { spawn } from 'node:child_process'

export function browserCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] }
  return { command: 'xdg-open', args: [url] }
}

export function openBrowser(url: string): void {
  const { command, args } = browserCommand(process.platform, url)
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}
