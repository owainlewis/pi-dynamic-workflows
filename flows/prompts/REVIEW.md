# Review the implementation

Task:

{{ .Task }}

Run directory: {{ .RunDir }}
Plan file: {{ .RunDir }}/PLAN.md
Build report: {{ .RunDir }}/BUILD.md

Review the current diff for task completeness, correctness, scope control, maintainability, and practical verification gaps.

Rules:
- Do not edit files.
- Be specific and actionable.
- Prefix each actionable finding with `ISSUE:` so conditional refine steps can detect it.
- If there is no actionable feedback, say so explicitly and do not include `ISSUE:`.
- Write your review to {{ .RunDir }}/REVIEW.md.
