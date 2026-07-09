import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

export interface ProbeData {
  error?: { code?: number; string?: string };
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
}

export interface MediaRules {
  requireAudio?: boolean;
  requireVideo?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  minDuration?: number;
  maxDuration?: number;
  formatName?: string;
}

export interface MediaSummary {
  duration: number | null;
  formatNames: string[];
  videoStreams: Array<{
    codec: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
  }>;
  audioStreams: Array<{
    codec: string | null;
    channels: number | null;
    sampleRate: number | null;
  }>;
}

export interface MediaValidation {
  ok: boolean;
  errors: string[];
  summary: MediaSummary;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function frameRate(value: unknown): number | null {
  if (typeof value !== "string" || value === "0/0") return finiteNumber(value);
  const [numeratorText, denominatorText] = value.split("/");
  if (denominatorText === undefined) return finiteNumber(value);
  const numerator = Number.parseFloat(numeratorText);
  const denominator = Number.parseFloat(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function summarizeProbe(probe: ProbeData): MediaSummary {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const streamDurations = streams
    .map((stream) => finiteNumber(stream.duration))
    .filter((value): value is number => value !== null);
  const formatDuration = finiteNumber(probe.format?.duration);
  const duration = formatDuration ?? (streamDurations.length ? Math.max(...streamDurations) : null);

  return {
    duration,
    formatNames: String(probe.format?.format_name ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    videoStreams: streams
      .filter((stream) => stream.codec_type === "video")
      .map((stream) => ({
        codec: stream.codec_name ?? null,
        width: finiteNumber(stream.width),
        height: finiteNumber(stream.height),
        fps: frameRate(stream.avg_frame_rate) ?? frameRate(stream.r_frame_rate),
      })),
    audioStreams: streams
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({
        codec: stream.codec_name ?? null,
        channels: finiteNumber(stream.channels),
        sampleRate: finiteNumber(stream.sample_rate),
      })),
  };
}

export function validateProbe(probe: ProbeData, rules: MediaRules): MediaValidation {
  const summary = summarizeProbe(probe);
  const errors: string[] = [];

  if (probe.error) errors.push(`ffprobe reported an input error (code ${probe.error.code ?? "unknown"})`);
  if (!summary.audioStreams.length && !summary.videoStreams.length) errors.push("no audio or video streams found");
  if (rules.requireAudio && !summary.audioStreams.length) errors.push("an audio stream is required");
  if (rules.requireVideo && !summary.videoStreams.length) errors.push("a video stream is required");

  const primaryVideo = summary.videoStreams[0];
  if (rules.width !== undefined && primaryVideo?.width !== rules.width) {
    errors.push(`video width must be ${rules.width}, got ${primaryVideo?.width ?? "missing"}`);
  }
  if (rules.height !== undefined && primaryVideo?.height !== rules.height) {
    errors.push(`video height must be ${rules.height}, got ${primaryVideo?.height ?? "missing"}`);
  }
  if (rules.fps !== undefined) {
    const actualFps = primaryVideo?.fps;
    if (actualFps === null || actualFps === undefined || Math.abs(actualFps - rules.fps) > 0.02) {
      errors.push(`video fps must be ${rules.fps}, got ${actualFps ?? "missing"}`);
    }
  }
  if (rules.minDuration !== undefined && (summary.duration === null || summary.duration < rules.minDuration)) {
    errors.push(`duration must be at least ${rules.minDuration}s, got ${summary.duration ?? "missing"}`);
  }
  if (rules.maxDuration !== undefined && (summary.duration === null || summary.duration > rules.maxDuration)) {
    errors.push(`duration must be at most ${rules.maxDuration}s, got ${summary.duration ?? "missing"}`);
  }
  if (rules.formatName && !summary.formatNames.includes(rules.formatName)) {
    errors.push(`format must include ${rules.formatName}, got ${summary.formatNames.join(",") || "missing"}`);
  }

  return { ok: errors.length === 0, errors, summary };
}

export async function loadProbeFixture(path: string): Promise<ProbeData> {
  return (await Bun.file(path).json()) as ProbeData;
}

export async function probeMedia(path: string, ffprobeCommand = "ffprobe", timeoutMs = 20_000): Promise<ProbeData> {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) throw new Error("media input does not exist");
  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = Bun.spawn(
      [ffprobeCommand, "-v", "error", "-show_error", "-show_format", "-show_streams", "-of", "json", absolutePath],
      { stdout: "pipe", stderr: "ignore" },
    );
  } catch {
    throw new Error("ffprobe could not be started; run the environment preflight first");
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  clearTimeout(timer);

  if (timedOut) throw new Error(`ffprobe timed out after ${timeoutMs}ms`);
  if (exitCode !== 0 && !stdout.trim()) throw new Error(`ffprobe exited with code ${exitCode}`);

  try {
    return JSON.parse(stdout) as ProbeData;
  } catch {
    throw new Error("ffprobe did not return valid JSON");
  }
}
