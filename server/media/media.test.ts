import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessFfprobePayload,
  buildCaptionCues,
  buildFinanceEditPlan,
  normalizeVoiceAlignment,
  parseJsonOutput,
  prepareFinanceReelMedia,
  runHyperframesCommands,
  writeFinanceVisualAssets,
  type FinanceScript,
  type ProcessExecutor,
} from "./index.ts";

const CREATED_AT = "2026-07-09T10:00:00.000Z";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "finance-media-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const script: FinanceScript = {
  title: "Los movimientos que marcaron la sesion",
  language: "es",
  narration:
    "Estas fueron las acciones que mas se movieron hoy en Wall Street. Nvidia NVDA sube con fuerza por la demanda sostenida de chips para inteligencia artificial. Tesla TSLA baja tras nuevas dudas sobre margenes y entregas. Para manana vigila resultados empresariales, guidance y los proximos datos macro.",
  movers: [
    {
      ticker: "NVDA",
      company: "Nvidia",
      direction: "up",
      changePct: 4.8,
      catalyst: "Demanda sostenida de chips para inteligencia artificial.",
      sourceIds: ["source-nvda"],
    },
    {
      ticker: "TSLA",
      company: "Tesla",
      direction: "down",
      changePct: -3.2,
      catalyst: "Nuevas dudas sobre margenes y entregas.",
      sourceIds: ["source-tsla"],
    },
  ],
  closing: "Para manana vigila resultados empresariales, guidance y los proximos datos macro.",
};

function alignmentFixture(): { words: Array<{ text: string; start: number; end: number }>; duration: number } {
  const words = script.narration.split(/\s+/).map((text, index) => ({
    text,
    start: 0.2 + index * 0.39,
    end: 0.5 + index * 0.39,
  }));
  return { words, duration: 20 };
}

describe("finance-reel-v0 media generation", () => {
  test("normalizes ElevenLabs character alignment into real word timings", () => {
    const normalized = normalizeVoiceAlignment({
      characters: ["H", "o", "l", "a", " ", "m", "e", "r", "c", "a", "d", "o"],
      character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1],
      character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2],
      duration: 1.2,
    });
    expect(normalized.words).toEqual([
      { text: "Hola", start: 0, end: 0.4 },
      { text: "mercado", start: 0.5, end: 1.2 },
    ]);
  });

  test("keeps adjacent caption clips from overlapping", () => {
    const cues = buildCaptionCues({
      words: [
        { text: "Primera", start: 0, end: 0.7 },
        { text: "frase.", start: 0.6, end: 1.1 },
        { text: "Segunda", start: 1.08, end: 1.6 },
        { text: "frase.", start: 1.55, end: 2 },
      ],
      duration: 2,
    }, { maxWords: 2 });

    expect(cues).toHaveLength(2);
    expect(cues[0].end).toBe(cues[1].start);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
  });

  test("writes byte-stable single-observation SVG assets and manifest", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    const firstResult = await writeFinanceVisualAssets({ projectDir: first, script, createdAt: CREATED_AT });
    const secondResult = await writeFinanceVisualAssets({ projectDir: second, script, createdAt: CREATED_AT });
    expect(firstResult.manifest).toEqual(secondResult.manifest);

    const chartPath = join(first, "assets", "01-nvda-change.svg");
    const firstChart = await readFile(chartPath, "utf8");
    const secondChart = await readFile(join(second, "assets", "01-nvda-change.svg"), "utf8");
    expect(firstChart).toBe(secondChart);
    expect(firstChart).toContain('data-observation-count="1"');
    expect(firstChart).toContain("+4,8%");
    expect(firstChart).not.toMatch(/<(?:path|polyline)\b/);
    expect(firstResult.manifest.chartDomain).toEqual({ minPct: -4.8, maxPct: 4.8, observationCountPerMover: 1 });
  });

  test("builds a gap-free edit and escaped HyperFrames composition", async () => {
    const projectDir = await temporaryDirectory();
    await writeFile(join(projectDir, "voiceover.mp3"), new Uint8Array([0]));
    const result = await prepareFinanceReelMedia({
      projectDir,
      script: { ...script, title: "Mercado <script>alert(1)</script>" },
      alignment: alignmentFixture(),
      audio: "voiceover.mp3",
      createdAt: CREATED_AT,
    });

    expect(result.edit.duration).toBe(20);
    expect(result.edit.scenes[0].start).toBe(0);
    expect(result.edit.scenes.at(-1)?.end).toBe(20);
    for (let index = 1; index < result.edit.scenes.length; index += 1) {
      expect(result.edit.scenes[index].start).toBe(result.edit.scenes[index - 1].end);
    }

    const html = await readFile(join(projectDir, "hyperframes", "index.html"), "utf8");
    expect(html).toContain('data-width="1080" data-height="1920" data-duration="20" data-fps="30"');
    expect(html).toContain('src="./voiceover.mp3"');
    expect(html).toContain("window.__timelines.root = timeline");
    expect(html).toContain("caption-layer clip");
    expect(html).toContain("ticker-track");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(result.checks.map((check) => check.id)).toEqual(["assets-valid", "edit-timeline"]);
  });

  test("rejects contradictory mover direction before planning", () => {
    expect(() =>
      buildFinanceEditPlan({
        script: { ...script, movers: [{ ...script.movers[0], direction: "down" }, script.movers[1]] },
        alignment: alignmentFixture(),
        manifest: { version: 1, styleId: "finance-reel-v0", chartDomain: { minPct: -5, maxPct: 5, observationCountPerMover: 1 }, assets: [] },
        audio: "voiceover.mp3",
      }),
    ).toThrow("contradictory");
  });
});

