# Editify

## Objetivo

Crear un agente que genere videos faceless estilo YouTube desde un brief, usando datos financieros de Cala, voz de ElevenLabs y render con HyperFrames.

Core del producto: agente editor alrededor de HyperFrames CLI.

El valor principal no es solo generar guion o voz, sino decidir y ejecutar montaje:

- Que entra y que no entra.
- Orden de escenas.
- Ritmo.
- Cortes.
- Zooms.
- Captions.
- Graficos.
- Transiciones.
- Sincronizacion voz/visual.
- Lint/inspect/render con HyperFrames CLI.

Regla de trabajo: ver `rules.md`. Solo notas high-signal.

## Idea

```text
Brief
-> Cala data
-> guion
-> voz ElevenLabs
-> escenas + visuales
-> HyperFrames
-> MP4
```

Arquitectura: multi-agent colaborativo.

- Un agente orquestador controla el flujo.
- Cada skill/agente especializado produce un artefacto.
- Los artefactos se guardan por `projectId`.
- La web muestra estado, preview y aprobaciones.

## Stack inicial

### Cala high signal

- Fuente de datos financieros.
- Debe devolver datos trazables.
- Usar para hechos, cifras, contexto y fuentes.

### GPT/Codex high signal

- Escribe el guion.
- Decide narrativa, estilo y estructura.
- Orquesta skills y herramientas.
- Genera `edit.json`.

### ElevenLabs high signal

- Genera la voz.
- Devuelve audio y, si es posible, timestamps.
- No escribe el guion.

### HyperFrames high signal

- Renderiza el video desde HTML/CSS/JS.
- Sirve para cards, captions, graficos, zooms y motion graphics.
- Core visible del producto junto con FFmpeg.

### FFmpeg high signal

- Corta, une, mide duraciones y exporta.
- Herramienta tecnica de media.
- Core media del producto junto con HyperFrames.

### Remotion high signal

- Alternativa si necesitamos React/componentes.
- No MVP salvo que HyperFrames limite.

## Estilo MVP

Faceless YouTube financiero:

- Hook en 5 segundos.
- Voz profesional.
- Graficos simples.
- Cards de ticker/datos.
- Captions cortos.
- Zooms suaves.
- Cortes cada 4-8 segundos.
- Sin recomendaciones de compra/venta.

## Archivos clave

- `brief.json`: pedido normalizado.
- `research.json`: datos de Cala.
- `script.md`: guion.
- `voiceover.mp3`: voz ElevenLabs.
- `alignment.json`: timestamps.
- `edit.json`: plan de edicion.
- `hyperframes/index.html`: fuente HyperFrames.
- `renders/output.mp4`: video final.
- `sources.md`: fuentes usadas.

## Data visual financiera

- Cala: fuente principal si trae datos + procedencia.
- SEC EDGAR: filings, fundamentals oficiales.
- FRED: macro series.
- FMP / Twelve Data / Alpha Vantage: precios, fundamentals, indicadores.
- Salida visual: charts, ticker cards, KPI cards, timelines, risk cards.

## Skills

- `finance-news-style`
- `cala-research`
- `finance-scriptwriter`
- `hyperframes-editor`

ElevenLabs, assets y render son workers deterministas, no agentes separados.

## Primer MVP

Generar un video diario de 45-90 segundos: top movers.

Tema:

- 5 acciones que mas subieron.
- 5 acciones que mas bajaron.
- Causa/catalizador breve por accion.
- Cierre: que vigilar manana.

Visuales:

- Ranking cards.
- Mini chart 1D/5D.
- % change grande.
- Headline/catalizador.
- Estilo financial-news propio, no copia literal Bloomberg.

## Interfaz MVP

Web interna simple.

Flujo:

1. Usuario escribe brief.
2. Elige skill de estilo.
3. Elige voz ElevenLabs.
4. Elige formato: 16:9 o 9:16.
5. Genera research + guion.
6. Usuario aprueba/edita guion.
7. Genera video.
8. Preview + export MP4.

Pantallas clave:

- Nuevo video.
- Research/fuentes.
- Guion editable.
- Timeline/escenas.
- Preview.
- Historial de renders.

## Pendiente

- Confirmar que Cala exacto usamos.
- Confirmar API keys.
- Elegir 16:9 o 9:16.
- Elegir voces ElevenLabs.
- Decidir si usamos stock, imagen generada o graficos propios.

## Referencias

- HyperFrames: https://hyperframes.heygen.com/introduction
- Workflow HyperFrames + ElevenLabs: https://www.mindstudio.ai/blog/ai-video-generation-workflow-hyperframes-elevenlabs
- ElevenLabs timing: https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
- Cala: https://www.cala.ai/
