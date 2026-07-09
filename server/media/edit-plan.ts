import { normalizeVoiceAlignment, transcriptForRange } from "./alignment.ts";
import { normalizeFinanceScript } from "./script.ts";
import {
  FINANCE_REEL_FPS,
  FINANCE_REEL_HEIGHT,
  FINANCE_REEL_MAX_DURATION,
  FINANCE_REEL_MIN_DURATION,
  FINANCE_REEL_STYLE_ID,
  FINANCE_REEL_WIDTH,
  type EditScene,
  type FinanceAssetManifest,
  type FinanceEditPlan,
  type FinanceMover,
  type NormalizedAlignment,
  type PipelineCheck,
} from "./types.ts";
import { roundTime } from "./utils.ts";

const TOKEN_PATTERN = /[^a-z0-9]+/g;

function normalizeToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(TOKEN_PATTERN, "");
}

function tokenize(value: string): string[] {
  return value
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

function findSequence(haystack: string[], needle: string[], fromIndex: number): number | undefined {
  if (needle.length === 0) return undefined;
  for (let index = fromIndex; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) return index;
  }
  return undefined;
}

function anchorCandidates(mover: FinanceMover): string[][] {
  const tickerTokens = mover.ticker.split(/[.-]/).map(normalizeToken).filter(Boolean);
  const companyTokens = tokenize(mover.company).filter((token) => token.length > 2);
  const catalystTokens = tokenize(mover.catalyst).filter((token) => token.length > 3);
  return [tickerTokens, companyTokens.slice(0, 2), companyTokens.slice(0, 1), catalystTokens.slice(0, 2)].filter(
    (candidate) => candidate.length > 0,
  );
}

function earliestCandidate(haystack: string[], candidates: string[][], fromIndex: number): number | undefined {
  const matches = candidates
    .map((candidate) => findSequence(haystack, candidate, fromIndex))
    .filter((value): value is number => value !== undefined);
  return matches.length > 0 ? Math.min(...matches) : undefined;
}

function sceneWeights(script: ReturnType<typeof normalizeFinanceScript>): number[] {
  const narrationWordCount = tokenize(script.narration).length;
  return [
    Math.max(7, Math.round(narrationWordCount * 0.15)),
    ...script.movers.map((mover) => Math.max(8, tokenize(mover.company).length + tokenize(mover.catalyst).length + 4)),
    Math.max(7, tokenize(script.closing).length),
  ];
}

function idealSceneStarts(duration: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsedWeight = 0;
  const starts = [0];
  for (let index = 1; index < weights.length; index += 1) {
    elapsedWeight += weights[index - 1];
    starts.push((elapsedWeight / total) * duration);
  }
  return starts;
}

function findAnchors(
  script: ReturnType<typeof normalizeFinanceScript>,
  alignment: NormalizedAlignment,
): Array<number | undefined> {
  const alignedTokens = alignment.words.map((word) => normalizeToken(word.text));
  const anchors: Array<number | undefined> = [];
  let searchFrom = 1;
  for (const mover of script.movers) {
    const match = earliestCandidate(alignedTokens, anchorCandidates(mover), searchFrom);
    anchors.push(match === undefined ? undefined : alignment.words[match].start);
    if (match !== undefined) searchFrom = match + 1;
  }

  const closingTokens = tokenize(script.closing).filter((token) => token.length > 2);
  const closingCandidates = [closingTokens.slice(0, 4), closingTokens.slice(0, 3), closingTokens.slice(0, 2)].filter(
    (candidate) => candidate.length > 0,
  );
  const closingMatch = earliestCandidate(alignedTokens, closingCandidates, searchFrom);
  anchors.push(closingMatch === undefined ? undefined : alignment.words[closingMatch].start);
  return anchors;
}

