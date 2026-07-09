import { describe, expect, test } from "bun:test";
import { resolveRuntimeExecutables, withExecutableDirectory } from "./runtime";

describe("runtime executable discovery", () => {
  test("finds the required local tools", async () => {
    const tools = await resolveRuntimeExecutables();
    expect(tools.codex.toLowerCase()).toContain("codex");
    expect(tools.ffmpeg.toLowerCase()).toContain("ffmpeg");
    expect(tools.ffprobe.toLowerCase()).toContain("ffprobe");
    expect(tools.hyperframes.toLowerCase()).toContain("node");
    expect(tools.hyperframes.toLowerCase().endsWith(".cmd")).toBe(false);
    expect(tools.hyperframesPrefixArgs[0]?.replaceAll("\\", "/")).toContain(
      "node_modules/hyperframes/dist/cli.js",
    );
  });

  test("prepends an executable directory to PATH", () => {
    const result = withExecutableDirectory({ PATH: "existing" }, "C:\\tools\\ffmpeg.exe");
    expect(result.PATH?.startsWith("C:\\tools;")).toBe(true);
  });
});
