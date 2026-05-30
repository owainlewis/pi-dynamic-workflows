import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";
type StepType = "agent" | "command";

interface FlowStep {
	name: string;
	type: StepType;
	label?: string;
	prompt?: string;
	run?: string;
	tools?: string;
	timeoutSeconds?: number;
}

interface FlowDefinition {
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
	artifact?: string;
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

function safeArtifactName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, "-");
}

function runId(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

function workspaceFooterLine(ctx: any, footerData: any): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	let cwd = ctx.cwd as string;
	if (home && cwd.startsWith(home)) cwd = `~${cwd.slice(home.length)}`;
	const branch = footerData?.getGitBranch?.();
	return branch ? `${cwd} (${branch})` : cwd;
}

function setFlowReadyFooter(ctx: any): void {
	if (!ctx.hasUI) return;
	ctx.ui.setFooter((_tui: any, _theme: any, footerData: any) => ({
		render(width: number) {
			return [
				truncateToWidth(color(workspaceFooterLine(ctx, footerData), ANSI.dim), width),
				truncateToWidth(`${color("Flow ready", ANSI.softGreen)} ${color("•", ANSI.gray)} /flows ${color("•", ANSI.gray)} /flow <flow.yml> <task> ${color("•", ANSI.gray)} /flow-runs`, width),
			];
		},
		invalidate() {},
	}));
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

	const finish = () => {
		if (!current) return;
		if (!current.name) throw new Error(`${flowPath}: step is missing name`);
		if (!/^[A-Za-z0-9_-]+$/.test(current.name)) throw new Error(`${flowPath}: invalid step name: ${current.name}`);
		if (seen.has(current.name)) throw new Error(`${flowPath}: duplicate step name: ${current.name}`);
		seen.add(current.name);
		if (current.type !== "agent" && current.type !== "command") throw new Error(`${flowPath}: step ${current.name} must have type agent or command`);
		if (current.type === "agent" && !current.prompt) throw new Error(`${flowPath}: agent step ${current.name} is missing prompt`);
		if (current.type === "command" && !current.run) throw new Error(`${flowPath}: command step ${current.name} is missing run`);
		if (current.timeoutSeconds !== undefined && (!Number.isFinite(current.timeoutSeconds) || current.timeoutSeconds <= 0)) throw new Error(`${flowPath}: step ${current.name} timeoutSeconds must be positive`);
		steps.push(current as FlowStep);
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripYamlComment(rawLine);
		if (!line.trim() || /^\s*steps\s*:\s*$/.test(line)) continue;
		const stepStart = line.match(/^\s*-\s+name\s*:\s*(.+?)\s*$/);
		if (stepStart) {
			finish();
			current = { name: unquoteYamlValue(stepStart[1]) };
			continue;
		}
		const prop = line.match(/^\s+(name|type|label|prompt|run|tools|timeoutSeconds)\s*:\s*(.+?)\s*$/);
		if (!prop) throw new Error(`${flowPath}: unsupported or malformed line: ${rawLine.trim()}`);
		if (!current) current = {};
		const key = prop[1];
		const value = unquoteYamlValue(prop[2]);
		(current as any)[key] = key === "timeoutSeconds" ? Number.parseInt(value, 10) : value;
	}
	finish();
	if (steps.length === 0) throw new Error(`${flowPath}: no steps found`);
	return { steps };
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

function commandArtifact(step: FlowStep, result: ProcessResult): string {
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	return [`# Command Step: ${step.label ?? step.name}`, "", `- command: \`${step.run}\``, `- status: ${result.exitCode === 0 ? "passed" : "failed"}`, `- exitCode: ${result.exitCode}`, `- durationMs: ${result.durationMs}`, `- timedOut: ${result.timedOut}`, output ? `\n\`\`\`text\n${output.slice(0, 8_000)}\n\`\`\`` : ""].join("\n");
}

function summaryMarkdown(data: { flowPath: string; task: string; runId: string; runDir: string; startedAt: string; endedAt: string; status: "passed" | "failed"; steps: StepSummary[] }): string {
	const durationMs = Math.max(0, Date.parse(data.endedAt) - Date.parse(data.startedAt));
	const lines = [`# Flow Run ${data.status === "passed" ? "✅" : "❌"}`, "", `- status: ${data.status}`, `- flow: \`${data.flowPath}\``, `- run id: \`${data.runId}\``, `- run dir: \`${data.runDir}\``, `- duration: ${Math.round(durationMs / 1000)}s`, "", "## Task", "", data.task, "", "## Steps"];
	for (const step of data.steps) {
		const icon = step.status === "passed" ? "✅" : step.status === "failed" ? "❌" : step.status === "skipped" ? "⏭️" : "◻️";
		lines.push("", `### ${icon} ${step.label}`, "", `- name: ${step.name}`, `- type: ${step.type}`, `- status: ${step.status}`, `- duration: ${step.durationMs === undefined ? "n/a" : `${Math.round(step.durationMs / 1000)}s`}`, `- detail: ${step.detail || "n/a"}`);
		if (step.artifact) lines.push(`- artifact: \`${step.artifact}\``);
	}
	return `${lines.join("\n").trim()}\n`;
}

function createFlowUi(ctx: any, flowPath: string, runDir: string, steps: FlowStep[]) {
	const statuses = steps.map((step) => ({ label: step.label ?? step.name, status: "pending" as StepStatus, detail: "", startedAt: 0 }));
	const startedAt = Date.now();
	const progressBar = () => {
		const done = statuses.filter((step) => step.status === "passed" || step.status === "skipped").length;
		const failed = statuses.some((step) => step.status === "failed");
		const width = 24;
		const filled = Math.round((done / Math.max(1, statuses.length)) * width);
		return `${color("█".repeat(filled), failed ? ANSI.red : ANSI.green)}${color("░".repeat(width - filled), ANSI.gray)} ${done}/${statuses.length}`;
	};
	const render = (active: string) => {
		if (!ctx.hasUI) return;
		const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
		const lines = [
			color("Flow", ANSI.softGreen + ANSI.bold),
			`${color("Flow:", ANSI.cyan)} ${flowPath}`,
			`${color("Run:", ANSI.cyan)} ${runDir} ${color("•", ANSI.gray)} ${progressBar()} ${color("•", ANSI.gray)} ${elapsed}s`,
			"",
			...statuses.map((step, index) => {
				const symbol = step.status === "passed" ? color("✓", ANSI.green) : step.status === "failed" ? color("✗", ANSI.red) : step.status === "running" ? color("▶", ANSI.amber) : color("○", ANSI.gray);
				const timer = step.status === "running" && step.startedAt ? color(` ${Math.round((Date.now() - step.startedAt) / 1000)}s`, ANSI.amber) : "";
				return `${symbol} ${color(step.label.padEnd(24), statusColor(step.status))} ${color(`${index + 1}/${steps.length}`, ANSI.gray)}${timer}${step.detail ? color(` — ${step.detail}`, ANSI.dim) : ""}`;
			}),
			"",
			`${color("Current:", ANSI.cyan)} ${active}`,
		];
		ctx.ui.setStatus("flow", `Flow ${progressBar()} • ${active}`);
		ctx.ui.setWidget("flow-progress", (_tui: any, _theme: any) => ({
			render(width: number) {
				const rendered: string[] = [];
				for (const line of lines) for (const wrapped of wrapTextWithAnsi(line, Math.max(20, width - 2))) rendered.push(truncateToWidth(` ${wrapped}`, width));
				return rendered;
			},
			invalidate() {},
		}), { placement: "aboveEditor" });
	};
	return {
		set(index: number, status: StepStatus, detail = "") {
			statuses[index].status = status;
			statuses[index].detail = truncate(detail, 140);
			if (status === "running") statuses[index].startedAt = Date.now();
			render(`${statuses[index].label}: ${detail || status}`);
		},
		detail(index: number, detail: string) {
			statuses[index].detail = truncate(detail, 140);
			render(`${statuses[index].label}: ${detail}`);
		},
		clear() {
			ctx.ui.setStatus("flow", undefined);
			ctx.ui.setWidget("flow-progress", undefined);
			setFlowReadyFooter(ctx);
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

	await writeArtifact(absoluteRunDir, "RUN.json", JSON.stringify({ flowPath: relativeFlowPath, runId: id, runDir: relativeRunDir, startedAt, status: "running", steps }, null, 2));

	let currentIndex = -1;
	try {
		for (let i = 0; i < flow.steps.length; i++) {
			currentIndex = i;
			const step = flow.steps[i];
			const stepStartedAt = Date.now();
			const vars: FlowVars = { Task: options.task, RunID: id, RunDir: relativeRunDir, CWD: options.cwd, FlowPath: relativeFlowPath, StepName: step.name };
			steps[i].status = "running";
			steps[i].detail = step.type;
			ui.set(i, "running", step.type);

			if (step.type === "command") {
				const command = renderTemplate(step.run!, vars);
				ui.detail(i, command);
				const result = await runShell(command, options.cwd, step.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS, options.signal);
				const artifact = await writeArtifact(absoluteRunDir, `${safeArtifactName(step.name)}.command.md`, commandArtifact({ ...step, run: command }, result));
				steps[i].artifact = relativeForPrompt(options.cwd, artifact);
				steps[i].durationMs = Date.now() - stepStartedAt;
				steps[i].detail = result.exitCode === 0 ? `passed in ${result.durationMs}ms` : `failed with exit code ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`;
				if (result.exitCode !== 0) throw new Error(`Command step failed: ${step.label ?? step.name}\n${result.stderr || result.stdout}`.trim());
			} else {
				const promptPath = path.resolve(path.dirname(absoluteFlowPath), step.prompt!);
				const prompt = renderTemplate(await readFile(promptPath, "utf8"), vars);
				const tools = step.tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
				const output = await runAgent({ cwd: options.cwd, prompt, tools, timeoutSeconds: step.timeoutSeconds ?? parsePositiveInt(process.env.FLOW_AGENT_TIMEOUT_SECONDS, DEFAULT_AGENT_TIMEOUT_SECONDS), signal: options.signal, onProgress: (message) => ui.detail(i, message) });
				const artifact = await writeArtifact(absoluteRunDir, `${safeArtifactName(step.name)}.agent.md`, output || `# ${step.label ?? step.name}\n\nCompleted.`);
				steps[i].artifact = relativeForPrompt(options.cwd, artifact);
				steps[i].durationMs = Date.now() - stepStartedAt;
				steps[i].detail = "agent completed";
			}

			steps[i].status = "passed";
			ui.set(i, "passed", steps[i].detail);
		}

		const endedAt = new Date().toISOString();
		await writeArtifact(absoluteRunDir, "SUMMARY.md", summaryMarkdown({ flowPath: relativeFlowPath, task: options.task, runId: id, runDir: relativeRunDir, startedAt, endedAt, status: "passed", steps }));
		await writeArtifact(absoluteRunDir, "RUN.json", JSON.stringify({ flowPath: relativeFlowPath, runId: id, runDir: relativeRunDir, startedAt, endedAt, status: "passed", steps }, null, 2));
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
		await writeArtifact(absoluteRunDir, "RUN.json", JSON.stringify({ flowPath: relativeFlowPath, runId: id, runDir: relativeRunDir, startedAt, endedAt, status: "failed", error: message, steps }, null, 2));
		throw error;
	} finally {
		ui.clear();
	}
}

function discoverFlowFiles(cwd: string): Array<{ label: string; file: string; source: "project" | "bundled" }> {
	const candidates = [
		{ dir: path.join(cwd, ".pi", "workflows"), source: "project" as const },
		// Legacy project locations retained so existing workflows keep working.
		{ dir: path.join(cwd, ".pi", "flow"), source: "project" as const },
		{ dir: path.join(cwd, ".pi", "flow", "flows"), source: "project" as const },
		{ dir: path.join(EXTENSION_DIR, "flows"), source: "bundled" as const },
	];
	const seen = new Set<string>();
	const flows: Array<{ label: string; file: string; source: "project" | "bundled" }> = [];
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate.dir)) continue;
		for (const entry of fs.readdirSync(candidate.dir, { withFileTypes: true })) {
			if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
			const absolute = path.join(candidate.dir, entry.name);
			if (seen.has(absolute)) continue;
			seen.add(absolute);
			flows.push({ label: entry.name.replace(/\.ya?ml$/i, ""), file: relativeForPrompt(cwd, absolute), source: candidate.source });
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
	pi.on("session_start", async (_event, ctx) => setFlowReadyFooter(ctx));

	pi.registerCommand("flows", {
		description: "List available Flow workflows",
		handler: async (_args, ctx) => {
			const flows = discoverFlowFiles(ctx.cwd);
			const runs = listRunDirs(ctx.cwd, 5);
			pi.sendMessage({
				customType: "flows",
				content: `# Flows\n\n${flows.length ? flows.map((flow) => `- **${flow.label}** (${flow.source}) — \`${flow.file}\`\n  - run: \`/flow ${flow.file} "your task"\``).join("\n") : "No flows found. Add YAML files under `.pi/workflows/`."}\n\n## Recent runs\n\n${runs.length ? runs.map((run) => `- \`${run}\` — summary: \`${run}/SUMMARY.md\``).join("\n") : "No Flow runs yet."}`,
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
		description: "Show recent Flow run artifact directories",
		handler: async (_args, ctx) => {
			const runs = listRunDirs(ctx.cwd, 12);
			pi.sendMessage({
				customType: "flow-runs",
				content: `# Recent Flow Runs\n\n${runs.length ? runs.map((run) => `- \`${run}\`\n  - summary: \`${run}/SUMMARY.md\`\n  - manifest: \`${run}/RUN.json\``).join("\n") : "No Flow runs found in `.pi/flow/runs`."}`,
				display: true,
			}, { triggerTurn: false });
		},
	});

	pi.registerCommand("flow-status", {
		description: "Show Flow help",
		handler: async (_args, ctx) => {
			pi.sendMessage({
				customType: "flow-status",
				content: "# Flow\n\nFlow runs declarative YAML workflows in Pi. Steps can be deterministic shell commands or nested Pi agents.\n\n## Commands\n\n- `/flows` — list available workflows.\n- `/flow <flow.yml> <task>` — run a workflow.\n- `/flow-runs` — list recent run artifacts.\n\n## Project workflows\n\nPut YAML files in `.pi/workflows/`. Run artifacts are written to `.pi/flow/runs/<run-id>/`.",
				display: true,
			}, { triggerTurn: false });
		},
	});
}
