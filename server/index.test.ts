import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ApiError, RunEvent, RunRecord } from "../shared/contracts";
import { createRunApi, MAX_MULTIPART_BODY_BYTES, type RunApi } from "./index";
import type { PipelineRunContext, PipelineRunner } from "./run-manager";
import { RunStore } from "./store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function projectsRoot(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "run-api-test-"));
  temporaryDirectories.push(directory);
  return resolve(directory, "projects");
}

function runForm(prompt = "Top movers de hoy"): FormData {
  const form = new FormData();
  form.set("prompt", prompt);
  return form;
}

async function postRun(api: RunApi, form: FormData): Promise<Response> {
  return api.app.request("/api/runs", { method: "POST", body: form });
}

async function responseRun(response: Response): Promise<RunRecord> {
  const body = (await response.json()) as { run: RunRecord };
  return body.run;
}

async function waitForStatus(api: RunApi, runId: string, status: RunRecord["status"]): Promise<RunRecord> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await api.app.request(`/api/runs/${runId}`);
    const run = ((await response.json()) as { run: RunRecord }).run;
    if (run.status === status) return run;
    await Bun.sleep(10);
  }
  throw new Error(`Run ${runId} did not reach ${status}.`);
}

function successfulRunner(contents = new Uint8Array([0, 1, 2, 3])): PipelineRunner {
  return {
    async runPipeline(context) {
      const outputDirectory = resolve(context.projectDirectory, "renders");
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(resolve(outputDirectory, "output.mp4"), contents);
      await context.report({
        stage: "render",
        status: "running",
        message: "Render generado",
        progress: 95,
        artifact: {
          id: "video-main",
          kind: "video",
          label: "output.mp4",
          stage: "render",
          relativePath: "renders/output.mp4",
          mimeType: "video/mp4",
          createdAt: new Date().toISOString(),
        },
      });
    },
  };
}

function persistedRun(
  id: string,
  status: RunRecord["status"],
  currentStage: RunRecord["currentStage"],
  progress: number,
): RunRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id,
    prompt: `Persisted ${status} run`,
    references: [],
    format: { width: 1080, height: 1920, fps: 30 },
    styleId: "finance-reel-v0",
    duration: { target: 30, min: 15, max: 45 },
    status,
    currentStage,
    progress,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(status === "failed" ? { failedStage: currentStage, error: "Fallo ya persistido" } : {}),
    artifacts: [],
    checks: [],
  };
}

async function persistRun(store: RunStore, run: RunRecord): Promise<void> {
  await store.createRun(run);
  await store.appendEvent(run.id, {
    stage: run.currentStage,
    status: run.status,
    message: `Estado persistido: ${run.status}`,
    progress: run.progress,
    timestamp: run.updatedAt,
  });
}

