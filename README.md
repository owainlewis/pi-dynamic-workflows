# Flow for Pi

Flow is a Pi extension for turning repeatable agent work into simple workflows.

## Explain it like I'm 5

Prompting an agent is like saying:

> "Please clean my room."

A workflow is like giving the agent a checklist:

1. Pick up the toys.
2. Put books on the shelf.
3. Check the floor is clear.
4. Tell me what you did.

That checklist matters because the agent does not have to guess the process every time. It follows the same useful steps, in the same order, and leaves notes behind so you can see what happened.

## Why this is valuable

Most people start with one big prompt:

```text
Build this feature, test it, review it, and summarize it.
```

That works sometimes, but it is fragile. The agent might skip planning, forget to run a check, or mix up implementation and review.

Flow moves you from **prompting agents** to **building workflows**.

Instead of hoping the agent remembers the process, you write the process down once:

```text
Plan → Check plan exists → Build → Review → Refine → Summarize
```

Then you can run it again and again.

This gives you:

- **Repeatability** — the same kind of task follows the same path every time.
- **Visibility** — Pi shows which step is running now.
- **Safety** — command steps can enforce hard gates, like `test -s PLAN.md`.
- **Focus** — each agent step gets a small prompt and a limited tool list.
- **Summaries** — every run writes one simple `SUMMARY.md` you can inspect later.
- **Composability** — teams can share useful workflows instead of sharing long prompts.

In short: prompts are one-off instructions; workflows are reusable operating procedures.

## What a workflow is

A workflow is a YAML file with ordered steps. Each step is either:

- `command` — deterministic shell execution
- `agent` — a nested Pi agent with a focused prompt and tool allowlist

Flow shows the run live in Pi's UI and writes one simple `SUMMARY.md` for every run.

Project workflows live in `.pi/workflows/<flow-name>.yaml`.

## Commands

```text
/flows                  # list available workflows and recent runs
/flow <flow.yml> <task> # run a workflow
/flow-runs              # list recent run summaries
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

## Project workflows

Put project workflows in `.pi/workflows/`:

```text
.pi/workflows/code-change.yaml
.pi/workflows/hello.yaml
```

Then run one with:

```text
/flow .pi/workflows/hello.yaml "Run the hello workflow"
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
{{ .Task }}      # the task text passed to /flow
{{ .RunID }}     # unique id for this run
{{ .RunDir }}    # directory for this run
{{ .CWD }}       # current working directory
{{ .FlowPath }}  # workflow file path
{{ .StepName }}  # current step name
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

## Run summaries

Each run writes one summary file:

```text
.pi/flow/runs/<run-id>/SUMMARY.md
```

`SUMMARY.md` is the human-readable record of what happened, including step status and compact step output.

## Learn more

See [`docs/architecture.md`](docs/architecture.md) for a simple explanation of how Flow works, how it compares with launching subagents directly, and how state moves between steps.

## Notes

- Flow runs steps sequentially.
- A failed command, agent error, or timeout stops the workflow.
- Agent steps pass if the nested Pi process exits successfully.
- Use deterministic command steps for gates that must be reliable.
- Set `FLOW_AGENT_TIMEOUT_SECONDS` to override the default agent timeout.
