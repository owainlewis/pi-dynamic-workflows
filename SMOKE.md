# Flow Smoke Tests

## Load the extension

```bash
pi --no-session -e ./index.ts --mode json -p '/flow-status'
```

Expected: command exits successfully and prints Flow help.

## List bundled workflows

```bash
pi --no-session -e ./index.ts --mode json -p '/flows'
```

Expected: bundled workflows are listed with description lines.

## Generate a workflow, model required

```bash
pi -e ./index.ts
```

```text
/flow-new "Create a workflow that runs three review agents in parallel over PR1, PR2, and PR3, then combines their reports"
```

Expected:

- `.pi/workflows/<name>.yml` exists
- prompt files exist under `.pi/workflows/prompts/<name>/`
- the emitted message says validation passed or shows concrete validation errors

## Bundled UI smoke flow, no model required

This flow includes short pauses so you can see progress in the Pi UI.

Run from this repository:

```bash
pi --no-session -e ./index.ts --mode json -p '/flow flows/ui-smoke.yml "ui smoke"'
```

Expected:

- the command exits successfully
- `.pi/flow/runs/<run-id>/UI_SMOKE.md` exists
- `SUMMARY.md` records all steps as passed

## GitHub issue demo flow

The GitHub issue demo is intentionally stateful. Run it only in a clean git working tree:

```bash
pi -e ./index.ts
```

```text
/flow flows/github-issue-demo.yml "https://github.com/owner/repo/issues/123"
```

By default, remote side effects are skipped. Set `FLOW_DEMO_ALLOW_PUSH=1` to allow push/draft PR creation and `FLOW_DEMO_UPDATE_ISSUE=1` to allow issue comments.

Cleanup:

```text
/flow flows/github-issue-demo-cleanup.yml ".pi/flow/runs/<run-id>"
```

## Inline command-only flow, no model required

Run in a disposable directory:

```bash
tmp=$(mktemp -d)
cd "$tmp"
git init -q

mkdir -p .pi/workflows
cat > .pi/workflows/smoke.yaml <<'YAML'
name: Smoke
steps:
  - command: Make smoke plan
    run: mkdir -p "{{ .RunDir }}" && echo "# Smoke plan" > "{{ .RunDir }}/PLAN.md"

  - command: Check plan
    run: test -s "{{ .RunDir }}/PLAN.md"
YAML

pi --no-session -e /path/to/index.ts --mode json -p '/flow .pi/workflows/smoke.yaml smoke test'
```

Expected:

- the command exits successfully
- `.pi/flow/runs/<run-id>/SUMMARY.md` exists
- `SUMMARY.md` records both command steps

## Multiline command flow, no model required

```yaml
name: Multiline command smoke
steps:
  - command: Write report
    run: |
      set -eu
      mkdir -p "{{ .RunDir }}"
      printf "# Multiline smoke\n" > "{{ .RunDir }}/REPORT.md"
```

Expected: `SUMMARY.md` records the command as passed and `REPORT.md` exists.

## Conditional and already-satisfied loop path, no model required

Use a disposable git repo and a workflow where `when` skips one command and `loop.until` passes before the agent body or prompt file is used.

```yaml
name: Conditional smoke
steps:
  - command: Skipped
    when: test -s missing-file
    run: exit 1

  - loop: Already green
    prompt: prompts/FIX.md
    until: test 1 = 1
    maxIterations: 1
    freeze: "test/"
```

Expected: `SUMMARY.md` records `skipped` as skipped and `already-green` as passed.

## Parallel review shape, model required

```yaml
name: Parallel review smoke
steps:
  - parallel: Review items
    foreach:
      - PR1
      - PR2
      - PR3
    worktree: false
    agent:
      prompt: prompts/REVIEW_ITEM.md
      tools: read,bash,write
      expect: RESULT.md

  - agent: Combine reports
    prompt: prompts/COMBINE.md
```

Expected:

- the parallel step creates one child directory per item under `.pi/flow/runs/<run-id>/review-items/`
- each child directory contains `OUTPUT.md` and the expected artifact
- `SUMMARY.md` records the parent parallel step as passed only if every child passed

## Failure path

```bash
cat > .pi/workflows/fail.yaml <<'YAML'
name: Failure smoke
steps:
  - command: Check missing plan
    run: test -s "{{ .RunDir }}/PLAN.md" || { echo "Missing plan artifact" >&2; exit 1; }
YAML

pi --no-session -e /path/to/index.ts --mode json -p '/flow .pi/workflows/fail.yaml smoke failure'
```

Expected:

- Pi command exits successfully because the slash command handled the error
- the emitted Flow message contains `Flow Error`
- `SUMMARY.md` records the failed step
- `STATE.json` exists beside `SUMMARY.md`

## Resume path

After fixing the failing workflow command, resume the same run:

```text
/flow resume .pi/flow/runs/<failed-run-id>
```

Expected:

- already-passed steps are not re-run
- resume starts from the failed step
- `SUMMARY.md` and `STATE.json` are updated in the same run directory
