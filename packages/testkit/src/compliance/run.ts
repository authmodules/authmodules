import { type ComplianceCase, type ComplianceHarness, type ComplianceSuite } from './types.ts'

export function createComplianceSuite(name: string, cases: readonly ComplianceCase[]): ComplianceSuite

export function createComplianceSuite(name: string, cases: readonly ComplianceCase[] = []): ComplianceSuite {
  return { name, cases }
}

export async function runComplianceSuite(suite: ComplianceSuite, harness: ComplianceHarness): Promise<void>

export async function runComplianceSuite(suite: ComplianceSuite, harness: ComplianceHarness): Promise<void> {
  for (const complianceCase of suite.cases) await complianceCase.run(harness)
}
