export type ActionErrorStatus = 400 | 404 | 409

export class ActionError extends Error {
  readonly status: ActionErrorStatus
  readonly conflictsWith?: string

  constructor(status: ActionErrorStatus, message: string, conflictsWith?: string) {
    super(message)
    this.name = 'ActionError'
    this.status = status
    if (conflictsWith !== undefined) this.conflictsWith = conflictsWith
  }
}
