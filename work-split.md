# Work Split

## Owner

- Elegir formato inicial: `9:16` recomendado para la demo.
- Aprobar una voz y una referencia visual principal.
- Aprobar el primer brief top movers.

## Persona 1: estilo y referencias

No tecnico.

- Seleccionar 5 videos de referencia.
- Marcar timestamps: hook, grafico, caption, corte y cierre.
- Entregar colores, tipografia, ritmo y ejemplos buenos/malos.
- Redactar el contenido inicial de la skill `finance-news`.

Entrega: un pack de referencias suficientemente preciso para reproducir el
estilo sin copiar una marca.

## Persona 2: contenido y voz

No tecnico.

- Probar 3 voces ElevenLabs y elegir 2 finalistas.
- Preparar 5 prompts reales de top movers.
- Comprobar ticker, porcentaje, catalizador y fuente.
- Revisar guion y pronunciacion antes de render.

Entrega: prompts de prueba + tabla de voz + correcciones factuales.

## Dev / Codex

- Instalar FFmpeg/FFprobe y cerrar `hyperframes doctor`.
- Crear storage local y contratos JSON.
- Implementar orquestador Bun.
- Integrar Cala, ElevenLabs y Codex CLI.
- Implementar style pack + `edit.json` + HyperFrames.
- Conectar Vite al estado y al MP4 final.

## Primer sprint

1. Un brief fijo genera research real de Cala.
2. El guion genera voz real de ElevenLabs.
3. Dos charts y un asset de referencia entran por `assetId`.
4. HyperFrames genera un video vertical de 30-45 segundos.
5. La web reproduce el MP4 generado, sin preview hardcodeado.

Definition of done: un comando local y el boton web producen el mismo
`renders/output.mp4` desde una carpeta vacia de proyecto.
