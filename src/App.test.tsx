import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHECKS, STAGE_LABELS, type RunEvent, type RunRecord } from "../shared/contracts";
import { App } from "./App";

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: "message" | "run", data: RunEvent) {
    const event = new MessageEvent<string>(type, { data: JSON.stringify(data) });
    if (type === "message") this.onmessage?.(event);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

function createRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const timestamp = "2026-07-09T12:00:00.000Z";
  return {
    id: "run-ui-123",
    prompt: "Resumen financiero",
    references: [],
    format: { width: 1080, height: 1920, fps: 30 },
    styleId: "finance-reel-v0",
    duration: { target: 30, min: 15, max: 45 },
    status: "queued",
    currentStage: "intake",
    progress: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    artifacts: [],
    checks: DEFAULT_CHECKS.map((check) => ({ ...check })),
    ...overrides,
  };
}

function runResponse(run: RunRecord): Response {
  return new Response(JSON.stringify({ run }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

function latestResponse(run: RunRecord | null = null, events: RunEvent[] = []): Response {
  return new Response(JSON.stringify({ run, events }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("App", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("posts multipart input and consumes named run events through completion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(latestResponse())
      .mockResolvedValueOnce(runResponse(createRun()));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(screen.getByRole("button", { name: "Crear reel" })).toBeDisabled();
    expect(screen.queryByRole("video")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Tema y enfoque"), {
      target: { value: "Explica el contexto financiero con fuentes verificables." },
    });
    fireEvent.change(screen.getByLabelText("Referencias URL Opcional"), {
      target: { value: "https://example.com/source" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Anadir referencia URL" }));

    const upload = new File(["chart"], "chart.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Archivos Opcional"), { target: { files: [upload] } });
    fireEvent.click(screen.getByRole("button", { name: "Crear reel" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = options.body as FormData;
    expect(body.get("prompt")).toBe("Explica el contexto financiero con fuentes verificables.");
    expect(body.getAll("referenceUrls")).toEqual(["https://example.com/source"]);
    expect(body.getAll("files")).toHaveLength(1);

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(MockEventSource.instances[0].url).toBe("/api/runs/run-ui-123/events?lastEventId=0");

    const researchEvent: RunEvent = {
      id: 1,
      runId: "run-ui-123",
      stage: "research",
      status: "running",
      message: "Fuentes verificadas",
      progress: 24,
      timestamp: "2026-07-09T12:00:01.000Z",
    };
    act(() => MockEventSource.instances[0].emit("run", researchEvent));

    await waitFor(() => expect(screen.getAllByText("Fuentes verificadas")).toHaveLength(2));
    expect(screen.getByRole("progressbar", { name: "Progreso del run" })).toHaveAttribute("aria-valuenow", "24");

    const completedEvent: RunEvent = {
      id: 2,
      runId: "run-ui-123",
      stage: "complete",
      status: "completed",
      message: "Reel listo",
      progress: 100,
      timestamp: "2026-07-09T12:00:02.000Z",
      artifact: {
        id: "video-main",
        kind: "video",
        label: "output.mp4",
        stage: "complete",
        relativePath: "renders/output.mp4",
        mimeType: "video/mp4",
        createdAt: "2026-07-09T12:00:02.000Z",
      },
    };
    act(() => MockEventSource.instances[0].emit("run", completedEvent));

    const video = await screen.findByLabelText("Video final del run run-ui-123");
    expect(video).toHaveAttribute("src", "/api/runs/run-ui-123/output");
    expect(screen.getByTitle("renders/output.mp4")).toHaveAttribute(
      "href",
      "/api/runs/run-ui-123/artifacts/video-main",
    );
    expect(MockEventSource.instances[0].close).toHaveBeenCalled();
  });

  it("tracks every sequential non-terminal named run event in the live pipeline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(latestResponse(createRun())));
    render(<App />);

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0];
    const events: RunEvent[] = [
      {
        id: 1,
        runId: "run-ui-123",
        stage: "research",
        status: "running",
        message: "Contrastando fuentes primarias",
        progress: 18,
        timestamp: "2026-07-09T12:00:01.000Z",
      },
      {
        id: 2,
        runId: "run-ui-123",
        stage: "script",
        status: "running",
        message: "Estructurando el guion narrativo",
        progress: 42,
        timestamp: "2026-07-09T12:00:02.000Z",
      },
      {
        id: 3,
        runId: "run-ui-123",
        stage: "voice",
        status: "running",
        message: "Generando la narracion final",
        progress: 66,
        timestamp: "2026-07-09T12:00:03.000Z",
      },
      {
        id: 4,
        runId: "run-ui-123",
        stage: "render",
        status: "running",
        message: "Componiendo el render final",
        progress: 91,
        timestamp: "2026-07-09T12:00:04.000Z",
      },
    ];

    for (const event of events) {
      act(() => source.emit("run", event));

      await waitFor(() => {
        expect(screen.getByText("Etapa actual").parentElement).toHaveTextContent(STAGE_LABELS[event.stage]);
        expect(screen.getByText("Progreso").parentElement).toHaveTextContent(`${event.progress}%`);
        expect(screen.getByRole("progressbar", { name: "Progreso del run" })).toHaveAttribute(
          "aria-valuenow",
          String(event.progress),
        );

        const activeStage = screen.getByRole("listitem", { current: "step" });
        expect(activeStage).toHaveTextContent(STAGE_LABELS[event.stage]);
        expect(within(activeStage).getByText(event.message)).toBeVisible();
      });
    }

    expect(MockEventSource.instances).toHaveLength(1);
    expect(source.close).not.toHaveBeenCalled();
  });

  it("resumes after hydrated SSE history without applying an old terminal event", async () => {
    const failed: RunEvent = {
      id: 1,
      runId: "run-ui-123",
      stage: "voice",
      status: "failed",
      message: "Fallo anterior de voz",
      progress: 46,
      timestamp: "2026-07-09T12:00:01.000Z",
    };
    const recovered: RunEvent = {
      id: 2,
      runId: "run-ui-123",
      stage: "render",
      status: "running",
      message: "Segundo intento activo",
      progress: 82,
      timestamp: "2026-07-09T12:00:02.000Z",
    };
    const activeRun = createRun({
      status: "running",
      currentStage: "render",
      progress: 82,
      updatedAt: recovered.timestamp,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(latestResponse(activeRun, [failed, recovered])));

    render(<App />);

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0];
    expect(source.url).toBe("/api/runs/run-ui-123/events?lastEventId=2");
    expect(screen.getByText("Etapa actual").parentElement).toHaveTextContent(STAGE_LABELS.render);

    act(() => source.emit("run", failed));

    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
    expect(screen.getByText("Etapa actual").parentElement).toHaveTextContent(STAGE_LABELS.render);
    expect(source.close).not.toHaveBeenCalled();
  });

  it("recovers an active run through polling when the SSE stream is silent", async () => {
    const initialRun = createRun({
      status: "running",
      currentStage: "research",
      progress: 12,
    });
    const scriptEvent: RunEvent = {
      id: 6,
      runId: "run-ui-123",
      stage: "script",
      status: "running",
      message: "Codex sigue preparando el guion (10s)",
      progress: 32,
      timestamp: "2026-07-09T12:00:10.000Z",
    };
    const updatedRun = createRun({
      status: "running",
      currentStage: "script",
      progress: 32,
      updatedAt: scriptEvent.timestamp,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(latestResponse(initialRun))
      .mockResolvedValueOnce(latestResponse(updatedRun, [scriptEvent]));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 4_500 });
    expect(screen.getByText("Etapa actual").parentElement).toHaveTextContent(STAGE_LABELS.script);
    expect(screen.getByRole("progressbar", { name: "Progreso del run" })).toHaveAttribute(
      "aria-valuenow",
      "32",
    );
    expect(screen.getAllByText(scriptEvent.message)).toHaveLength(2);
  });

  it("shows a failed run and retries it with POST", async () => {
    const failedRun = createRun({
      id: "run-failed",
      status: "failed",
      currentStage: "voice",
      failedStage: "voice",
      progress: 46,
      error: "La voz no se pudo generar.",
    });
    const retriedRun = createRun({ id: "run-failed", status: "queued", currentStage: "voice", progress: 46 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(latestResponse())
      .mockResolvedValueOnce(runResponse(failedRun))
      .mockResolvedValueOnce(runResponse(retriedRun));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(screen.getByLabelText("Tema y enfoque"), { target: { value: "Brief para retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear reel" }));

    const retryButton = await screen.findByRole("button", { name: "Reintentar" });
    expect(screen.getByText("La voz no se pudo generar.")).toBeInTheDocument();
    fireEvent.click(retryButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/runs/run-failed/retry", { method: "POST" });
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
  });

  it("restores the latest completed run and its output on load", async () => {
    const completed = createRun({
      id: "run-latest",
      status: "completed",
      currentStage: "complete",
      progress: 100,
      artifacts: [{
        id: "video-latest",
        kind: "video",
        label: "output.mp4",
        stage: "complete",
        relativePath: "renders/output.mp4",
        mimeType: "video/mp4",
        createdAt: "2026-07-09T12:00:02.000Z",
      }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(latestResponse(completed)));

    render(<App />);

    expect(await screen.findByLabelText("Video final del run run-latest")).toHaveAttribute(
      "src",
      "/api/runs/run-latest/output",
    );
    expect(await screen.findByText("API lista")).toBeInTheDocument();
  });
});
