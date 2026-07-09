import {
  ALLOWED_UPLOAD_TYPES,
  DEFAULT_CHECKS,
  MAX_UPLOAD_BYTES,
  PIPELINE_STATUSES,
  STAGE_LABELS,
  clampProgress,
  isPipelineStage,
  validatePrompt,
  validateReferenceUrl,
  type ApiError,
  type PipelineStage,
  type RunEvent,
  type RunRecord,
  type RunReference,
} from "../shared/contracts";
import { RunEventHub } from "./events";
import {
  RunStore,
  normalizeRelativePath,
  sanitizeFilename,
  type StoredUpload,
} from "./store";

export interface UploadInput {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface CreateRunInput {
  prompt: unknown;
  referenceUrls?: readonly unknown[];
  uploads?: readonly UploadInput[];
}

export type PipelineEventInput = Omit<RunEvent, "id" | "runId" | "timestamp"> & {
  timestamp?: string;
};

export interface PipelineRunContext {
  runId: string;
  run: Readonly<RunRecord>;
  projectDirectory: string;
  resumeFrom: PipelineStage;
  isRetry: boolean;
  signal: AbortSignal;
  report: (event: PipelineEventInput) => Promise<RunEvent>;
  getRun: () => Promise<RunRecord>;
}

export interface PipelineRunner {
  runPipeline(context: PipelineRunContext): Promise<void>;
}

export class RunManagerError extends Error {
  constructor(
    readonly code: ApiError["code"],
    message: string,
    readonly httpStatus: number,
    readonly stage?: PipelineStage,
  ) {
    super(message);
    this.name = "RunManagerError";
  }
}

const VALID_STATUSES = new Set<string>(PIPELINE_STATUSES);

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 1_000);
  return "La pipeline ha fallado.";
}

function replaceById<T extends { id: string }>(values: readonly T[], value: T): T[] {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index < 0) return [...values, value];

  const updated = [...values];
  updated[index] = value;
  return updated;
}

export class RunManager {
  private managerQueue: Promise<unknown> = Promise.resolve();
  private readonly runQueues = new Map<string, Promise<unknown>>();
  private activeRunId: string | null = null;
  private activeController: AbortController | null = null;

  constructor(
    readonly store: RunStore,
    readonly events: RunEventHub,
    private readonly runner: PipelineRunner,
  ) {}

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const normalized = this.normalizeInput(input);
    let createdRun: RunRecord | undefined;

    await this.withManagerLock(async () => {
      await this.assertNoActiveRun();

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const references: RunReference[] = normalized.referenceUrls.map((value) => ({
        id: `url-${crypto.randomUUID()}`,
        kind: "url",
        value,
      }));
      const storedUploads: StoredUpload[] = [];

      for (const upload of normalized.uploads) {
        const referenceId = `upload-${crypto.randomUUID()}`;
        const filename = sanitizeFilename(upload.name);
        const relativePath = `uploads/${referenceId}-${filename}`;
        references.push({
          id: referenceId,
          kind: "upload",
          value: relativePath,
          filename,
          mimeType: upload.type,
          size: upload.bytes.byteLength,
        });
        storedUploads.push({ relativePath, bytes: upload.bytes });
      }

      const run: RunRecord = {
        id,
        prompt: normalized.prompt,
        references,
        format: { width: 1080, height: 1920, fps: 30 },
        styleId: "finance-reel-v0",
        duration: { target: 30, min: 15, max: 45 },
        status: "queued",
        currentStage: "intake",
        progress: 0,
        createdAt: now,
        updatedAt: now,
        artifacts: [],
        checks: DEFAULT_CHECKS.map((check) => ({ ...check })),
      };

      await this.store.createRun(run, storedUploads);
      const event = await this.store.appendEvent(id, {
        stage: "intake",
        status: "queued",
        message: STAGE_LABELS.intake,
        progress: 0,
        timestamp: now,
      });
      this.events.publish(event);
      this.activeRunId = id;
      createdRun = run;
    });

