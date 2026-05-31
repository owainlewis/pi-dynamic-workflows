# Prepare PR notes

Task:

{{ .Task }}

Run directory: {{ .RunDir }}

Read the plan, build report, review, refinement report if present, current git status, and current diff summary.

Write a concise draft PR body to `{{ .RunDir }}/PR_BODY.md` with:

- Summary
- Verification
- Risks / follow-up

Rules:
- Do not edit source files.
- Do not commit, push, or open a PR.
- If there are uncommitted changes, mention that the PR opener requires a clean working tree with commits already on the branch.