function nearestAlignedStart(
  alignment: NormalizedAlignment,
  target: number,
  minimum: number,
  maximum: number,
): number | undefined {
  const candidates = alignment.words
    .map((word) => word.start)
    .filter((start) => start >= minimum && start <= maximum)
    .sort((left, right) => Math.abs(left - target) - Math.abs(right - target) || left - right);
  return candidates[0];
}

function buildBoundaries(
  script: ReturnType<typeof normalizeFinanceScript>,
  alignment: NormalizedAlignment,
): number[] {
  const weights = sceneWeights(script);
  const ideals = idealSceneStarts(alignment.duration, weights);
  const anchors = findAnchors(script, alignment);
  const sceneCount = weights.length;
  const minimumSceneDuration = Math.min(1, alignment.duration / (sceneCount * 2));
  const starts = [0];

  for (let sceneIndex = 1; sceneIndex < sceneCount; sceneIndex += 1) {
    const minimum = starts[sceneIndex - 1] + minimumSceneDuration;
    const maximum = alignment.duration - (sceneCount - sceneIndex) * minimumSceneDuration;
    const anchored = anchors[sceneIndex - 1];
    const candidate =
      anchored !== undefined && anchored >= minimum && anchored <= maximum
        ? anchored
        : nearestAlignedStart(alignment, ideals[sceneIndex], minimum, maximum) ??
          Math.max(minimum, Math.min(maximum, ideals[sceneIndex]));
    starts.push(roundTime(candidate));
  }

  return [...starts, alignment.duration];
}

function normalizeAudioPath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error("audio must be a non-empty media path.");
  }
  return value.trim().replaceAll("\\", "/");
}

function moverAssetIds(manifest: FinanceAssetManifest, ticker: string): string[] {
  const assets = manifest.assets.filter((asset) => asset.moverTicker === ticker);
  const kinds = new Set(assets.map((asset) => asset.kind));
  if (!kinds.has("change-chart") || !kinds.has("mover-card")) {
    throw new Error(`Asset manifest is missing the chart or card for ${ticker}.`);
  }
  return assets.map((asset) => asset.id).sort((left, right) => left.localeCompare(right, "en"));
}

function captionForScene(
  alignment: NormalizedAlignment,
  start: number,
  end: number,
  fallback: string,
): string {
  return transcriptForRange(alignment, start, end) || fallback;
}

export function validateFinanceEditPlan(edit: FinanceEditPlan, manifest?: FinanceAssetManifest): void {
  if (edit.styleId !== FINANCE_REEL_STYLE_ID) throw new Error("edit.styleId must be finance-reel-v0.");
  if (edit.width !== FINANCE_REEL_WIDTH || edit.height !== FINANCE_REEL_HEIGHT || edit.fps !== FINANCE_REEL_FPS) {
    throw new Error("edit format must be 1080x1920 at 30fps.");
  }
  if (edit.duration < FINANCE_REEL_MIN_DURATION || edit.duration > FINANCE_REEL_MAX_DURATION) {
    throw new Error("edit.duration must be between 15 and 45 seconds.");
  }
  if (!edit.audio) throw new Error("edit.audio is required.");
  if (edit.scenes.length < 3) throw new Error("edit.scenes must include a hook, movers, and a closing.");
  if (edit.scenes[0].kind !== "hook" || edit.scenes.at(-1)?.kind !== "closing") {
    throw new Error("edit.scenes must start with hook and end with closing.");
  }
  if (edit.scenes.slice(1, -1).some((scene) => scene.kind !== "mover")) {
    throw new Error("All scenes between hook and closing must be mover scenes.");
  }

  const assetIds = manifest ? new Set(manifest.assets.map((asset) => asset.id)) : undefined;
  for (const [index, scene] of edit.scenes.entries()) {
    if (scene.start < 0 || scene.end <= scene.start) throw new Error(`Scene ${scene.id} has an invalid time range.`);
    if (index === 0 && scene.start !== 0) throw new Error("The timeline must begin at zero.");
    if (index > 0 && Math.abs(scene.start - edit.scenes[index - 1].end) > 0.0001) {
      throw new Error(`Timeline gap or overlap before scene ${scene.id}.`);
    }
    if (!scene.id || !scene.title || !scene.caption) throw new Error(`Scene ${index} is missing required text.`);
    if (assetIds && scene.assetIds.some((assetId) => !assetIds.has(assetId))) {
      throw new Error(`Scene ${scene.id} references an unknown asset.`);
    }
    if (scene.kind === "mover" && (!scene.ticker || scene.changePct === undefined || !scene.catalyst)) {
      throw new Error(`Mover scene ${scene.id} is missing ticker, changePct, or catalyst.`);
    }
  }
  if (Math.abs(edit.scenes.at(-1)!.end - edit.duration) > 0.0001) {
    throw new Error("The final scene must end at edit.duration.");
  }
}

