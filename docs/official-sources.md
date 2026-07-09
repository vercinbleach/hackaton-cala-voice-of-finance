# Official Sources

Fuentes de verdad para implementar y revisar la demo.

## HyperFrames

- CLI: https://hyperframes.heygen.com/packages/cli
- Introduction: https://hyperframes.heygen.com/introduction

Validar comandos, flags, requisitos, lint, inspect, snapshot y render aqui.

## Cala

- Quickstart: https://docs.cala.ai/quickstart
- Agent skill and operating guidelines: https://docs.cala.ai/integrations/agent-skill
- Official Cala skill: https://github.com/cala-ai/cala-skill
- Structured query: https://docs.cala.ai/api-reference/query
- Sourced narrative search: https://docs.cala.ai/api-reference/search
- Entity search: https://docs.cala.ai/api-reference/search-entities
- Retrieve entity: https://docs.cala.ai/api-reference/entities

Para listas conocidas, preferir `knowledge_query`. Conservar siempre entidades,
origenes, URLs y fechas. Un timeout puede tardar hasta 180 segundos: repetir una
vez solo los timeouts; no repetir automaticamente un 429. Cala no sustituye un
feed de cotizacion al segundo.

## ElevenLabs

- Quickstart: https://elevenlabs.io/docs/eleven-api/quickstart
- Speech with timestamps: https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps

Usar el alignment de la respuesta como base de captions y escenas.

## Runtime y tests

- Hono on Bun: https://hono.dev/docs/getting-started/bun
- Hono SSE: https://hono.dev/docs/helpers/streaming
- Bun HTTP server: https://bun.com/docs/runtime/http/server
- Bun test: https://bun.com/docs/test
- Vite: https://vite.dev/guide/
- Vitest: https://vitest.dev/guide/
- Playwright: https://playwright.dev/docs/intro
- FFmpeg: https://ffmpeg.org/documentation.html

## Backend futuro

- Convex local deployments: https://docs.convex.dev/cli/local-deployments
- Convex CLI: https://docs.convex.dev/cli/overview
- Convex durable workflows: https://stack.convex.dev/durable-workflows-and-strong-guarantees

Convex queda como sustituto futuro de storage/realtime. El MVP mantiene el
worker local porque Codex CLI, HyperFrames y FFmpeg deben ejecutarse en esta
maquina.

## Regla

Si una nota local contradice estas fuentes, manda la fuente oficial y se
actualiza el codigo o la nota local.
