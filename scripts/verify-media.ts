import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveRuntimeExecutables } from "../server/runtime";
import { probeMedia, validateProbe } from "./lib/media-probe";

async function latestProject(root: string): Promise<string> {
  const candidates = await Promise.all((await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const project = join(root, entry.name);
      try {
        const run = await Bun.file(join(project, "run.json")).json() as { updatedAt?: string };
        return existsSync(join(project, "renders", "output.mp4"))
          ? { project, updatedAt: run.updatedAt ?? "" }
          : null;
      } catch {
        return null;
      }
    }));
  const project = candidates
    .filter((item): item is { project: string; updatedAt: string } => item !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.project;
  if (!project) throw new Error("No hay un proyecto renderizado. Ejecuta demo:real o usa --project <ruta>.");
  return project;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Snapshot PNG invalido.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function main(): Promise<void> {
  const projectFlag = Bun.argv.indexOf("--project");
  const explicit = projectFlag >= 0 ? Bun.argv[projectFlag + 1] : undefined;
  if (projectFlag >= 0 && !explicit) throw new Error("--project requiere una ruta.");
  const project = explicit
    ? resolve(explicit)
    : await latestProject(resolve(process.cwd(), "projects"));
  const runtime = await resolveRuntimeExecutables();
  const output = join(project, "renders", "output.mp4");
  const probe = await probeMedia(output, runtime.ffprobe, 30_000);
  const validation = validateProbe(probe, {
    requireVideo: true,
    requireAudio: true,
    width: 1080,
    height: 1920,
    fps: 30,
    minDuration: 15,
    maxDuration: 45,
    formatName: "mp4",
  });
  const video = validation.summary.videoStreams[0];
  const audio = validation.summary.audioStreams[0];
  if (video?.codec !== "h264") validation.errors.push(`video codec must be h264, got ${video?.codec ?? "missing"}`);
  if (audio?.codec !== "aac") validation.errors.push(`audio codec must be aac, got ${audio?.codec ?? "missing"}`);

  const snapshotsDir = join(project, "hyperframes", "snapshots");
  const snapshots = (await readdir(snapshotsDir)).filter((name) => /^frame-.*\.png$/i.test(name)).sort();
  if (snapshots.length < 7) validation.errors.push(`expected at least 7 snapshots, got ${snapshots.length}`);
  for (const name of snapshots) {
    const dimensions = pngDimensions(await readFile(join(snapshotsDir, name)));
    if (dimensions.width !== 1080 || dimensions.height !== 1920) {
      validation.errors.push(`${name} must be 1080x1920, got ${dimensions.width}x${dimensions.height}`);
    }
  }

  const ok = validation.errors.length === 0;
  console.log(JSON.stringify({
    ok,
    project,
    duration: validation.summary.duration,
    videoCodec: video?.codec,
    audioCodec: audio?.codec,
    snapshots: snapshots.length,
    errors: validation.errors,
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

await main();
