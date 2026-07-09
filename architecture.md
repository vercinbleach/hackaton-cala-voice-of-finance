# Architecture

## Decision MVP

Pipeline local, CLI-first y ligera.

- Vite: recoge prompt, referencias, uploads, estilo, voz y formato.
- Bun/TypeScript: API local + orquestador.
- Codex CLI: agentes de research, guion y edicion.
- Cala y ElevenLabs: APIs externas.
- HyperFrames CLI + FFmpeg: composicion y MP4.

No necesitamos colas, base de datos ni microservicios para la demo.

## Modelo multiagente

Los agentes no conversan entre ellos. Intercambian archivos por `projectId`;
el orquestador controla dependencias, reintentos y estado.

- `research-agent`: consulta Cala y conserva fuentes.
- `script-agent`: convierte research + brief en guion.
- `editor-agent`: aplica la skill de estilo y crea `edit.json` + HyperFrames.
- `asset-worker`: ingesta, OCR/analisis y genera charts.
- `voice-worker`: genera voz y alignment con ElevenLabs.
- `render-worker`: ejecuta HyperFrames y FFmpeg.

Solo los tres primeros necesitan razonamiento. Los workers deben ser
deterministas.

## Flujo

```text
prompt + referencias + uploads
-> crear projectId y normalizar brief
-> [Cala research || ingesta/analisis de referencias]
-> guion
-> [voz ElevenLabs || charts/assets visuales]
-> edit.json
-> HyperFrames index.html
-> lint + inspect + snapshot + render
-> FFmpeg final
-> output.mp4 en la web
```

Paralelo:

- Cala y analisis de referencias.
- Voz y generacion de assets, despues del guion.

Secuencial:

- Guion espera research.
- Edicion espera voz, alignment y assets.
- Render espera `edit.json` e `index.html`.

## Skill vs edit vs render

```text
style skill = reglas reutilizables
edit.json   = decisiones para este video
index.html  = implementacion renderizable
output.mp4  = resultado
```

HyperFrames no lee `edit.json` directamente. El `editor-agent` lo transforma
en codigo HyperFrames.

```text
styles/{styleId}/
  SKILL.md
  style.json
  template/
  references/
```

## Storage local

```text
asset-library/
  originals/{sha256}.{ext}
  generated/
  manifest.json

projects/{projectId}/
  run.json
  brief.json
  references.json
  research.json
  sources.md
  script.md
  asset-manifest.json
  assets/
  voiceover.mp3
  alignment.json
  edit.json
  hyperframes/index.html
  renders/raw.mp4
  renders/output.mp4
```

`asset-library` es el repositorio comun local. Git guarda codigo, skills y
fixtures pequenos; no uploads ni renders. En cloud se sustituye por S3/R2 sin
cambiar los `assetId`.

## API local minima

- `POST /api/projects`: crea proyecto y guarda brief.
- `POST /api/projects/:id/assets`: sube/registra assets.
- `POST /api/projects/:id/run`: inicia o reanuda pipeline.
- `GET /api/projects/:id`: estado y artefactos.
- `GET /api/projects/:id/output`: devuelve el MP4.

La web consulta `run.json`; SSE puede llegar despues.

## Adapter de agente

El orquestador usa un contrato comun:

```ts
runAgent({ role, skillPath, inputFiles, outputFile, schema })
```

Primero: Codex CLI local. Despues: adapter Claude CLI o AI SDK sin tocar la
pipeline.
