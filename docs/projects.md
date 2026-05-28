# Working with GitHub Projects

AuthModules uses the organization-level GitHub Project **AuthModules Roadmap** as the planning source of truth.

Before starting work, check the project first.

## Project

Project owner:

```text
authmodules
```

Project name:

```text
AuthModules Roadmap
```

Project number:

```text
1
```

## Required fields

Every planned item should have these fields set:

- `Status`
- `Priority`
- `Area`
- `Release`

## Status

- `Inbox` — new idea or task, not reviewed yet.
- `Ready` — accepted and ready to work on.
- `In progress` — currently being worked on.
- `Blocked` — cannot continue until a dependency, decision, access, or external step is resolved.
- `Done` — completed and verified.
- `Won't do` — intentionally not planned.

## Priority

- `P0` — blocks the current milestone or release; must be done before shipping.
- `P1` — important, but does not necessarily block the release.
- `P2` — useful, but can be deferred.
- `P3` — nice-to-have or future idea.

## Area

- `Core` — API, entities, ports, services, and tests.
- `Docs` — README files, roadmap, branding, architecture, and public documentation.
- `Infrastructure` — CI, release workflows, repository settings, and package setup.
- `Release` — versioning, changelog, GitHub releases, and package publishing.

## Release

- `0.1.0` — minimal core-only baseline.
- `0.2.0` — next layer after the core baseline.
- `Later` — not planned for the nearest releases.

## Workflow

1. Check the project before starting work.
2. Work from existing project items whenever possible.
3. Do not invent hidden scope outside the project item.
4. Keep project item fields up to date.
5. Move the item to `In progress` when starting implementation.
6. Move the item to `Blocked` when work cannot continue.
7. Move the item to `Done` only after implementation, checks, and documentation are complete.

## Draft items and issues

Use draft project items for early planning.

Convert a draft item into an issue only when:

- the scope is clear;
- the target repository is known;
- acceptance criteria are defined;
- the work is ready for implementation.

## Repository split

Use the umbrella repository for:

- public roadmap;
- architecture decisions;
- package map;
- release planning;
- cross-repository coordination;
- project workflow documentation.

Use package repositories for:

- package-specific code;
- package-specific issues;
- package-specific CI and release workflows;
- package-specific documentation.

## Public documentation boundary

Public project items and public repository files must not include credentials, tokens, private access details, private hostnames, personal machine details, deployment secrets, or local-only operator notes.

Keep public documents focused on product, architecture, packages, releases, and implementation scope.
