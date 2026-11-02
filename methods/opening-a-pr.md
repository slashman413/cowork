# Method: opening-a-pr

Open a reviewable pull request that a reviewer can judge in one minute.

## Steps

1. Work on a branch or worktree off main; never commit unrelated changes.
2. Rebase into small, ordered commits; each one landable.
3. Title: Conventional Commits `type(scope): subject`, imperative, no trailing period.
4. Body sections, in order: Why, What changed, Scope (what it leaves out), Blast Radius, Verification.
5. Remove explanatory comments that restate code; run unslop over the description.
6. Open ready for review, not draft. Record the PR URL in the result.

## Principles

- `technical-writing`: Short, plain sentences; one word per action.
- `prove-it-works`: Verification lists the commands run and their output.

## Evidence

- PR URL and head commit SHA.
- The test or check summary quoted in Verification.
