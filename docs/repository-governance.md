# Repository Governance Baseline

This baseline applies to current and future AuthModules repositories. It defines the expected repository settings, branch protection posture, security baseline, and automation files before implementation work expands beyond the minimal core-first baseline.

Organization rulesets are the preferred long-term mechanism because they provide one policy surface for all repositories. Organization rulesets are not available in the current organization plan, so the current fallback is a per-repository branch protection and settings rollout.

This document is a governance baseline only. It does not change GitHub repository settings, add CodeQL workflows, add Dependabot configuration, or modify domain code.

## Repository Defaults

Every maintained AuthModules repository must use these defaults:

- Default branch: `main`.
- Issues enabled.
- Projects enabled.
- Wiki disabled unless a repository has an explicit documentation need that cannot be handled in Markdown files.
- Squash merge preferred.
- Merge commits disabled.
- Rebase merge disabled unless a repository has an explicit need for it.
- Automatically delete head branches enabled.

## Branch Protection

`main` must be protected through organization rulesets when available. Until then, each repository must configure equivalent per-repository branch protection.

Required `main` protections:

- Require a pull request before merge.
- Require status checks before merge when a CI workflow exists.
- Require the `CI / Check` status check for `authmodules/core`.
- Do not require a non-existing status check in repositories without CI.
- Require conversation resolution before merge.
- Block force pushes.
- Block branch deletion.
- Require linear history when compatible with the squash-only merge policy.
- Do not require an external approving review yet if that would block solo maintenance.

Administrators should be covered by the same protections where practical. Any exception must be explicit and temporary.

## Security Baseline

JavaScript and TypeScript repositories must use this security baseline:

- CodeQL enabled for JavaScript and TypeScript.
- Dependabot alerts enabled.
- Dependabot security updates enabled where available.
- Dependabot version updates for npm and GitHub Actions where applicable.
- `SECURITY.md` present.
- `CODEOWNERS` added only after the ownership policy is defined.

Security automation must match the repository type. Documentation-only repositories do not need npm-specific automation unless they gain package files or workflow dependencies.

## Automation Files

Repositories should include these files when applicable:

- `.github/dependabot.yml` for npm and GitHub Actions dependencies.
- `.github/workflows/codeql.yml` for JavaScript and TypeScript repositories when CodeQL default setup is not used.
- Pull request template from the organization `.github` repository.
- Issue templates from the organization `.github` repository.

This baseline does not add those automation files in this pull request.

## Package Repository Constraints

AuthModules package repositories must not be created for visibility alone. A repository should exist only when a Project item and scoped issue require actual implementation or documentation.

Node.js and TypeScript package repositories must:

- Use Node.js 24 or newer.
- Use npm only.
- Add CI before domain or runtime code.
- Document package boundaries before or with the first implementation pull request.
- Keep package names under the `@authmodules/*` namespace.

`@authmodules/core` remains headless. It must not include runtime adapters, storage adapters, framework adapters, provider SDKs, UI, deployment logic, or infrastructure logic.
