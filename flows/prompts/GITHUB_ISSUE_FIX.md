# Fix issue implementation until checks pass

Issue:

{{ .Task }}

Use:
- `{{ .RunDir }}/PLAN.md`
- `{{ .RunDir }}/IMPLEMENTATION.md` if present

The workflow gate failed. Make the smallest safe code change needed to make the deterministic project check pass.

Rules:
- Inspect the failing check output before editing.
- Do not weaken, remove, skip, or rewrite tests/checks.
- Do not modify frozen test/spec paths.
- Preserve the issue scope and public contracts.
- Do not commit, push, or open a PR.

Report what you changed and what check should be re-run.
