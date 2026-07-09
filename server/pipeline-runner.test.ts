import { describe, expect, test } from "bun:test";
import { ProviderError } from "./providers";
import { withControlledProviderRetry, withOperationHeartbeat } from "./pipeline-runner";

describe("withOperationHeartbeat", () => {
  test("reports elapsed liveness while a provider operation is still pending", async () => {
    const heartbeats: number[] = [];
    const result = await withOperationHeartbeat(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 18)),
      {
        intervalMs: 5,
        onHeartbeat: (elapsedSeconds) => { heartbeats.push(elapsedSeconds); },
      },
    );

    expect(result).toBe("ok");
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats.every((elapsed) => elapsed >= 1)).toBe(true);
  });
});

describe("withControlledProviderRetry", () => {
  test("retries one transient provider failure and reports it", async () => {
    let calls = 0;
    const retries: number[] = [];

    const result = await withControlledProviderRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new ProviderError("temporary", {
            provider: "cala",
            code: "TIMEOUT",
            retryable: true,
          });
        }
        return "ok";
      },
      {
        sleep: async (delayMs) => { retries.push(delayMs); },
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(retries).toEqual([1_000]);
  });

  test("does not retry permanent provider failures", async () => {
    let calls = 0;

    await expect(withControlledProviderRetry(async () => {
      calls += 1;
      throw new ProviderError("invalid", {
        provider: "cala",
        code: "VALIDATION",
        retryable: false,
      });
    }, { sleep: async () => undefined })).rejects.toMatchObject({ code: "VALIDATION" });

    expect(calls).toBe(1);
  });

  test("does not retry rate limits even when marked retryable", async () => {
    let calls = 0;

    await expect(withControlledProviderRetry(async () => {
      calls += 1;
      throw new ProviderError("limited", {
        provider: "cala",
        code: "RATE_LIMITED",
        retryable: true,
        status: 429,
      });
    }, { sleep: async () => undefined })).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(calls).toBe(1);
  });
});
