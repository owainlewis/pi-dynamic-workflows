# Refactor pass

Run a conservative refactor pass on the current issue implementation.

Issue:

{{ .Task }}

Read:

- `{{ .RunDir }}/PLAN.md`
- `{{ .RunDir }}/REVIEW.md`

Follow refactor-skill principles:

- preserve behavior and public contracts
- improve clarity, naming, duplication, and structure only where useful
- keep changes small and related to the issue
- do not introduce broad rewrites
- do not commit, push, or open a PR

If the review found real issues, fix them when safe. If no refactor is needed, leave the code unchanged and say so.

Write `{{ .RunDir }}/REFACTOR.md` with what you changed, what you intentionally left alone, and checks to run.
