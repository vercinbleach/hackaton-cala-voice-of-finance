import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeExecutables, withExecutableDirectory } from "../server/runtime.ts";

type Status = "passed" | "failed" | "skipped";

interface CheckResult {
  id: string;
  label: string;
  required: boolean;
  status: Status;
  version?: string;
  detail: string;
}

interface CommandResult {
  started: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
}

interface DoctorSummary {
  source: string;
  parsed: boolean;
  requiredChecks: DoctorCheck[];
  optionalChecks: DoctorCheck[];
}

const allowedArguments = new Set([
  "--json",
  "--strict",
  "--skip-hyperframes",
  "--allow-npx-download",
  "--help",
  "-h",
]);

function usage(): string {
  return [
    "Usage: bun scripts/preflight.ts [options]",
    "",
    "  --json                 Emit one redacted JSON report",
    "  --strict               Exit 1 when a required check is not ready",
    "  --skip-hyperframes     Do not run HyperFrames doctor",
    "  --allow-npx-download   Allow npx to download HyperFrames into its cache",
  ].join("\n");
}

function redact(value: string): string {
  let safe = value.replace(
    /((?:api[ _-]?key|token|secret|password|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    "$1[REDACTED]",
  );
  safe = safe.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  for (const home of [process.env.USERPROFILE, process.env.HOME]) {
    if (home) safe = safe.replaceAll(home, "~");
  }
  return safe.trim().slice(0, 240);
}

function firstLine(value: string): string {
  return redact(value.split(/\r?\n/).find((line) => line.trim()) ?? "");
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 20_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", env });
  } catch {
    return { started: false, exitCode: null, stdout: "", stderr: "", timedOut: false };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { started: true, exitCode, stdout, stderr, timedOut };
}

async function toolCheck(id: string, label: string, command: string, args: string[]): Promise<CheckResult> {
  const result = await runCommand(command, args, 8_000);
  if (!result.started) {
    return { id, label, required: true, status: "failed", detail: `${label} was not found on PATH` };
  }
  if (result.timedOut) {
    return { id, label, required: true, status: "failed", detail: `${label} version check timed out` };
  }
  const version = firstLine(result.stdout || result.stderr);
  if (result.exitCode !== 0) {
    return { id, label, required: true, status: "failed", detail: `${label} exited with code ${result.exitCode}` };
  }
  return { id, label, required: true, status: "passed", version, detail: "available" };
}

function chromeFiles(): string[] {
  if (process.platform !== "win32") return [];
  const candidates: string[] = [];
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(
    (value): value is string => Boolean(value),
  );
  for (const root of roots) {
    candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
    candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
  }
  return candidates;
}

async function directChromeCheck(): Promise<CheckResult> {
  if (chromeFiles().some((path) => existsSync(path))) {
    return {
      id: "chrome",
      label: "Chrome",
      required: true,
      status: "passed",
      detail: "Chrome-compatible browser detected in a standard Windows location",
    };
  }

  if (process.platform !== "win32") {
    for (const command of ["google-chrome", "chromium", "chromium-browser"]) {
      const result = await runCommand(command, ["--version"], 5_000);
      if (result.started && result.exitCode === 0) {
        return {
          id: "chrome",
          label: "Chrome",
          required: true,
          status: "passed",
          version: firstLine(result.stdout || result.stderr),
          detail: "Chrome-compatible browser available",
        };
      }
    }
  }

  return {
    id: "chrome",
    label: "Chrome",
    required: true,
    status: "failed",
    detail: "Chrome was not found directly; HyperFrames doctor may still provide a managed browser",
  };
}

function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hyperframesDoctor(allowDownload: boolean, env: NodeJS.ProcessEnv): Promise<{
  check: CheckResult;
  summary: DoctorSummary | null;
  chromeReady: boolean;
}> {
  const localBinary = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "hyperframes.cmd" : "hyperframes",
  );
  const candidates: Array<{ command: string; args: string[]; source: string }> = [];
  if (existsSync(localBinary)) candidates.push({ command: localBinary, args: ["doctor", "--json"], source: "local" });
  candidates.push({ command: "hyperframes", args: ["doctor", "--json"], source: "PATH" });
  candidates.push({ command: "npx", args: ["--no-install", "hyperframes", "doctor", "--json"], source: "npx-cache" });
  if (allowDownload) {
    candidates.push({ command: "npx", args: ["--yes", "hyperframes", "doctor", "--json"], source: "npx-download" });
  }

  let lastFailure = "HyperFrames doctor could not be started";
  for (const candidate of candidates) {
    const result = await runCommand(candidate.command, candidate.args, 30_000, env);
    if (!result.started) continue;
    if (result.timedOut) {
      lastFailure = "HyperFrames doctor timed out";
      continue;
    }

    const parsed = extractJson(result.stdout || result.stderr);
    if (!isRecord(parsed) || !Array.isArray(parsed.checks)) {
      lastFailure = `HyperFrames doctor did not return JSON (exit ${result.exitCode ?? "unknown"})`;
      continue;
    }

    const doctorChecks = parsed.checks
      .filter(isRecord)
      .filter((item) => typeof item.name === "string" && typeof item.ok === "boolean")
      .map((item) => ({ name: item.name as string, ok: item.ok as boolean }));
    const requiredNames = ["Version", "Node.js", "FFmpeg", "FFprobe", "Chrome"];
    const requiredChecks = requiredNames.map((name) => ({
      name,
      ok: doctorChecks.find((item) => item.name === name)?.ok === true,
    }));
    const optionalChecks = doctorChecks.filter((item) => !requiredNames.includes(item.name));
    const requiredReady = requiredChecks.every((item) => item.ok);
    const optionalMissing = optionalChecks.filter((item) => !item.ok).length;

    return {
      check: {
        id: "hyperframes-doctor",
        label: "HyperFrames doctor",
        required: true,
        status: requiredReady ? "passed" : "failed",
        detail: `doctor JSON parsed; required ${requiredChecks.filter((item) => item.ok).length}/${requiredChecks.length}; optional unavailable ${optionalMissing}`,
      },
      summary: { source: candidate.source, parsed: true, requiredChecks, optionalChecks },
      chromeReady: requiredChecks.find((item) => item.name === "Chrome")?.ok === true,
    };
  }

  return {
    check: {
      id: "hyperframes-doctor",
      label: "HyperFrames doctor",
      required: true,
      status: "failed",
      detail: lastFailure,
    },
    summary: null,
    chromeReady: false,
  };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const unknown = argv.filter((argument) => !allowedArguments.has(argument));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(", ")}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const skipHyperframes = argv.includes("--skip-hyperframes");
  const executables = await resolveRuntimeExecutables();
  const renderEnv = withExecutableDirectory(process.env, executables.ffmpeg);
  const [bun, node, codex, ffmpeg, ffprobe, chrome, doctor] = await Promise.all([
    toolCheck("bun", "Bun", "bun", ["--version"]),
    toolCheck("node", "Node.js", "node", ["--version"]),
    toolCheck("codex", "Codex CLI", executables.codex, ["--version"]),
    toolCheck("ffmpeg", "FFmpeg", executables.ffmpeg, ["-version"]),
    toolCheck("ffprobe", "FFprobe", executables.ffprobe, ["-version"]),
    directChromeCheck(),
    skipHyperframes
      ? Promise.resolve(null)
      : hyperframesDoctor(argv.includes("--allow-npx-download"), renderEnv),
  ]);

  if (chrome.status === "failed" && doctor?.chromeReady) {
    chrome.status = "passed";
    chrome.detail = "HyperFrames doctor detected a managed Chrome-compatible browser";
  }

  const doctorCheck: CheckResult = doctor?.check ?? {
    id: "hyperframes-doctor",
    label: "HyperFrames doctor",
    required: true,
    status: "skipped",
    detail: "skipped by command-line option",
  };
  const checks = [bun, node, codex, doctorCheck, chrome, ffmpeg, ffprobe];
  const ready = checks.every((check) => !check.required || check.status === "passed");
  const report = {
    ready,
    platform: process.platform,
    architecture: process.arch,
    generatedAt: new Date().toISOString(),
    checks,
    hyperframesDoctor: doctor?.summary ?? null,
  };

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Environment preflight: ${ready ? "READY" : "NOT READY"}`);
    for (const check of checks) {
      const marker = check.status === "passed" ? "PASS" : check.status === "skipped" ? "SKIP" : "FAIL";
      console.log(`[${marker}] ${check.label}: ${check.version ?? check.detail}`);
    }
  }

  if (argv.includes("--strict") && !ready) process.exitCode = 1;
}

await main();
