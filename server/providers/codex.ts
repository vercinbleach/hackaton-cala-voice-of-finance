import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { CalaResearch } from "./cala";
import { asFiniteNumber, asTrimmedString, isRecord } from "./common";
import { ProviderError, isProviderError, providerValidationError } from "./errors";

const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 512 * 1024;
const DEFAULT_SCHEMA_PATH = fileURLToPath(
  new URL("../../shared/script-output.schema.json", import.meta.url),
);

export interface ScriptMover {
  ticker: string;
  company: string;
  direction: "up" | "down";
  changePct: number;
  catalyst: string;
  sourceIds: string[];
}

export interface ScriptOutput {
  title: string;
  language: "es";
  narration: string;
  movers: ScriptMover[];
  closing: string;
}

export interface GenerateScriptInput {
  brief: unknown;
  research: CalaResearch;
  instructions?: string;
  cwd?: string;
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface ProcessStdin {
  write(data: string | Uint8Array): unknown;
  end(): unknown;
}

export type ProcessOutput =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>
  | null
  | undefined;

export interface SpawnedProcess {
  stdin?: ProcessStdin | WritableStream<Uint8Array> | null;
  stdout?: ProcessOutput;
  stderr?: ProcessOutput;
  exited: Promise<number>;
  kill?: (signal?: number | NodeJS.Signals) => unknown;
}

export type SpawnLike = (
  command: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess;

export interface CodexProviderOptions {
  spawn?: SpawnLike;
  command?: string | string[];
  cwd?: string;
  schemaPath?: string;
  model?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface CodexJsonEvent extends Record<string, unknown> {
  type: string;
}

interface GroundingMover {
  ticker: string;
  direction: "up" | "down";
  changePct: number;
  sourceIds: Set<string>;
}

interface GroundingIndex {
  sourceIds: Set<string>;
  movers: Map<string, GroundingMover>;
}

export class CodexProvider {
  private readonly spawn: SpawnLike;
  private readonly command: string[];
  private readonly cwd: string;
  private readonly schemaPath: string;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly env?: Record<string, string | undefined>;

  constructor(options: CodexProviderOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.command = normalizeCommand(options.command ?? "codex");
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.schemaPath = resolve(options.schemaPath ?? DEFAULT_SCHEMA_PATH);
    this.model = asTrimmedString(options.model);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
    this.env = options.env;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ProviderError("Codex timeout must be a positive number.", {
        provider: "codex",
        code: "CONFIGURATION",
        retryable: false,
      });
    }
  }

  async generateScript(input: GenerateScriptInput): Promise<ScriptOutput> {
    const grounding = createGroundingIndex(input.research);
    const prompt = buildScriptPrompt(input, grounding);
    const cwd = resolve(input.cwd ?? this.cwd);
    const command = [
      ...this.command,
      "exec",
      "--json",
      "--color",
      "never",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--output-schema",
      this.schemaPath,
      "-C",
      cwd,
    ];
    if (this.model) command.push("--model", this.model);
    command.push("-");

    let processHandle: SpawnedProcess;
    try {
      processHandle = this.spawn(command, { cwd, env: this.env });
    } catch {
      throw new ProviderError("Codex CLI could not be started.", {
        provider: "codex",
        code: "PROCESS_FAILED",
        retryable: false,
      });
    }

    try {
      const { stdout, stderr, exitCode } = await runProcess(
        processHandle,
        prompt,
        this.timeoutMs,
      );

      if (exitCode !== 0) throw classifyProcessFailure(`${stderr}\n${stdout}`);

      const events = parseCodexJsonl(stdout);
      const failedEvent = events.find((event) =>
        event.type === "error" || event.type === "turn.failed" || event.type === "response.failed"
      );
      if (failedEvent) throw classifyProcessFailure(JSON.stringify(failedEvent));

      const value = extractFinalAgentValue(events);
      return validateScriptOutput(value, input.research);
    } catch (error) {
      if (isProviderError(error)) throw error;
      processHandle.kill?.();
      throw new ProviderError("Codex CLI execution failed.", {
        provider: "codex",
        code: "PROCESS_FAILED",
        retryable: false,
      });
    }
  }
}

export function createCodexProvider(options: CodexProviderOptions = {}): CodexProvider {
  return new CodexProvider(options);
}

export function parseCodexJsonl(value: string): CodexJsonEvent[] {
  const lines = value.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    throw new ProviderError("Codex CLI returned no JSONL events.", {
      provider: "codex",
      code: "BAD_RESPONSE",
      retryable: false,
    });
  }
  if (lines.length > 10_000) {
    throw new ProviderError("Codex CLI returned too many JSONL events.", {
      provider: "codex",
      code: "BAD_RESPONSE",
      retryable: false,
    });
  }

  return lines.map((line) => {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      throw new ProviderError("Codex CLI returned malformed JSONL.", {
        provider: "codex",
        code: "BAD_RESPONSE",
        retryable: false,
      });
    }

    if (!isRecord(event) || !asTrimmedString(event.type)) {
      throw new ProviderError("Codex CLI returned an invalid JSONL event.", {
        provider: "codex",
        code: "BAD_RESPONSE",
        retryable: false,
      });
    }
    return event as CodexJsonEvent;
  });
}

