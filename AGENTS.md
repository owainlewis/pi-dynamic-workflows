# AGENTS.md

Guidance for agents working on `pi-dynamic-workflows`.

## Project
- This is a Pi extension that runs declarative YAML workflows via slash commands.
- Main extension entrypoint: `index.ts`.
- Bundled example workflows live in `flows/`; prompt files live in `flows/prompts/`.
- User/project workflows are expected under `.pi/workflows/`.

## Workflow format
- Keep YAML intentionally simple; `parseFlowYaml` only supports the fields documented in `README.md`.
- Steps must be ordered and use `type: agent` or `type: command`.
- Agent prompt paths are relative to the workflow file.
- Commands and prompts can use template vars like `{{ .Task }}`, `{{ .RunDir }}`, and `{{ .FlowPath }}`.

## Development guidelines
- Prefer small, focused changes and preserve the lightweight no-build package shape.
- Read `README.md`, `SMOKE.md`, and relevant `flows/` files before changing behavior.
- If changing workflow behavior, update `README.md` and add or adjust example flows/prompts.
- Keep examples safe by default: no commits, pushes, destructive deletes, or network-dependent behavior unless explicit.
- Use deterministic command steps for validation gates where possible.

## Validation
- There is currently no dedicated test suite.
- For quick checks, run TypeScript/package-level validation if available in the local environment.
- Smoke-test the extension with:
  ```bash
  pi -e ./index.ts
  ```
- Use `/flows`, `/flow <path> "task"`, and `/flow-runs` to verify user-facing behavior.
