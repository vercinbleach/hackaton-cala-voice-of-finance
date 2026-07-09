import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ArtifactRef, PipelineCheck, PipelineStage } from "../shared/contracts";
import type { PipelineRunContext, PipelineRunner } from "./run-manager";
import {
  CalaProvider,
  CodexProvider,
  ElevenLabsProvider,
  ProviderError,
  type CalaResearch,
  type ScriptOutput,
  type SpeechWithTimestampsResult,
} from "./providers";
import {
  prepareFinanceReelMedia,
  renderFinanceReelMedia,
  writeFinanceVisualAssets,
  type FinanceAssetManifest,
  type FinanceEditPlan,
  type HyperframesCommandEvent,
  type NormalizedAlignment,
  type WriteFinanceAssetsResult,
} from "./media";

const STAGE_ORDER: PipelineStage[] = [
  "intake",
  "research",
  "script",
  "voice",
  "assets",
  "edit",
  "render",
  "complete",
];

interface FinancePipelineRunnerOptions {
  cala: CalaProvider;
  codex: CodexProvider;
  elevenLabs: ElevenLabsProvider;
  hyperframesCommand?: string;
  hyperframesPrefixArgs?: string[];
  ffprobeCommand?: string;
  renderEnv?: Record<string, string | undefined>;
}

interface PipelineState {
  research?: CalaResearch;
  script?: ScriptOutput;
  speech?: SpeechWithTimestampsResult;
  alignment?: NormalizedAlignment;
  manifest?: FinanceAssetManifest;
  edit?: FinanceEditPlan;
}

interface ControlledRetryOptions {
  attempts?: number;
  signal?: AbortSignal;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (input: { attempt: number; delayMs: number; error: ProviderError }) => Promise<void> | void;
}

interface OperationHeartbeatOptions {
  intervalMs?: number;
  onHeartbeat: (elapsedSeconds: number) => Promise<void> | void;
}

export async function withOperationHeartbeat<T>(
  operation: () => Promise<T>,
  options: OperationHeartbeatOptions,
): Promise<T> {
  const startedAt = Date.now();
  const outcome = operation().then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

  while (true) {
    const result = await Promise.race([
      outcome,
      new Promise<{ kind: "heartbeat" }>((resolveHeartbeat) => {
        setTimeout(() => resolveHeartbeat({ kind: "heartbeat" }), options.intervalMs ?? 10_000);
      }),
    ]);
    if (result.kind === "heartbeat") {
      await options.onHeartbeat(Math.max(1, Math.round((Date.now() - startedAt) / 1_000)));
      continue;
    }
    if (result.kind === "error") throw result.error;
    return result.value;
  }
}

export async function withControlledProviderRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: ControlledRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 2;
  const sleep = options.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw new Error("La pipeline fue cancelada.");
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        !(error instanceof ProviderError) ||
        error.code !== "TIMEOUT" ||
        !error.retryable ||
        attempt === attempts
      ) throw error;
      const delayMs = Math.min(error.retryAfterMs ?? 1_000 * attempt, 5_000);
      await options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error("El proveedor no completo la operacion.");
}