export function extractFinalAgentValue(events: CodexJsonEvent[]): unknown {
  const messages = events.flatMap(extractAgentMessages);
  const message = messages.at(-1);
  if (!message) {
    throw new ProviderError("Codex CLI returned no final agent message.", {
      provider: "codex",
      code: "BAD_RESPONSE",
      retryable: false,
    });
  }

  const trimmed = message.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  try {
    return JSON.parse(fenced ?? trimmed) as unknown;
  } catch {
    throw new ProviderError("Codex CLI final message was not valid JSON.", {
      provider: "codex",
      code: "BAD_RESPONSE",
      retryable: false,
    });
  }
}

export function validateScriptOutput(value: unknown, research: CalaResearch): ScriptOutput {
  if (!isRecord(value)) throw invalidScript("Script output must be an object.");
  assertExactKeys(value, ["title", "language", "narration", "movers", "closing"]);

  const title = boundedText(value.title, "title", 1, 90);
  if (value.language !== "es") throw invalidScript("Script language must be Spanish.");
  const narration = boundedText(value.narration, "narration", 120, 900);
  const closing = boundedText(value.closing, "closing", 1, 180);

  if (!Array.isArray(value.movers) || value.movers.length < 2 || value.movers.length > 4) {
    throw invalidScript("Script must contain between two and four movers.");
  }

  const movers = value.movers.map(validateScriptMover);
  const wordCount = countScriptWords(narration);
  if (wordCount < 65 || wordCount > 85) {
    throw invalidScript("Script narration must contain between 65 and 85 words.");
  }
  if (!normalizeText(narration).includes(normalizeText(closing))) {
    throw invalidScript("Script closing must appear in the narration.");
  }

  const grounding = createGroundingIndex(research);
  const seenTickers = new Set<string>();
  for (const mover of movers) {
    if (seenTickers.has(mover.ticker)) throw invalidScript("Script contains duplicate tickers.");
    seenTickers.add(mover.ticker);

    const grounded = grounding.movers.get(mover.ticker);
    if (!grounded) throw invalidScript("Script contains a ticker absent from research.");
    if (grounded.direction !== mover.direction) {
      throw invalidScript("Script mover direction does not match research.");
    }
    if (Math.abs(grounded.changePct - mover.changePct) > 0.11) {
      throw invalidScript("Script mover percentage does not match research.");
    }
    if ((mover.direction === "up" && mover.changePct <= 0) ||
      (mover.direction === "down" && mover.changePct >= 0)) {
      throw invalidScript("Script mover percentage has an invalid sign.");
    }

    for (const sourceId of mover.sourceIds) {
      if (!grounding.sourceIds.has(sourceId) || !grounded.sourceIds.has(sourceId)) {
        throw invalidScript("Script references a source not grounding that mover.");
      }
    }

    const normalizedNarration = normalizeText(narration);
    if (!normalizedNarration.includes(normalizeText(mover.ticker)) &&
      !normalizedNarration.includes(normalizeText(mover.company))) {
      throw invalidScript("Every script mover must appear in the narration.");
    }
  }

  return { title, language: "es", narration, movers, closing };
}

