export type ProviderName = "cala" | "codex" | "elevenlabs";

export type ProviderErrorCode =
  | "CONFIGURATION"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTHENTICATION"
  | "REQUEST_FAILED"
  | "NETWORK"
  | "BAD_RESPONSE"
  | "PROCESS_FAILED"
  | "VALIDATION";

export interface ProviderErrorOptions {
  provider: ProviderName;
  code: ProviderErrorCode;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export function providerValidationError(
  provider: ProviderName,
  message: string,
): ProviderError {
  return new ProviderError(message, {
    provider,
    code: "VALIDATION",
    retryable: false,
  });
}
