# Pipeline

## Objetivo

Convertir un brief financiero en un MP4.

## Flujo MVP

```text
1. Brief
2. Research data
3. Guion
4. Voz
5. Edit plan
6. Render visual
7. Export MP4
8. QA
```

## Artefactos

```text
projects/{projectId}/
  brief.json
  research.json
  script.md
  voiceover.mp3
  alignment.json
  edit.json
  composition.html
  output.mp4
  sources.md
```

## Responsabilidades

- Vite web: operar pipeline.
- Codex/GPT: guion + edit plan.
- Cala: data financiera.
- ElevenLabs: voz.
- HyperFrames: visual/animacion.
- FFmpeg: media/export.

## Primer target

Top movers diario:

- 5 subidas.
- 5 bajadas.
- % cambio.
- mini chart.
- catalizador.
- que vigilar manana.
