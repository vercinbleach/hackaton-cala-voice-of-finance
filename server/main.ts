import { startRunServer } from "./index";
import { FinancePipelineRunner } from "./pipeline-runner";
import { CalaProvider, CodexProvider, ElevenLabsProvider } from "./providers";
import { resolveRuntimeExecutables, withExecutableDirectory } from "./runtime";

const runtime = await resolveRuntimeExecutables();
const renderEnv = withExecutableDirectory(process.env, runtime.ffmpeg);
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase() === "PATH") delete process.env[key];
}
process.env.PATH = renderEnv.PATH;

const calaApiKey = process.env.CALA_API_KEY;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID;
if (!calaApiKey) throw new Error("CALA_API_KEY no esta configurada.");
if (!elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY no esta configurada.");
if (!elevenLabsVoiceId) throw new Error("ELEVENLABS_VOICE_ID no esta configurada.");

const runner = new FinancePipelineRunner({
  cala: new CalaProvider({
    apiKey: calaApiKey,
    timeoutMs: Number.parseInt(process.env.CALA_TIMEOUT_MS ?? "180000", 10),
  }),
  codex: new CodexProvider({ command: runtime.codex, env: renderEnv, timeoutMs: 180_000 }),
  elevenLabs: new ElevenLabsProvider({
    apiKey: elevenLabsApiKey,
    voiceId: elevenLabsVoiceId,
    timeoutMs: 60_000,
  }),
  hyperframesCommand: runtime.hyperframes,
  hyperframesPrefixArgs: runtime.hyperframesPrefixArgs,
  ffprobeCommand: runtime.ffprobe,
  renderEnv,
});

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const server = startRunServer({ runner, port: Number.isFinite(port) ? port : 3001 });
console.log(`Finance reel API ready at http://${server.hostname}:${server.port}`);
