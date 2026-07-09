import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/elevenlabs-response.json";
import {
  ElevenLabsProvider,
  normalizeElevenLabsResponse,
} from "./elevenlabs";
import { ProviderError } from "./errors";

describe("ElevenLabsProvider", () => {
  test("decodes MP3 and derives normalized word and caption timings", () => {
    const result = normalizeElevenLabsResponse(fixture);

    expect(new TextDecoder().decode(result.audio.slice(0, 3))).toBe("ID3");
    expect(result.alignmentSource).toBe("normalized");
    expect(result.words.map((word) => word.text)).toEqual(["Hola", "mundo.", "Baja", "AMD."]);
    expect(result.captions.map((caption) => caption.text)).toEqual([
      "Hola mundo.",
      "Baja AMD.",
    ]);
    expect(result.captions[1]).toMatchObject({
      start: 1.2,
      end: 2.1,
      wordStartIndex: 2,
      wordEndIndex: 4,
    });
  });

  test("calls speech-with-timestamps using injected fetch", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const provider = new ElevenLabsProvider({
      apiKey: "eleven-secret",
      voiceId: "voice/test",
      fetch: async (input, init) => {
        requestUrl = input.toString();
        requestInit = init;
        return Response.json(fixture);
      },
    });

    const result = await provider.synthesizeSpeechWithTimestamps({
      text: "Hola mundo. Baja AMD.",
      voiceSettings: { stability: 0.5, similarityBoost: 0.8 },
    });
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;

    expect(requestUrl).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2Ftest/with-timestamps?output_format=mp3_44100_128",
    );
    expect(new Headers(requestInit?.headers).get("xi-api-key")).toBe("eleven-secret");
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.8 });
    expect(result.durationSeconds).toBe(2.1);
  });

  test("handles 429 without exposing API response secrets", async () => {
    const secret = "eleven-never-log";
    const provider = new ElevenLabsProvider({
      apiKey: secret,
      voiceId: "voice-id",
      fetch: async () => new Response(`rate limit ${secret}`, {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
    });

    try {
      await provider.synthesize({ text: "Hola" });
      throw new Error("Expected ElevenLabs to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe("RATE_LIMITED");
      expect((error as ProviderError).retryable).toBe(true);
      expect((error as ProviderError).retryAfterMs).toBe(2_000);
      expect(String(error)).not.toContain(secret);
    }
  });

  test("rejects malformed alignment", () => {
    expect(() => normalizeElevenLabsResponse({
      ...fixture,
      normalized_alignment: {
        characters: ["H", "i"],
        character_start_times_seconds: [0],
        character_end_times_seconds: [0.1, 0.2],
      },
    })).toThrow("no valid alignment");
  });

  test("times out a request that never settles", async () => {
    const provider = new ElevenLabsProvider({
      apiKey: "test-key",
      voiceId: "voice-id",
      timeoutMs: 5,
      fetch: async () => new Promise<Response>(() => undefined),
    });

    await expect(provider.synthesize({ text: "Hola" })).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
  });
});
