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
2. Release Please creates or updates one ready pull request without lifecycle labels. The
   workflow rejects a same-named fork branch and resolves the pull request through an
   owner-qualified API query.
3. The workflow refreshes the root lockfile and dispatches `check.yml` for the exact pull request head.
4. Review the generated versions and changelogs.
5. Merge the release pull request only after its exact head is green.

Ordinary pushes and merges do not create release pull requests.

The publish workflow runs only when `.release-please-manifest.json` changes on `main`. Before planning a release, it confirms that the exact commit belongs to one merged `chore: release main` pull request from `release-please--branches--main`. It then computes the changed package paths, reruns the complete check, and publishes only those packages.

## Package publication

The protected `github-packages` environment is restricted to `main`. Publication jobs grant only the permissions needed for repository contents, packages, attestations, artifact metadata, and short-lived identity tokens.

For every changed workspace the workflow:

1. Builds the package from the exact release commit.
2. Creates one exact npm tarball and a CycloneDX SBOM.
3. Records the tarball SHA-512 integrity.
4. Publishes the tarball with `GITHUB_TOKEN`.
5. Treats an identical existing version as a safe rerun and a different integrity as a fatal conflict.
6. Verifies registry integrity and creates build-provenance and SBOM attestations.

After every matrix job succeeds, a clean consumer installs the complete package set from GitHub Packages and confirms, with bounded retries for registry propagation, that every package is public and linked to `authmodules/authmodules`. Before the first public mutation, one component-release command validates every changelog, tag target, and existing Release. It creates only missing Releases, never replaces the repository's Latest Release, and then verifies the complete changed set again. Existing tags must point to the same release commit; updates and deletions remain blocked by the tag ruleset.

## Package consumers

GitHub Packages requires authenticated installs. Local consumers map the `@authmodules` scope to `https://npm.pkg.github.com` and provide a classic token with `read:packages`. GitHub Actions consumers use `GITHUB_TOKEN` with `packages: read` and explicit package access when inheritance does not apply.
