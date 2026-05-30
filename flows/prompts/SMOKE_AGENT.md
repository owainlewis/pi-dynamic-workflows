# Smoke sample flow

You are running a safe sample Flow step for Pi.

Task from the user:

{{ .Task }}

Read this sample input file:

`.pi/flow/tmp/{{ .RunID }}/input.txt`

Then write this artifact:

`{{ .RunDir }}/SMOKE_AGENT.md`

The artifact must include:

- a top-level heading exactly `# Smoke sample flow`
- the run id: `{{ .RunID }}`
- the task text
- the contents of the sample input file

Do not modify source files. Do not write outside `{{ .RunDir }}`.
