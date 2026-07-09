import { Buffer } from "node:buffer";
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  type FetchLike,
  asTrimmedString,
  fetchJson,
  isRecord,
  requireCredential,
} from "./common";
import { ProviderError, providerValidationError } from "./errors";

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const MAX_TEXT_LENGTH = 20_000;

export interface ElevenLabsVoiceSettings {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
}

export interface SpeechWithTimestampsInput {
  text: string;
  voiceId?: string;
  modelId?: string;
  languageCode?: string;
  seed?: number;
  voiceSettings?: ElevenLabsVoiceSettings;
  captionMaxWords?: number;
  captionMaxChars?: number;
  captionMaxDurationSeconds?: number;
}

export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export interface CaptionTiming {
  text: string;
  start: number;
  end: number;
  wordStartIndex: number;
  wordEndIndex: number;
}

export interface SpeechWithTimestampsResult {
  audio: Uint8Array;
  mimeType: "audio/mpeg";
  text: string;
  durationSeconds: number;
  alignmentSource: "normalized" | "original";
  words: WordTiming[];
  captions: CaptionTiming[];
}

export interface ElevenLabsProviderOptions {
  apiKey: string;
  voiceId: string;
  fetch?: FetchLike;
  baseUrl?: string;
  modelId?: string;
  outputFormat?: string;
  timeoutMs?: number;
}

interface RawAlignment {
  characters: string[];
  starts: number[];
  ends: number[];
}

interface CaptionOptions {
  maxWords: number;
  maxChars: number;
  maxDurationSeconds: number;
}

export class ElevenLabsProvider {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly modelId: string;
  private readonly outputFormat: string;
  private readonly timeoutMs: number;

  constructor(options: ElevenLabsProviderOptions) {
    this.apiKey = requireCredential(options.apiKey, "elevenlabs", "ElevenLabs API key");
    this.voiceId = validateVoiceId(options.voiceId);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_ELEVENLABS_BASE_URL);
    this.modelId = validateModelId(options.modelId ?? DEFAULT_MODEL_ID);
    this.outputFormat = validateOutputFormat(options.outputFormat ?? DEFAULT_OUTPUT_FORMAT);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ProviderError("ElevenLabs timeout must be a positive number.", {
        provider: "elevenlabs",
        code: "CONFIGURATION",
        retryable: false,
      });
    }
  }

  async synthesizeSpeechWithTimestamps(
    input: SpeechWithTimestampsInput,
  ): Promise<SpeechWithTimestampsResult> {
    const text = validateText(input.text);
    const voiceId = input.voiceId ? validateVoiceId(input.voiceId) : this.voiceId;
    const modelId = input.modelId ? validateModelId(input.modelId) : this.modelId;
    const captionOptions = normalizeCaptionOptions(input);
    const body: Record<string, unknown> = {
      text,
      model_id: modelId,
    };

    const languageCode = asTrimmedString(input.languageCode);
    if (languageCode) {
      if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(languageCode)) {
        throw providerValidationError("elevenlabs", "ElevenLabs language code is invalid.");
      }
      body.language_code = languageCode;
    }
    if (input.seed !== undefined) {
      if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 4_294_967_295) {
        throw providerValidationError("elevenlabs", "ElevenLabs seed is invalid.");
      }
      body.seed = input.seed;
    }
    if (input.voiceSettings) body.voice_settings = normalizeVoiceSettings(input.voiceSettings);

    const payload = await fetchJson({
      provider: "elevenlabs",
      fetch: this.fetch,
      url: `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${encodeURIComponent(this.outputFormat)}`,
      timeoutMs: this.timeoutMs,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "xi-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      },
    });

    return normalizeElevenLabsResponse(payload, captionOptions);
  }

  synthesize(input: SpeechWithTimestampsInput): Promise<SpeechWithTimestampsResult> {
    return this.synthesizeSpeechWithTimestamps(input);
  }
}

export function createElevenLabsProvider(
  options: ElevenLabsProviderOptions,
): ElevenLabsProvider {
  return new ElevenLabsProvider(options);
}

