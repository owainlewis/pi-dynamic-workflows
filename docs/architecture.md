# Flow Architecture

This document explains how Flow works in simple terms.

## The simple idea

Flow is a checklist runner for Pi.

You give it a YAML file like this:

```text
Step 1: run a command
Step 2: ask an agent to do focused work
Step 3: run another command to check the result
Step 4: write a summary
```

Flow reads the checklist and runs each step in order.

If a step fails, Flow stops. If every step passes, the workflow is complete.

## Big picture

```text
User
  |
  | /flow .pi/workflows/my-flow.yaml "do the task"
  v
Pi extension command
  |
  | reads YAML workflow
  v
Flow runner
  |
  | creates .pi/flow/runs/<run-id>/
  v
Step 1 -> Step 2 -> Step 3 -> Step 4
  |
  | records what happened
  v
SUMMARY.md
```

## Main parts

### 1. The Pi extension

Flow is loaded by Pi as an extension.

It adds slash commands:

- `/flows`
- `/flow <workflow.yml> <task>`
- `/flow-new <request>`
- `/flow-runs`
- `/flow-status`

When you run `/flow`, the extension does not ask the main chat model to invent a plan. It runs the workflow file directly.

### 2. The workflow file

A workflow file is YAML.

Example:

```yaml
name: Code Change
steps:
  - agent: Plan
    prompt: prompts/PLAN.md

  - command: Check plan
    run: test -s "{{ .RunDir }}/PLAN.md"
```

The workflow file is the recipe.

It says:

- what steps exist
- what order they run in
- which steps are commands
- which steps are agents
- which steps run agents in parallel
- which tools each agent may use

### 3. The run directory

Every workflow run gets its own folder:

```text
.pi/flow/runs/<run-id>/
```

This is the workflow's notebook.

It contains:

```text
SUMMARY.md        # human-readable record of the run
```

This is important because the workflow leaves a simple receipt behind. You can inspect what happened after the run finishes without filling the filesystem with lots of log files.

### 4. Command steps

A command step runs shell code.

Example:

```yaml
- command: Check plan
  run: test -s "{{ .RunDir }}/PLAN.md"
```

Commands can also use a multiline YAML block:

```yaml
- command: Write report
  run: |
    set -eu
    printf "done\n" > "{{ .RunDir }}/REPORT.md"
```

Command steps are useful for hard checks.

They are good for things like:

- checking that a file exists
- running tests
- formatting code
- validating JSON
- making sure an artifact was produced

A command either exits successfully or fails. That makes it reliable as a gate.

Any step can also have `when:`. Flow runs that shell command first. If it exits non-zero, the step is skipped instead of failed.

### 5. Agent steps

An agent step launches a focused nested Pi agent.

Example:

```yaml
- agent: Build
  prompt: prompts/BUILD.md
  tools: read,bash,edit,write
```

The nested agent gets:

- one focused prompt
- a limited tool list
- the current working directory
- template variables like `{{ .Task }}` and `{{ .RunDir }}`

The nested agent does **not** get the whole parent chat as its memory. It gets the prompt for that step.

Agent steps that write an artifact should use `expect:` so Flow fails if the file is missing or empty:

```yaml
- agent: Review
  prompt: prompts/REVIEW.md
  expect: REVIEW.md
```

That makes it easier to control.

### 6. Loop steps

A loop step is the safe form of "test, fix, test again". It runs the `until` command first. If the command already passes, the body agent never runs. Otherwise Flow runs the body agent, checks that frozen paths were not modified, and repeats until the gate passes or `maxIterations` is exhausted.

```yaml
- loop: Fix until green
  id: fix_until_green
  prompt: prompts/FIX.md
  until: npm test
  maxIterations: 4
  freeze: "test/ spec/"
```

Flow requires `maxIterations` and `freeze` so workflows cannot express an unbounded or unfenced loop.

### 7. Parallel steps

A parallel step fans one nested agent out over a simple YAML list.

```yaml
- parallel: Review PRs
  foreach:
    - PR1
    - PR2
    - PR3
  worktree: true
  agent:
    prompt: prompts/REVIEW_PR.md
    tools: read,bash,write
    expect: RESULT.md
```

Each child gets the normal workflow variables plus:

```text
{{ .Item }}
{{ .ItemIndex }}
{{ .ItemSlug }}
{{ .ChildRunDir }}
{{ .WorktreeDir }}
{{ .BranchName }}
```

Child prompts should write artifacts to `{{ .ChildRunDir }}`. If `worktree: true`, Flow creates a separate git worktree and branch for each item, then records `PATCH.diff` and `STATUS.txt` in the child run directory.

The next step is usually a normal agent that reads the child reports and combines the results.

