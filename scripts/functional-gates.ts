import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  PIPELINE_STAGES,
  PIPELINE_STATUSES,
  validatePrompt,
  validateReferenceUrl,
} from "../shared/contracts.ts";
import { validateJsonSchema } from "./lib/json-schema.ts";
import { loadProbeFixture, probeMedia, validateProbe } from "./lib/media-probe.ts";

type JsonObject = Record<string, unknown>;
type GateStatus = "passed" | "failed";

interface Gate {
  id: string;
  label: string;
  run: () => Promise<string>;
}

interface GateResult {
  id: string;
  label: string;
  status: GateStatus;
  durationMs: number;
  detail: string;
}

interface CliOptions {
  fixtures: string;
  project?: string;
  includePreflight: boolean;
  json: boolean;
  list: boolean;
  only: Set<string>;
}

interface SseRecord {
  id: number | null;
  event: string | null;
  data: unknown;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usage(): string {
  return [
    "Usage: bun scripts/functional-gates.ts [options]",
    "",
    "  --fixtures <path>   Fixture root (default tests/fixtures)",
    "  --project <path>    Add live project artifact and ffprobe gates",
    "  --preflight         Add the strict live environment preflight gate",
    "  --only <id,...>     Run selected gate IDs",
    "  --list              List available gate IDs",
    "  --json              Emit one JSON report",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    fixtures: join(repositoryRoot, "tests", "fixtures"),
    includePreflight: false,
    json: false,
    list: false,
    only: new Set(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };

    switch (argument) {
      case "--fixtures":
        options.fixtures = resolve(next());
        break;
      case "--project":
        options.project = resolve(next());
        break;
      case "--preflight":
        options.includePreflight = true;
        break;
      case "--only":
        for (const id of next().split(",").map((item) => item.trim()).filter(Boolean)) options.only.add(id);
        break;
      case "--json":
        options.json = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

async function readJson(path: string): Promise<unknown> {
  return Bun.file(path).json();
}

async function readText(path: string): Promise<string> {
  return Bun.file(path).text();
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireNoErrors(errors: string[], label: string): void {
  if (errors.length) throw new Error(`${label}: ${errors.join("; ")}`);
}

function requireExpectedErrors(errors: string[], label: string): void {
  if (!errors.length) throw new Error(`${label}: fixture unexpectedly passed`);
}

function validateReferences(value: unknown): string[] {
  const errors: string[] = [];
  const references = asArray(value);
  for (const [index, candidate] of references.entries()) {
    const path = `references[${index}]`;
    if (!isObject(candidate)) {
      errors.push(`${path}: expected object`);
      continue;
    }
    if (typeof candidate.id !== "string" || !candidate.id) errors.push(`${path}.id: required`);
    if (candidate.kind === "url") {
      try {
        validateReferenceUrl(candidate.value);
      } catch (error) {
        errors.push(`${path}.value: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (candidate.kind === "upload") {
      if (typeof candidate.filename !== "string" || !candidate.filename) errors.push(`${path}.filename: required`);
      if (typeof candidate.mimeType !== "string" || !ALLOWED_UPLOAD_TYPES.has(candidate.mimeType)) {
        errors.push(`${path}.mimeType: unsupported upload type`);
      }
      if (finiteNumber(candidate.size) === null || Number(candidate.size) < 0 || Number(candidate.size) > MAX_UPLOAD_BYTES) {
        errors.push(`${path}.size: must be between 0 and ${MAX_UPLOAD_BYTES}`);
      }
    } else {
      errors.push(`${path}.kind: must be url or upload`);
    }
  }
  return errors;
}

function validateCreateRun(value: unknown): string[] {
  if (!isObject(value)) return ["request must be an object"];
  const errors: string[] = [];
  try {
    validatePrompt(value.prompt);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  errors.push(...validateReferences(value.references));
  if (value.styleId !== "finance-reel-v0") errors.push("styleId must be finance-reel-v0");
  if (!isObject(value.format) || value.format.width !== 1080 || value.format.height !== 1920 || value.format.fps !== 30) {
    errors.push("format must be 1080x1920 at 30fps");
  }
  return errors;
}

function validateResearch(value: unknown): string[] {
  if (!isObject(value)) return ["research must be an object"];
  if ("error" in value) return ["research contains a provider error"];

  const errors: string[] = [];
  const sources = asArray(value.sources);
  const movers = asArray(value.movers);
  if (!sources.length) errors.push("sources must not be empty");
  if (movers.length < 2) errors.push("at least two movers are required");

  const sourceIds = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (!isObject(source) || typeof source.id !== "string" || !source.id) {
      errors.push(`sources[${index}].id: required`);
      continue;
    }
    if (sourceIds.has(source.id)) errors.push(`sources[${index}].id: duplicate ${source.id}`);
    sourceIds.add(source.id);
    try {
      validateReferenceUrl(source.url);
    } catch {
      errors.push(`sources[${index}].url: invalid HTTP(S) URL`);
    }
  }

  for (const [index, mover] of movers.entries()) {
    if (!isObject(mover)) {
      errors.push(`movers[${index}]: expected object`);
      continue;
    }
    const changePct = finiteNumber(mover.changePct);
    if (typeof mover.ticker !== "string" || !mover.ticker) errors.push(`movers[${index}].ticker: required`);
    if (mover.direction !== "up" && mover.direction !== "down") errors.push(`movers[${index}].direction: invalid`);
    if (changePct === null) errors.push(`movers[${index}].changePct: required`);
    if (mover.direction === "up" && changePct !== null && changePct <= 0) errors.push(`movers[${index}]: up mover must be positive`);
    if (mover.direction === "down" && changePct !== null && changePct >= 0) errors.push(`movers[${index}]: down mover must be negative`);
    const moverSources = asArray(mover.sourceIds);
    if (!moverSources.length) errors.push(`movers[${index}].sourceIds: required`);
    for (const sourceId of moverSources) {
      if (typeof sourceId !== "string" || !sourceIds.has(sourceId)) errors.push(`movers[${index}]: unknown source ${String(sourceId)}`);
    }
  }
  return errors;
}

function validateScriptGrounding(script: unknown, research: unknown): string[] {
  if (!isObject(script) || !isObject(research)) return ["script and research must be objects"];
  const errors: string[] = [];
  const sources = new Set(
    asArray(research.sources)
      .filter(isObject)
      .map((source) => source.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const researchMovers = new Map(
    asArray(research.movers)
      .filter(isObject)
      .filter((mover) => typeof mover.ticker === "string")
      .map((mover) => [mover.ticker as string, mover]),
  );

  for (const [index, candidate] of asArray(script.movers).entries()) {
    if (!isObject(candidate) || typeof candidate.ticker !== "string") continue;
    const sourceMover = researchMovers.get(candidate.ticker);
    if (!sourceMover) {
      errors.push(`movers[${index}]: ticker ${candidate.ticker} is absent from research`);
      continue;
    }
    if (candidate.changePct !== sourceMover.changePct) errors.push(`movers[${index}]: changePct differs from research`);
    if (candidate.direction !== sourceMover.direction) errors.push(`movers[${index}]: direction differs from research`);
    if (candidate.catalyst !== sourceMover.catalyst) errors.push(`movers[${index}]: catalyst differs from research`);
    for (const sourceId of asArray(candidate.sourceIds)) {
      if (typeof sourceId !== "string" || !sources.has(sourceId)) errors.push(`movers[${index}]: unknown source ${String(sourceId)}`);
    }
  }
  return errors;
}

function validateAlignmentBlock(value: unknown, path: string): string[] {
  if (!isObject(value)) return [`${path}: expected object`];
  const characters = asArray(value.characters);
  const starts = asArray(value.character_start_times_seconds);
  const ends = asArray(value.character_end_times_seconds);
  const errors: string[] = [];
  if (!characters.length) errors.push(`${path}.characters: must not be empty`);
  if (characters.length !== starts.length || characters.length !== ends.length) {
    errors.push(`${path}: character/start/end arrays must have equal lengths`);
    return errors;
  }
  for (let index = 0; index < characters.length; index += 1) {
    const start = finiteNumber(starts[index]);
    const end = finiteNumber(ends[index]);
    if (typeof characters[index] !== "string") errors.push(`${path}.characters[${index}]: expected string`);
    if (start === null || end === null || start < 0 || end <= start) errors.push(`${path}[${index}]: invalid time range`);
    if (index > 0 && start !== null && finiteNumber(starts[index - 1]) !== null && start < Number(starts[index - 1])) {
      errors.push(`${path}[${index}]: start times must be monotonic`);
    }
  }
  return errors;
}

function validateAlignment(value: unknown): string[] {
  if (!isObject(value)) return ["alignment response must be an object"];
  const errors: string[] = [];
  if (typeof value.audio_base64 !== "string" || !value.audio_base64) errors.push("audio_base64 is required");
  errors.push(...validateAlignmentBlock(value.alignment, "alignment"));
  errors.push(...validateAlignmentBlock(value.normalized_alignment, "normalized_alignment"));
  return errors;
}

function validateEditSemantics(value: unknown, sourceIds: Set<string>): string[] {
  if (!isObject(value)) return ["edit must be an object"];
  const errors: string[] = [];
  const duration = finiteNumber(value.duration);
  const scenes = asArray(value.scenes);
  let expectedStart = 0;
  const sceneIds = new Set<string>();

  for (const [index, scene] of scenes.entries()) {
    if (!isObject(scene)) continue;
    const start = finiteNumber(scene.start);
    const end = finiteNumber(scene.end);
    if (typeof scene.id === "string") {
      if (sceneIds.has(scene.id)) errors.push(`scenes[${index}].id: duplicate ${scene.id}`);
      sceneIds.add(scene.id);
    }
    if (start === null || Math.abs(start - expectedStart) > 0.001) {
      errors.push(`scenes[${index}].start: expected ${expectedStart}, got ${start ?? "missing"}`);
    }
    if (start === null || end === null || end <= start) errors.push(`scenes[${index}]: invalid time range`);
    if (end !== null) expectedStart = end;
    if (scene.kind === "mover" && typeof scene.ticker !== "string") errors.push(`scenes[${index}].ticker: required for mover`);
    for (const sourceId of asArray(scene.sourceIds)) {
      if (typeof sourceId !== "string" || !sourceIds.has(sourceId)) errors.push(`scenes[${index}]: unknown source ${String(sourceId)}`);
    }
  }
  if (duration === null || Math.abs(expectedStart - duration) > 0.001) {
    errors.push(`timeline must end at duration ${duration ?? "missing"}, got ${expectedStart}`);
  }
  return errors;
}

function parseSse(text: string): SseRecord[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  return normalized.split(/\n\n+/).map((block, blockIndex) => {
    let id: number | null = null;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator >= 0 ? line.slice(0, separator) : line;
      const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
      if (field === "id") id = Number.parseInt(value, 10);
      else if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }
    if (!dataLines.length) throw new Error(`SSE block ${blockIndex + 1} has no data field`);
    try {
      return { id, event, data: JSON.parse(dataLines.join("\n")) };
    } catch {
      throw new Error(`SSE block ${blockIndex + 1} contains invalid JSON data`);
    }
  });
}

function validateRunEvents(records: SseRecord[]): string[] {
  const errors: string[] = [];
  let previousId = 0;
  let runId: string | null = null;
  for (const [index, record] of records.entries()) {
    if (!isObject(record.data)) {
      errors.push(`events[${index}]: data must be an object`);
      continue;
    }
    const event = record.data;
    const eventId = finiteNumber(event.id);
    if (record.event !== "run-event") errors.push(`events[${index}]: event must be run-event`);
    if (eventId === null || eventId <= previousId) errors.push(`events[${index}].id: must increase`);
    if (record.id !== eventId) errors.push(`events[${index}].id: SSE id and payload id differ`);
    if (eventId !== null) previousId = eventId;
    if (typeof event.runId !== "string" || !event.runId) errors.push(`events[${index}].runId: required`);
    if (runId === null && typeof event.runId === "string") runId = event.runId;
    if (runId !== null && event.runId !== runId) errors.push(`events[${index}].runId: changed within stream`);
    if (!PIPELINE_STAGES.includes(event.stage as never)) errors.push(`events[${index}].stage: invalid`);
    if (!PIPELINE_STATUSES.includes(event.status as never)) errors.push(`events[${index}].status: invalid`);
    if (typeof event.message !== "string" || !event.message) errors.push(`events[${index}].message: required`);
    const progress = finiteNumber(event.progress);
    if (progress === null || progress < 0 || progress > 100) errors.push(`events[${index}].progress: invalid`);
    if (typeof event.timestamp !== "string" || Number.isNaN(Date.parse(event.timestamp))) errors.push(`events[${index}].timestamp: invalid`);
  }
  return errors;
}

function sourceIdsFromResearch(research: unknown): Set<string> {
  if (!isObject(research)) return new Set();
  return new Set(
    asArray(research.sources)
      .filter(isObject)
      .map((source) => source.id)
      .filter((id): id is string => typeof id === "string"),
  );
}

function fixtureGates(root: string): Gate[] {
  const path = (...parts: string[]) => join(root, ...parts);
  return [
    {
      id: "intake-prompt",
      label: "Prompt contract and empty-prompt rejection",
      run: async () => {
        requireNoErrors(validateCreateRun(await readJson(path("intake", "create-run.valid.json"))), "valid request");
        requireExpectedErrors(validateCreateRun(await readJson(path("intake", "prompt-empty.failure.json"))), "empty prompt");
        return "valid prompt accepted; blank prompt rejected";
      },
    },
    {
      id: "intake-reference",
      label: "Reference URL and upload boundaries",
      run: async () => {
        requireNoErrors(validateReferences((await readJson(path("intake", "create-run.valid.json")) as JsonObject).references), "valid references");
        requireExpectedErrors(
          validateReferences((await readJson(path("intake", "reference-protocol.failure.json")) as JsonObject).references),
          "non-HTTP reference",
        );
        requireExpectedErrors(
          validateReferences((await readJson(path("intake", "reference-upload-size.failure.json")) as JsonObject).references),
          "oversized upload",
        );
        return "HTTP(S), MIME, and 50 MiB boundaries exercised";
      },
    },
    {
      id: "research-provider",
      label: "Research provenance and provider failure",
      run: async () => {
        requireNoErrors(validateResearch(await readJson(path("research", "cala.success.json"))), "valid research");
        const failure = await readJson(path("research", "cala-rate-limit.failure.json"));
        requireCondition(isObject(failure) && isObject(failure.error), "rate-limit fixture must contain an error object");
        requireCondition(failure.error.code === "RATE_LIMITED" && failure.error.httpStatus === 429 && failure.error.retryable === true, "rate-limit fixture is not retryable 429");
        return "source provenance accepted; retryable 429 classified";
      },
    },
    {
      id: "script-grounding",
      label: "Script schema and research grounding",
      run: async () => {
        const schema = await readJson(join(repositoryRoot, "shared", "script-output.schema.json"));
        const research = await readJson(path("research", "cala.success.json"));
        const valid = await readJson(path("script", "script.success.json"));
        const invalid = await readJson(path("script", "script-ungrounded.failure.json"));
        requireNoErrors(validateJsonSchema(schema, valid), "valid script schema");
        requireNoErrors(validateScriptGrounding(valid, research), "valid script grounding");
        requireNoErrors(validateJsonSchema(schema, invalid), "semantic-failure script schema");
        requireExpectedErrors(validateScriptGrounding(invalid, research), "ungrounded script");
        return "locked JSON schema honored; invented source and changed value rejected";
      },
    },
    {
      id: "voice-alignment",
      label: "ElevenLabs alignment and quota failure",
      run: async () => {
        requireNoErrors(validateAlignment(await readJson(path("alignment", "elevenlabs.success.json"))), "valid alignment");
        requireExpectedErrors(
          validateAlignment(await readJson(path("alignment", "elevenlabs-length-mismatch.failure.json"))),
          "mismatched alignment",
        );
        const quota = await readJson(path("alignment", "elevenlabs-quota.failure.json"));
        requireCondition(isObject(quota) && isObject(quota.detail) && quota.detail.status === "quota_exceeded", "quota fixture is not classified");
        return "character timing arrays validated; quota failure classified";
      },
    },
    {
      id: "edit-timeline",
      label: "Edit schema and continuous timeline",
      run: async () => {
        const schema = await readJson(join(repositoryRoot, "shared", "edit-output.schema.json"));
        const research = await readJson(path("research", "cala.success.json"));
        const sourceIds = sourceIdsFromResearch(research);
        const valid = await readJson(path("edit", "edit.success.json"));
        const invalid = await readJson(path("edit", "edit-gap.failure.json"));
        requireNoErrors(validateJsonSchema(schema, valid), "valid edit schema");
        requireNoErrors(validateEditSemantics(valid, sourceIds), "valid edit timeline");
        requireNoErrors(validateJsonSchema(schema, invalid), "semantic-failure edit schema");
        requireExpectedErrors(validateEditSemantics(invalid, sourceIds), "gapped edit timeline");
        return "locked JSON schema honored; one-second timeline gap rejected";
      },
    },
    {
      id: "sse-stream",
      label: "SSE success, terminal failure, and malformed data",
      run: async () => {
        const completed = parseSse(await readText(path("sse", "run.completed.sse")));
        const failed = parseSse(await readText(path("sse", "run.failed.sse")));
        requireNoErrors(validateRunEvents(completed), "completed SSE stream");
        requireNoErrors(validateRunEvents(failed), "failed SSE stream");
        const completedTerminal = completed.at(-1)?.data;
        const failedTerminal = failed.at(-1)?.data;
        requireCondition(isObject(completedTerminal) && completedTerminal.stage === "complete" && completedTerminal.status === "completed", "completed SSE stream has no completed terminal event");
        requireCondition(isObject(failedTerminal) && failedTerminal.status === "failed", "failed SSE stream has no failed terminal event");
        let malformedRejected = false;
        try {
          parseSse(await readText(path("sse", "malformed.failure.sse")));
        } catch {
          malformedRejected = true;
        }
        requireCondition(malformedRejected, "malformed SSE fixture unexpectedly parsed");
        return "monotonic events validated; failed terminal and malformed JSON detected";
      },
    },
    {
      id: "media-probe",
      label: "Captured ffprobe media constraints",
      run: async () => {
        const videoRules = {
          requireVideo: true,
          requireAudio: true,
          width: 1080,
          height: 1920,
          fps: 30,
          minDuration: 15,
          maxDuration: 45,
          formatName: "mp4",
        };
        const valid = validateProbe(await loadProbeFixture(path("media", "output.valid.ffprobe.json")), videoRules);
        const noAudio = validateProbe(await loadProbeFixture(path("media", "output-no-audio.failure.ffprobe.json")), videoRules);
        const corrupt = validateProbe(await loadProbeFixture(path("media", "corrupt.failure.ffprobe.json")), videoRules);
        const voice = validateProbe(await loadProbeFixture(path("media", "voiceover.valid.ffprobe.json")), {
          requireAudio: true,
          minDuration: 15,
          maxDuration: 45,
          formatName: "mp3",
        });
        requireCondition(valid.ok, `valid video fixture failed: ${valid.errors.join("; ")}`);
        requireCondition(!noAudio.ok && noAudio.errors.some((error) => error.includes("audio")), "missing-audio fixture was not rejected");
        requireCondition(!corrupt.ok, "corrupt media fixture was not rejected");
        requireCondition(voice.ok, `valid voice fixture failed: ${voice.errors.join("; ")}`);
        return "vertical MP4 and voice accepted; no-audio and corrupt media rejected";
      },
    },
  ];
}

function projectGates(projectRoot: string): Gate[] {
  return [
    {
      id: "project-artifacts",
      label: "Live project artifact set",
      run: async () => {
        const required = [
          "brief.json",
          "research.json",
          "sources.md",
          "voiceover.mp3",
          "alignment.json",
          "edit.json",
          join("hyperframes", "index.html"),
          join("renders", "output.mp4"),
        ];
        const missing = required.filter((relativePath) => !existsSync(join(projectRoot, relativePath)));
        const scriptCandidates = ["script.json", "script-output.json", "script.md"];
        const scriptPath = scriptCandidates.find((relativePath) => existsSync(join(projectRoot, relativePath)));
        if (!scriptPath) missing.push("script.json|script-output.json|script.md");
        requireCondition(!missing.length, `missing artifacts: ${missing.join(", ")}`);

        const editSchema = await readJson(join(repositoryRoot, "shared", "edit-output.schema.json"));
        requireNoErrors(validateJsonSchema(editSchema, await readJson(join(projectRoot, "edit.json"))), "project edit schema");
        if (scriptPath?.endsWith(".json")) {
          const scriptSchema = await readJson(join(repositoryRoot, "shared", "script-output.schema.json"));
          requireNoErrors(validateJsonSchema(scriptSchema, await readJson(join(projectRoot, scriptPath))), "project script schema");
        } else if (scriptPath) {
          requireCondition((await readText(join(projectRoot, scriptPath))).trim().length >= 120, "project script.md is too short");
        }
        return "required artifacts found; locked JSON outputs validated";
      },
    },
    {
      id: "project-media",
      label: "Live project output via ffprobe",
      run: async () => {
        const probe = await probeMedia(join(projectRoot, "renders", "output.mp4"));
        const result = validateProbe(probe, {
          requireVideo: true,
          requireAudio: true,
          width: 1080,
          height: 1920,
          fps: 30,
          minDuration: 15,
          maxDuration: 45,
          formatName: "mp4",
        });
        requireCondition(result.ok, result.errors.join("; "));
        return `${result.summary.duration}s, 1080x1920, 30fps, audio present`;
      },
    },
  ];
}

function preflightGate(): Gate {
  return {
    id: "environment-preflight",
    label: "Strict live environment preflight",
    run: async () => {
      const child = Bun.spawn([process.execPath, join(repositoryRoot, "scripts", "preflight.ts"), "--json", "--strict"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      let report: unknown = null;
      try {
        report = JSON.parse(stdout);
      } catch {
        throw new Error("preflight did not return JSON");
      }
      requireCondition(exitCode === 0 && isObject(report) && report.ready === true, "environment is not ready; run scripts/preflight.ts for the redacted report");
      return "all required tools and HyperFrames doctor checks passed";
    },
  };
}

async function runGate(gate: Gate): Promise<GateResult> {
  const startedAt = performance.now();
  try {
    const detail = await gate.run();
    return { id: gate.id, label: gate.label, status: "passed", durationMs: Math.round(performance.now() - startedAt), detail };
  } catch (error) {
    return {
      id: gate.id,
      label: gate.label,
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const gates = fixtureGates(options.fixtures);
  if (options.project) gates.push(...projectGates(options.project));
  if (options.includePreflight) gates.push(preflightGate());

  if (options.list) {
    for (const gate of gates) console.log(`${gate.id}\t${gate.label}`);
    return;
  }

  if (options.only.size) {
    const known = new Set(gates.map((gate) => gate.id));
    const unknown = [...options.only].filter((id) => !known.has(id));
    if (unknown.length) {
      console.error(`unknown gate IDs: ${unknown.join(", ")}`);
      process.exitCode = 2;
      return;
    }
  }

  const selected = options.only.size ? gates.filter((gate) => options.only.has(gate.id)) : gates;
  const results: GateResult[] = [];
  for (const gate of selected) results.push(await runGate(gate));
  const ready = results.every((result) => result.status === "passed");

  if (options.json) {
    console.log(JSON.stringify({ ready, generatedAt: new Date().toISOString(), results }, null, 2));
  } else {
    console.log(`Functional gates: ${ready ? "PASS" : "FAIL"}`);
    for (const result of results) {
      console.log(`[${result.status === "passed" ? "PASS" : "FAIL"}] ${result.id} (${result.durationMs}ms): ${result.detail}`);
    }
  }
  if (!ready) process.exitCode = 1;
}

await main();
