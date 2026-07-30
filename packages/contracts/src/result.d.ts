export type Result<T, E = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export type ValidationIssue = {
  readonly path?: readonly string[]
  readonly code: string
  /** Public-safe validation message. Must not echo raw input, secrets or account/challenge existence hints. */
  readonly message?: string
}

export type ValidationFailure = {
  readonly type: 'validation.failure'
  readonly issues: readonly ValidationIssue[]
}

export type Validator<T> = (input: unknown) => Result<T, ValidationFailure>
