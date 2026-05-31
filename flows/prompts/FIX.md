# Fix until checks pass

Task:

{{ .Task }}

Run directory: {{ .RunDir }}
Plan file: {{ .RunDir }}/PLAN.md

The workflow gate failed. Make the smallest safe change needed to make the deterministic check pass.

Rules:
- Inspect the failing check output before editing.
- Preserve behavior and public contracts unless the task explicitly requires a change.
- Do not weaken, remove, skip, or rewrite tests/checks.
- Do not modify frozen test/spec paths.
- Do not commit, push, or open a PR.
- Keep changes focused on the task.

Report what you changed and what check should be re-run.
