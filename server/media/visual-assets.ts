import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactRef, PipelineCheck } from "../../shared/contracts.ts";
import { normalizeFinanceScript } from "./script.ts";
import type { FinanceAsset, FinanceAssetManifest, FinanceMover, FinanceScript } from "./types.ts";
import {
  escapeXml,
  formatChangePct,
  formatNumber,
  makeArtifactRef,
  projectRelativePath,
  sha256,
  slugify,
  stableJson,
} from "./utils.ts";

const CHART_WIDTH = 920;
const CHART_HEIGHT = 360;
const CARD_WIDTH = 920;
const CARD_HEIGHT = 860;

function wrapWords(value: string, maxCharacters: number, maxLines: number): string[] {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines - 1) break;
  }
  if (line && lines.length < maxLines) lines.push(line);

  const consumed = lines.join(" ").split(/\s+/).length;
  if (consumed < words.length && lines.length > 0) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = `${lines[lastIndex].replace(/[.,;:!?]+$/u, "")}...`;
  }
  return lines;
}

function textLines(lines: string[], input: { x: number; y: number; lineHeight: number; className: string }): string {
  return `<text x="${input.x}" y="${input.y}" class="${input.className}">${lines
    .map((line, index) => `<tspan x="${input.x}" dy="${index === 0 ? 0 : input.lineHeight}">${escapeXml(line)}</tspan>`)
    .join("")}</text>`;
}

function chartGeometry(changePct: number, domainMax: number): { x: number; width: number } {
  const zeroX = 460;
  const halfTrack = 350;
  const width = Math.max(3, (Math.abs(changePct) / domainMax) * halfTrack);
  return changePct > 0 ? { x: zeroX, width } : { x: zeroX - width, width };
}

