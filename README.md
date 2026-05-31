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
Plan → Build → Test → Review → Refine when needed → Prepare PR → Open PR when allowed
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

A workflow is a YAML file with ordered steps. Each step is one of:

- `command` — deterministic shell execution
- `agent` — a nested Pi agent with a focused prompt and tool allowlist
- `loop` — a guarded agent loop that fixes until a deterministic command passes

Flow shows each run live in Pi's UI and writes one simple `SUMMARY.md` for every run.

Project workflows live in `.pi/workflows/<flow-name>.yaml`.

## Commands

```text
/flows                     # list available workflows and recent runs
/flow <flow.yml> <task>    # run a workflow
/flow resume <run-dir>     # continue a failed run from the failed/skipped step
/flow resume <run-dir> --from <step>
/flow rerun <run-dir>      # start over with the same workflow and task
/flow-runs                 # list recent run summaries
/flow-status               # show help
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
description: Plan, build, and check a small code change.
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

Top-level workflow fields:

| Field | Required | Description |
| --- | --- | --- |
| `description` | no | Single-line summary shown by `/flows`. |
| `steps` | yes | Ordered workflow steps. |

Supported step fields:

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Stable step id. Use letters, numbers, `_`, or `-`. |
| `type` | yes | `agent`, `command`, or `loop`. |
| `label` | no | Human-friendly UI label. |
| `prompt` | agent/loop | Prompt file path, relative to the workflow file. |
| `run` | command | Shell command to run. |
| `tools` | agent/loop | Comma-separated Pi tools for the nested agent. Defaults to `read,bash,edit,write`. |
| `when` | no | Shell command condition. If it exits non-zero, the step is marked `skipped`. |
| `expect` | agent | Run-dir artifact that must exist and be non-empty after the agent step, for example `REVIEW.md`. |
| `until` | loop | Deterministic shell gate. The loop passes when this exits 0. |
| `maxIterations` | loop | Required positive hard cap for loop steps. |
| `freeze` | loop | Required space-separated paths the loop body must not modify, for example `test/ spec/`. |
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

Flow includes two main bundled workflows:

```text
flows/ui-smoke.yml     # command-only UI smoke test
flows/code-change.yml  # plan → build → test → review → refine → prepare/open PR
```

Run it with:

```text
/flow flows/ui-smoke.yml "test the Flow UI"
/flow flows/code-change.yml "Add input validation to the signup form"
```

The code-change example does **not** commit. It only pushes and opens a draft PR if `FLOW_ALLOW_PR=1` is set, the current branch is not `main`/`master`, and the working tree is clean.

## Run summaries

Each run writes:

```text
.pi/flow/runs/<run-id>/SUMMARY.md
.pi/flow/runs/<run-id>/STATE.json
```

`SUMMARY.md` is the human-readable record of what happened, including step status and compact step output. `STATE.json` is the machine-readable state used by resume.

Resume a failed run with:

```text
/flow resume .pi/flow/runs/<run-id>
```

Flow resumes from the first failed step, or the first skipped step if there is no failed step. Already-passed steps are not re-run. To force a specific step:

```text
/flow resume .pi/flow/runs/<run-id> --from reverify
```

To start over with the same workflow and task:

```text
/flow rerun .pi/flow/runs/<run-id>
```

## Learn more

See [`docs/architecture.md`](docs/architecture.md) for a simple explanation of how Flow works, how it compares with launching subagents directly, and how state moves between steps.

## Notes

- Flow runs steps sequentially.
- A failed command, agent error, missing `expect` artifact, loop exhaustion, or timeout stops the workflow.
- Agent steps pass if the nested Pi process exits successfully; use `expect` for artifact-producing agents.
- Use deterministic command steps or `loop.until` for gates that must be reliable.
- Keep state in files like `PLAN.md` and `REVIEW.md`; Flow does not implicitly pass one agent's final message to the next step.
- Set `FLOW_AGENT_TIMEOUT_SECONDS` to override the default agent timeout.