describe("media command and probe checks", () => {
  test("runs lint, inspect, snapshot, and render with structured artifacts", async () => {
    const projectDir = await temporaryDirectory();
    const commandEvents: Array<{ id: string; phase: string }> = [];
    const executor: ProcessExecutor = async (command) => {
      const operation = command.args[0];
      if (operation === "snapshot") {
        const output = join(command.args[1], "snapshots");
        await writeFile(join(output, "frame-001.png"), new Uint8Array([1, 2, 3]));
      }
      if (operation === "render") {
        const output = command.args[command.args.indexOf("--output") + 1];
        await writeFile(output, new Uint8Array([1, 2, 3]));
      }
      return {
        command: command.command,
        args: command.args,
        exitCode: 0,
        stdout: operation === "lint" || operation === "inspect" ? '{"issues":[],"ok":true}' : "done",
        stderr: "",
        durationMs: 5,
      };
    };

    const result = await runHyperframesCommands({
      projectDir,
      command: "hyperframes",
      prefixArgs: [],
      executor,
      createdAt: CREATED_AT,
      onCommandEvent: (event) => { commandEvents.push({ id: event.id, phase: event.phase }); },
    });
    expect(result.ok).toBe(true);
    expect(result.commands.map((command) => command.id)).toEqual(["lint", "inspect", "snapshot", "render"]);
    expect(result.commands.find((command) => command.id === "inspect")?.execution?.args).toEqual(["inspect", join(projectDir, "hyperframes"), "--json", "--strict"]);
    expect(result.commands.find((command) => command.id === "render")?.execution?.args.slice(0, 3)).toEqual(["render", "--output", join(projectDir, "renders", "output.mp4")]);
    expect(result.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["snapshot", "video"]);
    expect(commandEvents).toEqual([
      { id: "lint", phase: "started" },
      { id: "lint", phase: "completed" },
      { id: "inspect", phase: "started" },
      { id: "inspect", phase: "completed" },
      { id: "snapshot", phase: "started" },
      { id: "snapshot", phase: "completed" },
      { id: "render", phase: "started" },
      { id: "render", phase: "completed" },
    ]);
    expect(parseJsonOutput("setup\n{\"ok\":true}")).toEqual({ ok: true });
  });

  test("verifies H.264, AAC, portrait dimensions, fps, audio, and duration", () => {
    const result = assessFfprobePayload(
      {
        streams: [
          { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1" },
          { codec_type: "audio", codec_name: "aac" },
        ],
        format: { duration: "20.040" },
      },
      20,
    );
    expect(result.ok).toBe(true);
    expect(result.assertions.every((item) => item.passed)).toBe(true);

    const invalid = assessFfprobePayload({ streams: [{ codec_type: "video", codec_name: "vp9", width: 1920, height: 1080, avg_frame_rate: "24/1" }], format: { duration: "10" } }, 20);
    expect(invalid.ok).toBe(false);
    expect(invalid.assertions.find((item) => item.id === "audio-stream")?.passed).toBe(false);
  });
});
