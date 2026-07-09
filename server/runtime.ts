import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RuntimeExecutables {
  codex: string;
  ffmpeg: string;
  ffprobe: string;
  hyperframes: string;
  hyperframesPrefixArgs: string[];
}

async function findWingetExecutable(name: string): Promise<string | undefined> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return undefined;
  const packages = join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  if (!existsSync(packages)) return undefined;

  const glob = new Bun.Glob(`Gyan.FFmpeg*/**/bin/${name}.exe`);
  for await (const relativePath of glob.scan({ cwd: packages, absolute: false })) {
    return join(packages, relativePath);
  }
  return undefined;
}

async function requireExecutable(name: string): Promise<string> {
  const direct = Bun.which(name);
  if (direct) return direct;
  const winget = await findWingetExecutable(name);
  if (winget) return winget;
  throw new Error(`No se encontro ${name} en PATH ni en WinGet.`);
}

export async function resolveRuntimeExecutables(): Promise<RuntimeExecutables> {
  const [codex, ffmpeg, ffprobe, node] = await Promise.all([
    requireExecutable("codex"),
    requireExecutable("ffmpeg"),
    requireExecutable("ffprobe"),
    requireExecutable("node"),
  ]);

  const hyperframesCli = resolve(process.cwd(), "node_modules", "hyperframes", "dist", "cli.js");
  if (!existsSync(hyperframesCli)) {
    throw new Error("No se encontro el CLI local de HyperFrames. Ejecuta npm install.");
  }

  return {
    codex,
    ffmpeg,
    ffprobe,
    hyperframes: node,
    hyperframesPrefixArgs: [hyperframesCli],
  };
}

export function withExecutableDirectory(env: NodeJS.ProcessEnv, executable: string): NodeJS.ProcessEnv {
  const separator = process.platform === "win32" ? ";" : ":";
  const directory = executable.slice(0, Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\")));
  const result = { ...env };
  const existingPath = Object.entries(result).find(([key]) => key.toUpperCase() === "PATH")?.[1];
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === "PATH") delete result[key];
  }
  result.PATH = [directory, existingPath].filter(Boolean).join(separator);
  return result;
}