export function countScriptWords(value: string): number {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("es", { granularity: "word" });
    return [...segmenter.segment(value)].filter((segment) => segment.isWordLike).length;
  }
  return value.match(/[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

async function runProcess(
  processHandle: SpawnedProcess,
  prompt: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execution = (async () => {
    await writePrompt(processHandle.stdin, prompt);
    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessOutput(processHandle.stdout, MAX_PROCESS_OUTPUT_BYTES),
      readProcessOutput(processHandle.stderr, 128 * 1024),
      processHandle.exited,
    ]);
    return { stdout, stderr, exitCode };
  })();

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      processHandle.kill?.();
      reject(new ProviderError("Codex CLI execution timed out.", {
        provider: "codex",
        code: "TIMEOUT",
        retryable: true,
      }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writePrompt(
  target: ProcessStdin | WritableStream<Uint8Array> | null | undefined,
  prompt: string,
): Promise<void> {
  if (!target) {
    throw new ProviderError("Codex CLI stdin is unavailable.", {
      provider: "codex",
      code: "PROCESS_FAILED",
      retryable: false,
    });
  }

  if (isWritableStream(target)) {
    const writer = target.getWriter();
    try {
      await writer.write(new TextEncoder().encode(prompt));
      await writer.close();
    } finally {
      writer.releaseLock();
    }
    return;
  }

  const stdin = target as ProcessStdin;
  await stdin.write(prompt);
  await stdin.end();
}

async function readProcessOutput(stream: ProcessOutput, limit: number): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";

  const append = (chunk: Uint8Array | string) => {
    const byteLength = typeof chunk === "string"
      ? new TextEncoder().encode(chunk).byteLength
      : chunk.byteLength;
    bytes += byteLength;
    if (bytes > limit) {
      throw new ProviderError("Codex CLI returned too much output.", {
        provider: "codex",
        code: "BAD_RESPONSE",
        retryable: false,
      });
    }
    output += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  };

  if (isReadableStream(stream)) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) append(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of stream as AsyncIterable<Uint8Array | string>) append(chunk);
  }

  return output + decoder.decode();
}

function extractAgentMessages(event: CodexJsonEvent): string[] {
  if (event.type === "item.completed" && isRecord(event.item)) {
    if (event.item.type === "agent_message") return textFromMessage(event.item);
  }
  if (event.type === "agent_message") return textFromMessage(event);
  if (event.type === "message" && (!event.role || event.role === "assistant")) {
    return textFromMessage(event);
  }
  if (event.type === "response.completed" && isRecord(event.response)) {
    return textFromResponse(event.response);
  }
  return [];
}

function textFromResponse(response: Record<string, unknown>): string[] {
  const direct = firstMessageText([response.output_text, response.text]);
  if (direct) return [direct];
  if (!Array.isArray(response.output)) return [];
  return response.output.filter(isRecord).flatMap(textFromMessage);
}

function textFromMessage(message: Record<string, unknown>): string[] {
  const direct = firstMessageText([message.text, message.output_text]);
  if (direct) return [direct];
  if (typeof message.content === "string") return [message.content];
  if (!Array.isArray(message.content)) return [];

  return message.content.filter(isRecord).flatMap((part) => {
    if (part.type && !new Set(["text", "output_text"]).has(String(part.type))) return [];
    const text = firstMessageText([part.text, part.output_text]);
    return text ? [text] : [];
  });
}

function firstMessageText(values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asTrimmedString(value);
    if (text) return text;
  }
  return undefined;
}

function validateScriptMover(value: unknown): ScriptMover {
  if (!isRecord(value)) throw invalidScript("Script mover must be an object.");
  assertExactKeys(value, [
    "ticker",
    "company",
    "direction",
    "changePct",
    "catalyst",
    "sourceIds",
  ]);

  const ticker = boundedText(value.ticker, "ticker", 1, 10).toUpperCase();
  const company = boundedText(value.company, "company", 1, 80);
  const catalyst = boundedText(value.catalyst, "catalyst", 1, 180);
  if (value.direction !== "up" && value.direction !== "down") {
    throw invalidScript("Script mover direction is invalid.");
  }

  const changePct = asFiniteNumber(value.changePct);
  if (changePct === undefined) throw invalidScript("Script mover percentage is invalid.");
  if (!Array.isArray(value.sourceIds) || value.sourceIds.length === 0) {
    throw invalidScript("Script mover must reference at least one source.");
  }
  const sourceIds = value.sourceIds.map((sourceId) =>
    boundedText(sourceId, "sourceId", 1, 128)
  );
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw invalidScript("Script mover contains duplicate source references.");
  }

  return { ticker, company, direction: value.direction, changePct, catalyst, sourceIds };
}

function createGroundingIndex(research: CalaResearch): GroundingIndex {
  if (!isRecord(research) || !Array.isArray(research.sources) ||
    !Array.isArray(research.gainers) || !Array.isArray(research.decliners)) {
    throw providerValidationError("codex", "Script research input is invalid.");
  }

  const sourceIds = new Set<string>();
  for (const source of research.sources) {
    if (!isRecord(source)) continue;
    const id = asTrimmedString(source.id);
    if (id) sourceIds.add(id);
  }

  const movers = new Map<string, GroundingMover>();
  for (const value of [...research.gainers, ...research.decliners]) {
    if (!isRecord(value)) continue;
    const ticker = asTrimmedString(value.ticker)?.toUpperCase();
    const changePct = asFiniteNumber(value.changePct);
    const direction = value.direction;
    if (!ticker || changePct === undefined || (direction !== "up" && direction !== "down")) continue;
    const moverSourceIds = new Set(
      Array.isArray(value.sourceIds)
        ? value.sourceIds.filter((id): id is string => typeof id === "string" && sourceIds.has(id))
        : [],
    );
    if (moverSourceIds.size === 0) continue;
    movers.set(ticker, { ticker, direction, changePct, sourceIds: moverSourceIds });
  }

  if (sourceIds.size === 0 || movers.size === 0) {
    throw providerValidationError("codex", "Script research has no grounded movers.");
  }
  return { sourceIds, movers };
}

