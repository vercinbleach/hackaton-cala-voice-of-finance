import { resolve } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  type ApiError,
  type CreateRunResponse,
  type HealthResponse,
  type LatestRunResponse,
  type PipelineStage,
} from "../shared/contracts";
import { RunEventHub } from "./events";
import {
  RunManager,
  RunManagerError,
  type CreateRunInput,
  type PipelineRunner,
  type UploadInput,
} from "./run-manager";
import { RunStore, UnsafePathError, sanitizeFilename } from "./store";

const URL_FIELDS = ["urls", "url", "referenceUrls", "references"] as const;
const UPLOAD_FIELDS = ["uploads", "upload", "files", "file", "references"] as const;
export const MAX_MULTIPART_BODY_BYTES = 64 * 1024 * 1024;

export interface RunApiOptions {
  runner: PipelineRunner;
  projectsRoot?: string;
  heartbeatMs?: number;
}

export interface RunApi {
  app: Hono;
  fetch(request: Request): Response | Promise<Response>;
  manager: RunManager;
  store: RunStore;
  events: RunEventHub;
}

export interface RunServerOptions extends RunApiOptions {
  hostname?: string;
  port?: number;
}

function jsonResponse(c: Context, body: object, status: ContentfulStatusCode = 200): Response {
  c.header("Cache-Control", "no-store");
  return c.json(body, status);
}

function apiErrorResponse(
  c: Context,
  code: ApiError["code"],
  error: string,
  status: ContentfulStatusCode,
  stage?: PipelineStage,
): Response {
  const body: ApiError = { error, code, ...(stage ? { stage } : {}) };
  return jsonResponse(c, body, status);
}

function methodNotAllowed(c: Context, allow: "GET" | "POST"): Response {
  c.header("Allow", allow);
  return apiErrorResponse(c, "INTERNAL_ERROR", "Metodo no permitido.", 405);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new UnsafePathError();
  }
}

function parseReferenceField(value: string): unknown[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return trimmed.includes("\n") ? trimmed.split(/\r?\n/).map((item) => item.trim()) : [trimmed];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new RunManagerError("INVALID_REFERENCE", "Las referencias JSON no son validas.", 400);
  }

  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && "value" in item) {
      const reference = item as { kind?: unknown; value?: unknown };
      if (reference.kind === undefined || reference.kind === "url") return reference.value;
    }
    throw new RunManagerError("INVALID_REFERENCE", "La referencia debe ser una URL.", 400);
  });
}

