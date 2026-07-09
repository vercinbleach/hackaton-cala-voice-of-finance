# Demo Roadmap

## Meta demo

Prompt/skill -> voz + graficas + animaciones -> MP4.

## Slice 1: mock real

- Input desde web.
- Mock top movers.
- `script.md` generado.
- `edit.json` generado.
- Preview muestra artefactos; no simula el render final.

## Slice 2: voz

- ElevenLabs genera `voiceover.mp3`.
- Guardar por `projectId`.
- Medir duracion con FFmpeg.

## Slice 3: graficas

- Generar charts locales desde mock/Cala.
- Guardar assets con `assetId`.
- Referenciar assets en `edit.json`.

## Slice 4: render

- El agente convierte `edit.json` en `hyperframes/index.html`.
- HyperFrames valida y renderiza `raw.mp4`.
- FFmpeg exporta `output.mp4`.

## Slice 5: QA

- Video no negro.
- Audio presente.
- Captions legibles.
- Datos con fuente.
- Duracion 45-90s.

## Trabajo por persona

- Persona A: briefs + referencias visuales.
- Persona B: QA + voces + claridad producto.
- Dev/Codex: pipeline, render, integraciones.
- Owner: decisiones de estilo/calidad.
