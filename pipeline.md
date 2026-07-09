# Pipeline

## Objetivo

Convertir un brief financiero en un MP4 reproducible.

## Flujo MVP

```text
1. Prompt + estilo + referencias + uploads
2. Cala research || ingesta/analisis de assets
3. Guion
4. Voz ElevenLabs || charts/assets visuales
5. Edit plan
6. Codigo HyperFrames
7. Lint + inspect + snapshot + render
8. FFmpeg + entrega MP4
```

## Contratos

- `brief.json`: pedido normalizado.
- `research.json` + `sources.md`: hechos trazables de Cala.
- `script.md`: texto final de locucion.
- `asset-manifest.json`: assets por `assetId` y procedencia.
- `voiceover.mp3` + `alignment.json`: voz y tiempos.
- `edit.json`: escenas, timings, visuales y efectos.
- `hyperframes/index.html`: composicion ejecutable.
- `renders/output.mp4`: entrega.

Cada etapa valida su salida antes de desbloquear la siguiente. Si falla, se
reanuda desde el ultimo artefacto valido.

## Primer target

Top movers diario:

- 5 subidas y 5 bajadas.
- Porcentaje y mini chart.
- Catalizador con fuente.
- Que vigilar manana.

Los evaluadores quedan fuera del primer corte; primero cerramos una generacion
end-to-end.
