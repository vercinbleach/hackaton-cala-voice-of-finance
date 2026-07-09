# AI SDK + Claude

Decision:

- Podemos usar Vercel AI SDK.
- Encaja si queremos conectar varios modelos desde backend.
- Claude puede ser proveedor via Anthropic.

Uso recomendado:

- No poner claves en frontend.
- Crear backend local/API para llamadas AI.
- Web Vite solo dispara acciones y muestra estados.

Arquitectura:

```text
Vite web
-> backend local
-> AI SDK
-> Claude/OpenAI
-> artefactos del proyecto
```

Para colaboradores que usan Claude:

- Pueden trabajar en briefs, estilos, guiones y QA.
- Pueden proponer `edit.json`.
- No necesitan tocar render/media al principio.

Notas:

- AI SDK sirve para unificar proveedores.
- `@ai-sdk/anthropic` permite usar Claude.
- `@ai-sdk/react` sirve para UI conversacional si hace falta.

Referencias:

- https://ai-sdk.dev/docs/introduction
- https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
- https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat
