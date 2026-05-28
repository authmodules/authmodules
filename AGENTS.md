# AGENTS.md

## Planning source of truth

Before starting any work, check the organization GitHub Project:

```text
AuthModules Roadmap
```

Read and follow:

```text
docs/projects.md
```

Work from project items. Do not invent scope from memory.

## Project workflow

For every task:

1. Find the relevant project item.
2. Confirm its `Status`, `Priority`, `Area`, and `Release`.
3. Keep the project item up to date.
4. Move it to `In progress` when starting.
5. Move it to `Blocked` if work cannot continue.
6. Move it to `Done` only after implementation, checks, and documentation are complete.

## Scope discipline

Keep changes small and aligned with the selected project item.

Do not combine unrelated work in one change.

Do not add packages, runtime integrations, infrastructure, or public documentation unless the project item explicitly requires it.

## Public repository safety

Do not include private operational details in public files.

Do not include credentials, tokens, private access details, private hostnames, personal machine details, deployment secrets, or local-only operator notes.

Do not mention previous package or project names in public files unless explicitly approved for a specific document.

## Current baseline

AuthModules starts with a minimal core-only baseline.

The first package is:

```text
@authmodules/core
```

Do not add PostgreSQL, SQLite, Express, email OTP, password login, OAuth, UI, or deployment infrastructure to the first core baseline unless the project item explicitly says so.

## Verification

Run the repository checks before finalizing work.

If checks cannot be run, state that clearly. Do not claim success without evidence.