### 8. Dynamic workflow authoring

`/flow-new` is the authoring layer. You describe the process in plain language, and a Pi agent writes concrete workflow YAML plus prompt files under `.pi/workflows/`.

Flow then validates the generated YAML with the same parser the runtime uses. The runtime stays deterministic; the agent is only used to author the workflow.

## What happens during a run

Imagine this command:

```text
/flow .pi/workflows/code-change.yaml "Add signup validation"
```

Flow does this:

1. Reads `.pi/workflows/code-change.yaml`.
2. Creates `.pi/flow/runs/<run-id>/`.
3. Shows the Flow panel in Pi.
4. Starts the first step.
5. If the step has `when`, runs the condition and skips on non-zero exit.
6. If the step is `command`, runs shell code.
7. If the step is `agent`, starts a nested Pi process with that step prompt and checks any `expect` artifact.
8. If the step is `loop`, repeats a guarded agent body until its deterministic gate passes.
9. If the step is `parallel`, starts one child agent per `foreach` item and waits for all children to finish.
10. Records compact step output in memory.
11. Marks the step passed, failed, or skipped.
12. Moves to the next step.
13. Writes one `SUMMARY.md` file.

## How state is handled

Flow keeps state in files, not hidden chat memory.

There are three kinds of state:

### 1. The original task

This is the text you pass to `/flow`:

```text
"Add signup validation"
```

Steps can use it with:

```text
{{ .Task }}
```

### 2. Run metadata

Flow creates values like:

```text
{{ .RunID }}
{{ .RunDir }}
{{ .FlowPath }}
{{ .StepName }}  # slugified from the step name unless id is set
```

These values let each step know where it is and where to write files.

### 3. Artifacts

Artifacts are the most important state.

For example:

```text
PLAN.md
REVIEW.md
SUMMARY.md
```

One step can write an artifact. A later step can read it.

That is how information moves through the workflow.

```text
Plan step writes PLAN.md
        |
        v
Build step reads PLAN.md and edits code
        |
        v
Review step reads the diff and writes REVIEW.md
        |
        v
Refine step reads REVIEW.md and fixes issues
```

This is simpler and safer than hoping a later agent remembers what an earlier agent thought. Flow intentionally does not implicitly pass one agent's final text into the next step.

## Flow vs launching subagents directly

You can launch subagents directly. That is useful when you want one focused helper.

Flow is different. Flow is for a whole process.

### Direct subagent

A direct subagent is like saying:

```text
"You handle this one job."
```

Good for:

- one isolated task
- quick investigation
- parallel exploration
- asking for a review

But direct subagents can be hard to coordinate. You have to decide what to pass in, what to do with the result, and what should happen next.

### Flow workflow

A Flow workflow is like saying:

```text
"Follow this whole recipe."
```

Good for:

- repeatable work
- multi-step coding tasks
- processes with checks between steps
- leaving an audit trail
- turning team habits into reusable automation

Flow can still use agents. It just uses them as steps inside a larger recipe.

## Simple comparison

| Question | Direct subagent | Flow workflow |
| --- | --- | --- |
| What is it? | One helper agent | A full checklist |
| Who decides the next step? | Usually you | The workflow file |
| Is it repeatable? | Sometimes | Yes |
| Can it mix commands and agents? | Manually | Yes, built in |
| Where is state kept? | Mostly prompt/result context | Explicit files and the run summary |
| Can it enforce gates? | Manually | Yes, with command steps |
| Best for | One focused job | A repeatable process |

## Why file-based state matters

Agents are good at reasoning, but chat memory is soft.

Files are concrete.

If a plan must exist, a command can check it:

```bash
test -s "{{ .RunDir }}/PLAN.md"
```

If review feedback must be handled, a later step can read:

```text
{{ .RunDir }}/REVIEW.md
```

This makes workflows more predictable.

## Failure handling

Flow runs steps in order.

If a step fails:

1. Flow marks that step as failed.
2. Later steps are skipped.
3. `SUMMARY.md` records the failure.
4. The Flow panel stays visible so you can inspect the result.

This makes failures easier to understand.

## Mental model

Think of Flow like a factory line:

```text
Input task
   |
   v
[Plan station]
   |
   v
[Check station]
   |
   v
[Build station]
   |
   v
[Review station]
   |
   v
Output summary
```

Each station has one job. Some stations are deterministic commands. Some stations are agents.

The value is not that the agent is smarter. The value is that the work is organized.

## The shift

The important shift is:

```text
Before: "Here is a big prompt. Please figure it out."
After:  "Here is a workflow. Follow the process."
```

That shift turns agent work from a conversation into an operating system for repeatable tasks.