    if (!createdRun) throw new Error("No se pudo crear el run.");
    this.startExecution(createdRun.id, "intake", false);
    return createdRun;
  }

  async getRun(runId: string): Promise<RunRecord> {
    const run = await this.store.getRun(runId);
    if (!run) throw new RunManagerError("RUN_NOT_FOUND", "Run no encontrado.", 404);
    return run;
  }

  async recoverInterruptedRuns(): Promise<void> {
    await this.withManagerLock(async () => {
      for (const run of await this.store.listRuns()) {
        if (run.status === "completed" || run.status === "failed") continue;

        await this.report(run.id, {
          stage: run.currentStage,
          status: "failed",
          message: `La ejecucion se interrumpio al reiniciar la API. Reintenta el run para continuar desde ${STAGE_LABELS[run.currentStage]}.`,
          progress: run.progress,
        });
      }
    });
  }

  async retryRun(runId: string): Promise<RunRecord> {
    let queuedRun: RunRecord | undefined;
    let resumeFrom: PipelineStage = "intake";

    await this.withManagerLock(async () => {
      const run = await this.getRun(runId);
      if (run.status !== "failed") {
        throw new RunManagerError("RUN_NOT_FAILED", "Solo se puede reintentar un run fallido.", 409);
      }

      await this.assertNoActiveRun();
      resumeFrom = run.failedStage ?? run.currentStage;
      const now = new Date().toISOString();
      const { error: _error, failedStage: _failedStage, ...rest } = run;
      const updated: RunRecord = {
        ...rest,
        status: "queued",
        currentStage: resumeFrom,
        updatedAt: now,
      };

      await this.store.saveRun(updated);
      const event = await this.store.appendEvent(runId, {
        stage: resumeFrom,
        status: "queued",
        message: `Reintentando ${STAGE_LABELS[resumeFrom]}`,
        progress: updated.progress,
        timestamp: now,
      });
      this.events.publish(event);
      this.activeRunId = runId;
      queuedRun = updated;
    });

    if (!queuedRun) throw new Error("No se pudo reintentar el run.");
    this.startExecution(runId, resumeFrom, true);
    return queuedRun;
  }

  async report(runId: string, input: PipelineEventInput): Promise<RunEvent> {
    return this.withRunLock(runId, async () => {
      if (!isPipelineStage(input.stage) || !VALID_STATUSES.has(input.status)) {
        throw new Error("El runner ha reportado un estado no valido.");
      }
      if (!Number.isFinite(input.progress)) throw new Error("El runner ha reportado un progreso no valido.");

      const run = await this.getRun(runId);
      if (run.status === "failed" || run.status === "completed") {
        throw new Error(`El run ${runId} ya esta en estado terminal.`);
      }
      if (input.status === "completed" && input.stage !== "complete") {
        throw new Error("El runner solo puede completar el run en la etapa complete.");
      }

      const timestamp = new Date().toISOString();
      const progress = input.status === "completed" ? 100 : Math.max(run.progress, clampProgress(input.progress));
      const message = input.message.trim() || STAGE_LABELS[input.stage];
      const artifact = input.artifact
        ? { ...input.artifact, relativePath: normalizeRelativePath(input.artifact.relativePath) }
        : undefined;
      const check = input.check ? { ...input.check } : undefined;

      const updated: RunRecord = {
        ...run,
        status: input.status,
        currentStage: input.stage,
        progress,
        updatedAt: timestamp,
        artifacts: artifact ? replaceById(run.artifacts, artifact) : run.artifacts,
        checks: check ? replaceById(run.checks, check) : run.checks,
      };

      if (input.status === "failed") {
        updated.failedStage = input.stage;
        updated.error = message;
      } else if (input.status === "completed") {
        delete updated.failedStage;
        delete updated.error;
      }

      await this.store.saveRun(updated);
      const event = await this.store.appendEvent(runId, {
        stage: input.stage,
        status: input.status,
        message,
        progress,
        timestamp,
        ...(artifact ? { artifact } : {}),
        ...(check ? { check } : {}),
      });
      this.events.publish(event);
      return event;
    });
  }

  private normalizeInput(input: CreateRunInput): {
    prompt: string;
    referenceUrls: string[];
    uploads: UploadInput[];
  } {
    let prompt: string;
    try {
      prompt = validatePrompt(input.prompt);
    } catch (error) {
      throw new RunManagerError("INVALID_PROMPT", errorMessage(error), 400);
    }

    const referenceUrls: string[] = [];
    for (const value of input.referenceUrls ?? []) {
      try {
        referenceUrls.push(validateReferenceUrl(value));
      } catch (error) {
        throw new RunManagerError("INVALID_REFERENCE", errorMessage(error), 400);
      }
    }

    const uploads: UploadInput[] = [];
    for (const upload of input.uploads ?? []) {
      if (!upload || typeof upload.name !== "string" || !(upload.bytes instanceof Uint8Array)) {
        throw new RunManagerError("INVALID_UPLOAD", "El upload no es valido.", 400);
      }
      if (!ALLOWED_UPLOAD_TYPES.has(upload.type)) {
        throw new RunManagerError("INVALID_UPLOAD", `Tipo de upload no permitido: ${upload.type || "desconocido"}.`, 400);
      }
      if (upload.bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new RunManagerError("INVALID_UPLOAD", `El upload supera ${MAX_UPLOAD_BYTES} bytes.`, 400);
      }
      uploads.push({ ...upload, bytes: new Uint8Array(upload.bytes) });
    }

    return { prompt, referenceUrls, uploads };
  }

  private startExecution(runId: string, resumeFrom: PipelineStage, isRetry: boolean): void {
    queueMicrotask(() => void this.execute(runId, resumeFrom, isRetry));
  }

  private async execute(runId: string, resumeFrom: PipelineStage, isRetry: boolean): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;

    try {
      const startingRun = await this.getRun(runId);
      await this.report(runId, {
        stage: resumeFrom,
        status: "running",
        message: isRetry ? `Reanudando ${STAGE_LABELS[resumeFrom]}` : STAGE_LABELS[resumeFrom],
        progress: startingRun.progress,
      });

      const run = await this.getRun(runId);
      await this.runner.runPipeline({
        runId,
        run,
        projectDirectory: this.store.projectDirectory(runId),
        resumeFrom,
        isRetry,
        signal: controller.signal,
        report: (event) => this.report(runId, event),
        getRun: () => this.getRun(runId),
      });

      const latest = await this.getRun(runId);
      if (latest.status !== "failed" && latest.status !== "completed") {
        await this.report(runId, {
          stage: "complete",
          status: "completed",
          message: STAGE_LABELS.complete,
          progress: 100,
        });
      }
    } catch (error) {
      try {
        const latest = await this.getRun(runId);
        if (latest.status !== "failed" && latest.status !== "completed") {
          await this.report(runId, {
            stage: latest.currentStage,
            status: "failed",
            message: errorMessage(error),
            progress: latest.progress,
          });
        }
      } catch (persistenceError) {
        console.error(`No se pudo persistir el fallo del run ${runId}.`, persistenceError);
      }
    } finally {
      await this.withManagerLock(async () => {
        if (this.activeRunId === runId) this.activeRunId = null;
        if (this.activeController === controller) this.activeController = null;
      });
    }
  }

  private async assertNoActiveRun(): Promise<void> {
    const activeRun = this.activeRunId ? await this.store.getRun(this.activeRunId) : await this.store.findActiveRun();
    if (activeRun) {
      throw new RunManagerError("RUN_ACTIVE", `El run ${activeRun.id} sigue activo.`, 409, activeRun.currentStage);
    }
  }

  private withManagerLock<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.managerQueue.catch(() => undefined).then(operation);
    this.managerQueue = current;
    return current;
  }

  private withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runQueues.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.runQueues.set(runId, current);

    return current.finally(() => {
      if (this.runQueues.get(runId) === current) this.runQueues.delete(runId);
    });
  }
}
