import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";
type StepType = "agent" | "command" | "loop";

interface FlowStep {
	name: string;
	type: StepType;
	label?: string;
	prompt?: string;
	run?: string;
	tools?: string;
	when?: string;
	expect?: string;
	until?: string;
	maxIterations?: number;
	freeze?: string;
	timeoutSeconds?: number;
}

interface FlowDefinition {
	description?: string;
	steps: FlowStep[];
}

interface FlowVars {
	Task: string;
	RunID: string;
	RunDir: string;
	CWD: string;
	FlowPath: string;
	StepName: string;
}

interface StepSummary {
	name: string;
	label: string;
	type: StepType;
	status: StepStatus;
	detail: string;
	durationMs?: number;
	log?: string;
}

interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 900;
const TERMINATION_GRACE_MS = 5_000;

const ANSI = {
	reset: "\u001b[0m",
	dim: "\u001b[2m",
	bold: "\u001b[1m",
	green: "\u001b[38;5;114m",
	softGreen: "\u001b[38;5;108m",
	amber: "\u001b[38;5;179m",
	red: "\u001b[38;5;167m",
	gray: "\u001b[38;5;245m",
	cyan: "\u001b[38;5;110m",
};

function color(text: string, code: string): string {
	return `${code}${text}${ANSI.reset}`;
}

