# 08 — Repository and release settings

This document defines the required GitHub configuration for the AuthModules development monorepo. It does not authorize a merge, tag, package publication, package deletion, or repository deletion.

## Repository topology

The organization keeps two repositories:

- `authmodules/authmodules` contains all development workspaces, specifications, integration tests, and release automation.
- `authmodules/.github` contains only the organization profile and shared community files.

Each directory under [packages](../packages) remains a separately named, independently versioned npm package with its own public API and runtime responsibility. Sharing a development repository does not create a shared runtime package or permit cross-package imports outside the declared boundary rules.

## Main branch

- The default branch is `main`.
- Pull requests, the `check` status, and resolved conversations are required.
- Force pushes and branch deletion are blocked.
- Squash merge is enabled so the reviewed pull request title becomes the Conventional Commit consumed by Release Please.
- Merge commits are disabled and linear history is required.
- Head branches are deleted after merge.
- Default workflow permissions are read-only.

The required `check` job uses one atomic checkout, npm 11 workspaces, PostgreSQL 18, package API snapshots, package boundaries, package lint/test/build checks, integration and stack tests, coverage, and clean consumer installs from local tarballs.

Dependency review and CodeQL remain separate workflows. Dependabot owns npm and GitHub Actions update proposals from the root configuration.

## Release Please

[release-please-config.json](../release-please-config.json) uses manifest mode for all 15 workspaces. Versions are independent. The `node-workspace` plugin updates peer dependency ranges while keeping ordinary semver ranges in published manifests.

Release preparation is intentionally manual:

1. Dispatch `Prepare release pull request`.
2. Release Please creates or updates one ready pull request.
3. The workflow explicitly dispatches `check.yml` for that pull request head because events created by `GITHUB_TOKEN` require special handling.
4. Review the generated versions and changelogs.
5. Merge the release pull request only after its exact head is green.

Ordinary pushes and merges do not create release pull requests.

The publish workflow runs only when `.release-please-manifest.json` changes on `main`. It verifies that the commit came from a merged Release Please pull request, computes the changed package paths, reruns the complete check, and publishes only those packages.

## Package publication

The protected `github-packages` environment is restricted to `main`. Publication jobs grant only the permissions needed for repository contents, packages, attestations, artifact metadata, and short-lived identity tokens.

For every changed workspace the workflow:

1. Builds the package from the exact release commit.
2. Creates one exact npm tarball and a CycloneDX SBOM.
3. Records the tarball SHA-512 integrity.
4. Publishes the tarball with `GITHUB_TOKEN`.
5. Treats an identical existing version as a safe rerun and a different integrity as a fatal conflict.
6. Verifies registry integrity and uploads attestations and 90-day evidence.

The provenance predicate records the release source commit separately from the workflow-definition commit. This keeps a manual repair truthful when the release commit is an ancestor of the `main` commit that supplies the repaired workflow.

### Package release provenance v1

The package release build type uses a SLSA provenance v1 predicate. Its external parameters are:

- `package`: the scoped package name and exact version.
- `releaseSource`: the repository URL and immutable release commit used to build the tarball.
- `workflow`: the repository URL, workflow path, and Git ref that supplied the release implementation.

The `github.eventName` internal parameter records whether the invocation was the original `push` or a manual `workflow_dispatch` repair. Resolved dependencies bind both the release source and the workflow definition to exact `gitCommit` digests. The invocation ID identifies the exact workflow run and attempt. The predicate is signed by the GitHub-hosted runner identity through `actions/attest`.

After all matrix jobs succeed, a clean consumer installs the full package set from GitHub Packages and verifies every expected integrity. Component tags and GitHub Releases are created only after that verification succeeds. Tags use `<component>-v<version>`.

Tag creation is performed through an exact-SHA state machine rather than a moving branch ref. It validates all existing component state before mutation, creates each missing lightweight tag at the pinned release commit, and only then creates the matching GitHub Release. A rerun safely resumes absent, tag-only, release-only, or already-complete component state; any conflicting target or metadata remains a fatal error.

Tag rulesets allow the release workflow to create component tags. Updates and deletions remain blocked without bypass.

## Consolidated `0.1.0` reset

The imported package snapshots deliberately start a new release line at `0.1.0`. Legacy repository history, package tags, GitHub Releases, and package versions are not imported.

The previous GitHub Package records must be removed before the first consolidated release pull request is merged because GitHub Packages does not permit replacing an existing `name@version`. This is a one-time destructive cutover:

1. Verify the monorepo migration pull request is merged and green.
2. Run all local tarball and clean-consumer checks for the exact `0.1.0` sources.
3. Delete the legacy package versions, with `contracts@0.1.0` last.
4. Merge the initial Release Please pull request.
5. Let the protected publish workflow release every changed workspace through a separate matrix job.
6. Confirm all 15 packages are public, linked to `authmodules/authmodules`, and installable.
7. Delete the 15 obsolete package repositories only after registry and consumer verification.

Reusing the same public coordinates invalidates any cached legacy tarballs and lockfile integrities. This reset is permitted only because the packages have no consumers. Once the new namespace is populated, the previous deleted package versions can no longer be restored under the same coordinates.

## Package consumers

GitHub Packages requires authenticated installs. Local consumers map the `@authmodules` scope to `https://npm.pkg.github.com` and provide a classic token with `read:packages`. GitHub Actions consumers use `GITHUB_TOKEN` with `packages: read` and explicit package access when inheritance does not apply.
