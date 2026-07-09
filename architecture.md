# Architecture

## Web

App interna para operar la pipeline.

Entrada principal:

- Tematica.
- Referencias.
- Skill de estilo.
- Formato.
- Voz.

Pantallas:

- Nuevo video.
- Research.
- Guion.
- Escenas/timeline.
- Assets.
- Preview.
- Renders.

## Backend

API propia.

Responsabilidades:

- Crear `projectId`.
- Guardar brief/assets.
- Lanzar jobs.
- Llamar APIs externas.
- Exponer estado a la web.
- Servir previews y outputs.

## GPT/Codex demo

Para la demo, GPT opera via terminales Codex locales con la sesion del usuario.

Uso:

- Codex lee brief, referencias y artefactos.
- Codex ejecuta comandos locales.
- Codex genera/edita `research.json`, `script.md`, `edit.json` y `composition.html`.
- La web muestra artefactos y estados.

No tratar GPT como API externa en la demo.

## ElevenLabs demo

Env:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`

Uso:

- Generar `voiceover.mp3`.
- Guardar audio en carpeta del `projectId`.
- Usar timestamps/alignment si el endpoint elegido lo permite.
- FFmpeg queda como dependencia local para media.

## Workers

Jobs por etapa:

- `research`: Cala.
- `script`: GPT.
- `voice`: ElevenLabs.
- `assets`: charts/stock/generacion.
- `edit`: crea `edit.json`.
- `render`: HyperFrames.
- `postprocess`: FFmpeg.
- `qa`: checks finales.

## Storage

Local en MVP. Cloud despues.

```text
projects/{projectId}/
  brief.json
  research.json
  script.md
  voiceover.mp3
  alignment.json
  edit.json
  assets/
  composition.html
  output.mp4
  sources.md
```

## Recursos

Todo recurso se referencia por `assetId`, no por texto libre.

```json
{
  "assetId": "chart_nvda_1d",
  "type": "chart",
  "path": "assets/chart_nvda_1d.png",
  "source": "cala",
  "metadata": {
    "ticker": "NVDA",
    "range": "1D"
  }
}
```

## `edit.json`

Fuente de verdad de la edicion.

```json
{
  "format": "16:9",
  "duration": 58,
  "scenes": [
    {
      "id": "s01",
      "start": 0,
      "duration": 5,
      "voice": "Estas fueron las acciones que mas se movieron hoy.",
      "visuals": ["market_bg", "ticker_strip"],
      "effects": ["zoom_in", "caption_pop"]
    }
  ]
}
```

## Render

HyperFrames lee:

- `edit.json`
- assets
- voiceover
- alignment

Genera:

- `composition.html`
- `raw.mp4`

FFmpeg genera:

- `output.mp4`

## Local vs cloud

MVP local:

- Web local.
- Backend local.
- Storage local.
- FFmpeg local.
- HyperFrames local/API.
- APIs externas: Cala, GPT, ElevenLabs.

Produccion:

- Storage S3/R2.
- Queue.
- Workers.
- DB.
- Renders aislados.
- CDN para previews.