function truncate(input: string, max = 120): string {
	const compact = input.replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function statusColor(status: StepStatus): string {
	if (status === "passed") return ANSI.green;
	if (status === "failed") return ANSI.red;
	if (status === "running") return ANSI.amber;
	return ANSI.gray;
}

function parsePositiveInt(value: unknown, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function relativeForPrompt(cwd: string, filePath: string): string {
	const relative = path.relative(cwd, filePath);
	return relative.startsWith("..") ? filePath : relative;
}

function runId(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

function setFlowIdlePanel(ctx: any): void {
	if (!ctx.hasUI) return;
	const flows = discoverFlowFiles(ctx.cwd).filter((flow) => flow.source === "project").slice(0, 5);
	const runs = listRunDirs(ctx.cwd, 3);
	const lines = [
		color("Flow", ANSI.softGreen + ANSI.bold),
		`${color("Status:", ANSI.cyan)} No active workflow`,
		`${color("Workflows:", ANSI.cyan)} ${flows.length ? flows.map((flow) => flow.file).join(", ") : "add .pi/workflows/<name>.yaml"}`,
		`${color("Run:", ANSI.cyan)} /flow .pi/workflows/<name>.yaml "your task"`,
		...(runs.length ? ["", color("Recent runs", ANSI.cyan), ...runs.map((run) => `${color("•", ANSI.gray)} ${run}`)] : []),
	];
	ctx.ui.setWidget("flow-progress", (_tui: any, _theme: any) => ({
		render(width: number) {
			const rendered: string[] = [];
			for (const line of lines) for (const wrapped of wrapTextWithAnsi(line, Math.max(20, width - 2))) rendered.push(truncateToWidth(` ${wrapped}`, width));
			return rendered;
		},
		invalidate() {},
	}), { placement: "aboveEditor" });
}

function setFlowReadyUi(ctx: any): void {
	setFlowIdlePanel(ctx);
}

function stripYamlComment(line: string): string {
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		const previous = line[i - 1];
		if ((char === '"' || char === "'") && previous !== "\\") quote = quote === char ? undefined : quote ?? char;
		if (char === "#" && !quote && (i === 0 || /\s/.test(previous))) return line.slice(0, i).trimEnd();
	}
	return line;
}

function unquoteYamlValue(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed;
}

function parseFlowYaml(text: string, flowPath: string): FlowDefinition {
	const steps: FlowStep[] = [];
	const seen = new Set<string>();
	let current: Partial<FlowStep> | undefined;
	let description: string | undefined;
	let inSteps = false;

	const finish = () => {
		if (!current) return;
		if (!current.name) throw new Error(`${flowPath}: step is missing name`);
		if (!/^[A-Za-z0-9_-]+$/.test(current.name)) throw new Error(`${flowPath}: invalid step name: ${current.name}`);
		if (seen.has(current.name)) throw new Error(`${flowPath}: duplicate step name: ${current.name}`);
		seen.add(current.name);
		if (current.type !== "agent" && current.type !== "command" && current.type !== "loop") throw new Error(`${flowPath}: step ${current.name} must have type agent, command, or loop`);
		if (current.type === "agent" && !current.prompt) throw new Error(`${flowPath}: agent step ${current.name} is missing prompt`);
		if (current.type === "command" && !current.run) throw new Error(`${flowPath}: command step ${current.name} is missing run`);
		if (current.type === "loop") {
			if (!current.prompt) throw new Error(`${flowPath}: loop step ${current.name} is missing prompt`);
			if (!current.until) throw new Error(`${flowPath}: loop step ${current.name} is missing until`);
			if (!current.maxIterations || !Number.isFinite(current.maxIterations) || current.maxIterations <= 0) throw new Error(`${flowPath}: loop step ${current.name} maxIterations must be positive`);
			if (!current.freeze?.trim()) throw new Error(`${flowPath}: loop step ${current.name} is missing freeze`);
		}
		if (current.timeoutSeconds !== undefined && (!Number.isFinite(current.timeoutSeconds) || current.timeoutSeconds <= 0)) throw new Error(`${flowPath}: step ${current.name} timeoutSeconds must be positive`);
		steps.push(current as FlowStep);
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripYamlComment(rawLine);
		if (!line.trim()) continue;
		if (/^\s*steps\s*:\s*$/.test(line)) {
			inSteps = true;
			continue;
		}
		const descriptionMatch = line.match(/^description\s*:\s*(.*?)\s*$/);
		if (descriptionMatch && !inSteps) {
			if (description !== undefined) throw new Error(`${flowPath}: duplicate description`);
			description = unquoteYamlValue(descriptionMatch[1]);
			continue;
		}
		const stepStart = line.match(/^\s*-\s+name\s*:\s*(.+?)\s*$/);
		if (stepStart) {
			finish();
			current = { name: unquoteYamlValue(stepStart[1]) };
			continue;
		}
		const prop = line.match(/^\s+(name|type|label|prompt|run|tools|when|expect|until|maxIterations|freeze|timeoutSeconds)\s*:\s*(.+?)\s*$/);
		if (!prop) throw new Error(`${flowPath}: unsupported or malformed line: ${rawLine.trim()}`);
		if (!current) current = {};
		const key = prop[1];
		const value = unquoteYamlValue(prop[2]);
		(current as any)[key] = key === "timeoutSeconds" || key === "maxIterations" ? Number.parseInt(value, 10) : value;
	}
	finish();
	if (steps.length === 0) throw new Error(`${flowPath}: no steps found`);
	return { description, steps };
}

function renderTemplate(input: string, vars: FlowVars): string {
	return input.replace(/{{\s*\.([A-Za-z0-9_]+)\s*}}/g, (_match, key) => String((vars as any)[key] ?? ""));
}

function terminateProcess(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	try {
		if (proc.pid) process.kill(-proc.pid, signal);
		else proc.kill(signal);
	} catch {
		try { proc.kill(signal); } catch { /* ignore */ }
	}
}

async function runShell(command: string, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<ProcessResult> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const proc = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let forceKill: NodeJS.Timeout | undefined;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKill) clearTimeout(forceKill);
			fn();
		};
		const stop = (isTimeout: boolean) => {
			if (isTimeout) timedOut = true;
			terminateProcess(proc, "SIGTERM");
			forceKill = setTimeout(() => terminateProcess(proc, "SIGKILL"), TERMINATION_GRACE_MS);
		};
		const timeout = setTimeout(() => stop(true), timeoutSeconds * 1000);

		proc.stdout.on("data", (data) => { stdout += data.toString(); });
		proc.stderr.on("data", (data) => { stderr += data.toString(); });
		proc.on("error", (error) => finish(() => reject(error)));
		proc.on("close", (code) => finish(() => resolve({ exitCode: code ?? (timedOut ? 124 : 1), stdout, stderr, durationMs: Date.now() - startedAt, timedOut })));
		if (signal) {
			if (signal.aborted) stop(false);
			else signal.addEventListener("abort", () => stop(false), { once: true });
		}
	});
}

