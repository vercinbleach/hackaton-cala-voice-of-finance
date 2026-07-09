import { spawn } from "node:child_process";

import type { ProcessCommand, ProcessExecution } from "./types.ts";

export function executeProcess(input: ProcessCommand): Promise<ProcessExecution> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: input.command,
        args: [...input.args],
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs ?? 600_000);

    child.once("error", (error) => finish(null, error.message));
    child.once("close", (exitCode) => finish(exitCode, timedOut ? "Process timed out." : undefined));
  });
}

export function parseJsonOutput(output: string): unknown | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some CLIs emit setup logs before their JSON payload.
  }

  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      // Continue looking for the first line of a trailing JSON value.
    }
  }
  return undefined;
}
