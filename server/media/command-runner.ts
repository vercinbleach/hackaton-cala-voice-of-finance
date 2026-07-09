import { mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ArtifactRef, PipelineCheck } from "../../shared/contracts.ts";
import { executeProcess, parseJsonOutput } from "./process-runner.ts";
import type {
  CommandCheckResult,
  HyperframesCommandEvent,
  HyperframesRunResult,
  ProcessCommand,
  ProcessExecutor,
} from "./types.ts";

type CommandEventReporter = (event: HyperframesCommandEvent) => Promise<void> | void;
import { makeArtifactRef, projectRelativePath } from "./utils.ts";

function defaultInvocation(): { command: string; prefixArgs: string[] } {
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    prefixArgs: ["--yes", "hyperframes"],
  };
}

function commandDetail(result: CommandCheckResult): string {
  if (result.status === "skipped") return result.detail;
  const execution = result.execution!;
  if (execution.error) return execution.error;
  const message = execution.stderr.trim() || execution.stdout.trim();
  return message ? message.slice(0, 800) : `Exit code ${execution.exitCode}.`;
}

async function runCommand(
  id: CommandCheckResult["id"],
  command: ProcessCommand,
  executor: ProcessExecutor,
  expectJson: boolean,
): Promise<CommandCheckResult> {
  const execution = await executor(command);
  const data = expectJson ? parseJsonOutput(execution.stdout) : undefined;
  const jsonPassed = !expectJson || (data !== undefined && !(typeof data === "object" && data !== null && "ok" in data && data.ok === false));
  const passed = execution.exitCode === 0 && !execution.error && jsonPassed;
  const result: CommandCheckResult = {
    id,
    status: passed ? "passed" : "failed",
    execution,
    ...(data !== undefined ? { data } : {}),
    detail: passed
      ? `${id} completed in ${execution.durationMs}ms.`
      : expectJson && execution.exitCode === 0 && data === undefined
        ? `${id} returned no parseable JSON.`
        : `${id} failed with ${commandDetail({ id, status: "failed", execution, detail: "" })}`,
  };
  return result;
}

function skipped(id: CommandCheckResult["id"], blocker: string): CommandCheckResult {
  return { id, status: "skipped", detail: `Skipped because ${blocker} failed.` };
}

async function runWithHeartbeat<T>(
  operation: Promise<T>,
  onHeartbeat: ((elapsedMs: number) => Promise<void> | void) | undefined,
  intervalMs: number,
): Promise<T> {
  if (!onHeartbeat) return operation;

  const startedAt = Date.now();
  const outcome = operation.then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

  while (true) {
    const result = await Promise.race([
      outcome,
      new Promise<{ kind: "heartbeat" }>((resolveHeartbeat) => {
        setTimeout(() => resolveHeartbeat({ kind: "heartbeat" }), intervalMs);
      }),
    ]);
    if (result.kind === "heartbeat") {
      await onHeartbeat(Date.now() - startedAt);
      continue;
    }
    if (result.kind === "error") throw result.error;
    return result.value;
  }
}

