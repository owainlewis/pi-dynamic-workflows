# Summarize the run

Task:

{{ .Task }}

Run directory: {{ .RunDir }}

Inspect the plan, build report, review, refinement report, current git status, and current diff summary.

Write a final handoff report to {{ .RunDir }}/FINAL.md with:

- what changed
- files touched
- verification performed or still needed
- risks / follow-up

Do not commit, push, or open a PR.
