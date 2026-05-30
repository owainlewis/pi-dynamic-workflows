# Flow Smoke Tests

## Load the extension

```bash
pi --no-session -e ./index.ts --mode json -p '/flow-status'
```

Expected: command exits successfully and prints Flow help.

## Command-only flow, no model required

Run in a disposable directory:

```bash
tmp=$(mktemp -d)
cd "$tmp"
git init -q

mkdir -p flows
cat > flows/smoke.yml <<'YAML'
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

pi --no-session -e /path/to/index.ts --mode json -p '/flow flows/smoke.yml smoke test'
```

Expected:

- the command exits successfully
- `.pi/flow/runs/<run-id>/RUN.json` exists
- `.pi/flow/runs/<run-id>/SUMMARY.md` exists
- command artifacts exist for both steps

## Failure path

```bash
cat > flows/fail.yml <<'YAML'
steps:
  - name: check_plan
    label: Check missing plan
    type: command
    run: test -s "{{ .RunDir }}/PLAN.md" || { echo "Missing plan artifact" >&2; exit 1; }
YAML

pi --no-session -e /path/to/index.ts --mode json -p '/flow flows/fail.yml smoke failure'
```

Expected:

- Pi command exits successfully because the slash command handled the error
- the emitted Flow message contains `Flow Error`
- `SUMMARY.md` records the failed step
