import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PipelineStatus, RunEvent, RunRecord } from "../shared/contracts";

const ACTIVE_STATUSES = new Set<PipelineStatus>(["queued", "running", "testing"]);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface StoredUpload {
  relativePath: string;
  bytes: Uint8Array;
}

export type NewRunEvent = Omit<RunEvent, "id" | "runId">;

export class UnsafePathError extends Error {
  constructor(message = "La ruta solicitada no es valida.") {
    super(message);
    this.name = "UnsafePathError";
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

export function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new UnsafePathError("El identificador del run no es valido.");
  return runId;
}

export function normalizeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new UnsafePathError();

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:/.test(normalized)) {
    throw new UnsafePathError();
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new UnsafePathError();
  }

  return segments.join("/");
}

export function sanitizeFilename(value: string): string {
  const basename = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  let filename = basename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");

  if (!filename) filename = "upload";

  const stem = filename.split(".", 1)[0]?.toUpperCase();
  if (stem && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) filename = `_${filename}`;

  if (filename.length <= 120) return filename;

  const extensionIndex = filename.lastIndexOf(".");
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex, extensionIndex + 21) : "";
  return `${filename.slice(0, 120 - extension.length)}${extension}`;
}

export class RunStore {
  readonly projectsRoot: string;
  private readonly eventQueues = new Map<string, Promise<unknown>>();
  private readonly lastEventIds = new Map<string, number>();

  constructor(projectsRoot = resolve(process.cwd(), "projects")) {
    this.projectsRoot = resolve(projectsRoot);
  }

  projectDirectory(runId: string): string {
    return resolve(this.projectsRoot, assertRunId(runId));
  }

  async createRun(run: RunRecord, uploads: readonly StoredUpload[] = []): Promise<void> {
    assertRunId(run.id);
    await mkdir(this.projectsRoot, { recursive: true });

    const runDirectory = this.projectDirectory(run.id);
    await mkdir(runDirectory);

    try {
      for (const upload of uploads) {
        const relativePath = normalizeRelativePath(upload.relativePath);
        const destination = this.resolveProjectPath(run.id, relativePath);
        await mkdir(resolve(destination, ".."), { recursive: true });
        await writeFile(destination, upload.bytes, { flag: "wx" });
      }

      await this.writeRunJson(run);
      await writeFile(resolve(runDirectory, "events.ndjson"), "", { flag: "wx" });
    } catch (error) {
      await rm(runDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const runPath = resolve(this.projectDirectory(runId), "run.json");

    try {
      const parsed = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
      if (!parsed || parsed.id !== runId) throw new Error(`run.json no coincide con el run ${runId}.`);
      return parsed;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async saveRun(run: RunRecord): Promise<void> {
    if (!(await this.getRun(run.id))) throw new Error(`No existe el run ${run.id}.`);
    await this.writeRunJson(run);
  }

  async listRuns(): Promise<RunRecord[]> {
    let entries;
    try {
      entries = await readdir(this.projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
        .map((entry) => this.getRun(entry.name)),
    );

    return runs.filter((run): run is RunRecord => run !== null);
  }

  async findActiveRun(exceptRunId?: string): Promise<RunRecord | null> {
    const runs = await this.listRuns();
    return runs.find((run) => run.id !== exceptRunId && ACTIVE_STATUSES.has(run.status)) ?? null;
  }

  async appendEvent(runId: string, input: NewRunEvent): Promise<RunEvent> {
    assertRunId(runId);

    return this.enqueueEventOperation(runId, async () => {
      let lastId = this.lastEventIds.get(runId);
      if (lastId === undefined) {
        const events = await this.getEvents(runId);
        lastId = events.at(-1)?.id ?? 0;
      }

      const event: RunEvent = { ...input, id: lastId + 1, runId };
      const eventsPath = resolve(this.projectDirectory(runId), "events.ndjson");
      await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      this.lastEventIds.set(runId, event.id);
      return event;
    });
  }

  async getEvents(runId: string, afterId = 0): Promise<RunEvent[]> {
    assertRunId(runId);
    const eventsPath = resolve(this.projectDirectory(runId), "events.ndjson");

    let contents: string;
    try {
      contents = await readFile(eventsPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    const events = contents
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);

    const lastId = events.at(-1)?.id ?? 0;
    this.lastEventIds.set(runId, Math.max(this.lastEventIds.get(runId) ?? 0, lastId));
    return events.filter((event) => event.id > afterId);
  }

  async resolveReadableFile(runId: string, relativePath: string): Promise<string> {
    const candidate = this.resolveProjectPath(runId, relativePath);
    const [projectsPath, runPath, filePath] = await Promise.all([
      realpath(this.projectsRoot),
      realpath(this.projectDirectory(runId)),
      realpath(candidate),
    ]);
    if (!isWithin(projectsPath, runPath) || !isWithin(runPath, filePath)) throw new UnsafePathError();

    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new UnsafePathError("La ruta solicitada no es un fichero.");
    return filePath;
  }

  private resolveProjectPath(runId: string, relativePath: string): string {
    const runDirectory = this.projectDirectory(runId);
    const normalized = normalizeRelativePath(relativePath);
    const candidate = resolve(runDirectory, ...normalized.split("/"));
    if (!isWithin(runDirectory, candidate)) throw new UnsafePathError();
    return candidate;
  }

  private async writeRunJson(run: RunRecord): Promise<void> {
    const runDirectory = this.projectDirectory(run.id);
    const destination = resolve(runDirectory, "run.json");
    const temporary = resolve(runDirectory, `.run-${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  }

  private enqueueEventOperation<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.eventQueues.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.eventQueues.set(runId, current);

    return current.finally(() => {
      if (this.eventQueues.get(runId) === current) this.eventQueues.delete(runId);
    });
  }
}
