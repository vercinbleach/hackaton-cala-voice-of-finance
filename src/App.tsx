import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  CircleDashed,
  Clapperboard,
  Clock3,
  Database,
  ExternalLink,
  File,
  FileAudio,
  FileImage,
  FileText,
  Film,
  Globe2,
  Inbox,
  Link2,
  ListChecks,
  LoaderCircle,
  Mic2,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Upload,
  Video,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  ALLOWED_UPLOAD_TYPES,
  DEFAULT_CHECKS,
  MAX_PROMPT_LENGTH,
  MAX_UPLOAD_BYTES,
  PIPELINE_STAGES,
  PIPELINE_STATUSES,
  STAGE_LABELS,
  clampProgress,
  isPipelineStage,
  validatePrompt,
  validateReferenceUrl,
  type ApiError,
  type ArtifactRef,
  type LatestRunResponse,
  type PipelineCheck,
  type PipelineStage,
  type PipelineStatus,
  type RunEvent,
  type RunRecord,
} from "../shared/contracts";

type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "ready" | "closed";
type StageState = "idle" | "queued" | "active" | "testing" | "passed" | "failed";

const STAGE_ICONS: Record<PipelineStage, LucideIcon> = {
  intake: Inbox,
  research: Search,
  script: FileText,
  voice: Mic2,
  assets: Database,
  edit: Scissors,
  render: Clapperboard,
  complete: Video,
};

const STAGE_BRANDS: Partial<Record<PipelineStage, { src: string; alt: string }>> = {
  research: { src: "/brands/cala.png", alt: "Cala" },
  script: { src: "/brands/openai-wordmark.png", alt: "OpenAI" },
  voice: { src: "/brands/elevenlabs-wordmark.svg", alt: "ElevenLabs" },
  render: { src: "/brands/hyperframes.svg", alt: "HyperFrames" },
};

const STATUS_LABELS: Record<PipelineStatus, string> = {
  queued: "En cola",
  running: "En curso",
  testing: "Validando",
  completed: "Completado",
  failed: "Fallido",
};

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: "Sin conexion",
  connecting: "Conectando",
  live: "En directo",
  reconnecting: "Reconectando",
  ready: "API lista",
  closed: "Stream cerrado",
};

const CHECK_LABELS: Record<PipelineCheck["status"], string> = {
  pending: "Pendiente",
  passed: "Aprobado",
  failed: "Fallido",
};

