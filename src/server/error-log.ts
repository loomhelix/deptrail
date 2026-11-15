import { processSecrets } from '../config/secrets.ts'

export type ErrorLog = (context: string, failure: unknown) => void
export type LogStream = { write(text: string): unknown }

const LINE_BREAKS = /\s*[\r\n]+\s*/g

export function createErrorLog(stream: LogStream): ErrorLog {
  return (context, failure) => {
    const message = failure instanceof Error ? failure.message : String(failure)
    const line = processSecrets.redact(`${context} failed: ${message}`).replace(LINE_BREAKS, ' ').trim()
    stream.write(`deptrail: ${line}\n`)
  }
}