export function normalizeElevenLabsResponse(
  payload: unknown,
  captionOptions: Partial<CaptionOptions> = {},
): SpeechWithTimestampsResult {
  if (!isRecord(payload)) throw badElevenLabsResponse("ElevenLabs response must be an object.");
  const audioBase64 = asTrimmedString(payload.audio_base64);
  if (!audioBase64) throw badElevenLabsResponse("ElevenLabs response is missing audio.");
  const audio = decodeMp3(audioBase64);

  const normalized = parseAlignment(payload.normalized_alignment);
  const original = parseAlignment(payload.alignment);
  const alignment = normalized ?? original;
  if (!alignment) {
    throw badElevenLabsResponse("ElevenLabs response has no valid alignment.");
  }

  const words = alignmentToWords(alignment);
  if (words.length === 0) {
    throw badElevenLabsResponse("ElevenLabs alignment contains no words.");
  }
  const options = normalizeCaptionOptions(captionOptions);
  const captions = wordsToCaptions(words, options);

  return {
    audio,
    mimeType: "audio/mpeg",
    text: alignment.characters.join("").trim().replace(/\s+/g, " "),
    durationSeconds: words.at(-1)!.end,
    alignmentSource: normalized ? "normalized" : "original",
    words,
    captions,
  };
}

export function alignmentToWords(alignment: RawAlignment): WordTiming[] {
  const words: WordTiming[] = [];
  let current = "";
  let start = 0;
  let end = 0;

  const flush = () => {
    if (!current) return;
    if (!/[\p{L}\p{N}]/u.test(current) && words.length > 0) {
      const previous = words.at(-1)!;
      previous.text += current;
      previous.end = end;
    } else {
      words.push({ text: current, start, end });
    }
    current = "";
  };

  alignment.characters.forEach((chunk, index) => {
    for (const character of [...chunk]) {
      if (/\s/u.test(character)) {
        flush();
        continue;
      }
      if (!current) start = alignment.starts[index]!;
      current += character;
      end = alignment.ends[index]!;
    }
  });
  flush();
  return words;
}

export function wordsToCaptions(
  words: WordTiming[],
  options: CaptionOptions,
): CaptionTiming[] {
  const captions: CaptionTiming[] = [];
  let startIndex = 0;
  let current: WordTiming[] = [];

  const flush = () => {
    if (current.length === 0) return;
    captions.push({
      text: current.map((word) => word.text).join(" "),
      start: current[0]!.start,
      end: current.at(-1)!.end,
      wordStartIndex: startIndex,
      wordEndIndex: startIndex + current.length,
    });
    startIndex += current.length;
    current = [];
  };

  for (const word of words) {
    const candidate = [...current, word];
    const candidateText = candidate.map((item) => item.text).join(" ");
    const candidateDuration = word.end - candidate[0]!.start;
    if (current.length > 0 && (
      candidate.length > options.maxWords ||
      candidateText.length > options.maxChars ||
      candidateDuration > options.maxDurationSeconds
    )) {
      flush();
    }

    current.push(word);
    if (/[.!?…:]$/u.test(word.text) && current.length >= 2) flush();
  }
  flush();
  return captions;
}

function parseAlignment(value: unknown): RawAlignment | undefined {
  if (!isRecord(value)) return undefined;
  const characters = value.characters;
  const starts = value.character_start_times_seconds;
  const ends = value.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends) ||
    characters.length === 0 || characters.length !== starts.length || starts.length !== ends.length) {
    return undefined;
  }

  if (!characters.every((character) => typeof character === "string" && character.length > 0) ||
    !starts.every((time) => typeof time === "number" && Number.isFinite(time)) ||
    !ends.every((time) => typeof time === "number" && Number.isFinite(time))) {
    return undefined;
  }

  let previousStart = -1;
  let previousEnd = -1;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] as number;
    const end = ends[index] as number;
    if (start < 0 || end < start || start < previousStart || end < previousEnd) return undefined;
    previousStart = start;
    previousEnd = end;
  }

  return {
    characters: characters as string[],
    starts: starts as number[],
    ends: ends as number[],
  };
}