function extractAssistantText(message: any): string {
	const parts = message?.content;
	if (!Array.isArray(parts)) return "";
	return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

async function runAgent(options: { cwd: string; prompt: string; tools?: string[]; timeoutSeconds: number; signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<string> {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "flow-prompt-"));
	const promptFile = path.join(tempDir, "prompt.md");
	await writeFile(promptFile, options.prompt, "utf8");
	const args = ["--mode", "json", "-p", "--no-session", "--tools", (options.tools ?? ["read", "bash", "edit", "write"]).join(","), `@${promptFile}`];

	return new Promise((resolve, reject) => {
		const proc = spawn("pi", args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdoutBuffer = "";
		let stderr = "";
		let lastAssistantText = "";
		let textPreview = "";
		let lastPreviewAt = 0;
		let timedOut = false;
		let settled = false;
		let forceKill: NodeJS.Timeout | undefined;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKill) clearTimeout(forceKill);
			void rm(tempDir, { recursive: true, force: true });
			fn();
		};
		const stop = (isTimeout: boolean) => {
			if (isTimeout) timedOut = true;
			terminateProcess(proc, "SIGTERM");
			forceKill = setTimeout(() => terminateProcess(proc, "SIGKILL"), TERMINATION_GRACE_MS);
		};
		const timeout = setTimeout(() => stop(true), options.timeoutSeconds * 1000);

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (event.type === "agent_start") options.onProgress?.("agent started");
				if (event.type === "turn_start") options.onProgress?.("thinking");
				if (event.type === "tool_execution_start") options.onProgress?.(`tool: ${event.toolName}${event.args?.command ? ` — ${truncate(event.args.command, 90)}` : ""}`);
				if (event.type === "tool_execution_end") options.onProgress?.(`tool done: ${event.toolName}${event.isError ? " (error)" : ""}`);
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					textPreview += event.assistantMessageEvent.delta;
					const now = Date.now();
					if (now - lastPreviewAt > 1200 && textPreview.trim()) {
						lastPreviewAt = now;
						options.onProgress?.(`writing: ${truncate(textPreview.slice(-200), 120)}`);
					}
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const text = extractAssistantText(event.message).trim();
					if (text) lastAssistantText = text;
				}
			} catch { /* ignore non-json lines */ }
		};

		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => { stderr += data.toString(); });
		proc.on("error", (error) => finish(() => reject(error)));
		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			if (code !== 0 || timedOut) {
				const reason = timedOut ? `agent timed out after ${options.timeoutSeconds}s` : `agent exited with code ${code}`;
				return finish(() => reject(new Error(`${reason}:\n${stderr}`.trim())));
			}
			finish(() => resolve(lastAssistantText));
		});
		if (options.signal) {
			if (options.signal.aborted) stop(false);
			else options.signal.addEventListener("abort", () => stop(false), { once: true });
		}
	});
}

async function writeArtifact(runDir: string, name: string, content: string): Promise<string> {
	await mkdir(runDir, { recursive: true });
	const artifactPath = path.join(runDir, name);
	await writeFile(artifactPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
	return artifactPath;
}

function summarizeCommandResult(command: string, result: ProcessResult): string {
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
	const lines = [`command: ${command}`, `exitCode: ${result.exitCode}`, `timedOut: ${result.timedOut}`];
	if (output) lines.push("", output.slice(0, 2_000));
	return lines.join("\n");
}

function summarizeAgentOutput(output: string): string {
	const trimmed = output.trim();
	return trimmed ? trimmed.slice(0, 2_000) : "Agent completed without a final text response.";
}

function hashProcessOutput(result: ProcessResult): string {
	return createHash("sha256").update(`${result.stdout}\n${result.stderr}`).digest("hex");
}

function artifactPath(runDir: string, artifact: string): string {
	const resolved = path.resolve(runDir, artifact);
	const relative = path.relative(runDir, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`artifact path escapes run directory: ${artifact}`);
	return resolved;
}

function assertExpectedArtifact(runDir: string, artifact: string): void {
	const expectedPath = artifactPath(runDir, artifact);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(expectedPath);
	} catch {
		throw new Error(`Expected artifact is missing: ${artifact}`);
	}
	if (!stat.isFile() || stat.size <= 0) throw new Error(`Expected artifact is empty or not a file: ${artifact}`);
}

