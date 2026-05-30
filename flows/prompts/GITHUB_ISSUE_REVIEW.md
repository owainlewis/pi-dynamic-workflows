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

Do not modify source files in this step.