function decodeMp3(value: string): Uint8Array {
  const compact = value.replace(/\s/g, "");
  if (!compact || compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw badElevenLabsResponse("ElevenLabs audio is not valid base64.");
  }

  const audio = new Uint8Array(Buffer.from(compact, "base64"));
  const hasId3 = audio.length >= 3 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33;
  const hasMp3Frame = audio.length >= 2 && audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0;
  if (!hasId3 && !hasMp3Frame) {
    throw badElevenLabsResponse("ElevenLabs audio is not an MP3 payload.");
  }
  return audio;
}

function normalizeCaptionOptions(
  value: Partial<CaptionOptions> | SpeechWithTimestampsInput,
): CaptionOptions {
  const input = value as SpeechWithTimestampsInput;
  const partial = value as Partial<CaptionOptions>;
  const maxWords = input.captionMaxWords ?? partial.maxWords ?? 6;
  const maxChars = input.captionMaxChars ?? partial.maxChars ?? 42;
  const maxDurationSeconds = input.captionMaxDurationSeconds ?? partial.maxDurationSeconds ?? 3;

  if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > 12) {
    throw providerValidationError("elevenlabs", "Caption max words is invalid.");
  }
  if (!Number.isInteger(maxChars) || maxChars < 8 || maxChars > 120) {
    throw providerValidationError("elevenlabs", "Caption max characters is invalid.");
  }
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds < 0.25 || maxDurationSeconds > 10) {
    throw providerValidationError("elevenlabs", "Caption max duration is invalid.");
  }

  return { maxWords, maxChars, maxDurationSeconds };
}

function normalizeVoiceSettings(settings: ElevenLabsVoiceSettings): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  addUnitInterval(normalized, "stability", settings.stability);
  addUnitInterval(normalized, "similarity_boost", settings.similarityBoost);
  addUnitInterval(normalized, "style", settings.style);

  if (settings.useSpeakerBoost !== undefined) {
    if (typeof settings.useSpeakerBoost !== "boolean") {
      throw providerValidationError("elevenlabs", "Voice speaker boost is invalid.");
    }
    normalized.use_speaker_boost = settings.useSpeakerBoost;
  }
  if (settings.speed !== undefined) {
    if (!Number.isFinite(settings.speed) || settings.speed < 0.7 || settings.speed > 1.2) {
      throw providerValidationError("elevenlabs", "Voice speed is invalid.");
    }
    normalized.speed = settings.speed;
  }
  return normalized;
}

function addUnitInterval(
  target: Record<string, unknown>,
  key: string,
  value: number | undefined,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw providerValidationError("elevenlabs", `Voice ${key} is invalid.`);
  }
  target[key] = value;
}

function validateText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw providerValidationError("elevenlabs", "Speech text is required.");
  }
  const text = value.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    throw providerValidationError("elevenlabs", "Speech text is too long.");
  }
  return text;
}

function validateVoiceId(value: unknown): string {
  const voiceId = asTrimmedString(value);
  if (!voiceId || voiceId.length > 200) {
    throw new ProviderError("ElevenLabs voice ID is invalid.", {
      provider: "elevenlabs",
      code: "CONFIGURATION",
      retryable: false,
    });
  }
  return voiceId;
}

function validateModelId(value: unknown): string {
  const modelId = asTrimmedString(value);
  if (!modelId || modelId.length > 200) {
    throw new ProviderError("ElevenLabs model ID is invalid.", {
      provider: "elevenlabs",
      code: "CONFIGURATION",
      retryable: false,
    });
  }
  return modelId;
}

function validateOutputFormat(value: unknown): string {
  const outputFormat = asTrimmedString(value);
  if (!outputFormat || !/^mp3_\d+_\d+$/.test(outputFormat)) {
    throw new ProviderError("ElevenLabs output format must be MP3.", {
      provider: "elevenlabs",
      code: "CONFIGURATION",
      retryable: false,
    });
  }
  return outputFormat;
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
      throw new Error("invalid");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new ProviderError("ElevenLabs base URL is invalid.", {
      provider: "elevenlabs",
      code: "CONFIGURATION",
      retryable: false,
    });
  }
}

function badElevenLabsResponse(message: string): ProviderError {
  return new ProviderError(message, {
    provider: "elevenlabs",
    code: "BAD_RESPONSE",
    retryable: false,
  });
}
