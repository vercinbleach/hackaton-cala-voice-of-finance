import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { executeProcess } from "./process-runner.ts";
import {
  FINANCE_REEL_FPS,
  FINANCE_REEL_HEIGHT,
  FINANCE_REEL_MAX_DURATION,
  FINANCE_REEL_MIN_DURATION,
  FINANCE_REEL_WIDTH,
  type ProcessExecutor,
  type VideoProbeAssertion,
  type VideoVerificationResult,
} from "./types.ts";
import { isRecord, makeArtifactRef, projectRelativePath } from "./utils.ts";

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function frameRate(value: unknown): number | undefined {
  if (typeof value !== "string") return numeric(value);
  const [numerator, denominator = "1"] = value.split("/");
  const top = Number(numerator);
  const bottom = Number(denominator);
  return Number.isFinite(top) && Number.isFinite(bottom) && bottom !== 0 ? top / bottom : undefined;
}

function assertion(
  id: VideoProbeAssertion["id"],
  passed: boolean,
  expected: string,
  actual: unknown,
): VideoProbeAssertion {
  return { id, passed, expected, actual: actual === undefined ? "missing" : String(actual) };
}

export function assessFfprobePayload(
  payload: unknown,
  expectedDuration?: number,
  durationTolerance = 0.25,
): Pick<VideoVerificationResult, "ok" | "duration" | "fps" | "assertions"> {
  const root = isRecord(payload) ? payload : {};
  const streams = Array.isArray(root.streams) ? root.streams.filter(isRecord) : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const format = isRecord(root.format) ? root.format : {};
  const fps = video ? frameRate(video.avg_frame_rate ?? video.r_frame_rate) : undefined;
  const duration = numeric(format.duration) ?? numeric(video?.duration) ?? numeric(audio?.duration);
  const assertions: VideoProbeAssertion[] = [
    assertion("video-stream", Boolean(video), "present", video ? "present" : undefined),
    assertion("video-codec", video?.codec_name === "h264", "h264", video?.codec_name),
    assertion(
      "resolution",
      video?.width === FINANCE_REEL_WIDTH && video?.height === FINANCE_REEL_HEIGHT,
      `${FINANCE_REEL_WIDTH}x${FINANCE_REEL_HEIGHT}`,
      video ? `${video.width}x${video.height}` : undefined,
    ),
    assertion("frame-rate", fps !== undefined && Math.abs(fps - FINANCE_REEL_FPS) <= 0.01, "30", fps),
    assertion("audio-stream", Boolean(audio), "present", audio ? "present" : undefined),
    assertion("audio-codec", audio?.codec_name === "aac", "aac", audio?.codec_name),
    assertion(
      "duration-range",
      duration !== undefined && duration >= FINANCE_REEL_MIN_DURATION && duration <= FINANCE_REEL_MAX_DURATION,
      `${FINANCE_REEL_MIN_DURATION}-${FINANCE_REEL_MAX_DURATION}s`,
      duration,
    ),
  ];
  if (expectedDuration !== undefined) {
    assertions.push(
      assertion(
        "duration-match",
        duration !== undefined && Math.abs(duration - expectedDuration) <= durationTolerance,
        `${expectedDuration}s +/- ${durationTolerance}s`,
        duration,
      ),
    );
  }
  return { ok: assertions.every((item) => item.passed), duration, fps, assertions };
}

export async function verifyRenderedVideo(input: {
  videoPath: string;
  projectDir: string;
  expectedDuration: number;
  ffprobeCommand?: string;
  executor?: ProcessExecutor;
  createdAt?: string;
}): Promise<VideoVerificationResult> {
  const videoPath = isAbsolute(input.videoPath) ? input.videoPath : resolve(input.projectDir, input.videoPath);
  const executor = input.executor ?? executeProcess;
  const execution = await executor({
    command: input.ffprobeCommand ?? "ffprobe",
    args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", videoPath],
    cwd: input.projectDir,
    timeoutMs: 120_000,
  });
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (execution.exitCode !== 0 || execution.error) {
    const error = execution.error ?? (execution.stderr.trim() || `ffprobe exited with ${execution.exitCode}.`);
    return {
      ok: false,
      available: execution.exitCode !== null,
      assertions: [],
      execution,
      error,
      check: {
        id: "video-output",
        label: "MP4 1080x1920",
        stage: "complete",
        status: "failed",
        detail: error,
        measuredAt: createdAt,
      },
    };
  }

  let probe: unknown;
  try {
    probe = JSON.parse(execution.stdout);
  } catch {
    const error = "ffprobe returned invalid JSON.";
    return {
      ok: false,
      available: true,
      assertions: [],
      execution,
      error,
      check: {
        id: "video-output",
        label: "MP4 1080x1920",
        stage: "complete",
        status: "failed",
        detail: error,
        measuredAt: createdAt,
      },
    };
  }

  const assessed = assessFfprobePayload(probe, input.expectedDuration);
  const detail = assessed.assertions
    .map((item) => `${item.id}=${item.passed ? "pass" : `fail(${item.actual})`}`)
    .join(", ");
  let artifact;
  try {
    await stat(videoPath);
    artifact = makeArtifactRef({
      kind: "video",
      label: "Verified finance reel",
      stage: "complete",
      relativePath: projectRelativePath(input.projectDir, videoPath),
      mimeType: "video/mp4",
      createdAt,
    });
  } catch {
    // ffprobe can be injected in tests; a missing file remains visible through the absent artifact.
  }

  return {
    ...assessed,
    available: true,
    execution,
    probe,
    ...(artifact ? { artifact } : {}),
    check: {
      id: "video-output",
      label: "MP4 1080x1920",
      stage: "complete",
      status: assessed.ok ? "passed" : "failed",
      detail,
      measuredAt: createdAt,
    },
  };
}
