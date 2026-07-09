import type { CaptionCue, NormalizedAlignment, WordTiming } from "./types.ts";
import { assertFiniteNumber, isRecord, readString, roundTime } from "./utils.ts";

function readNumber(record: Record<string, unknown>, keys: string[], label: string): number {
  for (const key of keys) {
    if (record[key] !== undefined) return assertFiniteNumber(record[key], label);
  }
  throw new Error(`${label} is required.`);
}

function normalizeWordArray(value: unknown): WordTiming[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`alignment.words[${index}] must be an object.`);
    const rawText = item.text ?? item.word;
    return {
      text: readString(rawText, `alignment.words[${index}].text`, 1, 200),
      start: readNumber(item, ["start", "startSeconds", "start_time"], `alignment.words[${index}].start`),
      end: readNumber(item, ["end", "endSeconds", "end_time"], `alignment.words[${index}].end`),
    };
  });
}

function normalizeCharacterArrays(record: Record<string, unknown>): WordTiming[] | undefined {
  const characters = record.characters;
  const starts = record.character_start_times_seconds;
  const ends = record.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return undefined;
  if (characters.length === 0 || characters.length !== starts.length || characters.length !== ends.length) {
    throw new Error("ElevenLabs character alignment arrays must be non-empty and have equal lengths.");
  }

  const words: WordTiming[] = [];
  let text = "";
  let start = 0;
  let end = 0;

  const flush = () => {
    if (!text) return;
    words.push({ text, start, end });
    text = "";
  };

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (typeof character !== "string") {
      throw new Error(`alignment.characters[${index}] must be a string.`);
    }
    const characterStart = assertFiniteNumber(starts[index], `alignment.character_start_times_seconds[${index}]`);
    const characterEnd = assertFiniteNumber(ends[index], `alignment.character_end_times_seconds[${index}]`);
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (!text) start = characterStart;
    text += character;
    end = characterEnd;
  }
  flush();
  return words;
}

function alignmentRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("alignment must be an object.");
  if (isRecord(value.normalized_alignment)) return value.normalized_alignment;
  if (isRecord(value.alignment)) return value.alignment;
  return value;
}

function explicitDuration(value: unknown, record: Record<string, unknown>): number | undefined {
  const candidates: unknown[] = [];
  if (isRecord(value)) {
    candidates.push(value.duration, value.durationSeconds, value.audio_duration);
  }
  candidates.push(record.duration, record.durationSeconds, record.audio_duration);
  const candidate = candidates.find((item) => item !== undefined);
  return candidate === undefined ? undefined : assertFiniteNumber(candidate, "alignment.duration");
}

export function normalizeVoiceAlignment(value: unknown): NormalizedAlignment {
  const record = alignmentRecord(value);
  const words = normalizeWordArray(record.words) ?? normalizeCharacterArrays(record);
  if (!words || words.length === 0) {
    throw new Error("alignment must provide words or ElevenLabs character timings.");
  }

  let previousStart = -1;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.start < 0 || word.end <= word.start) {
      throw new Error(`alignment word ${index} has an invalid time range.`);
    }
    if (word.start < previousStart) {
      throw new Error(`alignment words must be ordered by start time (index ${index}).`);
    }
    previousStart = word.start;
    word.start = roundTime(word.start);
    word.end = roundTime(word.end);
  }

  const lastEnd = Math.max(...words.map((word) => word.end));
  const declaredDuration = explicitDuration(value, record);
  if (declaredDuration !== undefined && declaredDuration + 0.01 < lastEnd) {
    throw new Error(`alignment.duration (${declaredDuration}) ends before the final aligned word (${lastEnd}).`);
  }

  return {
    words,
    duration: roundTime(declaredDuration ?? lastEnd),
  };
}

function joinWords(words: WordTiming[]): string {
  return words
    .map((word) => word.text)
    .join(" ")
    .replace(/\s+([,.;:!?%)\]])/g, "$1")
    .replace(/([\u00bf\u00a1(\[])\s+/g, "$1");
}

export function buildCaptionCues(
  alignmentInput: unknown,
  options: { maxWords?: number; maxDuration?: number; maxGap?: number } = {},
): CaptionCue[] {
  const alignment = normalizeVoiceAlignment(alignmentInput);
  const maxWords = options.maxWords ?? 5;
  const maxDuration = options.maxDuration ?? 2.4;
  const maxGap = options.maxGap ?? 0.55;
  if (!Number.isInteger(maxWords) || maxWords < 1) throw new Error("maxWords must be a positive integer.");

  const groups: WordTiming[][] = [];
  let current: WordTiming[] = [];
  for (const word of alignment.words) {
    const previous = current.at(-1);
    const shouldBreak = Boolean(
      previous &&
        (current.length >= maxWords ||
          word.end - current[0].start > maxDuration ||
          word.start - previous.end > maxGap ||
          /[.!?]$/u.test(previous.text)),
    );
    if (shouldBreak) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((words, index) => {
    const nextStart = groups[index + 1]?.[0].start ?? alignment.duration;
    return {
      id: `caption-${String(index + 1).padStart(3, "0")}`,
      text: joinWords(words),
      start: words[0].start,
      end: roundTime(Math.min(alignment.duration, nextStart, words.at(-1)!.end + 0.08)),
    };
  });
}

export function transcriptForRange(alignment: NormalizedAlignment, start: number, end: number): string {
  const words = alignment.words.filter((word) => {
    const midpoint = word.start + (word.end - word.start) / 2;
    return midpoint >= start && midpoint < end;
  });
  return joinWords(words);
}
