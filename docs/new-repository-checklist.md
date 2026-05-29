# New Repository Checklist

Use this checklist before creating or accepting the first implementation pull request in a new AuthModules repository.

## Creation Gate

- Confirm there is a GitHub Project item in `AuthModules Roadmap`.
- Confirm the item has a scoped issue in the target repository or in the umbrella repository when the target repository does not exist yet.
- Confirm `Status`, `Priority`, `Area`, and `Release` are set.
- Confirm implementation issues are assigned to `alyldas` during the single-maintainer phase.
- Do not create an empty package repository only for visibility.
- Create a repository only when there is an actual implementation or documentation need.

## Repository Setup

- Set the default branch to `main`.
- Enable Issues.
- Enable Projects.
- Disable Wiki unless explicitly needed.
- Prefer squash merge.
- Disable merge commits.
- Disable rebase merge unless explicitly needed.
- Enable automatic deletion of head branches.
- Add `SECURITY.md`.
- Add pull request and issue templates from the organization `.github` repository.
- Add `CODEOWNERS` only after the ownership policy is defined.

## Branch Protection

- Protect `main` before the first implementation pull request.
- Require pull requests before merge.
- Require conversation resolution before merge.
- Block force pushes.
- Block branch deletion.
- Require linear history when compatible with the squash-only policy.
- Require status checks only after the repository has CI.
- Do not require a status check that does not exist.
- Do not require external approving review yet if it would block solo maintenance.

## Node.js and TypeScript Packages

- Use Node.js 24 or newer.
- Use npm only.
- Add `package.json` with `engines.node` set to `>=24`.
- Add CI before domain or runtime code.
- Add Dependabot version updates for npm and GitHub Actions where applicable.
- Enable Dependabot alerts.
- Enable Dependabot security updates where available.
- Enable CodeQL for JavaScript and TypeScript.
- Add `.github/workflows/codeql.yml` only when CodeQL default setup is not used.
- Document package boundaries before adding domain or runtime code.

## Package Boundaries

- Keep `@authmodules/core` headless.
- Keep runtime adapters outside core.
- Keep storage adapters outside core.
- Keep framework integrations outside core.
- Keep provider SDK integrations outside core.
- Keep UI and deployment logic outside core.
- Document the package responsibility, public entrypoint, supported runtime, and out-of-scope integrations.

## First Pull Request

- Keep the first pull request focused on repository baseline work.
- Include CI before domain or runtime implementation.
- Link the pull request to the scoped issue.
- Add the pull request to `AuthModules Roadmap`.
- Confirm review comments and review threads before merge.