export function renderChangeChartSvg(moverInput: FinanceMover, domainMax: number): string {
  const mover = normalizeFinanceScript({
    title: "Chart validation",
    language: "es",
    narration: "Validacion determinista del dato observado para construir un grafico de cambio sin inventar una serie temporal ni puntos intermedios adicionales.",
    movers: [moverInput, { ...moverInput, ticker: `${moverInput.ticker.slice(0, 8)}X` }],
    closing: "Dato validado.",
  }).movers[0];
  if (!Number.isFinite(domainMax) || domainMax <= 0 || domainMax < Math.abs(mover.changePct)) {
    throw new Error("domainMax must cover the mover's absolute change.");
  }

  const accent = mover.direction === "up" ? "#00A878" : "#F04464";
  const geometry = chartGeometry(mover.changePct, domainMax);
  const sourceIds = escapeXml(mover.sourceIds.join(","));
  const companySize = Math.max(25, Math.min(34, 34 - Math.max(0, mover.company.length - 36) * 0.35));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-labelledby="title desc" data-chart-kind="single-observation-delta" data-observation-count="1" data-source-ids="${sourceIds}">
  <title id="title">${escapeXml(mover.ticker)} ${escapeXml(formatChangePct(mover.changePct))}</title>
  <desc id="desc">Cambio porcentual observado de la sesion, representado desde cero sin serie temporal sintetica.</desc>
  <rect width="920" height="360" rx="28" fill="#EEF0EC"/>
  <rect x="26" y="24" width="8" height="312" rx="4" fill="${accent}"/>
  <text x="64" y="72" fill="#111814" font-family="Trebuchet MS, sans-serif" font-size="28" font-weight="700" letter-spacing="0">${escapeXml(mover.ticker)}</text>
  <text x="64" y="116" fill="#4B554F" font-family="Trebuchet MS, sans-serif" font-size="${companySize.toFixed(1)}" letter-spacing="0">${escapeXml(mover.company)}</text>
  <text x="856" y="92" fill="${accent}" font-family="Georgia, serif" font-size="58" font-weight="700" text-anchor="end" letter-spacing="0">${escapeXml(formatChangePct(mover.changePct))}</text>
  <text x="64" y="168" fill="#69736D" font-family="Trebuchet MS, sans-serif" font-size="18" font-weight="700" letter-spacing="0">CIERRE VS. REFERENCIA</text>
  <rect x="110" y="218" width="700" height="30" rx="15" fill="#D4D9D5"/>
  <rect x="${geometry.x.toFixed(2)}" y="218" width="${geometry.width.toFixed(2)}" height="30" rx="15" fill="${accent}"/>
  <rect x="457" y="202" width="6" height="62" rx="3" fill="#111814"/>
  <circle cx="${(mover.changePct > 0 ? geometry.x + geometry.width : geometry.x).toFixed(2)}" cy="233" r="11" fill="${accent}" stroke="#EEF0EC" stroke-width="5"/>
  <text x="110" y="298" fill="#69736D" font-family="Trebuchet MS, sans-serif" font-size="17" text-anchor="middle" letter-spacing="0">-${escapeXml(formatNumber(domainMax))}%</text>
  <text x="460" y="298" fill="#111814" font-family="Trebuchet MS, sans-serif" font-size="17" font-weight="700" text-anchor="middle" letter-spacing="0">0%</text>
  <text x="810" y="298" fill="#69736D" font-family="Trebuchet MS, sans-serif" font-size="17" text-anchor="middle" letter-spacing="0">+${escapeXml(formatNumber(domainMax))}%</text>
</svg>
`;
}

export function renderMoverCardSvg(moverInput: FinanceMover, rank: number): string {
  const mover = { ...moverInput };
  if (!Number.isInteger(rank) || rank < 1) throw new Error("rank must be a positive integer.");
  const accent = mover.direction === "up" ? "#00A878" : "#F04464";
  const directionLabel = mover.direction === "up" ? "SUBE" : "BAJA";
  const companyLines = wrapWords(mover.company, 27, 2);
  const catalystLines = wrapWords(mover.catalyst, 39, 5);
  const sourceIds = escapeXml(mover.sourceIds.join(","));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-labelledby="title desc" data-card-kind="normalized-mover" data-source-ids="${sourceIds}">
  <title id="title">${escapeXml(mover.ticker)} ${escapeXml(formatChangePct(mover.changePct))}</title>
  <desc id="desc">Tarjeta de mercado con el cambio observado y su catalizador documentado.</desc>
  <rect width="920" height="860" rx="32" fill="#111814"/>
  <rect x="0" y="0" width="920" height="18" rx="9" fill="${accent}"/>
  <circle cx="810" cy="108" r="58" fill="none" stroke="${accent}" stroke-width="3" opacity="0.55"/>
  <text x="810" y="121" fill="${accent}" font-family="Trebuchet MS, sans-serif" font-size="30" font-weight="700" text-anchor="middle" letter-spacing="0">#${String(rank).padStart(2, "0")}</text>
  <text x="64" y="118" fill="#AAB4AE" font-family="Trebuchet MS, sans-serif" font-size="22" font-weight="700" letter-spacing="0">MOVER DEL DIA</text>
  <text x="64" y="242" fill="#F6F7F3" font-family="Georgia, serif" font-size="102" font-weight="700" letter-spacing="0">${escapeXml(mover.ticker)}</text>
  ${textLines(companyLines, { x: 64, y: 308, lineHeight: 43, className: "company" })}
  <style>.company{fill:#AAB4AE;font-family:Trebuchet MS,sans-serif;font-size:34px;letter-spacing:0}.catalyst{fill:#F6F7F3;font-family:Trebuchet MS,sans-serif;font-size:29px;letter-spacing:0}</style>
  <rect x="64" y="410" width="792" height="154" rx="20" fill="#1D2722" stroke="#34433B" stroke-width="2"/>
  <text x="98" y="466" fill="${accent}" font-family="Trebuchet MS, sans-serif" font-size="24" font-weight="700" letter-spacing="0">${directionLabel}</text>
  <text x="98" y="536" fill="${accent}" font-family="Georgia, serif" font-size="72" font-weight="700" letter-spacing="0">${escapeXml(formatChangePct(mover.changePct))}</text>
  <text x="64" y="632" fill="#7E8B84" font-family="Trebuchet MS, sans-serif" font-size="20" font-weight="700" letter-spacing="0">CATALIZADOR</text>
  ${textLines(catalystLines, { x: 64, y: 680, lineHeight: 37, className: "catalyst" })}
</svg>
`;
}

