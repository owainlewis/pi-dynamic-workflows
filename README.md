# Flow for Pi

Flow is a Pi extension for running declarative coding-agent workflows.

A workflow is a YAML file with ordered steps. Each step is either:

- `command` — deterministic shell execution
- `agent` — a nested Pi agent with a focused prompt and tool allowlist

Flow shows the run live in Pi's UI and writes durable artifacts for every run.

## Commands

```text
/flows                  # list available workflows and recent runs
/flow <flow.yml> <task> # run a workflow
/flow-runs              # list recent run artifact directories
/flow-status            # show help
```

## Install / run

For local testing:

```bash
pi -e ./index.ts
```

As a package:

```bash
pi install git:github.com/owainlewis/pi-dynamic-workflows
```

## Workflow format

```yaml
steps:
  - name: plan
    label: Plan the change
    type: agent
    tools: read,bash,write
    prompt: prompts/PLAN.md

  - name: check_plan
    label: Validate plan artifact
    type: command
    timeoutSeconds: 30
    run: test -s "{{ .RunDir }}/PLAN.md"

  - name: build
    label: Implement change
    type: agent
    tools: read,bash,edit,write
    prompt: prompts/BUILD.md
```

Supported step fields:

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Stable step id. Use letters, numbers, `_`, or `-`. |
| `type` | yes | `agent` or `command`. |
| `label` | no | Human-friendly UI label. |
| `prompt` | agent | Prompt file path, relative to the workflow file. |
| `run` | command | Shell command to run. |
| `tools` | agent | Comma-separated Pi tools for the nested agent. Defaults to `read,bash,edit,write`. |
| `timeoutSeconds` | no | Per-step timeout. Commands default to 120s. Agents default to 900s. |

## Template variables

Prompts and command strings support:

```text
{{ .Task }}
{{ .RunID }}
{{ .RunDir }}
{{ .CWD }}
{{ .FlowPath }}
{{ .StepName }}
```

## Built-in example

Flow includes `flows/code-change.yml`, a supervised coding workflow:

```text
Plan the change → Validate plan artifact → Implement change → Review implementation → Refine implementation → Write final summary
```

Run it with:

```text
/flow flows/code-change.yml "Add input validation to the signup form"
```

The example does **not** commit, push, or open PRs. It leaves the final decision to you.

## Artifacts

Each run writes to:

```text
.pi/flow/runs/<run-id>/
```

Important files:

- `RUN.json` — machine-readable manifest
- `SUMMARY.md` — human-readable run summary
- `<step>.command.md` / `<step>.agent.md` — per-step output

## Notes

- Flow runs steps sequentially.
- A failed command, agent error, or timeout stops the workflow.
- Agent steps pass if the nested Pi process exits successfully.
- Use deterministic command steps for gates that must be reliable.
- Set `FLOW_AGENT_TIMEOUT_SECONDS` to override the default agent timeout.
