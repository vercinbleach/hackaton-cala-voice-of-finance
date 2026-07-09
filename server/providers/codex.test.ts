import { describe, expect, test } from "bun:test";
import calaFixture from "./fixtures/cala-response.json";
import { normalizeCalaResponse } from "./cala";
import {
  CodexProvider,
  countScriptWords,
  extractFinalAgentValue,
  parseCodexJsonl,
  type SpawnLike,
  validateScriptOutput,
} from "./codex";
import { ProviderError } from "./errors";

const research = normalizeCalaResponse(calaFixture, "Daily US movers");
const successJsonl = await Bun.file(
  new URL("./fixtures/codex-success.jsonl", import.meta.url),
).text();

describe("CodexProvider", () => {
  test("parses JSONL and validates a grounded 65-85 word script", () => {
    const events = parseCodexJsonl(successJsonl);
    const value = extractFinalAgentValue(events);
    const script = validateScriptOutput(value, research);

    expect(events.map((event) => event.type)).toEqual([
      "thread.started",
      "turn.started",
      "item.completed",
      "turn.completed",
    ]);
    expect(countScriptWords(script.narration)).toBe(71);
    expect(script.movers.map((mover) => mover.ticker)).toEqual([
      "NVDA",
      "AAPL",
      "TSLA",
      "AMD",
    ]);
  });

  test("spawns codex exec noninteractively with schema and stdin", async () => {
    let capturedCommand: readonly string[] = [];
    let capturedStdin = "";
    const spawn: SpawnLike = (command) => {
      capturedCommand = command;
      return {
        stdin: {
          write(data) {
            capturedStdin += typeof data === "string" ? data : new TextDecoder().decode(data);
          },
          end() {},
        },
        stdout: stream(successJsonl),
        stderr: stream(""),
        exited: Promise.resolve(0),
      };
    };
    const provider = new CodexProvider({ spawn });

    const script = await provider.generateScript({
      brief: "Un reel rápido sobre los movimientos del día.",
      research,
    });

    expect(capturedCommand.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(capturedCommand).toContain("--json");
    expect(capturedCommand).toContain("--ephemeral");
    expect(capturedCommand).toContain("--output-schema");
    expect(capturedCommand.find((part) => part.endsWith("script-output.schema.json"))).toBeTruthy();
    expect(capturedCommand.at(-1)).toBe("-");
    expect(capturedStdin).toContain("65 to 85 words");
    expect(capturedStdin).toContain("ctx-nvda");
    expect(script.title).toBe("Cuatro movimientos que marcaron Wall Street");
  });

  test("rejects source IDs that do not ground the matching mover", () => {
    const value = structuredClone(extractFinalAgentValue(parseCodexJsonl(successJsonl))) as {
      movers: Array<{ sourceIds: string[] }>;
    };
    value.movers[0]!.sourceIds = ["ctx-apple"];

    expect(() => validateScriptOutput(value, research)).toThrow(
      "source not grounding that mover",
    );
  });

  test("rejects narration outside the 65-85 word range", () => {
    const value = structuredClone(extractFinalAgentValue(parseCodexJsonl(successJsonl))) as {
      narration: string;
      closing: string;
    };
    value.narration = `${Array(48).fill("mercado").join(" ")} ${value.closing}`;

    expect(() => validateScriptOutput(value, research)).toThrow(
      "between 65 and 85 words",
    );
  });

  test("classifies CLI rate limits without returning stderr secrets", async () => {
    const secret = "codex-secret-never-log";
    const provider = new CodexProvider({
      spawn: () => ({
        stdin: { write() {}, end() {} },
        stdout: stream(""),
        stderr: stream(`429 Too Many Requests ${secret}`),
        exited: Promise.resolve(1),
      }),
    });

    try {
      await provider.generateScript({ brief: "movers", research });
      throw new Error("Expected Codex to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe("RATE_LIMITED");
      expect((error as ProviderError).retryable).toBe(true);
      expect(String(error)).not.toContain(secret);
    }
  });

  test("kills a Codex process on timeout", async () => {
    let killed = false;
    const provider = new CodexProvider({
      timeoutMs: 5,
      spawn: () => ({
        stdin: { write() {}, end() {} },
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        exited: new Promise<number>(() => undefined),
        kill: () => { killed = true; },
      }),
    });

    await expect(provider.generateScript({ brief: "movers", research })).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
    expect(killed).toBe(true);
  });

  test("rejects malformed JSONL", () => {
    expect(() => parseCodexJsonl('{"type":"turn.started"}\nnot-json')).toThrow(
      "malformed JSONL",
    );
  });
});

function stream(value: string): ReadableStream<Uint8Array> {
  return new Response(value).body!;
}