function artifact(
  kind: ArtifactRef["kind"],
  stage: PipelineStage,
  label: string,
  relativePath: string,
  mimeType?: string,
): ArtifactRef {
  return {
    id: `${stage}-${kind}-${relativePath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    kind,
    stage,
    label,
    relativePath: relativePath.replaceAll("\\", "/"),
    ...(mimeType ? { mimeType } : {}),
    createdAt: new Date().toISOString(),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function sourceMarkdown(research: CalaResearch): string {
  return [
    "# Sources",
    "",
    ...research.sources.flatMap((source) => [
      `- [${source.title}](${source.url})${source.publisher ? ` - ${source.publisher}` : ""}`,
      source.publishedAt ? `  - Published: ${source.publishedAt}` : "",
    ]).filter(Boolean),
    "",
  ].join("\n");
}

function stageAtOrAfter(current: PipelineStage, target: PipelineStage): boolean {
  return STAGE_ORDER.indexOf(current) <= STAGE_ORDER.indexOf(target);
}

async function reportCheck(
  context: PipelineRunContext,
  stage: PipelineStage,
  progress: number,
  message: string,
  check: PipelineCheck,
): Promise<void> {
  await context.report({ stage, status: "testing", progress, message, check });
}

async function reportArtifacts(
  context: PipelineRunContext,
  stage: PipelineStage,
  progress: number,
  message: string,
  artifacts: ArtifactRef[],
): Promise<void> {
  if (artifacts.length === 0) {
    await context.report({ stage, status: "running", progress, message });
    return;
  }
  for (const [index, item] of artifacts.entries()) {
    await context.report({
      stage,
      status: "running",
      progress,
      message: index === 0 ? message : `Artefacto listo: ${item.label}`,
      artifact: item,
    });
  }
}

export class FinancePipelineRunner implements PipelineRunner {
  constructor(private readonly options: FinancePipelineRunnerOptions) {}

  async runPipeline(context: PipelineRunContext): Promise<void> {
    const projectDir = context.projectDirectory;
    const state: PipelineState = {};
    await mkdir(projectDir, { recursive: true });

    await this.intake(context);
    state.research = await this.research(context);
    state.script = await this.script(context, state.research);
    const parallel = await this.voiceAndAssets(context, state.script);
    state.speech = parallel.speech;
    state.alignment = parallel.alignment;
    state.manifest = parallel.manifest;
    state.edit = await this.edit(context, state.script, state.alignment, state.manifest);
    await this.render(context, state.edit);
  }

  private async intake(context: PipelineRunContext): Promise<void> {
    const path = join(context.projectDirectory, "brief.json");
    if (stageAtOrAfter(context.resumeFrom, "intake") || !(await Bun.file(path).exists())) {
      await context.report({ stage: "intake", status: "running", progress: 2, message: "Normalizando prompt y referencias" });
      await writeJson(path, {
        prompt: context.run.prompt,
        references: context.run.references,
        format: context.run.format,
        styleId: context.run.styleId,
        duration: context.run.duration,
      });
    }
    await reportArtifacts(context, "intake", 8, "Brief guardado", [
      artifact("brief", "intake", "Brief normalizado", "brief.json", "application/json"),
    ]);
  }

  private async research(context: PipelineRunContext): Promise<CalaResearch> {
    const researchPath = join(context.projectDirectory, "research.json");
    const sourcesPath = join(context.projectDirectory, "sources.md");
    let research: CalaResearch;
    if (stageAtOrAfter(context.resumeFrom, "research") || !(await Bun.file(researchPath).exists())) {
      await context.report({ stage: "research", status: "running", progress: 12, message: "Consultando Cala con trazabilidad" });
      research = await withOperationHeartbeat(
        () => withControlledProviderRetry(
          () => this.options.cala.queryMarketMovers({ query: context.run.prompt }),
          {
            attempts: 2,
            signal: context.signal,
            onRetry: async ({ attempt, delayMs, error }) => {
              await context.report({
                stage: "research",
                status: "running",
                progress: 12,
                message: `Cala fallo temporalmente (${error.code}); reintento ${attempt + 1}/2 en ${delayMs} ms`,
              });
            },
          },
        ),
        {
          intervalMs: 10_000,
          onHeartbeat: async (elapsedSeconds) => {
            await context.report({
              stage: "research",
              status: "running",
              progress: 12,
              message: `Cala sigue procesando la consulta (${elapsedSeconds}s)`,
            });
          },
        },
      );
      await Promise.all([
        writeJson(researchPath, research),
        writeFile(sourcesPath, sourceMarkdown(research), "utf8"),
      ]);
    } else {
      research = await readJson<CalaResearch>(researchPath);
    }

    const check: PipelineCheck = {
      id: "research-sources",
      label: "Datos con fuentes",
      stage: "research",
      status: research.sources.length > 0 ? "passed" : "failed",
      detail: `${research.gainers.length} subidas, ${research.decliners.length} bajadas y ${research.sources.length} fuentes.`,
      measuredAt: new Date().toISOString(),
    };
    await reportCheck(context, "research", 24, "Validando datos y fuentes", check);
    if (check.status === "failed") throw new Error("Cala no devolvio fuentes utilizables.");
    await reportArtifacts(context, "research", 28, "Research trazable listo", [
      artifact("research", "research", "Research Cala", "research.json", "application/json"),
      artifact("sources", "research", "Fuentes", "sources.md", "text/markdown"),
    ]);
    return research;
  }

  private async script(context: PipelineRunContext, research: CalaResearch): Promise<ScriptOutput> {
    const path = join(context.projectDirectory, "script.json");
    let script: ScriptOutput;
    if (stageAtOrAfter(context.resumeFrom, "script") || !(await Bun.file(path).exists())) {
      await context.report({ stage: "script", status: "running", progress: 32, message: "Codex esta escribiendo un guion grounded" });
      script = await withOperationHeartbeat(
        () => this.options.codex.generateScript({
          brief: context.run.prompt,
          research,
          cwd: context.projectDirectory,
          instructions: "Reel vertical informativo de unos 30 segundos. Sin recomendaciones de inversion.",
        }),
        {
          intervalMs: 8_000,
          onHeartbeat: async (elapsedSeconds) => {
            await context.report({
              stage: "script",
              status: "running",
              progress: 32,
              message: `Codex sigue preparando el guion (${elapsedSeconds}s)`,
            });
          },
        },
      );
      await writeJson(path, script);
      await writeFile(join(context.projectDirectory, "script.md"), `# ${script.title}\n\n${script.narration}\n`, "utf8");
    } else {
      script = await readJson<ScriptOutput>(path);
    }
    const wordCount = script.narration.trim().split(/\s+/).length;
    const check: PipelineCheck = {
      id: "script-grounding",
      label: "Guion grounded",
      stage: "script",
      status: wordCount >= 65 && wordCount <= 85 ? "passed" : "failed",
      detail: `${wordCount} palabras y ${script.movers.length} movers con sourceIds.`,
      measuredAt: new Date().toISOString(),
    };
    await reportCheck(context, "script", 40, "Comprobando grounding y longitud", check);
    if (check.status === "failed") throw new Error("El guion no cumple el contrato editorial.");
    await reportArtifacts(context, "script", 43, "Guion listo", [
      artifact("script", "script", "Guion", "script.json", "application/json"),
    ]);
    return script;
  }

  private async voiceAndAssets(
    context: PipelineRunContext,
    script: ScriptOutput,
  ): Promise<{ speech: SpeechWithTimestampsResult; alignment: NormalizedAlignment; manifest: FinanceAssetManifest }> {
    const voicePath = join(context.projectDirectory, "voiceover.mp3");
    const alignmentPath = join(context.projectDirectory, "alignment.json");
    const manifestPath = join(context.projectDirectory, "asset-manifest.json");
    const runVoice = stageAtOrAfter(context.resumeFrom, "voice") || !(await Bun.file(voicePath).exists());
    const runAssets = stageAtOrAfter(context.resumeFrom, "assets") || !(await Bun.file(manifestPath).exists());

    await context.report({ stage: "voice", status: "running", progress: 46, message: runVoice ? "ElevenLabs esta generando voz y tiempos" : "Reutilizando voz validada" });
    await context.report({ stage: "assets", status: "running", progress: 46, message: runAssets ? "Generando charts y cards desde datos" : "Reutilizando assets validados" });

    const voicePromise = runVoice
      ? this.options.elevenLabs.synthesizeSpeechWithTimestamps({ text: script.narration, languageCode: "es" })
      : Promise.all([
          readFile(voicePath),
          readJson<{ words: SpeechWithTimestampsResult["words"]; captions: SpeechWithTimestampsResult["captions"]; durationSeconds: number }>(alignmentPath),
        ]).then(([audio, saved]) => ({
          audio: new Uint8Array(audio),
          mimeType: "audio/mpeg" as const,
          text: script.narration,
          durationSeconds: saved.durationSeconds,
          alignmentSource: "normalized" as const,
          words: saved.words,
          captions: saved.captions,
        }));
    const assetsPromise: Promise<WriteFinanceAssetsResult | { manifest: FinanceAssetManifest }> = runAssets
      ? writeFinanceVisualAssets({ projectDir: context.projectDirectory, script })
      : readJson<FinanceAssetManifest>(manifestPath).then((manifest) => ({ manifest }));

    const [speech, assets] = await withOperationHeartbeat(
      () => Promise.all([voicePromise, assetsPromise]),
      {
        intervalMs: 8_000,
        onHeartbeat: async (elapsedSeconds) => {
          await context.report({
            stage: "voice",
            status: "running",
            progress: 46,
            message: `ElevenLabs sigue generando voz (${elapsedSeconds}s)`,
          });
          await context.report({
            stage: "assets",
            status: "running",
            progress: 46,
            message: `Los assets siguen procesandose (${elapsedSeconds}s)`,
          });
        },
      },
    );
    if (speech.durationSeconds < context.run.duration.min || speech.durationSeconds > context.run.duration.max) {
      throw new Error(`La voz dura ${speech.durationSeconds.toFixed(2)}s; debe durar entre 15 y 45s.`);
    }
    if (runVoice) {
      await Promise.all([
        writeFile(voicePath, speech.audio),
        writeJson(alignmentPath, {
          words: speech.words,
          captions: speech.captions,
          durationSeconds: speech.durationSeconds,
          source: speech.alignmentSource,
        }),
      ]);
    }
    const alignment: NormalizedAlignment = { words: speech.words, duration: speech.durationSeconds };
    const voiceCheck: PipelineCheck = {
      id: "voice-alignment",
      label: "Audio y captions",
      stage: "voice",
      status: "passed",
      detail: `${speech.durationSeconds.toFixed(2)}s, ${speech.words.length} palabras y ${speech.captions.length} captions.`,
      measuredAt: new Date().toISOString(),
    };
    await reportCheck(context, "voice", 57, "Validando audio y alignment", voiceCheck);
    await reportArtifacts(context, "voice", 60, "Voz lista", [
      artifact("voice", "voice", "Voiceover", "voiceover.mp3", "audio/mpeg"),
      artifact("alignment", "voice", "Alignment", "alignment.json", "application/json"),
    ]);

    const manifest = assets.manifest;
    const assetCheck: PipelineCheck = "check" in assets ? assets.check : {
      id: "assets-valid",
      label: "Assets validos",
      stage: "assets",
      status: manifest.assets.length > 0 ? "passed" : "failed",
      detail: `${manifest.assets.length} assets reutilizados.`,
      measuredAt: new Date().toISOString(),
    };
    await reportCheck(context, "assets", 63, "Validando assets", assetCheck);
    if (assetCheck.status === "failed") throw new Error("Los assets generados no son validos.");
    if ("artifacts" in assets) await reportArtifacts(context, "assets", 66, "Assets listos", assets.artifacts);
    return { speech, alignment, manifest };
  }

  private async edit(
    context: PipelineRunContext,
    script: ScriptOutput,
    alignment: NormalizedAlignment,
    manifest: FinanceAssetManifest,
  ): Promise<FinanceEditPlan> {
    const editPath = join(context.projectDirectory, "edit.json");
    let edit: FinanceEditPlan;
    const refreshComposition = context.resumeFrom === "render";
    if (refreshComposition || stageAtOrAfter(context.resumeFrom, "edit") || !(await Bun.file(editPath).exists())) {
      await context.report({ stage: "edit", status: "running", progress: 69, message: "Construyendo timeline desde el alignment" });
      const prepared = await prepareFinanceReelMedia({
        projectDir: context.projectDirectory,
        script,
        alignment,
        audio: "voiceover.mp3",
      });
      edit = prepared.edit;
      for (const check of prepared.checks) {
        await reportCheck(context, check.stage, 75, check.label, check);
      }
      await reportArtifacts(
        context,
        "edit",
        78,
        "Plan de edicion y composicion listos",
        prepared.artifacts.filter((item) => item.kind === "edit" || item.kind === "composition"),
      );
    } else {
      edit = await readJson<FinanceEditPlan>(editPath);
    }
    return edit;
  }

  private async render(context: PipelineRunContext, edit: FinanceEditPlan): Promise<void> {
    const commandProgress: Record<HyperframesCommandEvent["id"], { start: number; complete: number; label: string }> = {
      lint: { start: 82, complete: 84, label: "Lint HyperFrames" },
      inspect: { start: 85, complete: 87, label: "Inspeccion de layout" },
      snapshot: { start: 88, complete: 91, label: "Snapshots" },
      render: { start: 92, complete: 96, label: "Render MP4" },
    };
    const rendered = await renderFinanceReelMedia({
      projectDir: context.projectDirectory,
      expectedDuration: edit.duration,
      hyperframesCommand: this.options.hyperframesCommand,
      hyperframesPrefixArgs: this.options.hyperframesPrefixArgs,
      ffprobeCommand: this.options.ffprobeCommand,
      hyperframesEnv: this.options.renderEnv,
      heartbeatMs: 10_000,
      onCommandEvent: async (event) => {
        const command = commandProgress[event.id];
        const progress = event.phase === "completed" ? command.complete : command.start;
        const message = event.phase === "started"
          ? `${command.label} iniciado`
          : event.phase === "heartbeat"
            ? `${command.label} sigue en curso (${Math.max(1, Math.round(event.elapsedMs / 1_000))}s)`
            : `${command.label} ${event.status === "passed" ? "aprobado" : event.status === "skipped" ? "omitido" : "fallido"}`;
        await context.report({
          stage: "render",
          status: event.phase === "completed" ? "testing" : "running",
          progress,
          message,
        });
      },
    });
    for (const check of rendered.checks) {
      await reportCheck(context, "render", 97, check.label, check);
    }
    await reportArtifacts(context, "render", 98, "Render y artefactos verificados", rendered.artifacts);
    if (!rendered.ok) {
      const failures = rendered.checks.filter((check) => check.status === "failed").map((check) => check.label);
      throw new Error(`Fallo de media: ${failures.join(", ") || "render desconocido"}.`);
    }
    const video = rendered.artifacts.find((item) => item.kind === "video");
    if (!video) throw new Error("El render no produjo un MP4 verificable.");
    await context.report({
      stage: "complete",
      status: "completed",
      progress: 100,
      message: "Reel financiero listo",
      artifact: { ...video, stage: "complete" },
      check: rendered.verification?.check,
    });
  }
}

export function projectPath(projectDir: string, path: string): string {
  return relative(projectDir, path).replaceAll("\\", "/");
}
