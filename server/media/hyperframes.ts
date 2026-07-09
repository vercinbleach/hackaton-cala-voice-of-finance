import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { FINANCE_REEL_CSS } from "../../video/finance-reel-v0/style.ts";
import { buildCaptionCues, normalizeVoiceAlignment } from "./alignment.ts";
import { validateFinanceEditPlan } from "./edit-plan.ts";
import { normalizeFinanceScript } from "./script.ts";
import type {
  CaptionCue,
  EditScene,
  FinanceAsset,
  FinanceAssetManifest,
  FinanceEditPlan,
  FinanceMover,
} from "./types.ts";
import { escapeHtml, formatChangePct, safeJsonForScript } from "./utils.ts";

function timedAttributes(start: number, end: number, trackIndex: number): string {
  return `class="clip" data-start="${start}" data-duration="${(end - start).toFixed(3)}" data-track-index="${trackIndex}"`;
}

function resolveWebPath(basePath: string, mediaPath: string): string {
  if (/^(?:[a-z]+:|\/)/i.test(mediaPath)) return mediaPath;
  const base = basePath.replace(/\/+$/g, "");
  const value = mediaPath.replace(/^\.\//, "").replaceAll("\\", "/");
  return `${base}/${value}`.replace(/\/{2,}/g, "/");
}

function moverClass(mover: Pick<FinanceMover, "direction">): string {
  return mover.direction === "up" ? "is-up" : "is-down";
}

function renderMoverRows(movers: FinanceMover[], prefix: "hook" | "closing"): string {
  return movers
    .map(
      (mover) => `<div class="${prefix}-mover">
        <span class="${prefix}-ticker">${escapeHtml(mover.ticker)}</span>
        <span class="${prefix}-company">${escapeHtml(mover.company)}</span>
        <span class="${prefix}-change ${moverClass(mover)}">${escapeHtml(formatChangePct(mover.changePct))}</span>
      </div>`,
    )
    .join("\n");
}

function renderHookScene(scene: EditScene, movers: FinanceMover[]): string {
  return `<section id="${escapeHtml(scene.id)}" class="scene clip" data-start="${scene.start}" data-duration="${(
    scene.end - scene.start
  ).toFixed(3)}" data-track-index="10">
    <div class="scene-kicker motion-kicker">Apertura de mercado</div>
    <h1 class="hook-title motion-title">${escapeHtml(scene.title)}</h1>
    <div class="hook-rule motion-rule"></div>
    <div class="hook-board motion-board">${renderMoverRows(movers, "hook")}</div>
  </section>`;
}

function assetForScene(
  scene: EditScene,
  manifest: FinanceAssetManifest,
  kind: FinanceAsset["kind"],
): FinanceAsset {
  const asset = manifest.assets.find((candidate) => candidate.kind === kind && scene.assetIds.includes(candidate.id));
  if (!asset) throw new Error(`Scene ${scene.id} is missing its ${kind} asset.`);
  return asset;
}

function renderMoverScene(
  scene: EditScene,
  manifest: FinanceAssetManifest,
  assetBasePath: string,
): string {
  const card = assetForScene(scene, manifest, "mover-card");
  const chart = assetForScene(scene, manifest, "change-chart");
  const directionClass = (scene.changePct ?? 0) > 0 ? "is-up" : "is-down";
  return `<section id="${escapeHtml(scene.id)}" class="scene clip" data-start="${scene.start}" data-duration="${(
    scene.end - scene.start
  ).toFixed(3)}" data-track-index="10">
    <div class="scene-kicker motion-kicker">Movimiento confirmado</div>
    <div class="mover-heading motion-title">
      <div>
        <h2 class="mover-ticker">${escapeHtml(scene.ticker!)}</h2>
        <p class="mover-company">${escapeHtml(scene.title.replace(`${scene.ticker} - `, ""))}</p>
      </div>
      <div class="mover-change ${directionClass}">${escapeHtml(formatChangePct(scene.changePct!))}</div>
    </div>
    <img class="asset-card motion-card" src="${escapeHtml(resolveWebPath(assetBasePath, card.relativePath))}" alt="Tarjeta de ${escapeHtml(
      scene.ticker!,
    )}" width="${card.width}" height="${card.height}" />
    <img class="asset-chart motion-chart" src="${escapeHtml(resolveWebPath(assetBasePath, chart.relativePath))}" alt="Cambio de ${escapeHtml(
      scene.ticker!,
    )}" width="${chart.width}" height="${chart.height}" />
  </section>`;
}

function renderClosingScene(scene: EditScene, closing: string, movers: FinanceMover[]): string {
  return `<section id="${escapeHtml(scene.id)}" class="scene clip" data-start="${scene.start}" data-duration="${(
    scene.end - scene.start
  ).toFixed(3)}" data-track-index="10">
    <div class="scene-kicker motion-kicker">Proxima sesion</div>
    <h2 class="closing-title motion-title">${escapeHtml(scene.title)}</h2>
    <p class="closing-copy motion-copy">${escapeHtml(closing)}</p>
    <div class="closing-board motion-board">${renderMoverRows(movers, "closing")}</div>
  </section>`;
}

function renderCaptionLayers(cues: CaptionCue[]): string {
  return cues
    .map(
      (cue) => `<div id="${cue.id}" class="caption-layer clip" data-start="${cue.start}" data-duration="${(
        cue.end - cue.start
      ).toFixed(3)}" data-track-index="40">${escapeHtml(cue.text)}</div>`,
    )
    .join("\n");
}

function renderTickerGroup(movers: FinanceMover[]): string {
  return `<div class="ticker-group">${movers
    .map(
      (mover) => `<span class="ticker-item" data-layout-allow-overflow data-layout-allow-overlap data-layout-allow-occlusion>${escapeHtml(mover.ticker)} <strong class="${moverClass(mover)}" data-layout-allow-overflow data-layout-allow-overlap data-layout-allow-occlusion>${escapeHtml(
        formatChangePct(mover.changePct),
      )}</strong></span>`,
    )
    .join("")}</div>`;
}

function motionScript(edit: FinanceEditPlan, cues: CaptionCue[]): string {
  const sceneTimings = edit.scenes.map((scene) => ({ id: scene.id, start: scene.start, end: scene.end }));
  const captionTimings = cues.map((cue) => ({ id: cue.id, start: cue.start, end: cue.end }));
  return `
    const sceneTimings = ${safeJsonForScript(sceneTimings)};
    const captionTimings = ${safeJsonForScript(captionTimings)};
    const timeline = gsap.timeline({ paused: true });
    const animate = (selector, from, to, at) => {
      if (document.querySelector(selector)) timeline.fromTo(selector, from, to, at);
    };

    for (const scene of sceneTimings) {
      const selector = "#" + scene.id;
      const outroAt = Math.max(scene.start, scene.end - 0.22);
      timeline.set(selector, { opacity: 1 }, scene.start);
      animate(selector + " .motion-kicker", { opacity: 0, x: -42 }, { opacity: 1, x: 0, duration: 0.34, ease: "power2.out" }, scene.start + 0.04);
      animate(selector + " .motion-title", { opacity: 0, y: 54 }, { opacity: 1, y: 0, duration: 0.48, ease: "power3.out" }, scene.start + 0.12);
      animate(selector + " .motion-rule", { opacity: 0, scaleX: 0 }, { opacity: 1, scaleX: 1, duration: 0.42, ease: "power2.out" }, scene.start + 0.28);
      animate(selector + " .motion-board", { opacity: 0, y: 44 }, { opacity: 1, y: 0, duration: 0.52, ease: "power3.out" }, scene.start + 0.35);
      animate(selector + " .motion-copy", { opacity: 0, y: 34 }, { opacity: 1, y: 0, duration: 0.42, ease: "power2.out" }, scene.start + 0.3);
      animate(selector + " .motion-card", { opacity: 0, y: 70, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.56, ease: "power3.out" }, scene.start + 0.26);
      animate(selector + " .motion-chart", { opacity: 0, x: 70 }, { opacity: 1, x: 0, duration: 0.52, ease: "power3.out" }, scene.start + 0.48);
      timeline.to(selector, { opacity: 0, duration: 0.2, ease: "power1.in" }, outroAt);
    }

    for (const cue of captionTimings) {
      const selector = "#" + cue.id;
      const outroAt = Math.max(cue.start, cue.end - 0.1);
      timeline.fromTo(selector, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.1, ease: "power1.out" }, cue.start);
      timeline.to(selector, { opacity: 0, y: -12, duration: 0.1, ease: "power1.in" }, outroAt);
    }

    timeline.fromTo(".ticker-track", { x: 0 }, { x: -1080, duration: ${edit.duration}, ease: "none" }, 0);
    window.__timelines = window.__timelines || {};
    window.__timelines.root = timeline;
  `;
}

export function generateHyperframesHtml(input: {
  script: unknown;
  alignment: unknown;
  edit: FinanceEditPlan;
  manifest: FinanceAssetManifest;
  assetBasePath?: string;
  audioBasePath?: string;
}): string {
  const script = normalizeFinanceScript(input.script);
  const alignment = normalizeVoiceAlignment(input.alignment);
  validateFinanceEditPlan(input.edit, input.manifest);
  if (Math.abs(alignment.duration - input.edit.duration) > 0.001) {
    throw new Error("Alignment and edit durations must match.");
  }
  const assetBasePath = input.assetBasePath ?? ".";
  const audioBasePath = input.audioBasePath ?? ".";
  const cues = buildCaptionCues(alignment);
  const scenes = input.edit.scenes
    .map((scene) => {
      if (scene.kind === "hook") return renderHookScene(scene, script.movers);
      if (scene.kind === "closing") return renderClosingScene(scene, script.closing, script.movers);
      return renderMoverScene(scene, input.manifest, assetBasePath);
    })
    .join("\n");
  const tickerGroup = renderTickerGroup(script.movers);
  const audioSource = resolveWebPath(audioBasePath, input.edit.audio);

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(script.title)}</title>
  <style>${FINANCE_REEL_CSS}</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-start="0" data-width="1080" data-height="1920" data-duration="${input.edit.duration}" data-fps="30">
    <div class="frame-rail"></div>
    <header class="masthead">
      <div class="brand"><span class="live-mark"></span> MARKET PULSE</div>
      <div class="edition">FINANCE / DAILY</div>
    </header>
    ${scenes}
    ${renderCaptionLayers(cues)}
    <div id="market-ticker" class="ticker-shell clip" data-start="0" data-duration="${input.edit.duration.toFixed(3)}" data-track-index="50">
      <div class="ticker-label" data-layout-allow-overlap data-layout-allow-occlusion>MERCADO</div>
      <div class="ticker-window" data-layout-allow-overflow><div class="ticker-track" data-layout-allow-overflow data-layout-allow-overlap data-layout-allow-occlusion>${tickerGroup}${tickerGroup}</div></div>
    </div>
    <div class="frame-count">1080 x 1920 / 30 FPS</div>
    <audio id="voiceover" ${timedAttributes(0, input.edit.duration, 1)} src="${escapeHtml(audioSource)}" data-volume="1" preload="auto"></audio>
  </div>
  <script>window.__financeReel = ${safeJsonForScript({ edit: input.edit, captionCues: cues })};</script>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js"></script>
  <script>${motionScript(input.edit, cues)}</script>
</body>
</html>
`;
}

export async function writeHyperframesIndex(input: {
  projectDir: string;
  script: unknown;
  alignment: unknown;
  edit: FinanceEditPlan;
  manifest: FinanceAssetManifest;
}): Promise<{ html: string; indexPath: string }> {
  const indexPath = join(input.projectDir, "hyperframes", "index.html");
  const html = generateHyperframesHtml(input);
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, html, "utf8");
  return { html, indexPath };
}