function buildScriptPrompt(input: GenerateScriptInput, grounding: GroundingIndex): string {
  const instructions = asTrimmedString(input.instructions);
  if (instructions && instructions.length > 4_000) {
    throw providerValidationError("codex", "Script instructions are too long.");
  }

  const research = {
    sources: input.research.sources,
    movers: [...input.research.gainers, ...input.research.decliners],
  };
  const brief = serializePromptValue(input.brief, "brief");
  const researchJson = serializePromptValue(research, "research");
  const prompt = [
    "Generate the final Spanish finance-reel script as JSON matching the supplied output schema.",
    "The narration is the complete spoken script, including the exact closing, and must contain 65 to 85 words.",
    "Use only movers and facts present in RESEARCH. Preserve ticker, direction, percentage and sourceIds exactly; do not invent or substitute citations.",
    "Mention every selected mover in the narration. Keep the tone factual and avoid investment advice.",
    instructions ? `ADDITIONAL INSTRUCTIONS:\n${instructions}` : undefined,
    `BRIEF:\n${brief}`,
    `RESEARCH:\n${researchJson}`,
    `AVAILABLE GROUNDED TICKERS: ${[...grounding.movers.keys()].join(", ")}`,
  ].filter((part): part is string => Boolean(part)).join("\n\n");

  if (new TextEncoder().encode(prompt).byteLength > MAX_PROMPT_BYTES) {
    throw providerValidationError("codex", "Script prompt is too large.");
  }
  return prompt;
}

function serializePromptValue(value: unknown, label: string): string {
  if (label === "brief" && typeof value === "string" && !value.trim()) {
    throw providerValidationError("codex", "Script brief is required.");
  }
  if (value === undefined) throw providerValidationError("codex", `Script ${label} is required.`);

  try {
    const serialized = typeof value === "string" ? value.trim() : JSON.stringify(value);
    if (!serialized) throw new Error("empty");
    return serialized;
  } catch {
    throw providerValidationError("codex", `Script ${label} is not serializable.`);
  }
}

function normalizeCommand(value: string | string[]): string[] {
  const command = (Array.isArray(value) ? value : [value])
    .map((part) => part.trim())
    .filter(Boolean);
  if (command.length === 0) {
    throw new ProviderError("Codex command is required.", {
      provider: "codex",
      code: "CONFIGURATION",
      retryable: false,
    });
  }
  return command;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  const text = asTrimmedString(value);
  if (!text || text.length < min || text.length > max) {
    throw invalidScript(`Script ${field} has an invalid length.`);
  }
  return text;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw invalidScript("Script output contains missing or unexpected fields.");
  }
}

function invalidScript(message: string): ProviderError {
  return providerValidationError("codex", message);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

function classifyProcessFailure(diagnostic: string): ProviderError {
  const safeClassificationInput = diagnostic.slice(0, 64 * 1024).toLowerCase();
  if (/\b429\b|rate.?limit|too many requests/.test(safeClassificationInput)) {
    return new ProviderError("Codex CLI rate limit exceeded.", {
      provider: "codex",
      code: "RATE_LIMITED",
      retryable: true,
    });
  }
  if (/\b(401|403)\b|unauthori[sz]ed|authentication failed/.test(safeClassificationInput)) {
    return new ProviderError("Codex CLI authentication failed.", {
      provider: "codex",
      code: "AUTHENTICATION",
      retryable: false,
    });
  }
  return new ProviderError("Codex CLI process failed.", {
    provider: "codex",
    code: "PROCESS_FAILED",
    retryable: /\b(408|425|5\d\d)\b|timed? ?out|temporar/.test(safeClassificationInput),
  });
}

function isWritableStream(
  value: ProcessStdin | WritableStream<Uint8Array>,
): value is WritableStream<Uint8Array> {
  return typeof (value as WritableStream<Uint8Array>).getWriter === "function";
}

function isReadableStream(value: ProcessOutput): value is ReadableStream<Uint8Array> {
  return Boolean(value) && typeof (value as ReadableStream<Uint8Array>).getReader === "function";
}

function defaultSpawn(command: readonly string[], options: SpawnOptions): SpawnedProcess {
  return Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as SpawnedProcess;
}
