# Implement the change

Task:

{{ .Task }}

Run directory: {{ .RunDir }}
Plan file: {{ .RunDir }}/PLAN.md

Implement the plan with the smallest complete code change.

Rules:
- Preserve existing style.
- Avoid unrelated refactors.
- Do not commit, push, or open a PR.
- When done, write a short build report to {{ .RunDir }}/BUILD.md.
