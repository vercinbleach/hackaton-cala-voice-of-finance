import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ArtifactRef, PipelineCheck } from "../../shared/contracts.ts";
import { runHyperframesCommands } from "./command-runner.ts";
import { buildFinanceEditPlan } from "./edit-plan.ts";
import { writeHyperframesIndex } from "./hyperframes.ts";
import type {
  HyperframesCommandEvent,
  HyperframesRunResult,
  MediaBuildResult,
  ProcessExecutor,
  VideoVerificationResult,
} from "./types.ts";
import { makeArtifactRef, projectRelativePath, sha256, stableJson } from "./utils.ts";
import { verifyRenderedVideo } from "./verify-video.ts";
import { writeFinanceVisualAssets } from "./visual-assets.ts";

export async function prepareFinanceReelMedia(input: {
  projectDir: string;
  script: unknown;
  alignment: unknown;
  audio: string;
  createdAt?: string;
}): Promise<MediaBuildResult> {
  const projectDir = resolve(input.projectDir);
  const createdAt = input.createdAt ?? new Date().toISOString();
  await mkdir(projectDir, { recursive: true });
  const audioPath = isAbsolute(input.audio) ? input.audio : resolve(projectDir, input.audio);
  await stat(audioPath).catch(() => {
    throw new Error(`Voice audio does not exist: ${audioPath}`);
  });

  const assets = await writeFinanceVisualAssets({ projectDir, script: input.script, createdAt });
  const compositionDir = join(projectDir, "hyperframes");
  await mkdir(compositionDir, { recursive: true });
  for (const asset of assets.manifest.assets) {
    const sourcePath = resolve(projectDir, asset.relativePath);
    const targetPath = resolve(compositionDir, asset.relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
  const compositionAudioName = basename(audioPath);
  await copyFile(audioPath, join(compositionDir, compositionAudioName));
  const planned = buildFinanceEditPlan({
    script: assets.script,
    alignment: input.alignment,
    manifest: assets.manifest,
    audio: compositionAudioName,
    measuredAt: createdAt,
  });
  const editContent = stableJson(planned.edit);
  const editPath = join(projectDir, "edit.json");
  await writeFile(editPath, editContent, "utf8");
  const composition = await writeHyperframesIndex({
    projectDir,
    script: assets.script,
    alignment: planned.alignment,
    edit: planned.edit,
    manifest: assets.manifest,
  });

  const artifacts: ArtifactRef[] = [
    ...assets.artifacts,
    makeArtifactRef({
      kind: "edit",
      label: "Finance reel edit plan",
      stage: "edit",
      relativePath: projectRelativePath(projectDir, editPath),
      mimeType: "application/json",
      createdAt,
      contentHash: sha256(editContent),
    }),
    makeArtifactRef({
      kind: "composition",
      label: "HyperFrames composition",
      stage: "render",
      relativePath: projectRelativePath(projectDir, composition.indexPath),
      mimeType: "text/html",
      createdAt,
      contentHash: sha256(composition.html),
    }),
  ];
  const checks = [assets.check, planned.check];
  return {
    ok: checks.every((check) => check.status === "passed"),
    script: assets.script,
    alignment: planned.alignment,
    manifest: assets.manifest,
    edit: planned.edit,
    checks,
    artifacts,
  };
}

export interface RenderFinanceReelResult {
  ok: boolean;
  checks: PipelineCheck[];
  artifacts: ArtifactRef[];
  hyperframes: HyperframesRunResult;
  verification?: VideoVerificationResult;
}

export async function renderFinanceReelMedia(input: {
  projectDir: string;
  expectedDuration: number;
  outputPath?: string;
  hyperframesExecutor?: ProcessExecutor;
  ffprobeExecutor?: ProcessExecutor;
  hyperframesCommand?: string;
  hyperframesPrefixArgs?: string[];
  hyperframesEnv?: Record<string, string | undefined>;
  ffprobeCommand?: string;
  createdAt?: string;
  heartbeatMs?: number;
  onCommandEvent?: (event: HyperframesCommandEvent) => Promise<void> | void;
}): Promise<RenderFinanceReelResult> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const hyperframes = await runHyperframesCommands({
    projectDir: input.projectDir,
    outputPath: input.outputPath,
    executor: input.hyperframesExecutor,
    command: input.hyperframesCommand,
    prefixArgs: input.hyperframesPrefixArgs,
    env: input.hyperframesEnv,
    createdAt,
    heartbeatMs: input.heartbeatMs,
    onCommandEvent: input.onCommandEvent,
  });
  if (!hyperframes.outputPath) {
    return { ok: false, checks: hyperframes.checks, artifacts: hyperframes.artifacts, hyperframes };
  }

  const verification = await verifyRenderedVideo({
    videoPath: hyperframes.outputPath,
    projectDir: input.projectDir,
    expectedDuration: input.expectedDuration,
    executor: input.ffprobeExecutor,
    ffprobeCommand: input.ffprobeCommand,
    createdAt,
  });
  const artifacts = [
    ...hyperframes.artifacts.filter((artifact) => artifact.kind !== "video"),
    ...(verification.artifact ? [verification.artifact] : hyperframes.artifacts.filter((artifact) => artifact.kind === "video")),
  ];
  return {
    ok: hyperframes.ok && verification.ok,
    checks: [...hyperframes.checks, verification.check],
    artifacts,
    hyperframes,
    verification,
  };
}
