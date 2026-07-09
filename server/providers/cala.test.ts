import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/cala-response.json";
import { CalaProvider, normalizeCalaResponse } from "./cala";
import { ProviderError } from "./errors";

describe("CalaProvider", () => {
  test("normalizes, validates and deduplicates sourced movers", () => {
    const result = normalizeCalaResponse(fixture, "Daily US movers");

    expect(result.gainers.map((mover) => mover.ticker)).toEqual(["NVDA", "AAPL"]);
    expect(result.decliners.map((mover) => mover.ticker)).toEqual(["TSLA", "AMD"]);
    expect(result.decliners[1]?.changePct).toBe(-4.8);
    expect(result.sources).toHaveLength(4);
    expect(result.sources.filter((source) => source.url.includes("nvidia-outlook"))).toHaveLength(1);
    expect(result.gainers[0]?.sourceIds).toEqual(["ctx-nvda"]);
    expect(result.decliners[1]?.sourceIds).toEqual(["ctx-cloud"]);
    expect(result.sources.every((source) => /^https?:/.test(source.url))).toBe(true);
  });

  test("uses the documented knowledge query endpoint with injected fetch", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const provider = new CalaProvider({
      apiKey: "secret-cala-key",
      fetch: async (input, init) => {
        requestUrl = input.toString();
        requestInit = init;
        return Response.json(fixture);
      },
    });

    const result = await provider.queryMarketMovers({ query: "Top US movers today" });
    const body = JSON.parse(String(requestInit?.body)) as { input: string };

    expect(requestUrl).toBe("https://api.cala.ai/v1/knowledge/query");
    expect(new Headers(requestInit?.headers).get("X-API-KEY")).toBe("secret-cala-key");
    expect(body.input).toContain("Top US movers today");
    expect(body.input).toContain("two gainers and two decliners");
    expect(result.gainers).toHaveLength(2);
    expect(result.decliners).toHaveLength(2);
  });

  test("marks 429 errors retryable without exposing credentials", async () => {
    const secret = "cala-never-log-this";
    const provider = new CalaProvider({
      apiKey: secret,
      fetch: async () => new Response("rate limit contains cala-never-log-this", {
        status: 429,
        headers: { "Retry-After": "3" },
      }),
    });

    try {
      await provider.queryMarketMovers({ query: "movers" });
      throw new Error("Expected the request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe("RATE_LIMITED");
      expect((error as ProviderError).retryable).toBe(true);
      expect((error as ProviderError).retryAfterMs).toBe(3_000);
      expect(String(error)).not.toContain(secret);
    }
  });

  test("times out an injected fetch that never settles", async () => {
    const provider = new CalaProvider({
      apiKey: "test-key",
      timeoutMs: 5,
      fetch: async () => new Promise<Response>(() => undefined),
    });

    await expect(provider.queryMarketMovers({ query: "movers" })).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
  });

  test("rejects movers without valid source URLs", () => {
    expect(() => normalizeCalaResponse({
      results: [{
        ticker: "TEST",
        company: "Test Co",
        direction: "up",
        change_pct: 2,
        catalyst: "Unsourced claim",
        source_url: "file:///private/report",
      }],
    }, "test")).toThrow("no valid source URLs");
  });
});
