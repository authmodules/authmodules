# Pull Request Review Policy

This policy applies before merging any AuthModules pull request.

## Required Pre-Merge Review

Before merge:

- Inspect pull request comments.
- Inspect review threads.
- Do not merge with unresolved non-outdated review threads.
- Require conversation resolution before merge.
- Require CI status checks when the repository has CI.
- Prefer squash merge.
- Delete the source branch after merge.

Comments from ChatGPT or Codex must be treated as review input, not as noise. A pull request should not be merged until those comments are understood and handled.

## Handling Review Comments

For each ChatGPT or Codex comment:

- Read the full comment and surrounding code or document context.
- Classify it as valid or not applicable.
- Fix valid comments within the current scope.
- Add or update tests when the valid comment concerns behavior.
- Track valid comments in a separate issue when the fix is useful but out of scope.
- Answer out-of-scope comments with the reason they are not handled in the current pull request.
- Resolve the thread only after a deliberate decision.

Do not expand a pull request into adjacent roadmap work to satisfy an out-of-scope comment. Create a focused follow-up issue when the feedback is useful.

## Pull Request Template Checklist

The pull request template must include this checklist item:

```markdown
- [ ] I inspected PR comments and review threads, including ChatGPT and Codex comments, and there are no unresolved non-outdated review threads.
```

The checklist item belongs in the organization `.github` repository template. This pull request documents the requirement but does not modify the template.

## Merge Readiness

A pull request is merge-ready only when:

- The linked issue matches the pull request scope.
- The Project item is linked to the issue and pull request where GitHub supports it.
- Required checks for the current head commit are successful.
- There are no unresolved non-outdated review threads.
- The pull request does not implement adjacent roadmap items.
- The local working tree is clean before the merge or final handoff.