const ACCEPTED_UPLOADS = Array.from(ALLOWED_UPLOAD_TYPES).join(",");
const EVENT_LIMIT = 200;
const timeFormatter = new Intl.DateTimeFormat("es-ES", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function isTerminalStatus(status: PipelineStatus): boolean {
  return status === "completed" || status === "failed";
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RunEvent>;
  return (
    typeof candidate.id === "number" &&
    Number.isFinite(candidate.id) &&
    typeof candidate.runId === "string" &&
    isPipelineStage(candidate.stage) &&
    typeof candidate.status === "string" &&
    PIPELINE_STATUSES.includes(candidate.status as PipelineStatus) &&
    typeof candidate.message === "string" &&
    typeof candidate.progress === "number" &&
    Number.isFinite(candidate.progress) &&
    typeof candidate.timestamp === "string"
  );
}

function readRun(value: unknown): RunRecord {
  if (typeof value !== "object" || value === null || !("run" in value)) {
    throw new Error("La API devolvio una respuesta de run no valida.");
  }

  const run = value.run;
  if (
    typeof run !== "object" ||
    run === null ||
    !("id" in run) ||
    typeof run.id !== "string" ||
    !("currentStage" in run) ||
    !isPipelineStage(run.currentStage) ||
    !("status" in run) ||
    typeof run.status !== "string" ||
    !PIPELINE_STATUSES.includes(run.status as PipelineStatus) ||
    !("artifacts" in run) ||
    !Array.isArray(run.artifacts) ||
    !("checks" in run) ||
    !Array.isArray(run.checks)
  ) {
    throw new Error("La API devolvio una respuesta de run no valida.");
  }

  return run as RunRecord;
}

function readLatestRun(value: unknown): LatestRunResponse {
  if (typeof value !== "object" || value === null || !("run" in value) || !("events" in value)) {
    throw new Error("La API devolvio un ultimo run no valido.");
  }
  if (!Array.isArray(value.events) || !value.events.every(isRunEvent)) {
    throw new Error("La API devolvio un historial de eventos no valido.");
  }
  if (value.run === null) return { run: null, events: value.events };
  return { run: readRun({ run: value.run }), events: value.events };
}

async function parseRunResponse(response: Response): Promise<RunRecord> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`La API no devolvio JSON (${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(isApiError(payload) ? payload.error : `La API rechazo la solicitud (${response.status}).`);
  }

  return readRun(payload);
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function mergeRunEvents(current: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const merged = new Map(current.map((event) => [`${event.runId}:${event.id}`, event]));
  for (const event of incoming) merged.set(`${event.runId}:${event.id}`, event);
  return [...merged.values()]
    .sort((left, right) => left.id - right.id)
    .slice(-EVENT_LIMIT);
}

function applyEvent(run: RunRecord, event: RunEvent): RunRecord {
  if (run.id !== event.runId) return run;

  const statusChangedFromFailure = run.status === "failed" && event.status !== "failed";
  return {
    ...run,
    status: event.status,
    currentStage: event.stage,
    progress: clampProgress(event.progress),
    updatedAt: event.timestamp,
    failedStage: event.status === "failed" ? event.stage : statusChangedFromFailure ? undefined : run.failedStage,
    error: event.status === "failed" ? event.message : statusChangedFromFailure ? undefined : run.error,
    artifacts: event.artifact ? upsertById(run.artifacts, event.artifact) : run.artifacts,
    checks: event.check ? upsertById(run.checks, event.check) : run.checks,
  };
}

function stageStateFor(stage: PipelineStage, run: RunRecord | null): StageState {
  if (!run) return "idle";

  const stageIndex = PIPELINE_STAGES.indexOf(stage);
  const currentIndex = PIPELINE_STAGES.indexOf(run.currentStage);

  if (run.status === "failed" && stage === (run.failedStage ?? run.currentStage)) return "failed";
  if (stageIndex < currentIndex || run.status === "completed") return "passed";
  if (stageIndex > currentIndex) return "queued";
  if (run.status === "queued") return "queued";
  if (run.status === "testing") return "testing";
  return "active";
}

function stageStateLabel(state: StageState): string {
  switch (state) {
    case "passed":
      return "Finalizada";
    case "active":
      return "En curso";
    case "testing":
      return "Validando";
    case "failed":
      return "Fallida";
    case "queued":
      return "En espera";
    default:
      return "No iniciada";
  }
}

function displayChecks(run: RunRecord | null): PipelineCheck[] {
  if (!run) return DEFAULT_CHECKS;

  const received = new Map(run.checks.map((check) => [check.id, check]));
  const known = DEFAULT_CHECKS.map((check) => received.get(check.id) ?? check);
  const knownIds = new Set(DEFAULT_CHECKS.map((check) => check.id));
  const additional = run.checks.filter((check) => !knownIds.has(check.id));
  return [...known, ...additional];
}

function eventTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "--:--:--" : timeFormatter.format(date);
}

function shortRunId(runId: string): string {
  return runId.length > 18 ? `${runId.slice(0, 8)}...${runId.slice(-5)}` : runId;
}

function referenceLabel(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.hostname}${path}`;
  } catch {
    return value;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactIcon(artifact: ArtifactRef): LucideIcon {
  if (artifact.mimeType?.startsWith("audio/") || artifact.kind === "voice") return FileAudio;
  if (artifact.mimeType?.startsWith("image/") || artifact.kind === "chart") return FileImage;
  if (artifact.mimeType?.startsWith("video/") || artifact.kind === "video") return Film;
  if (["brief", "research", "sources", "script", "report"].includes(artifact.kind)) return FileText;
  return File;
}

function StageStatusIcon({ state }: { state: StageState }) {
  if (state === "passed") return <Check size={15} aria-hidden="true" />;
  if (state === "failed") return <X size={15} aria-hidden="true" />;
  if (state === "active" || state === "testing") {
    return <LoaderCircle className="spin" size={15} aria-hidden="true" />;
  }
  return <Circle size={13} aria-hidden="true" />;
}

function CheckStatusIcon({ status }: { status: PipelineCheck["status"] }) {
  if (status === "passed") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (status === "failed") return <XCircle size={16} aria-hidden="true" />;
  return <CircleDashed size={16} aria-hidden="true" />;
}

export function App() {
  const fileInputId = useId();
  const [prompt, setPrompt] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [referenceUrls, setReferenceUrls] = useState<string[]>([]);
  const [uploads, setUploads] = useState<File[]>([]);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [formError, setFormError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [streamRevision, setStreamRevision] = useState(0);
  const latestHydrationVersion = useRef(0);

  const checks = useMemo(() => displayChecks(run), [run]);
  const activity = useMemo(() => [...events].reverse(), [events]);
  const latestEvent = events.at(-1) ?? null;
  const passedChecks = run ? checks.filter((check) => check.status === "passed").length : 0;
  const activeRun = run ? !isTerminalStatus(run.status) : false;
  const canSubmit = prompt.trim().length > 0 && !isSubmitting && !activeRun;

  useEffect(() => {
    let disposed = false;
    const hydrationVersion = latestHydrationVersion.current;
    setConnection("connecting");

    void fetch("/api/runs/latest")
      .then(async (response) => {
        if (!response.ok) throw new Error(`La API no esta disponible (${response.status}).`);
        return readLatestRun(await response.json());
      })
      .then((latest) => {
        if (disposed || hydrationVersion !== latestHydrationVersion.current) return;
        setRun(latest.run);
        setEvents(latest.events.slice(-EVENT_LIMIT));
        setConnection(latest.run && !isTerminalStatus(latest.run.status) ? "connecting" : "ready");
      })
      .catch((error) => {
        if (disposed || hydrationVersion !== latestHydrationVersion.current) return;
        setConnection("idle");
        setStreamError(error instanceof Error ? error.message : "La API no esta disponible.");
      });

    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!run) return;
    if (isTerminalStatus(run.status)) {
      setConnection("ready");
      return;
    }

    const runId = run.id;
    const lastKnownEventId = events
      .filter((event) => event.runId === runId)
      .reduce((highest, event) => Math.max(highest, event.id), 0);
    let lastSeenEventId = lastKnownEventId;
    let disposed = false;
    let streamFinished = false;
    let pollInFlight = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const source = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events?lastEventId=${lastKnownEventId}`,
    );

    const finishStream = () => {
      streamFinished = true;
      source.close();
      if (pollTimer) clearInterval(pollTimer);
      setConnection("ready");
    };

    setConnection("connecting");
    setStreamError(null);

    source.onopen = () => {
      if (disposed) return;
      setConnection("live");
      setStreamError(null);
    };

    const handleMessage = (message: MessageEvent<string>) => {
      if (disposed) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        setStreamError("Se recibio un evento que no era JSON valido.");
        return;
      }

      if (!isRunEvent(parsed) || parsed.runId !== runId) {
        setStreamError("Se recibio un evento incompatible con el contrato.");
        return;
      }

      if (parsed.id <= lastSeenEventId) return;
      lastSeenEventId = parsed.id;

      setEvents((current) => {
        return mergeRunEvents(current, [parsed]);
      });
      setRun((current) => (current ? applyEvent(current, parsed) : current));

      if (isTerminalStatus(parsed.status)) {
        finishStream();
      }
    };

    const handleRunEvent = (event: Event) => handleMessage(event as MessageEvent<string>);
    source.onmessage = handleMessage;
    source.addEventListener("run", handleRunEvent);

    source.onerror = () => {
      if (disposed || streamFinished) return;
      setConnection("reconnecting");
      setStreamError("La conexion en directo se interrumpio; la sincronizacion automatica sigue activa.");
    };

    const pollRun = async () => {
      if (disposed || streamFinished || pollInFlight) return;
      pollInFlight = true;
      try {
        const response = await fetch("/api/runs/latest", { cache: "no-store" });
        if (!response.ok) return;
        const latest = readLatestRun(await response.json());
        if (!latest.run || latest.run.id !== runId) return;

        const latestEventId = latest.events.reduce((highest, event) => Math.max(highest, event.id), 0);
        lastSeenEventId = Math.max(lastSeenEventId, latestEventId);
        setEvents((current) => mergeRunEvents(current, latest.events));
        setRun((current) => {
          if (!current || current.id !== latest.run?.id) return current;
          return latest.run.updatedAt.localeCompare(current.updatedAt) >= 0 ? latest.run : current;
        });
        if (isTerminalStatus(latest.run.status)) finishStream();
      } catch {
        // EventSource keeps retrying; the next poll provides the same recovery path.
      } finally {
        pollInFlight = false;
      }
    };

    pollTimer = setInterval(() => { void pollRun(); }, 3_000);

    return () => {
      disposed = true;
      source.removeEventListener("run", handleRunEvent);
      source.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [run?.id, streamRevision]);

  useEffect(() => {
    setOutputError(null);
  }, [run?.id, run?.status]);

  function addReferenceUrl(): string[] | null {
    const rawValue = urlInput.trim();
    if (!rawValue) return referenceUrls;

    let url: string;
    try {
      url = validateReferenceUrl(rawValue);
    } catch {
      setFormError("Introduce una URL HTTP o HTTPS valida.");
      return null;
    }

    if (referenceUrls.includes(url)) {
      setFormError("Esa referencia ya esta incluida.");
      return null;
    }

    const next = [...referenceUrls, url];
    setReferenceUrls(next);
    setUrlInput("");
    setFormError(null);
    return next;
  }

  function handleUrlKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addReferenceUrl();
  }

  function handleFiles(files: FileList | null) {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;

    const invalidType = selected.find((file) => !ALLOWED_UPLOAD_TYPES.has(file.type));
    if (invalidType) {
      setFormError(`${invalidType.name} no tiene un formato admitido.`);
      return;
    }

    const oversized = selected.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (oversized) {
      setFormError(`${oversized.name} supera el limite de ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }

    setUploads((current) => {
      const existing = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      return [
        ...current,
        ...selected.filter((file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`)),
      ];
    });
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || activeRun) return;

    let cleanPrompt: string;
    try {
      cleanPrompt = validatePrompt(prompt);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Revisa el brief.");
      return;
    }

    let urls = referenceUrls;
    if (urlInput.trim()) {
      const next = addReferenceUrl();
      if (!next) return;
      urls = next;
    }

    const formData = new FormData();
    formData.append("prompt", cleanPrompt);
    urls.forEach((url) => formData.append("referenceUrls", url));
    uploads.forEach((file) => formData.append("files", file, file.name));

    latestHydrationVersion.current += 1;
    setIsSubmitting(true);
    setFormError(null);

    try {
      const response = await fetch("/api/runs", { method: "POST", body: formData });
      const nextRun = await parseRunResponse(response);
      setEvents([]);
      setRun(nextRun);
      setStreamError(null);
      setOutputError(null);
      setStreamRevision((revision) => revision + 1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "No se pudo crear el run.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function retryRun() {
    if (!run || run.status !== "failed" || isRetrying) return;

    setIsRetrying(true);
    setFormError(null);

    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/retry`, { method: "POST" });
      const nextRun = await parseRunResponse(response);
      if (nextRun.id !== run.id) setEvents([]);
      setRun(nextRun);
      setStreamError(null);
      setOutputError(null);
      setStreamRevision((revision) => revision + 1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "No se pudo reintentar el run.");
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <img src="/editify-logo.png" alt="" />
          </span>
          <div>
            <p>Finance reel control</p>
            <h1>Editify</h1>
          </div>
        </div>

        <div className="topbar-meta" aria-label="Formato de salida">
          <span>9:16</span>
          <span>{run ? `${run.format.width} x ${run.format.height}` : "Vertical"}</span>
          <span>{run ? `${run.format.fps} fps` : "MP4"}</span>
          <span className={`connection-state ${connection}`}>
            <i aria-hidden="true" />
            {CONNECTION_LABELS[connection]}
          </span>
        </div>
      </header>

      <section className="console-grid" aria-label="Consola de generacion">
        <aside className="request-pane">
          <div className="pane-heading">
            <div>
              <p>01 / Brief</p>
              <h2>Nueva pieza</h2>
            </div>
            <Paperclip size={18} aria-hidden="true" />
          </div>

          <form className="brief-form" onSubmit={handleSubmit} noValidate>
            <label className="field-label" htmlFor="reel-prompt">
              Tema y enfoque
            </label>
            <textarea
              id="reel-prompt"
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                if (formError) setFormError(null);
              }}
              maxLength={MAX_PROMPT_LENGTH}
              placeholder="Define la noticia, el angulo editorial y los datos que debe cubrir el reel."
              aria-describedby="prompt-count form-error"
              required
            />
            <span className="character-count" id="prompt-count">
              {prompt.length} / {MAX_PROMPT_LENGTH}
            </span>

            <div className="field-group">
              <label className="field-label" htmlFor="reference-url">
                Referencias URL <span>Opcional</span>
              </label>
              <div className="url-entry">
                <span className="input-icon" aria-hidden="true">
                  <Globe2 size={16} />
                </span>
                <input
                  id="reference-url"
                  type="url"
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  onKeyDown={handleUrlKeyDown}
                  placeholder="https://"
                />
                <button
                  className="icon-button"
                  type="button"
                  onClick={addReferenceUrl}
                  aria-label="Anadir referencia URL"
                  title="Anadir referencia URL"
                >
                  <Plus size={17} aria-hidden="true" />
                </button>
              </div>

              {referenceUrls.length > 0 ? (
                <div className="chip-list" aria-label="Referencias URL incluidas">
                  {referenceUrls.map((url) => (
                    <span className="reference-chip" key={url} title={url}>
                      <Link2 size={13} aria-hidden="true" />
                      <span>{referenceLabel(url)}</span>
                      <button
                        type="button"
                        onClick={() => setReferenceUrls((current) => current.filter((item) => item !== url))}
                        aria-label={`Quitar ${referenceLabel(url)}`}
                        title="Quitar referencia"
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="field-group">
              <span className="field-label" id="upload-label">
                Archivos <span>Opcional</span>
              </span>
              <input
                className="visually-hidden"
                id={fileInputId}
                type="file"
                accept={ACCEPTED_UPLOADS}
                multiple
                onChange={(event) => {
                  handleFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
                aria-labelledby="upload-label"
              />
              <label className="upload-button" htmlFor={fileInputId}>
                <Upload size={17} aria-hidden="true" />
                <span>Anadir archivos</span>
                <small>JPG, PNG, WEBP, MP4, MOV / 50 MB</small>
              </label>

              {uploads.length > 0 ? (
                <div className="upload-list" aria-label="Archivos incluidos">
                  {uploads.map((file) => {
                    const key = `${file.name}:${file.size}:${file.lastModified}`;
                    return (
                      <div className="upload-row" key={key}>
                        <Paperclip size={14} aria-hidden="true" />
                        <span title={file.name}>{file.name}</span>
                        <small>{formatBytes(file.size)}</small>
                        <button
                          type="button"
                          onClick={() => setUploads((current) => current.filter((item) => item !== file))}
                          aria-label={`Quitar ${file.name}`}
                          title="Quitar archivo"
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="submit-cluster">
              {formError ? (
                <div className="form-error" id="form-error" role="alert">
                  <AlertCircle size={16} aria-hidden="true" />
                  <span>{formError}</span>
                </div>
              ) : (
                <span id="form-error" />
              )}
              <button className="submit-button" type="submit" disabled={!canSubmit}>
                {isSubmitting ? (
                  <LoaderCircle className="spin" size={18} aria-hidden="true" />
                ) : (
                  <Play size={18} fill="currentColor" aria-hidden="true" />
                )}
                <span>
                  {isSubmitting
                    ? "Creando run"
                    : activeRun
                      ? "Run en curso"
                      : run
                        ? "Crear otro reel"
                        : "Crear reel"}
                </span>
              </button>
            </div>
          </form>
        </aside>

        <section className="run-pane">
          <div className="pane-heading run-heading">
            <div>
              <p>02 / Ejecucion</p>
              <h2>{run ? `Run ${shortRunId(run.id)}` : "Sin run activo"}</h2>
            </div>
            <span className={`run-status ${run?.status ?? "idle"}`}>
              {run ? STATUS_LABELS[run.status] : "En espera"}
            </span>
          </div>

          <div className="run-summary">
            <div className="summary-stage">
              <span>Etapa actual</span>
              <strong>{run ? STAGE_LABELS[run.currentStage] : "-"}</strong>
            </div>
            <div className="summary-progress">
              <div>
                <span>Progreso</span>
                <strong>{run ? `${clampProgress(run.progress)}%` : "-"}</strong>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Progreso del run"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={run ? clampProgress(run.progress) : undefined}
              >
                <i style={{ width: run ? `${clampProgress(run.progress)}%` : "0%" }} />
              </div>
            </div>
            <div className="summary-duration">
              <span>Duracion</span>
              <strong>
                {run?.duration.actual ? `${run.duration.actual}s` : run ? `${run.duration.target}s target` : "-"}
              </strong>
            </div>
          </div>

          {run?.status === "failed" ? (
            <div className="failure-banner" role="alert">
              <AlertTriangle size={19} aria-hidden="true" />
              <div>
                <strong>Fallo en {STAGE_LABELS[run.failedStage ?? run.currentStage]}</strong>
                <span>{run.error ?? latestEvent?.message ?? "El pipeline no pudo continuar."}</span>
              </div>
              <button type="button" onClick={retryRun} disabled={isRetrying}>
                <RefreshCw className={isRetrying ? "spin" : undefined} size={16} aria-hidden="true" />
                {isRetrying ? "Reintentando" : "Reintentar"}
              </button>
            </div>
          ) : null}

          <section className="pipeline-section" aria-labelledby="pipeline-title">
            <div className="section-heading">
              <div>
                <Activity size={16} aria-hidden="true" />
                <h3 id="pipeline-title">Pipeline</h3>
              </div>
              <span>8 etapas</span>
            </div>
            <ol className="stage-grid">
              {PIPELINE_STAGES.map((stage, index) => {
                const Icon = STAGE_ICONS[stage];
                const brand = STAGE_BRANDS[stage];
                const state = stageStateFor(stage, run);
                const operationalMessage =
                  (state === "active" || state === "testing") && latestEvent?.stage === stage
                    ? latestEvent.message
                    : stageStateLabel(state);
                return (
                  <li
                    className={`stage-cell ${state}`}
                    key={stage}
                    aria-current={state === "active" || state === "testing" ? "step" : undefined}
                  >
                    <div className="stage-index">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <i>
                        <StageStatusIcon state={state} />
                      </i>
                    </div>
                    {brand ? (
                      <span className="stage-brand" title={`${brand.alt} / asset oficial`}>
                        <img src={brand.src} alt={`${brand.alt} logo`} />
                      </span>
                    ) : (
                      <span className="stage-icon" aria-hidden="true">
                        <Icon size={18} />
                      </span>
                    )}
                    <div>
                      <strong>{STAGE_LABELS[stage]}</strong>
                      <span
                        className="stage-state-copy"
                        title={operationalMessage}
                        aria-live={state === "active" || state === "testing" ? "polite" : undefined}
                      >
                        {operationalMessage}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="activity-section" aria-labelledby="activity-title">
            <div className="section-heading">
              <div>
                <Clock3 size={16} aria-hidden="true" />
                <h3 id="activity-title">Actividad</h3>
              </div>
              <span>{events.length} eventos</span>
            </div>

            {streamError ? (
              <div className="stream-notice" role="status">
                <AlertCircle size={15} aria-hidden="true" />
                {streamError}
              </div>
            ) : null}

            <div className="activity-feed" aria-live="polite" aria-relevant="additions">
              {activity.length === 0 ? (
                <div className="empty-state compact">
                  <Activity size={20} aria-hidden="true" />
                  <strong>Sin actividad</strong>
                  <span>{run ? "Esperando eventos" : "Esperando un run"}</span>
                </div>
              ) : (
                activity.map((item) => (
                  <article className={`activity-row ${item.status}`} key={`${item.runId}:${item.id}`}>
                    <time dateTime={item.timestamp}>{eventTime(item.timestamp)}</time>
                    <span className="activity-marker" aria-hidden="true" />
                    <div>
                      <span>{STAGE_LABELS[item.stage]}</span>
                      <strong>{item.message}</strong>
                      {item.artifact ? <small>Artefacto: {item.artifact.label}</small> : null}
                      {item.check ? (
                        <small>
                          Check: {item.check.label} / {CHECK_LABELS[item.check.status]}
                        </small>
                      ) : null}
                    </div>
                    <b>{clampProgress(item.progress)}%</b>
                  </article>
                ))
              )}
            </div>
          </section>
        </section>

        <aside className="inspection-pane">
          <section className="output-section" aria-labelledby="output-title">
            <div className="section-heading inspection-heading">
              <div>
                <Film size={16} aria-hidden="true" />
                <h3 id="output-title">Salida</h3>
              </div>
              <span>9:16</span>
            </div>

            <div className={`video-shell ${run?.status ?? "idle"}`}>
              {run?.status === "completed" ? (
                <video
                  key={run.id}
                  controls
                  playsInline
                  preload="metadata"
                  src={`/api/runs/${encodeURIComponent(run.id)}/output`}
                  onError={() => setOutputError("El MP4 no esta disponible.")}
                  aria-label={`Video final del run ${run.id}`}
                />
              ) : (
                <div className="video-placeholder">
                  {run?.status === "failed" ? (
                    <AlertTriangle size={26} aria-hidden="true" />
                  ) : run ? (
                    <LoaderCircle className="spin" size={26} aria-hidden="true" />
                  ) : (
                    <Film size={26} aria-hidden="true" />
                  )}
                  <strong>
                    {run
                      ? run.status === "failed"
                        ? "Render interrumpido"
                        : STAGE_LABELS[run.currentStage]
                      : "Sin salida"}
                  </strong>
                  <span>{run ? `${clampProgress(run.progress)}%` : "9:16"}</span>
                </div>
              )}
              <div className="frame-corner top-left" aria-hidden="true" />
              <div className="frame-corner top-right" aria-hidden="true" />
              <div className="frame-corner bottom-left" aria-hidden="true" />
              <div className="frame-corner bottom-right" aria-hidden="true" />
            </div>
            {outputError ? (
              <div className="output-error" role="alert">
                <AlertCircle size={14} aria-hidden="true" />
                {outputError}
              </div>
            ) : null}
            <div className="output-meta">
              <span>{run ? shortRunId(run.id) : "Run -"}</span>
              <span>{run ? `${run.format.width} x ${run.format.height}` : "1080 x 1920"}</span>
            </div>
          </section>

          <section className="checks-section" aria-labelledby="checks-title">
            <div className="section-heading inspection-heading">
              <div>
                <ListChecks size={16} aria-hidden="true" />
                <h3 id="checks-title">Matriz de checks</h3>
              </div>
              <span>{run ? `${passedChecks}/${checks.length}` : `0/${checks.length}`}</span>
            </div>
            <div className={`check-matrix ${run ? "started" : "idle"}`}>
              {checks.map((check) => (
                <div className={`check-row ${run ? check.status : "idle"}`} key={check.id} title={check.detail}>
                  <CheckStatusIcon status={run ? check.status : "pending"} />
                  <div>
                    <strong>{check.label}</strong>
                    <span>{STAGE_LABELS[check.stage]}</span>
                  </div>
                  <small>{run ? CHECK_LABELS[check.status] : "No iniciado"}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="artifacts-section" aria-labelledby="artifacts-title">
            <div className="section-heading inspection-heading">
              <div>
                <Paperclip size={16} aria-hidden="true" />
                <h3 id="artifacts-title">Artefactos</h3>
              </div>
              <span>{run?.artifacts.length ?? 0}</span>
            </div>
            <div className="artifact-list">
              {run && run.artifacts.length > 0 ? (
                [...run.artifacts].reverse().map((artifact) => {
                  const Icon = artifactIcon(artifact);
                  return (
                    <a
                      className="artifact-row"
                      href={`/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}`}
                      key={artifact.id}
                      target="_blank"
                      rel="noreferrer"
                      title={artifact.relativePath}
                    >
                      <span className="artifact-icon">
                        <Icon size={15} aria-hidden="true" />
                      </span>
                      <div>
                        <strong>{artifact.label}</strong>
                        <span>
                          {artifact.kind} / {STAGE_LABELS[artifact.stage]}
                        </span>
                      </div>
                      <time dateTime={artifact.createdAt}>{eventTime(artifact.createdAt)}</time>
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  );
                })
              ) : (
                <div className="empty-state compact artifact-empty">
                  <Paperclip size={18} aria-hidden="true" />
                  <strong>Sin artefactos</strong>
                </div>
              )}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}