function splitFreezePaths(freeze: string): string[] {
	return freeze.split(/\s+/).map((entry) => entry.trim()).filter(Boolean);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function frozenPathsSnapshot(freeze: string, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<string> {
	const frozen = splitFreezePaths(freeze);
	if (!frozen.length) throw new Error("loop freeze must name at least one path");
	const paths = frozen.map(shellQuote).join(" ");
	const command = `{ git status --porcelain --untracked-files=all -- ${paths}; git diff --binary -- ${paths}; }`;
	const result = await runShell(command, cwd, timeoutSeconds, signal);
	if (result.exitCode !== 0) throw new Error(`Could not check frozen paths:\n${result.stderr || result.stdout}`.trim());
	return result.stdout;
}

async function assertFrozenPathsUnchanged(freeze: string, before: string, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<void> {
	const after = await frozenPathsSnapshot(freeze, cwd, timeoutSeconds, signal);
	if (after !== before) throw new Error(`Loop modified frozen path(s): ${freeze}`);
}

function summaryMarkdown(data: { flowPath: string; task: string; runId: string; runDir: string; startedAt: string; endedAt: string; status: "passed" | "failed"; steps: StepSummary[] }): string {
	const durationMs = Math.max(0, Date.parse(data.endedAt) - Date.parse(data.startedAt));
	const lines = [`# Flow Run ${data.status === "passed" ? "✅" : "❌"}`, "", `- status: ${data.status}`, `- flow: \`${data.flowPath}\``, `- run id: \`${data.runId}\``, `- run dir: \`${data.runDir}\``, `- duration: ${Math.round(durationMs / 1000)}s`, "", "## Task", "", data.task, "", "## Steps"];
	for (const step of data.steps) {
		const icon = step.status === "passed" ? "✅" : step.status === "failed" ? "❌" : step.status === "skipped" ? "⏭️" : "◻️";
		lines.push("", `### ${icon} ${step.label}`, "", `- name: ${step.name}`, `- type: ${step.type}`, `- status: ${step.status}`, `- duration: ${step.durationMs === undefined ? "n/a" : `${Math.round(step.durationMs / 1000)}s`}`, `- detail: ${step.detail || "n/a"}`);
		if (step.log) lines.push("", "```text", step.log, "```");
	}
	return `${lines.join("\n").trim()}\n`;
}

function createFlowUi(ctx: any, flowPath: string, runDir: string, steps: FlowStep[]) {
	const statuses = steps.map((step) => ({ label: step.label ?? step.name, type: step.type, status: "pending" as StepStatus, detail: "", startedAt: 0, endedAt: 0 }));
	const startedAt = Date.now();
	let activeIndex = 0;
	let activeText = "starting";
	const statusIcon = (status: StepStatus) => status === "passed" ? "✓" : status === "failed" ? "✗" : status === "running" ? "▶" : status === "skipped" ? "↷" : "○";
	const duration = (step: typeof statuses[number]) => {
		if (!step.startedAt) return "queued";
		const end = step.endedAt || Date.now();
		const seconds = Math.max(1, Math.round((end - step.startedAt) / 1000));
		return `${seconds}s`;
	};
	const progressBar = () => {
		const done = statuses.filter((step) => step.status === "passed" || step.status === "skipped").length;
		const failed = statuses.some((step) => step.status === "failed");
		const width = 18;
		const filled = Math.round((done / Math.max(1, statuses.length)) * width);
		return `${color("█".repeat(filled), failed ? ANSI.red : ANSI.green)}${color("░".repeat(width - filled), ANSI.gray)} ${done}/${statuses.length}`;
	};
	const plainCell = (text: string, width: number) => truncate(text, Math.max(1, width)).padEnd(width).slice(0, width);
	const checklistLines = (width: number): string[] => {
		const safeWidth = Math.max(40, width - 2);
		const numberWidth = String(statuses.length).length;
		return statuses.map((step, index) => {
			const symbol = color(statusIcon(step.status), statusColor(step.status));
			const count = color(`(${String(index + 1).padStart(numberWidth, " ")}/${statuses.length})`, ANSI.gray);
			const label = color(step.label, statusColor(step.status));
			const meta = step.status === "pending" ? "queued" : duration(step);
			const detail = step.detail ? ` — ${step.detail}` : "";
			return truncateToWidth(`${symbol} ${label} ${count} ${color(meta, ANSI.dim)}${color(detail, ANSI.dim)}`, safeWidth);
		});
	};
	const activeStepText = () => {
		const step = statuses[Math.max(0, Math.min(activeIndex, statuses.length - 1))];
		return `${step.label} (${activeIndex + 1}/${statuses.length})`;
	};
	const detailLines = (width: number): string[] => {
		const step = statuses[Math.max(0, Math.min(activeIndex, statuses.length - 1))];
		const safeWidth = Math.max(40, width - 2);
		const inner = safeWidth - 2;
		const title = step.status === "failed" ? " Failed step " : step.status === "running" ? " Active step " : " Step detail ";
		const top = `┌${title}${"─".repeat(Math.max(0, inner - title.length))}┐`;
		const body = [
			`${statusIcon(step.status)} ${step.label} (${activeIndex + 1}/${statuses.length})`,
			`${step.type} · ${step.status} · ${duration(step)}`,
			activeText,
			`summary: ${runDir}/SUMMARY.md`,
		];
		const lines = [top];
		for (const line of body) for (const wrapped of wrapTextWithAnsi(line, Math.max(20, inner))) lines.push(`│${plainCell(wrapped, inner)}│`);
		lines.push(`└${"─".repeat(inner)}┘`);
		return lines;
	};
	const render = (active: string) => {
		if (!ctx.hasUI) return;
		activeText = truncate(active, 220);
		const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
		ctx.ui.setStatus("flow", `Flow ${activeStepText()} • ${progressBar()} • ${activeText}`);
		ctx.ui.setWidget("flow-progress", (_tui: any, _theme: any) => ({
			render(width: number) {
				const lines = [
					`${color("Flow", ANSI.softGreen + ANSI.bold)} ${color(activeStepText(), ANSI.reset)} ${color("•", ANSI.gray)} ${color(progressBar(), ANSI.reset)} ${color("•", ANSI.gray)} ${elapsed}s`,
					`${color("Flow:", ANSI.cyan)} ${flowPath}`,
					`${color("Run:", ANSI.cyan)} ${runDir}`,
					"",
					color("Checklist", ANSI.cyan),
					...checklistLines(width),
					"",
					...detailLines(width),
				];
				const rendered: string[] = [];
				for (const line of lines) rendered.push(truncateToWidth(` ${line}`, width));
				return rendered;
			},
			invalidate() {},
		}), { placement: "aboveEditor" });
	};
	return {
		set(index: number, status: StepStatus, detail = "") {
			activeIndex = index;
			statuses[index].status = status;
			statuses[index].detail = truncate(detail, 140);
			if (status === "running") {
				statuses[index].startedAt = Date.now();
				statuses[index].endedAt = 0;
			}
			if (status === "passed" || status === "failed" || status === "skipped") statuses[index].endedAt = Date.now();
			render(`${statuses[index].label}: ${detail || status}`);
		},
		detail(index: number, detail: string) {
			activeIndex = index;
			statuses[index].detail = truncate(detail, 140);
			render(`${statuses[index].label}: ${detail}`);
		},
		complete(status: "passed" | "failed", active: string) {
			const failedIndex = statuses.findIndex((step) => step.status === "failed");
			activeIndex = failedIndex >= 0 ? failedIndex : Math.max(0, statuses.length - 1);
			render(`${status === "passed" ? "complete" : "failed"}: ${active}`);
			ctx.ui.setStatus("flow", status === "passed" ? "Flow complete" : "Flow failed");
		},
	};
}

async function runFlow(options: { cwd: string; flowPath: string; task: string; signal?: AbortSignal; ctx: any }): Promise<string> {
	const absoluteFlowPath = path.resolve(options.cwd, options.flowPath);
	const relativeFlowPath = relativeForPrompt(options.cwd, absoluteFlowPath);
	const flow = parseFlowYaml(await readFile(absoluteFlowPath, "utf8"), relativeFlowPath);
	const id = runId();
	const absoluteRunDir = path.join(options.cwd, ".pi", "flow", "runs", id);
	const relativeRunDir = relativeForPrompt(options.cwd, absoluteRunDir);
	const startedAt = new Date().toISOString();
	const steps: StepSummary[] = flow.steps.map((step) => ({ name: step.name, label: step.label ?? step.name, type: step.type, status: "pending", detail: "" }));
	const ui = createFlowUi(options.ctx, relativeFlowPath, relativeRunDir, flow.steps);

	await mkdir(absoluteRunDir, { recursive: true });

	let currentIndex = -1;
	try {
		for (let i = 0; i < flow.steps.length; i++) {
			currentIndex = i;
			const step = flow.steps[i];
			const stepStartedAt = Date.now();
			const vars: FlowVars = { Task: options.task, RunID: id, RunDir: relativeRunDir, CWD: options.cwd, FlowPath: relativeFlowPath, StepName: step.name };
			if (step.when) {
				const whenCommand = renderTemplate(step.when, vars);
				steps[i].status = "running";
				steps[i].detail = "checking condition";
				ui.set(i, "running", "checking condition");
				ui.detail(i, whenCommand);
				const whenResult = await runShell(whenCommand, options.cwd, step.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS, options.signal);
				if (whenResult.exitCode !== 0) {
					steps[i].status = "skipped";
					steps[i].durationMs = Date.now() - stepStartedAt;
					steps[i].detail = `skipped; when exited ${whenResult.exitCode}`;
					steps[i].log = summarizeCommandResult(whenCommand, whenResult);
					ui.set(i, "skipped", steps[i].detail);
					continue;
				}
			}

			steps[i].status = "running";
			steps[i].detail = step.type;
			ui.set(i, "running", step.type);

			if (step.type === "command") {
				const command = renderTemplate(step.run!, vars);
				ui.detail(i, command);
				const result = await runShell(command, options.cwd, step.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS, options.signal);
				steps[i].log = summarizeCommandResult(command, result);
				steps[i].durationMs = Date.now() - stepStartedAt;
				steps[i].detail = result.exitCode === 0 ? `passed in ${result.durationMs}ms` : `failed with exit code ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`;
				if (result.exitCode !== 0) throw new Error(`Command step failed: ${step.label ?? step.name}\n${result.stderr || result.stdout}`.trim());
			} else if (step.type === "agent") {
				const promptPath = path.resolve(path.dirname(absoluteFlowPath), step.prompt!);
				const prompt = renderTemplate(await readFile(promptPath, "utf8"), vars);
				const tools = step.tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
				const output = await runAgent({ cwd: options.cwd, prompt, tools, timeoutSeconds: step.timeoutSeconds ?? parsePositiveInt(process.env.FLOW_AGENT_TIMEOUT_SECONDS, DEFAULT_AGENT_TIMEOUT_SECONDS), signal: options.signal, onProgress: (message) => ui.detail(i, message) });
				if (step.expect) assertExpectedArtifact(absoluteRunDir, renderTemplate(step.expect, vars));
				steps[i].log = summarizeAgentOutput(output);
				steps[i].durationMs = Date.now() - stepStartedAt;
				steps[i].detail = step.expect ? `agent completed; found ${step.expect}` : "agent completed";
			} else {
				const until = renderTemplate(step.until!, vars);
				const maxIterations = step.maxIterations!;
				let gate = await runShell(until, options.cwd, step.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS, options.signal);
				let previousHash = hashProcessOutput(gate);
				const logs = [`initial gate\n${summarizeCommandResult(until, gate)}`];
				if (gate.exitCode === 0) {
					steps[i].detail = "gate already passed";
				} else {
					const promptPath = path.resolve(path.dirname(absoluteFlowPath), step.prompt!);
					const prompt = renderTemplate(await readFile(promptPath, "utf8"), vars);
					const tools = step.tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
					const timeoutSeconds = step.timeoutSeconds ?? parsePositiveInt(process.env.FLOW_AGENT_TIMEOUT_SECONDS, DEFAULT_AGENT_TIMEOUT_SECONDS);
					let passed = false;
					for (let iteration = 1; iteration <= maxIterations; iteration++) {
						ui.detail(i, `iteration ${iteration}/${maxIterations}: fixing`);
						const frozenBefore = await frozenPathsSnapshot(step.freeze!, options.cwd, DEFAULT_COMMAND_TIMEOUT_SECONDS, options.signal);
						const output = await runAgent({ cwd: options.cwd, prompt, tools, timeoutSeconds, signal: options.signal, onProgress: (message) => ui.detail(i, `iteration ${iteration}: ${message}`) });
						await writeArtifact(absoluteRunDir, `${step.name.toUpperCase()}_${iteration}.md`, output.trim() || "Agent completed without a final text response.");
						await assertFrozenPathsUnchanged(step.freeze!, frozenBefore, options.cwd, DEFAULT_COMMAND_TIMEOUT_SECONDS, options.signal);
						ui.detail(i, `iteration ${iteration}/${maxIterations}: checking gate`);
						gate = await runShell(until, options.cwd, step.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS, options.signal);
						logs.push(`iteration ${iteration} gate\n${summarizeCommandResult(until, gate)}`);
						if (gate.exitCode === 0) {
							passed = true;
							steps[i].detail = `gate passed after ${iteration} iteration${iteration === 1 ? "" : "s"}`;
							break;
						}
						const currentHash = hashProcessOutput(gate);
						if (currentHash === previousHash) throw new Error(`Loop step stuck with no gate-output progress after iteration ${iteration}: ${step.label ?? step.name}`);
						previousHash = currentHash;
					}
					if (!passed) throw new Error(`Loop step exhausted ${maxIterations} iteration${maxIterations === 1 ? "" : "s"}: ${step.label ?? step.name}\n${gate.stderr || gate.stdout}`.trim());
				}
				steps[i].log = logs.join("\n\n---\n\n").slice(0, 4_000);
				steps[i].durationMs = Date.now() - stepStartedAt;
			}

			steps[i].status = "passed";
			ui.set(i, "passed", steps[i].detail);
		}

		const endedAt = new Date().toISOString();
		await writeArtifact(absoluteRunDir, "SUMMARY.md", summaryMarkdown({ flowPath: relativeFlowPath, task: options.task, runId: id, runDir: relativeRunDir, startedAt, endedAt, status: "passed", steps }));
		ui.complete("passed", `${relativeRunDir}/SUMMARY.md`);
		return relativeRunDir;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (currentIndex >= 0) {
			steps[currentIndex].status = "failed";
			steps[currentIndex].detail = truncate(message, 240);
			ui.set(currentIndex, "failed", message);
		}
		for (let i = currentIndex + 1; i < steps.length; i++) steps[i].status = "skipped";
		const endedAt = new Date().toISOString();
		await writeArtifact(absoluteRunDir, "SUMMARY.md", summaryMarkdown({ flowPath: relativeFlowPath, task: options.task, runId: id, runDir: relativeRunDir, startedAt, endedAt, status: "failed", steps }));
		ui.complete("failed", `${relativeRunDir}/SUMMARY.md`);
		throw error;
	}
}

function discoverFlowFiles(cwd: string): Array<{ label: string; file: string; source: "project" | "bundled"; description?: string }> {
	const candidates = [
		{ dir: path.join(cwd, ".pi", "workflows"), source: "project" as const },
		// Legacy project locations retained so existing workflows keep working.
		{ dir: path.join(cwd, ".pi", "flow"), source: "project" as const },
		{ dir: path.join(cwd, ".pi", "flow", "flows"), source: "project" as const },
		{ dir: path.join(EXTENSION_DIR, "flows"), source: "bundled" as const },
	];
	const seen = new Set<string>();
	const flows: Array<{ label: string; file: string; source: "project" | "bundled"; description?: string }> = [];
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate.dir)) continue;
		for (const entry of fs.readdirSync(candidate.dir, { withFileTypes: true })) {
			if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
			const absolute = path.join(candidate.dir, entry.name);
			if (seen.has(absolute)) continue;
			seen.add(absolute);
			const file = relativeForPrompt(cwd, absolute);
			let description: string | undefined;
			try {
				description = parseFlowYaml(fs.readFileSync(absolute, "utf8"), file).description;
			} catch {
				// Keep /flows useful even when a workflow file is still being edited.
			}
			flows.push({ label: entry.name.replace(/\.ya?ml$/i, ""), file, source: candidate.source, description });
		}
	}
	return flows.sort((a, b) => `${a.source}:${a.label}`.localeCompare(`${b.source}:${b.label}`));
}