export async function runHyperframesCommands(input: {
  projectDir: string;
  outputPath?: string;
  executor?: ProcessExecutor;
  command?: string;
  prefixArgs?: string[];
  env?: Record<string, string | undefined>;
  createdAt?: string;
  continueOnFailure?: boolean;
  heartbeatMs?: number;
  onCommandEvent?: CommandEventReporter;
}): Promise<HyperframesRunResult> {
  const projectDir = resolve(input.projectDir);
  const compositionDir = join(projectDir, "hyperframes");
  const outputPath = input.outputPath
    ? isAbsolute(input.outputPath)
      ? input.outputPath
      : resolve(projectDir, input.outputPath)
    : join(projectDir, "renders", "output.mp4");
  const snapshotDir = join(compositionDir, "snapshots");
  await mkdir(snapshotDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  const defaults = defaultInvocation();
  const executable = input.command ?? defaults.command;
  const prefixArgs = input.prefixArgs ?? defaults.prefixArgs;
  const executor = input.executor ?? executeProcess;
  const commands: CommandCheckResult[] = [];
  const specs: Array<{ id: CommandCheckResult["id"]; args: string[]; json: boolean; timeoutMs: number; cwd?: string }> = [
    { id: "lint", args: ["lint", compositionDir, "--json"], json: true, timeoutMs: 60_000 },
    {
      id: "inspect",
      args: ["inspect", compositionDir, "--json", "--strict"],
      json: true,
      timeoutMs: 120_000,
    },
    {
      id: "snapshot",
      args: ["snapshot", compositionDir, "--frames", "7"],
      json: false,
      timeoutMs: 180_000,
    },
    {
      id: "render",
      args: ["render", "--output", outputPath, "--fps", "30", "--resolution", "portrait", "--quality", "standard"],
      json: false,
      timeoutMs: 900_000,
      cwd: compositionDir,
    },
  ];

  for (const spec of specs) {
    const blocker = commands.find((result) => result.status !== "passed");
    if (blocker && !input.continueOnFailure) {
      const result = skipped(spec.id, blocker.id);
      commands.push(result);
      await input.onCommandEvent?.({ id: spec.id, phase: "completed", elapsedMs: 0, status: result.status });
      continue;
    }
    const startedAt = Date.now();
    await input.onCommandEvent?.({ id: spec.id, phase: "started", elapsedMs: 0 });
    const result = await runWithHeartbeat(
      runCommand(
        spec.id,
        {
          command: executable,
          args: [...prefixArgs, ...spec.args],
          cwd: spec.cwd ?? projectDir,
          timeoutMs: spec.timeoutMs,
          env: input.env,
        },
        executor,
        spec.json,
      ),
      input.onCommandEvent
        ? (elapsedMs) => input.onCommandEvent?.({ id: spec.id, phase: "heartbeat", elapsedMs })
        : undefined,
      input.heartbeatMs ?? 10_000,
    );
    commands.push(result);
    await input.onCommandEvent?.({
      id: spec.id,
      phase: "completed",
      elapsedMs: Date.now() - startedAt,
      status: result.status,
    });
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const artifacts: ArtifactRef[] = [];
  if (commands.find((result) => result.id === "snapshot")?.status === "passed") {
    const names = (await readdir(snapshotDir)).filter((name) => name.toLowerCase().endsWith(".png")).sort();
    for (const name of names) {
      artifacts.push(
        makeArtifactRef({
          kind: "snapshot",
          label: `HyperFrames snapshot ${name}`,
          stage: "render",
          relativePath: projectRelativePath(projectDir, join(snapshotDir, name)),
          mimeType: "image/png",
          createdAt,
        }),
      );
    }
  }
  if (commands.find((result) => result.id === "render")?.status === "passed") {
    artifacts.push(
      makeArtifactRef({
        kind: "video",
        label: "Rendered finance reel",
        stage: "render",
        relativePath: projectRelativePath(projectDir, outputPath),
        mimeType: "video/mp4",
        createdAt,
      }),
    );
  }

  const checks: PipelineCheck[] = commands.map((result) => ({
    id: `hyperframes-${result.id}`,
    label: `HyperFrames ${result.id}`,
    stage: "render",
    status: result.status === "passed" ? "passed" : "failed",
    detail: result.detail,
    measuredAt: createdAt,
  }));
  const layoutPassed = commands
    .filter((result) => result.id !== "render")
    .every((result) => result.status === "passed");
  checks.push({
    id: "render-layout",
    label: "Layout y motion",
    stage: "render",
    status: layoutPassed ? "passed" : "failed",
    detail: layoutPassed ? "Lint, inspect, and snapshots completed." : "A layout validation command failed or was skipped.",
    measuredAt: createdAt,
  });

  return {
    ok: commands.every((result) => result.status === "passed"),
    commands,
    checks,
    artifacts,
    ...(commands.find((result) => result.id === "render")?.status === "passed" ? { outputPath } : {}),
  };
}
