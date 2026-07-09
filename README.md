# Autovideopipelinegeneration

Pipeline local para generar videos financieros faceless.

Core:

- Edicion automatica.
- Visualizaciones financieras.
- Render/media con HyperFrames + FFmpeg.

Demo actual:

- Web Vite local.
- Input: tematica, referencias, estilo, voz, formato.
- Output esperado: guion, voz, `edit.json`, preview/render.

## Setup

```bash
npm install
npm run dev
```

Abrir:

```text
http://127.0.0.1:5173/
```

## Env

Copiar `.env.example` a `.env`.

Variables:

- `CALA_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`

No subir `.env`.

## Docs

- `project.md`: decisiones clave.
- `architecture.md`: pipeline.
- `demo-video.md`: demo top movers.
- `collaborators.md`: tareas para colaboradores.
- `ai-sdk.md`: nota AI SDK + Claude.
