import { describe, expect, it } from "vitest";
import scriptOutputSchema from "./script-output.schema.json";
import {
  MAX_PROMPT_LENGTH,
  clampProgress,
  isPipelineStage,
  validatePrompt,
  validateReferenceUrl,
} from "./contracts";

describe("shared pipeline contracts", () => {
  it("normalizes a valid prompt", () => {
    expect(validatePrompt("  Top movers de hoy  ")).toBe("Top movers de hoy");
  });

  it("rejects empty and oversized prompts", () => {
    expect(() => validatePrompt("   ")).toThrow("obligatorio");
    expect(() => validatePrompt("x".repeat(MAX_PROMPT_LENGTH + 1))).toThrow("supera");
  });

  it("accepts only HTTP references", () => {
    expect(validateReferenceUrl("https://example.com/ref")).toBe("https://example.com/ref");
    expect(() => validateReferenceUrl("file:///secret.txt")).toThrow("HTTP");
  });

  it("recognizes stages and clamps progress", () => {
    expect(isPipelineStage("render")).toBe(true);
    expect(isPipelineStage("thinking")).toBe(false);
    expect(clampProgress(-20)).toBe(0);
    expect(clampProgress(57.6)).toBe(58);
    expect(clampProgress(180)).toBe(100);
  });

  it("uses explicit types for constrained Codex output fields", () => {
    const properties = scriptOutputSchema.properties;
    const moverProperties = properties.movers.items.properties;

    expect(properties.language).toMatchObject({ type: "string", const: "es" });
    expect(moverProperties.direction).toMatchObject({
      type: "string",
      enum: ["up", "down"],
    });
  });
});
