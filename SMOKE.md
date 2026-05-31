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

## Bundled command-only sample flow, no model required

This flow includes short pauses so you can see progress in the Pi UI.

Run from this repository:

```bash
pi --no-session -e ./index.ts --mode json -p '/flow flows/command-smoke.yml "command smoke"'
```

Expected:

- the command exits successfully
- `.pi/flow/runs/<run-id>/COMMAND_SMOKE.md` exists
- `.pi/flow/tmp/<run-id>/` was removed by the cleanup step
- `SUMMARY.md` records all steps as passed

## Bundled end-to-end sample flow with an agent step

Run from this repository:

```bash
pi --no-session -e ./index.ts --mode json -p '/flow flows/smoke-sample.yml "agent smoke"'
```

Expected:

- the command exits successfully
- `.pi/flow/tmp/<run-id>/` was removed by the cleanup step
- `SUMMARY.md` records all steps as passed, including the agent step output

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
steps:
  - name: make_plan
    label: Make smoke plan
    type: command
    run: mkdir -p "{{ .RunDir }}" && echo "# Smoke plan" > "{{ .RunDir }}/PLAN.md"

  - name: check_plan
    label: Check plan
    type: command
    run: test -s "{{ .RunDir }}/PLAN.md"
YAML

pi --no-session -e /path/to/index.ts --mode json -p '/flow .pi/workflows/smoke.yaml smoke test'
```

Expected:

- the command exits successfully
- `.pi/flow/runs/<run-id>/SUMMARY.md` exists
- `SUMMARY.md` records both command steps

## Conditional and already-satisfied loop path, no model required

Use a disposable git repo and a workflow where `when` skips one command and `loop.until` passes before the agent body or prompt file is used.

```yaml
steps:
  - name: skipped
    type: command
    when: test -s missing-file
    run: exit 1

  - name: already_green
    type: loop
    prompt: prompts/FIX.md
    until: test 1 = 1
    maxIterations: 1
    freeze: "test/"
```

Expected: `SUMMARY.md` records `skipped` as skipped and `already_green` as passed.

## Failure path

```bash
cat > .pi/workflows/fail.yaml <<'YAML'
steps:
  - name: check_plan
    label: Check missing plan
    type: command
    run: test -s "{{ .RunDir }}/PLAN.md" || { echo "Missing plan artifact" >&2; exit 1; }
YAML

pi --no-session -e /path/to/index.ts --mode json -p '/flow .pi/workflows/fail.yaml smoke failure'
```

Expected:

- Pi command exits successfully because the slash command handled the error
- the emitted Flow message contains `Flow Error`
- `SUMMARY.md` records the failed step
