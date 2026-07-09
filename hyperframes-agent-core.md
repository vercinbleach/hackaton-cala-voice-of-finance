# HyperFrames Agent Core

## Decision

El `editor-agent` gira alrededor de HyperFrames CLI. HyperFrames renderiza
HTML; nuestro agente convierte skill + assets + `edit.json` en `index.html`.

## Loop

```text
style skill + edit.json + assets + voice
-> hyperframes/index.html
-> lint --json
-> inspect --json
-> snapshot
-> render
-> raw.mp4
-> FFmpeg
-> output.mp4
```

## Comandos

Crear una plantilla de estilo una vez:

```bash
npx hyperframes init finance-news --example blank --non-interactive
```

Validar y renderizar cada proyecto:

```bash
npx hyperframes doctor --json
cd projects/{projectId}/hyperframes
npx hyperframes lint . --json
npx hyperframes inspect . --json
npx hyperframes snapshot .
npx hyperframes render --output ../renders/raw.mp4
```

Para captions, preferimos el alignment de ElevenLabs. Fallback local:

```bash
npx hyperframes transcribe voiceover.mp3 --language es --json
```

## Estado local verificado

- HyperFrames `0.7.46`: disponible.
- Node, Bun, Codex y Chrome: disponibles.
- FFmpeg/FFprobe: faltan y bloquean el render local.
- Claude CLI: no instalado; no bloquea el MVP.

## Fuente

- https://hyperframes.heygen.com/packages/cli