export interface BuildEditPlanResult {
  edit: FinanceEditPlan;
  alignment: NormalizedAlignment;
  check: PipelineCheck;
}

export function buildFinanceEditPlan(input: {
  script: unknown;
  alignment: unknown;
  manifest: FinanceAssetManifest;
  audio: string;
  measuredAt?: string;
}): BuildEditPlanResult {
  const script = normalizeFinanceScript(input.script);
  const alignment = normalizeVoiceAlignment(input.alignment);
  if (alignment.duration < FINANCE_REEL_MIN_DURATION || alignment.duration > FINANCE_REEL_MAX_DURATION) {
    throw new Error(
      `Aligned voice duration must be between ${FINANCE_REEL_MIN_DURATION} and ${FINANCE_REEL_MAX_DURATION} seconds.`,
    );
  }
  if (input.manifest.styleId !== FINANCE_REEL_STYLE_ID) {
    throw new Error("Asset manifest style does not match finance-reel-v0.");
  }

  const boundaries = buildBoundaries(script, alignment);
  const scenes: EditScene[] = [];
  scenes.push({
    id: "scene-hook",
    kind: "hook",
    start: boundaries[0],
    end: boundaries[1],
    title: script.title,
    caption: captionForScene(alignment, boundaries[0], boundaries[1], script.title),
    assetIds: [],
    sourceIds: [],
  });

  for (const [index, mover] of script.movers.entries()) {
    const start = boundaries[index + 1];
    const end = boundaries[index + 2];
    scenes.push({
      id: `scene-mover-${String(index + 1).padStart(2, "0")}`,
      kind: "mover",
      start,
      end,
      title: `${mover.ticker} - ${mover.company}`,
      caption: captionForScene(alignment, start, end, `${mover.company}. ${mover.catalyst}`),
      ticker: mover.ticker,
      changePct: mover.changePct,
      catalyst: mover.catalyst,
      assetIds: moverAssetIds(input.manifest, mover.ticker),
      sourceIds: [...mover.sourceIds],
    });
  }

  const closingStart = boundaries.at(-2)!;
  scenes.push({
    id: "scene-closing",
    kind: "closing",
    start: closingStart,
    end: boundaries.at(-1)!,
    title: "Lo que viene",
    caption: captionForScene(alignment, closingStart, alignment.duration, script.closing),
    assetIds: [],
    sourceIds: [],
  });

  const edit: FinanceEditPlan = {
    styleId: FINANCE_REEL_STYLE_ID,
    width: FINANCE_REEL_WIDTH,
    height: FINANCE_REEL_HEIGHT,
    fps: FINANCE_REEL_FPS,
    duration: alignment.duration,
    audio: normalizeAudioPath(input.audio),
    scenes,
  };
  validateFinanceEditPlan(edit, input.manifest);
  const measuredAt = input.measuredAt ?? new Date().toISOString();

  return {
    edit,
    alignment,
    check: {
      id: "edit-timeline",
      label: "Timeline continua",
      stage: "edit",
      status: "passed",
      detail: `${scenes.length} contiguous scenes from 0s to ${edit.duration}s using voice alignment.`,
      measuredAt,
    },
  };
}
