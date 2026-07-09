import { basename } from "node:path";
import { loadProbeFixture, probeMedia, validateProbe, type MediaRules } from "./lib/media-probe.ts";

interface CliOptions {
  input?: string;
  probeJson?: string;
  ffprobe: string;
  json: boolean;
  rules: MediaRules;
}

function usage(): string {
  return [
    "Usage:",
    "  bun scripts/validate-media.ts <media-file> [rules]",
    "  bun scripts/validate-media.ts --probe-json <ffprobe.json> [rules]",
    "",
    "Rules:",
    "  --kind <audio|video|any>  --require-audio  --require-video",
    "  --width <px>  --height <px>  --fps <number>",
    "  --min-duration <seconds>  --max-duration <seconds>  --format <name>",
    "  --ffprobe <command>  --json",
  ].join("\n");
}

function parseFinite(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} requires a finite number`);
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { ffprobe: "ffprobe", json: false, rules: {} };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };

    switch (argument) {
      case "--input":
        options.input = next();
        break;
      case "--probe-json":
        options.probeJson = next();
        break;
      case "--ffprobe":
        options.ffprobe = next();
        break;
      case "--kind": {
        const kind = next();
        if (!new Set(["audio", "video", "any"]).has(kind)) throw new Error("--kind must be audio, video, or any");
        options.rules.requireAudio = kind === "audio";
        options.rules.requireVideo = kind === "video";
        break;
      }
      case "--require-audio":
        options.rules.requireAudio = true;
        break;
      case "--require-video":
        options.rules.requireVideo = true;
        break;
      case "--width":
        options.rules.width = parseFinite(next(), argument);
        break;
      case "--height":
        options.rules.height = parseFinite(next(), argument);
        break;
      case "--fps":
        options.rules.fps = parseFinite(next(), argument);
        break;
      case "--min-duration":
        options.rules.minDuration = parseFinite(next(), argument);
        break;
      case "--max-duration":
        options.rules.maxDuration = parseFinite(next(), argument);
        break;
      case "--format":
        options.rules.formatName = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
        if (options.input) throw new Error("only one media input is supported per invocation");
        options.input = argument;
    }
  }

  if (Boolean(options.input) === Boolean(options.probeJson)) {
    throw new Error("provide exactly one media file or --probe-json fixture");
  }
  return options;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  try {
    const source = options.probeJson ?? options.input!;
    const probe = options.probeJson
      ? await loadProbeFixture(options.probeJson)
      : await probeMedia(options.input!, options.ffprobe);
    const result = validateProbe(probe, options.rules);
    const report = { input: basename(source), ...result };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`${result.ok ? "PASS" : "FAIL"} ${report.input}`);
      console.log(`  duration: ${result.summary.duration ?? "unknown"}s`);
      console.log(`  streams: ${result.summary.videoStreams.length} video, ${result.summary.audioStreams.length} audio`);
      for (const error of result.errors) console.log(`  - ${error}`);
    }

    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) console.log(JSON.stringify({ ok: false, errors: [message] }, null, 2));
    else console.error(`FAIL ${message}`);
    process.exitCode = 2;
  }
}

await main();
