import { normalizeSubject } from './normalize.ts'

export function normalizePasswordSubject(subject: string, subjectKind = 'email'): string {
  return normalizeSubject(subject, subjectKind)
}
