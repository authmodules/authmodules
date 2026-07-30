export function normalizeOtpSubject(subject: string, subjectKind = 'email'): string {
  const trimmed = subject.trim()
  return subjectKind === 'email' ? trimmed.toLowerCase() : trimmed
}
