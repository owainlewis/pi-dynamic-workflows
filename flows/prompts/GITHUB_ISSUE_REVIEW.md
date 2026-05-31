# Review GitHub issue implementation

Review the current diff for the issue:

{{ .Task }}

Use:

- `git diff --stat`
- `git diff`
- `{{ .RunDir }}/PLAN.md`
- `{{ .RunDir }}/IMPLEMENTATION.md` if present

Write `{{ .RunDir }}/REVIEW.md` with:

- correctness findings
- safety or edge-case concerns
- missing tests or validation
- whether the implementation appears ready for a draft PR

Prefix each actionable finding with `ISSUE:` so conditional refactor steps can detect it. If there is no actionable feedback, say so and do not include `ISSUE:`.

Do not modify source files in this step.
