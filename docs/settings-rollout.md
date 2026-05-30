# Settings Rollout Plan

This rollout documents the current fallback for repository governance settings. Organization rulesets remain the preferred future mechanism, but they are not available in the current organization plan. Until organization rulesets are available, settings must be applied per repository.

This document is a checklist for ongoing rollout. Repository settings are verified from GitHub before each settings pass so the document reflects current repository state instead of an old manual checklist.

## Observed Settings Snapshot

The current repository inventory was checked while preparing this baseline:

| Repository | Default branch | Issues | Projects | Wiki | Squash merge | Merge commits | Rebase merge | Auto-delete head branches | `main` protection |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `authmodules/authmodules` | `main` | Enabled | Enabled | Disabled | Enabled | Disabled | Disabled | Enabled | Protected; pull request review and conversation resolution required; no status checks |
| `authmodules/core` | `main` | Enabled | Enabled | Disabled | Enabled | Disabled | Disabled | Enabled | Protected; `CI / Check` required |
| `authmodules/.github` | `main` | Enabled | Enabled | Disabled | Enabled | Disabled | Disabled | Enabled | Protected; pull request review and conversation resolution required; no status checks |

The remaining rollout checks are therefore:

- Keep repository settings aligned when new repositories are added.
- Keep `authmodules/core` required status checks aligned with the actual `CI` workflow job name.
- Keep CodeQL, release automation, and Dependabot present only where they match repository purpose.
- Revisit organization rulesets when the organization plan supports them.

## Current Repositories

### `authmodules/authmodules`

Purpose:

- Umbrella repository for public roadmap, architecture decisions, package map, release planning, cross-repository coordination, and governance documentation.

Expected settings:

- Default branch: `main`.
- Issues enabled.
- Projects enabled.
- Wiki disabled unless explicitly needed.
- Squash merge preferred.
- Merge commits disabled.
- Rebase merge disabled unless explicitly needed.
- Automatically delete head branches enabled.

Expected `main` protection:

- Require pull requests before merge.
- Require conversation resolution before merge.
- Block force pushes.
- Block branch deletion.
- Require linear history when compatible with squash-only merging.
- Do not require a non-existing CI status check while this repository has no CI workflow.

### `authmodules/core`

Purpose:

- Headless `@authmodules/core` package for domain entities, ports, use cases, errors, and testing helpers.

Expected settings:

- Default branch: `main`.
- Issues enabled.
- Projects enabled.
- Wiki disabled unless explicitly needed.
- Squash merge preferred.
- Merge commits disabled.
- Rebase merge disabled unless explicitly needed.
- Automatically delete head branches enabled.

Expected `main` protection:

- Require pull requests before merge.
- Require the `CI / Check` status check.
- Require conversation resolution before merge.
- Block force pushes.
- Block branch deletion.
- Require linear history when compatible with squash-only merging.
- Do not require external approving review yet if it would block solo maintenance.

Security and automation expectations:

- CodeQL enabled for JavaScript and TypeScript.
- Dependabot alerts enabled.
- Dependabot security updates enabled where available.
- Dependabot version updates for npm and GitHub Actions where applicable.
- `SECURITY.md` present.
- `CODEOWNERS` added only after the ownership policy is defined.

### `authmodules/.github`

Purpose:

- Organization-level community health files, issue templates, and pull request templates.

Expected settings:

- Default branch: `main`.
- Issues enabled if template or governance issues are tracked there.
- Projects enabled when project linkage is needed.
- Wiki disabled unless explicitly needed.
- Squash merge preferred.
- Merge commits disabled.
- Rebase merge disabled unless explicitly needed.
- Automatically delete head branches enabled.

Expected files:

- Pull request template with the review-thread checklist item from [pull request review policy](pr-review-policy.md).
- Issue templates used by AuthModules repositories.

The organization community repository owns the shared templates and public profile.

## Future Repositories

Before the first implementation pull request in a future repository:

- Confirm the repository was created from a Project item and scoped issue.
- Apply the repository defaults from [repository governance baseline](repository-governance.md).
- Apply `main` branch protection.
- Add CI before domain or runtime code.
- Add security automation when applicable.
- Confirm Node.js 24 or newer for Node.js and TypeScript packages.
- Confirm npm is the only package manager.
- Document package boundaries.

## Follow-Up Work

Follow-up rollout work should be split into focused issues or pull requests:

- Re-check branch protection after workflow names change.
- Add repository-specific docs validation only if a real validation need appears.
- Keep community templates aligned with the pull request review policy.
- Revisit organization rulesets when the organization plan supports them.
