export const PIPELINE_STAGES = [
  "intake",
  "research",
  "script",
  "voice",
  "assets",
  "edit",
  "render",
  "complete",
] as const;

export const PIPELINE_STATUSES = [
  "queued",
  "running",
  "testing",
  "completed",
  "failed",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export type ArtifactKind =
  | "brief"
  | "research"
  | "sources"
  | "script"
  | "voice"
  | "alignment"
  | "chart"
  | "reference"
  | "edit"
  | "composition"
  | "snapshot"
  | "report"
  | "video";

export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  label: string;
  stage: PipelineStage;
  relativePath: string;
  mimeType?: string;
  source?: string;
  createdAt: string;
}

export interface PipelineCheck {
  id: string;
  label: string;
  stage: PipelineStage;
  status: "pending" | "passed" | "failed";
  detail?: string;
  measuredAt?: string;
}

export interface RunEvent {
  id: number;
  runId: string;
  stage: PipelineStage;
  status: PipelineStatus;
  message: string;
  progress: number;
  timestamp: string;
  artifact?: ArtifactRef;
  check?: PipelineCheck;
}

export interface RunReference {
  id: string;
  kind: "url" | "upload";
  value: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

export interface RunRecord {
  id: string;
  prompt: string;
  references: RunReference[];
  format: {
    width: 1080;
    height: 1920;
    fps: 30;
  };
  styleId: "finance-reel-v0";
  duration: {
    target: 30;
    min: 15;
    max: 45;
    actual?: number;
  };
  status: PipelineStatus;
  currentStage: PipelineStage;
  progress: number;
  createdAt: string;
  updatedAt: string;
  failedStage?: PipelineStage;
  error?: string;
  artifacts: ArtifactRef[];
  checks: PipelineCheck[];
}

export interface CreateRunResponse {
  run: RunRecord;
}

export interface LatestRunResponse {
  run: RunRecord | null;
  events: RunEvent[];
}

export interface HealthResponse {
  status: "ok";
}

export interface ApiError {
  error: string;
  code:
    | "INVALID_PROMPT"
    | "INVALID_REFERENCE"
    | "INVALID_UPLOAD"
    | "RUN_ACTIVE"
    | "RUN_NOT_FOUND"
    | "RUN_NOT_FAILED"
    | "PIPELINE_FAILED"
    | "INTERNAL_ERROR";
  stage?: PipelineStage;
}

export const STAGE_LABELS: Record<PipelineStage, string> = {
  intake: "Preparando run",
  research: "Research Cala",
  script: "Guion",
  voice: "Voz ElevenLabs",
  assets: "Graficos y assets",
  edit: "Plan de edicion",
  render: "Render HyperFrames",
  complete: "Reel listo",
};

export const DEFAULT_CHECKS: PipelineCheck[] = [
  { id: "research-sources", label: "Datos con fuentes", stage: "research", status: "pending" },
  { id: "script-grounding", label: "Guion grounded", stage: "script", status: "pending" },
  { id: "voice-alignment", label: "Audio y captions", stage: "voice", status: "pending" },
  { id: "assets-valid", label: "Assets validos", stage: "assets", status: "pending" },
  { id: "edit-timeline", label: "Timeline continua", stage: "edit", status: "pending" },
  { id: "render-layout", label: "Layout y motion", stage: "render", status: "pending" },
  { id: "video-output", label: "MP4 1080x1920", stage: "complete", status: "pending" },
];

export const ALLOWED_UPLOAD_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PROMPT_LENGTH = 2_000;

export function validatePrompt(value: unknown): string {
  if (typeof value !== "string") throw new Error("El prompt es obligatorio.");
  const prompt = value.trim();
  if (!prompt) throw new Error("El prompt es obligatorio.");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`El prompt supera ${MAX_PROMPT_LENGTH} caracteres.`);
  return prompt;
}

export function validateReferenceUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("La referencia debe ser una URL.");
  const url = new URL(value.trim());
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Solo se permiten URLs HTTP o HTTPS.");
  return url.toString();
}

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && PIPELINE_STAGES.includes(value as PipelineStage);
}

export function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, Math.round(progress)));
}
