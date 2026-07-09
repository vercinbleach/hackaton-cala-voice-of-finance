import { basename, extname, resolve } from "node:path";
import type { ApiError, CreateRunResponse, RunRecord } from "../shared/contracts";

interface Options {
  apiUrl: string;
  prompt: string;
  urls: string[];
  files: string[];
}

const DEFAULT_PROMPT = [
  "Crea un reel de 30 segundos sobre las 2 acciones de Estados Unidos que mas subieron",
  "y las 2 que mas bajaron en la ultima sesion disponible.",
  "Explica el catalizador de cada movimiento y cierra con que vigilar despues.",
].join(" ");

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apiUrl: process.env.DEMO_API_URL ?? "http://127.0.0.1:3001",
    prompt: DEFAULT_PROMPT,
    urls: [],
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requiere un valor.`);
      index += 1;
      return value;
    };

    if (argument === "--prompt") options.prompt = next();
    else if (argument === "--url") options.urls.push(next());
    else if (argument === "--file") options.files.push(resolve(next()));
    else if (argument === "--api") options.apiUrl = next().replace(/\/$/, "");
    else throw new Error(`Opcion desconocida: ${argument}`);
  }
  return options;
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T | ApiError;
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      ? String(payload.error)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function createRun(options: Options): Promise<RunRecord> {
  const form = new FormData();
  form.set("prompt", options.prompt);
  for (const url of options.urls) form.append("referenceUrls", url);
  for (const path of options.files) {
    const mimeType = MIME_BY_EXTENSION[extname(path).toLowerCase()];
    if (!mimeType) throw new Error(`Tipo de archivo no soportado: ${path}`);
    const file = Bun.file(path, { type: mimeType });
    if (!(await file.exists())) throw new Error(`No existe el archivo: ${path}`);
    form.append("files", file, basename(path));
  }

  const response = await fetch(`${options.apiUrl}/api/runs`, { method: "POST", body: form });
  return (await responseJson<CreateRunResponse>(response)).run;
}

async function waitForRun(apiUrl: string, initial: RunRecord): Promise<RunRecord> {
  const deadline = Date.now() + 20 * 60 * 1_000;
  let previous = "";

  while (Date.now() < deadline) {
    const response = await fetch(`${apiUrl}/api/runs/${encodeURIComponent(initial.id)}`);
    const run = (await responseJson<CreateRunResponse>(response)).run;
    const state = `${run.status}|${run.currentStage}|${run.progress}`;
    if (state !== previous) {
      console.log(`[${run.progress}%] ${run.currentStage}: ${run.status}`);
      previous = state;
    }
    if (run.status === "completed") return run;
    if (run.status === "failed") throw new Error(`${run.currentStage}: ${run.error ?? "pipeline failed"}`);
    await Bun.sleep(1_000);
  }

  throw new Error("La demo supero el limite de 20 minutos.");
}

const options = parseArgs(Bun.argv.slice(2));
await responseJson(await fetch(`${options.apiUrl}/api/health`));
const created = await createRun(options);
console.log(`Run ${created.id}`);
const completed = await waitForRun(options.apiUrl, created);
console.log(`Video: ${options.apiUrl}/api/runs/${completed.id}/output`);