async function parseCreateRunRequest(request: Request): Promise<CreateRunInput> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new RunManagerError("INVALID_UPLOAD", "La peticion debe usar multipart/form-data.", 415);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new RunManagerError("INVALID_UPLOAD", "No se pudo leer el formulario multipart.", 400);
  }

  const referenceUrls: unknown[] = [];
  for (const field of URL_FIELDS) {
    for (const value of formData.getAll(field)) {
      if (typeof value === "string") referenceUrls.push(...parseReferenceField(value));
    }
  }

  const uploadFiles = new Set<File>();
  for (const field of UPLOAD_FIELDS) {
    for (const value of formData.getAll(field)) {
      if (typeof value !== "string") uploadFiles.add(value);
    }
  }

  const uploads: UploadInput[] = [];
  for (const file of uploadFiles) {
    if (!ALLOWED_UPLOAD_TYPES.has(file.type)) {
      throw new RunManagerError(
        "INVALID_UPLOAD",
        `Tipo de upload no permitido: ${file.type || "desconocido"}.`,
        400,
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new RunManagerError("INVALID_UPLOAD", `El upload supera ${MAX_UPLOAD_BYTES} bytes.`, 400);
    }
    uploads.push({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
  }

  return { prompt: formData.get("prompt"), referenceUrls, uploads };
}

function parseLastEventId(request: Request): number {
  const url = new URL(request.url);
  const value = request.headers.get("last-event-id") ?? url.searchParams.get("lastEventId");
  if (!value || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function fileResponse(path: string, filename: string, mimeType?: string): Response {
  const file = Bun.file(path);
  return new Response(file, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="${sanitizeFilename(filename)}"`,
      "Content-Type": mimeType || file.type || "application/octet-stream",
    },
  });
}

export function createRunApi(options: RunApiOptions): RunApi {
  const store = new RunStore(options.projectsRoot ?? resolve(process.cwd(), "projects"));
  const events = new RunEventHub(store, options.heartbeatMs);
  const manager = new RunManager(store, events, options.runner);
  const startupRecovery = manager.recoverInterruptedRuns();
  const app = new Hono();

  app.use("/api/*", async (_c, next) => {
    await startupRecovery;
    await next();
  });

  app.options("/api/*", (c) => {
    c.header("Allow", "GET, POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    return c.body(null, 204);
  });

  app.get("/api/health", (c) => jsonResponse(c, { status: "ok" } satisfies HealthResponse));

  app.get("/api/runs/latest", async (c) => {
    const runs = await store.listRuns();
    const run = runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
    const response: LatestRunResponse = {
      run,
      events: run ? await store.getEvents(run.id) : [],
    };
    return jsonResponse(c, response);
  });

  app.post(
    "/api/runs",
    bodyLimit({
      maxSize: MAX_MULTIPART_BODY_BYTES,
      onError: (c) => apiErrorResponse(c, "INVALID_UPLOAD", "El formulario multipart es demasiado grande.", 413),
    }),
    async (c) => {
      const run = await manager.createRun(await parseCreateRunRequest(c.req.raw));
      const response: CreateRunResponse = { run };
      c.header("Location", `/api/runs/${run.id}`);
      return jsonResponse(c, response, 202);
    },
  );

  app.get("/api/runs/:id", async (c) => {
    const run = await manager.getRun(decodePathSegment(c.req.param("id")));
    return jsonResponse(c, { run });
  });

  app.get("/api/runs/:id/events", async (c) => {
    const runId = decodePathSegment(c.req.param("id"));
    await manager.getRun(runId);
    const feed = await events.openFeed(runId, parseLastEventId(c.req.raw));

    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(
      c,
      async (stream) => {
        stream.onAbort(() => feed.close());
        let nextEvent = feed.next();

        try {
          while (!stream.aborted) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const result = await Promise.race([
              nextEvent.then((event) => ({ type: "event" as const, event })),
              new Promise<{ type: "heartbeat" }>((resolveHeartbeat) => {
                timer = setTimeout(() => resolveHeartbeat({ type: "heartbeat" }), events.heartbeatMs);
              }),
            ]);
            if (timer) clearTimeout(timer);

            if (result.type === "heartbeat") {
              if (!stream.aborted) await stream.write(": heartbeat\n\n");
              continue;
            }
            if (!result.event || stream.aborted) break;

            await stream.writeSSE({ id: String(result.event.id), data: JSON.stringify(result.event) });
            nextEvent = feed.next();
          }
        } finally {
          feed.close();
        }
      },
      async (error) => {
        console.error(`Fallo el stream SSE del run ${runId}.`, error);
      },
    );
  });

  app.post("/api/runs/:id/retry", async (c) => {
    const run = await manager.retryRun(decodePathSegment(c.req.param("id")));
    return jsonResponse(c, { run }, 202);
  });

  app.get("/api/runs/:id/output", async (c) => {
    const runId = decodePathSegment(c.req.param("id"));
    const run = await manager.getRun(runId);
    const artifact = [...run.artifacts].reverse().find((candidate) => candidate.kind === "video");

    try {
      const path = await store.resolveReadableFile(runId, artifact?.relativePath ?? "renders/output.mp4");
      return fileResponse(path, artifact?.label ?? "output.mp4", artifact?.mimeType ?? "video/mp4");
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof UnsafePathError)) throw error;
      return apiErrorResponse(c, "PIPELINE_FAILED", "El output del run todavia no esta disponible.", 409, run.currentStage);
    }
  });

  app.get("/api/runs/:id/artifacts/:artifactId", async (c) => {
    const runId = decodePathSegment(c.req.param("id"));
    const artifactId = decodePathSegment(c.req.param("artifactId"));
    const run = await manager.getRun(runId);
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return apiErrorResponse(c, "RUN_NOT_FOUND", "Artefacto no encontrado.", 404);

    try {
      return fileResponse(await store.resolveReadableFile(runId, artifact.relativePath), artifact.label, artifact.mimeType);
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof UnsafePathError)) throw error;
      return apiErrorResponse(c, "RUN_NOT_FOUND", "Artefacto no encontrado.", 404);
    }
  });

  app.all("/api/runs", (c) => methodNotAllowed(c, "POST"));
  app.all("/api/health", (c) => methodNotAllowed(c, "GET"));
  app.all("/api/runs/latest", (c) => methodNotAllowed(c, "GET"));
  app.all("/api/runs/:id/retry", (c) => methodNotAllowed(c, "POST"));
  app.all("/api/runs/:id", (c) => methodNotAllowed(c, "GET"));
  app.all("/api/runs/:id/events", (c) => methodNotAllowed(c, "GET"));
  app.all("/api/runs/:id/output", (c) => methodNotAllowed(c, "GET"));
  app.all("/api/runs/:id/artifacts/:artifactId", (c) => methodNotAllowed(c, "GET"));

  app.notFound((c) => apiErrorResponse(c, "RUN_NOT_FOUND", "Ruta no encontrada.", 404));
  app.onError((error, c) => {
    if (error instanceof RunManagerError) {
      return apiErrorResponse(c, error.code, error.message, error.httpStatus as ContentfulStatusCode, error.stage);
    }
    if (error instanceof UnsafePathError) return apiErrorResponse(c, "RUN_NOT_FOUND", "Run no encontrado.", 404);
    console.error("Error no controlado en la API de runs.", error);
    return apiErrorResponse(c, "INTERNAL_ERROR", "Error interno del servidor.", 500);
  });

  return { app, fetch: (request) => app.fetch(request), manager, store, events };
}

export function createRequestHandler(options: RunApiOptions): (request: Request) => Response | Promise<Response> {
  return createRunApi(options).app.fetch;
}

export function startRunServer(options: RunServerOptions): ReturnType<typeof Bun.serve> {
  const api = createRunApi(options);
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 3001,
    maxRequestBodySize: MAX_MULTIPART_BODY_BYTES,
    fetch: api.app.fetch,
  });
}

const unconfiguredRunner: PipelineRunner = {
  async runPipeline() {
    throw new Error("No hay un PipelineRunner configurado.");
  },
};

export const app = createRunApi({ runner: unconfiguredRunner }).app;

const configuredPort = Number.parseInt(process.env.PORT ?? "3001", 10);
export default {
  hostname: "127.0.0.1",
  port: Number.isFinite(configuredPort) ? configuredPort : 3001,
  maxRequestBodySize: MAX_MULTIPART_BODY_BYTES,
  fetch: app.fetch,
};
