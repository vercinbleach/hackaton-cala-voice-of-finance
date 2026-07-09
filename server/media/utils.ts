import { createHash } from "node:crypto";
import { relative, sep } from "node:path";

import type { ArtifactKind, ArtifactRef, PipelineStage } from "../../shared/contracts.ts";

export function roundTime(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function formatNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
    useGrouping: false,
  }).format(value);
}

export function formatChangePct(value: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}%`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

export function projectRelativePath(projectDir: string, absolutePath: string): string {
  return toPosixPath(relative(projectDir, absolutePath));
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeXml(value: string): string {
  return escapeHtml(value);
}

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "asset";
}

export function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function makeArtifactRef(input: {
  kind: ArtifactKind;
  label: string;
  stage: PipelineStage;
  relativePath: string;
  mimeType?: string;
  source?: string;
  createdAt: string;
  contentHash?: string;
}): ArtifactRef {
  const identity = input.contentHash ?? sha256(`${input.kind}:${input.relativePath}`);
  return {
    id: `${input.kind}-${identity.slice(0, 16)}`,
    kind: input.kind,
    label: input.label,
    stage: input.stage,
    relativePath: toPosixPath(input.relativePath),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.source ? { source: input.source } : {}),
    createdAt: input.createdAt,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown, label: string, minLength = 1, maxLength = Number.POSITIVE_INFINITY): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new Error(`${label} must contain between ${minLength} and ${maxLength} characters.`);
  }
  return normalized;
}