function listRunDirs(cwd: string, limit = 10): string[] {
	const runsDir = path.join(cwd, ".pi", "flow", "runs");
	if (!fs.existsSync(runsDir)) return [];
	return fs.readdirSync(runsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(runsDir, entry.name))
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
		.slice(0, limit)
		.map((runDir) => relativeForPrompt(cwd, runDir));
}

export default function flowExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => setFlowReadyUi(ctx));

	pi.registerCommand("flows", {
		description: "List available Flow workflows",
		handler: async (_args, ctx) => {
			const flows = discoverFlowFiles(ctx.cwd);
			const runs = listRunDirs(ctx.cwd, 5);
			pi.sendMessage({
				customType: "flows",
				content: `# Flows\n\n${flows.length ? flows.map((flow) => `- **${flow.label}** (${flow.source}) — \`${flow.file}\`${flow.description ? `\n  - ${flow.description}` : ""}\n  - run: \`/flow ${flow.file} "your task"\``).join("\n") : "No flows found. Add YAML files under `.pi/workflows/`."}\n\n## Recent runs\n\n${runs.length ? runs.map((run) => `- \`${run}\` — summary: \`${run}/SUMMARY.md\``).join("\n") : "No Flow runs yet."}`,
				display: true,
			}, { triggerTurn: false });
		},
	});

	pi.registerCommand("flow", {
		description: "Run a YAML workflow: /flow <flow.yml> <task>",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!match) {
				ctx.ui.notify("Usage: /flow <flow.yml> <task>", "error");
				return;
			}
			const [, flowPath, task] = match;
			try {
				const runDir = await runFlow({ cwd: ctx.cwd, flowPath, task, signal: ctx.signal, ctx });
				pi.sendMessage({ customType: "flow-complete", content: `# Flow Complete\n\n- Flow: \`${flowPath}\`\n- Run: \`${runDir}\`\n- Summary: \`${runDir}/SUMMARY.md\``, display: true }, { triggerTurn: false });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Flow failed: ${message}`, "error");
				pi.sendMessage({ customType: "flow-error", content: `# Flow Error\n\n${message}`, display: true }, { triggerTurn: false });
			}
		},
	});

	pi.registerCommand("flow-runs", {
		description: "Show recent Flow run summaries",
		handler: async (_args, ctx) => {
			const runs = listRunDirs(ctx.cwd, 12);
			pi.sendMessage({
				customType: "flow-runs",
				content: `# Recent Flow Runs\n\n${runs.length ? runs.map((run) => `- \`${run}\`\n  - summary: \`${run}/SUMMARY.md\``).join("\n") : "No Flow runs found in `.pi/flow/runs`."}`,
				display: true,
			}, { triggerTurn: false });
		},
	});

	pi.registerCommand("flow-status", {
		description: "Show Flow help",
		handler: async (_args, ctx) => {
			pi.sendMessage({
				customType: "flow-status",
				content: "# Flow\n\nFlow runs declarative YAML workflows in Pi. Steps can be deterministic shell commands, nested Pi agents, or guarded loops.\n\n## Commands\n\n- `/flows` — list available workflows.\n- `/flow <flow.yml> <task>` — run a workflow.\n- `/flow-runs` — list recent run summaries.\n\n## Project workflows\n\nPut YAML files in `.pi/workflows/`. Run summaries are written to `.pi/flow/runs/<run-id>/SUMMARY.md`.",
				display: true,
			}, { triggerTurn: false });
		},
	});
}
