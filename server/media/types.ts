import type { ArtifactRef, PipelineCheck } from "../../shared/contracts.ts";

export const FINANCE_REEL_STYLE_ID = "finance-reel-v0" as const;
export const FINANCE_REEL_WIDTH = 1080 as const;
export const FINANCE_REEL_HEIGHT = 1920 as const;
export const FINANCE_REEL_FPS = 30 as const;
export const FINANCE_REEL_MIN_DURATION = 15 as const;
export const FINANCE_REEL_MAX_DURATION = 45 as const;

export type MoverDirection = "up" | "down";

export interface FinanceMover {
  ticker: string;
  company: string;
  direction: MoverDirection;
  changePct: number;
  catalyst: string;
  sourceIds: string[];
}

export interface FinanceScript {
  title: string;
  language: "es";
  narration: string;
  movers: FinanceMover[];
  closing: string;
}

export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export interface NormalizedAlignment {
  words: WordTiming[];
  duration: number;
}

export interface CaptionCue {
  id: string;
  text: string;
  start: number;
  end: number;
}

export type FinanceAssetKind = "change-chart" | "mover-card";

export interface FinanceAsset {
  id: string;
  kind: FinanceAssetKind;
  relativePath: string;
  mimeType: "image/svg+xml";
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  moverTicker: string;
  sourceIds: string[];
  observation: {
    metric: "session-change-pct";
    value: number;
    direction: MoverDirection;
    observationCount: 1;
  };
}

export interface FinanceAssetManifest {
  version: 1;
  styleId: typeof FINANCE_REEL_STYLE_ID;
  chartDomain: {
    minPct: number;
    maxPct: number;
    observationCountPerMover: 1;
  };
  assets: FinanceAsset[];
}

export type EditSceneKind = "hook" | "mover" | "closing";

export interface EditScene {
  id: string;
  kind: EditSceneKind;
  start: number;
  end: number;
  title: string;
  caption: string;
  ticker?: string;
  changePct?: number;
  catalyst?: string;
  assetIds: string[];
  sourceIds: string[];
}

export interface FinanceEditPlan {
  styleId: typeof FINANCE_REEL_STYLE_ID;
  width: typeof FINANCE_REEL_WIDTH;
  height: typeof FINANCE_REEL_HEIGHT;
  fps: typeof FINANCE_REEL_FPS;
  duration: number;
  audio: string;
  scenes: EditScene[];
}

export interface MediaBuildResult {
  ok: boolean;
  script: FinanceScript;
  alignment: NormalizedAlignment;
  manifest: FinanceAssetManifest;
  edit: FinanceEditPlan;
  checks: PipelineCheck[];
  artifacts: ArtifactRef[];
}

export interface ProcessCommand {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface ProcessExecution {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  timedOut?: boolean;
}

export type ProcessExecutor = (command: ProcessCommand) => Promise<ProcessExecution>;

export interface CommandCheckResult {
  id: "lint" | "inspect" | "snapshot" | "render";
  status: "passed" | "failed" | "skipped";
  execution?: ProcessExecution;
  data?: unknown;
  detail: string;
}

export interface HyperframesCommandEvent {
  id: CommandCheckResult["id"];
  phase: "started" | "heartbeat" | "completed";
  elapsedMs: number;
  status?: CommandCheckResult["status"];
}

export interface HyperframesRunResult {
  ok: boolean;
  commands: CommandCheckResult[];
  checks: PipelineCheck[];
  artifacts: ArtifactRef[];
  outputPath?: string;
}

export interface VideoProbeAssertion {
  id:
    | "video-stream"
    | "video-codec"
    | "resolution"
    | "frame-rate"
    | "audio-stream"
    | "audio-codec"
    | "duration-range"
    | "duration-match";
  passed: boolean;
  expected: string;
  actual: string;
}

export interface VideoVerificationResult {
  ok: boolean;
  available: boolean;
  duration?: number;
  fps?: number;
  assertions: VideoProbeAssertion[];
  execution?: ProcessExecution;
  check: PipelineCheck;
  artifact?: ArtifactRef;
  probe?: unknown;
  error?: string;
}

export type { ArtifactRef, PipelineCheck };