function createAsset(input: {
  id: string;
  kind: FinanceAsset["kind"];
  relativePath: string;
  width: number;
  height: number;
  svg: string;
  mover: FinanceMover;
}): FinanceAsset {
  return {
    id: input.id,
    kind: input.kind,
    relativePath: input.relativePath,
    mimeType: "image/svg+xml",
    width: input.width,
    height: input.height,
    byteLength: new TextEncoder().encode(input.svg).byteLength,
    sha256: sha256(input.svg),
    moverTicker: input.mover.ticker,
    sourceIds: [...input.mover.sourceIds],
    observation: {
      metric: "session-change-pct",
      value: input.mover.changePct,
      direction: input.mover.direction,
      observationCount: 1,
    },
  };
}

export interface WriteFinanceAssetsResult {
  script: FinanceScript;
  manifest: FinanceAssetManifest;
  check: PipelineCheck;
  artifacts: ArtifactRef[];
  manifestPath: string;
}

export async function writeFinanceVisualAssets(input: {
  projectDir: string;
  script: unknown;
  createdAt?: string;
}): Promise<WriteFinanceAssetsResult> {
  const script = normalizeFinanceScript(input.script);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const assetsDir = join(input.projectDir, "assets");
  await mkdir(assetsDir, { recursive: true });

  const rawDomainMax = Math.max(...script.movers.map((mover) => Math.abs(mover.changePct)), 1);
  const domainMax = Math.ceil(rawDomainMax * 10) / 10;
  const assets: FinanceAsset[] = [];
  const artifacts: ArtifactRef[] = [];

  for (const [index, mover] of script.movers.entries()) {
    const stem = `${String(index + 1).padStart(2, "0")}-${slugify(mover.ticker)}`;
    const chartRelativePath = `assets/${stem}-change.svg`;
    const cardRelativePath = `assets/${stem}-card.svg`;
    const chartSvg = renderChangeChartSvg(mover, domainMax);
    const cardSvg = renderMoverCardSvg(mover, index + 1);
    const chartPath = join(input.projectDir, ...chartRelativePath.split("/"));
    const cardPath = join(input.projectDir, ...cardRelativePath.split("/"));
    await writeFile(chartPath, chartSvg, "utf8");
    await writeFile(cardPath, cardSvg, "utf8");

    const chartAsset = createAsset({
      id: `mover-${slugify(mover.ticker)}-change`,
      kind: "change-chart",
      relativePath: chartRelativePath,
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      svg: chartSvg,
      mover,
    });
    const cardAsset = createAsset({
      id: `mover-${slugify(mover.ticker)}-card`,
      kind: "mover-card",
      relativePath: cardRelativePath,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      svg: cardSvg,
      mover,
    });
    assets.push(chartAsset, cardAsset);

    for (const asset of [chartAsset, cardAsset]) {
      artifacts.push(
        makeArtifactRef({
          kind: "chart",
          label: `${mover.ticker} ${asset.kind === "change-chart" ? "change chart" : "mover card"}`,
          stage: "assets",
          relativePath: asset.relativePath,
          mimeType: asset.mimeType,
          source: mover.sourceIds.join(","),
          createdAt,
          contentHash: asset.sha256,
        }),
      );
    }
  }

  const manifest: FinanceAssetManifest = {
    version: 1,
    styleId: "finance-reel-v0",
    chartDomain: {
      minPct: -domainMax,
      maxPct: domainMax,
      observationCountPerMover: 1,
    },
    assets,
  };
  const manifestContent = stableJson(manifest);
  const manifestPath = join(input.projectDir, "asset-manifest.json");
  await writeFile(manifestPath, manifestContent, "utf8");
  artifacts.push(
    makeArtifactRef({
      kind: "report",
      label: "Asset manifest",
      stage: "assets",
      relativePath: projectRelativePath(input.projectDir, manifestPath),
      mimeType: "application/json",
      createdAt,
      contentHash: sha256(manifestContent),
    }),
  );

  return {
    script,
    manifest,
    check: {
      id: "assets-valid",
      label: "Assets validos",
      stage: "assets",
      status: "passed",
      detail: `${assets.length} SVG assets from ${script.movers.length} normalized single-observation movers.`,
      measuredAt: createdAt,
    },
    artifacts,
    manifestPath,
  };
}