describe("Bun run API", () => {
  it("persists a multipart run, sanitized upload, events, and downloadable artifacts", async () => {
    const root = await projectsRoot();
    const api = createRunApi({ runner: successfulRunner(), projectsRoot: root });
    const form = runForm("  Top movers USA  ");
    form.append("references", JSON.stringify(["https://example.com/source"]));
    form.append(
      "uploads",
      new File([new Uint8Array([137, 80, 78, 71])], "..\\..\\chart final.png", { type: "image/png" }),
    );

    const createResponse = await postRun(api, form);
    expect(createResponse.status).toBe(202);
    const created = await responseRun(createResponse);
    expect(created.prompt).toBe("Top movers USA");
    expect(created.references.find((reference) => reference.kind === "url")?.value).toBe(
      "https://example.com/source",
    );

    const upload = created.references.find((reference) => reference.kind === "upload");
    expect(upload?.filename).toBe("chart_final.png");
    expect(upload?.value.startsWith("uploads/upload-")).toBe(true);
    expect(upload?.value.includes("..")).toBe(false);

    const completed = await waitForStatus(api, created.id, "completed");
    expect(completed.currentStage).toBe("complete");
    expect(completed.progress).toBe(100);

    const runDirectory = resolve(root, created.id);
    expect(JSON.parse(await readFile(resolve(runDirectory, "run.json"), "utf8")).status).toBe("completed");
    expect((await readFile(resolve(runDirectory, "events.ndjson"), "utf8")).trim().split(/\r?\n/).length).toBe(4);
    expect(await readdir(resolve(runDirectory, "uploads"))).toHaveLength(1);

    const artifactResponse = await api.app.request(`/api/runs/${created.id}/artifacts/video-main`);
    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await artifactResponse.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));

    const outputResponse = await api.app.request(`/api/runs/${created.id}/output`);
    expect(outputResponse.status).toBe(200);
    expect(new Uint8Array(await outputResponse.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));

    const healthResponse = await api.app.request("/api/health");
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({ status: "ok" });

    const latestResponse = await api.app.request("/api/runs/latest");
    expect(latestResponse.status).toBe(200);
    const latest = (await latestResponse.json()) as { run: RunRecord; events: unknown[] };
    expect(latest.run.id).toBe(created.id);
    expect(latest.events.length).toBeGreaterThan(0);
  });

  it("serializes concurrent creates and allows only one active run", async () => {
    const root = await projectsRoot();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const api = createRunApi({
      projectsRoot: root,
      runner: { async runPipeline() { await gate; } },
    });

    const responses = await Promise.all([postRun(api, runForm("Run one")), postRun(api, runForm("Run two"))]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([202, 409]);

    const conflict = responses.find((response) => response.status === 409)!;
    expect((await conflict.json()) as ApiError).toMatchObject({ code: "RUN_ACTIVE" });

    const accepted = responses.find((response) => response.status === 202)!;
    const run = await responseRun(accepted);
    release();
    await waitForStatus(api, run.id, "completed");
  });

  it("replays SSE after Last-Event-ID and emits heartbeats", async () => {
    const root = await projectsRoot();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const api = createRunApi({
      projectsRoot: root,
      heartbeatMs: 15,
      runner: { async runPipeline() { await gate; } },
    });

    const run = await responseRun(await postRun(api, runForm()));
    await waitForStatus(api, run.id, "running");
    const persistedEvents = await api.store.getEvents(run.id);
    expect(persistedEvents.map((event) => event.id)).toEqual([1, 2]);

    const replayResponse = await api.app.request(`/api/runs/${run.id}/events`, {
      headers: { "Last-Event-ID": "1" },
    });
    expect(replayResponse.headers.get("content-type")).toContain("text/event-stream");
    const replayReader = replayResponse.body!.getReader();
    const replay = new TextDecoder().decode((await replayReader.read()).value);
    expect(replay).toContain("id: 2");
    expect(replay).not.toContain("id: 1");
    expect(replay).not.toContain("event:");
    await replayReader.cancel();

    const heartbeatResponse = await api.app.request(`/api/runs/${run.id}/events`, {
      headers: { "Last-Event-ID": String(persistedEvents.at(-1)!.id) },
    });
    const heartbeatReader = heartbeatResponse.body!.getReader();
    const heartbeat = new TextDecoder().decode((await heartbeatReader.read()).value);
    expect(heartbeat).toBe(": heartbeat\n\n");
    await heartbeatReader.cancel();

    release();
    await waitForStatus(api, run.id, "completed");
  });

  it("retries a failed run from its failed stage with monotonic event IDs", async () => {
    const root = await projectsRoot();
    const contexts: Pick<PipelineRunContext, "resumeFrom" | "isRetry">[] = [];
    let attempt = 0;
    const runner: PipelineRunner = {
      async runPipeline(context) {
        attempt += 1;
        contexts.push({ resumeFrom: context.resumeFrom, isRetry: context.isRetry });
        await context.report({
          stage: "script",
          status: "running",
          message: "Generando guion",
          progress: 35,
        });
        if (attempt === 1) throw new Error("Fallo de guion controlado");
      },
    };
    const api = createRunApi({ runner, projectsRoot: root });

    const run = await responseRun(await postRun(api, runForm()));
    const failed = await waitForStatus(api, run.id, "failed");
    expect(failed.failedStage).toBe("script");
    expect(failed.error).toContain("Fallo de guion");

    const retryResponse = await api.app.request(`/api/runs/${run.id}/retry`, { method: "POST" });
    expect(retryResponse.status).toBe(202);
    await waitForStatus(api, run.id, "completed");

    expect(contexts).toEqual([
      { resumeFrom: "intake", isRetry: false },
      { resumeFrom: "script", isRetry: true },
    ]);
    const events = await api.store.getEvents(run.id);
    expect(events.map((event) => event.id)).toEqual(events.map((_, index) => index + 1));
    expect(events.some((event) => event.status === "queued" && event.stage === "script")).toBe(true);
  });

  it("recovers interrupted runs on restart without changing terminal runs", async () => {
    const root = await projectsRoot();
    const persistedStore = new RunStore(root);
    const activeRuns = [
      persistedRun("queued-before-restart", "queued", "intake", 0),
      persistedRun("running-before-restart", "running", "script", 42),
      persistedRun("testing-before-restart", "testing", "render", 91),
    ];
    const completedRun = persistedRun("completed-before-restart", "completed", "complete", 100);
    const failedRun = persistedRun("failed-before-restart", "failed", "voice", 55);

    for (const run of [...activeRuns, completedRun, failedRun]) await persistRun(persistedStore, run);

    const contexts: Pick<PipelineRunContext, "runId" | "resumeFrom" | "isRetry">[] = [];
    const api = createRunApi({
      projectsRoot: root,
      runner: {
        async runPipeline(context) {
          contexts.push({ runId: context.runId, resumeFrom: context.resumeFrom, isRetry: context.isRetry });
        },
      },
    });
    const publishedEvents: RunEvent[] = [];
    for (const run of activeRuns) api.events.subscribe(run.id, (event) => publishedEvents.push(event));

    for (const interrupted of activeRuns) {
      const recovered = await responseRun(await api.app.request(`/api/runs/${interrupted.id}`));
      expect(recovered).toMatchObject({
        status: "failed",
        currentStage: interrupted.currentStage,
        failedStage: interrupted.currentStage,
        progress: interrupted.progress,
      });
      expect(recovered.error).toContain("reiniciar la API");

      const events = await api.store.getEvents(interrupted.id);
      expect(events.map((event) => event.id)).toEqual([1, 2]);
      expect(events.at(-1)).toMatchObject({
        stage: interrupted.currentStage,
        status: "failed",
        progress: interrupted.progress,
      });
      expect(events.at(-1)?.message).toContain("reiniciar la API");
    }
    for (const interrupted of activeRuns) {
      expect(publishedEvents.filter((event) => event.runId === interrupted.id && event.id === 2)).toHaveLength(1);
    }

    expect(await api.store.getRun(completedRun.id)).toEqual(completedRun);
    expect(await api.store.getRun(failedRun.id)).toEqual(failedRun);
    expect((await api.store.getEvents(completedRun.id)).map((event) => event.id)).toEqual([1]);
    expect((await api.store.getEvents(failedRun.id)).map((event) => event.id)).toEqual([1]);

    const createResponse = await postRun(api, runForm("Run after restart"));
    expect(createResponse.status).toBe(202);
    const newRun = await responseRun(createResponse);
    await waitForStatus(api, newRun.id, "completed");

    const retryTarget = activeRuns[2]!;
    const retryResponse = await api.app.request(`/api/runs/${retryTarget.id}/retry`, { method: "POST" });
    expect(retryResponse.status).toBe(202);
    await waitForStatus(api, retryTarget.id, "completed");
    expect(contexts).toContainEqual({ runId: retryTarget.id, resumeFrom: "render", isRetry: true });

    const retryEvents = await api.store.getEvents(retryTarget.id);
    expect(retryEvents.map((event) => event.id)).toEqual(retryEvents.map((_, index) => index + 1));
  });

  it("returns typed errors for invalid prompt, references, uploads, and missing runs", async () => {
    const root = await projectsRoot();
    const api = createRunApi({ runner: successfulRunner(), projectsRoot: root });

    const invalidPrompt = await postRun(api, runForm("   "));
    expect(invalidPrompt.status).toBe(400);
    expect((await invalidPrompt.json()) as ApiError).toMatchObject({ code: "INVALID_PROMPT" });

    const referenceForm = runForm();
    referenceForm.set("urls", "file:///private.txt");
    const invalidReference = await postRun(api, referenceForm);
    expect(invalidReference.status).toBe(400);
    expect((await invalidReference.json()) as ApiError).toMatchObject({ code: "INVALID_REFERENCE" });

    const uploadForm = runForm();
    uploadForm.set("uploads", new File(["plain"], "notes.txt", { type: "text/plain" }));
    const invalidUpload = await postRun(api, uploadForm);
    expect(invalidUpload.status).toBe(400);
    expect((await invalidUpload.json()) as ApiError).toMatchObject({ code: "INVALID_UPLOAD" });

    const oversized = await api.app.fetch(
      new Request("http://local.test/api/runs", {
        method: "POST",
        headers: {
          "Content-Length": String(MAX_MULTIPART_BODY_BYTES + 1),
          "Content-Type": "multipart/form-data; boundary=test",
        },
        body: "--test--\r\n",
      }),
    );
    expect(oversized.status).toBe(413);
    expect((await oversized.json()) as ApiError).toMatchObject({ code: "INVALID_UPLOAD" });

    const missing = await api.app.fetch(new Request("http://local.test/api/runs/not-a-real-run"));
    expect(missing.status).toBe(404);
    expect((await missing.json()) as ApiError).toMatchObject({ code: "RUN_NOT_FOUND" });
  });
});
