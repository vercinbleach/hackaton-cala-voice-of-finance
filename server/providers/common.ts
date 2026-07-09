import {
  ProviderError,
  type ProviderName,
  isProviderError,
} from "./errors";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
const MAX_JSON_RESPONSE_BYTES = 5 * 1024 * 1024;

interface FetchJsonOptions {
  provider: Exclude<ProviderName, "codex">;
  fetch: FetchLike;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}

export function requireCredential(
  value: string | undefined,
  provider: ProviderName,
  label: string,
): string {
  if (!value?.trim()) {
    throw new ProviderError(`${label} is required.`, {
      provider,
      code: "CONFIGURATION",
      retryable: false,
    });
  }

  return value.trim();
}

export async function fetchJson(options: FetchJsonOptions): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new ProviderError(`${providerLabel(options.provider)} request timed out.`, {
          provider: options.provider,
          code: "TIMEOUT",
          retryable: true,
        }),
      );
    }, options.timeoutMs);
  });

  try {
    const response = await Promise.race([
      options.fetch(options.url, {
        ...options.init,
        signal: controller.signal,
      }),
      timeout,
    ]);

    if (!response.ok) throw createHttpError(options.provider, response);

    const body = await response.text();
    if (body.length > MAX_JSON_RESPONSE_BYTES) {
      throw new ProviderError(`${providerLabel(options.provider)} returned too much data.`, {
        provider: options.provider,
        code: "BAD_RESPONSE",
        retryable: false,
      });
    }

    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new ProviderError(`${providerLabel(options.provider)} returned invalid JSON.`, {
        provider: options.provider,
        code: "BAD_RESPONSE",
        retryable: false,
      });
    }
  } catch (error) {
    if (isProviderError(error)) throw error;

    throw new ProviderError(`${providerLabel(options.provider)} request failed.`, {
      provider: options.provider,
      code: "NETWORK",
      retryable: true,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createHttpError(
  provider: Exclude<ProviderName, "codex">,
  response: Response,
): ProviderError {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

  if (status === 429) {
    return new ProviderError(`${providerLabel(provider)} rate limit exceeded.`, {
      provider,
      code: "RATE_LIMITED",
      retryable: true,
      status,
      retryAfterMs,
    });
  }

  if (status === 401 || status === 403) {
    return new ProviderError(`${providerLabel(provider)} authentication failed.`, {
      provider,
      code: "AUTHENTICATION",
      retryable: false,
      status,
    });
  }

  return new ProviderError(`${providerLabel(provider)} request was rejected.`, {
    provider,
    code: "REQUEST_FAILED",
    retryable: status === 408 || status === 425 || status >= 500,
    status,
    retryAfterMs,
  });
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 24 * 60 * 60 * 1_000);
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - Date.now()), 24 * 60 * 60 * 1_000);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;

  const normalized = value
    .trim()
    .replace(/[%,$+]/g, "")
    .replace(/\s/g, "");
  if (!normalized) return undefined;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function providerLabel(provider: ProviderName): string {
  if (provider === "elevenlabs") return "ElevenLabs";
  if (provider === "codex") return "Codex";
  return "Cala";
}
