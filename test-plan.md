# Test Plan

## Test 1: UI demo

Objetivo: validar que la web comunica bien la pipeline.

Pasos:

```bash
npm install
npm run dev
```

Validar:

- Se entiende que es una consola, no el video final.
- Inputs claros: tematica, referencias, estilo, voz, formato.
- Preview marcada como mock.
- Timeline legible.
- Sin overflow raro en desktop/mobile.

## Test 2: Brief quality

Entrada:

```text
Top movers diario de bolsa USA. Estilo noticia financiera rapida. 60 segundos.
```

Validar:

- Hook claro.
- Audiencia clara.
- Estilo claro.
- No pide consejo financiero.

## Test 3: Script quality

Validar:

- 45-90 segundos.
- Catalizador por ticker.
- Lenguaje simple.
- No inventa datos.
- Cierre con "que vigilar".

## Test 4: Edit plan

Validar `edit.json`:

- Escenas con duracion.
- Visual por escena.
- Caption por escena.
- Efectos definidos.
- Referencias a assets por `assetId`.

## Test 5: Voice

Validar:

- `voiceover.mp3` existe.
- Voz clara.
- Ritmo financiero.
- Duracion compatible con escenas.

## Test 6: Render

Validar:

- `output.mp4` existe.
- Audio presente.
- Video no negro.
- Captions visibles.
- Graficos legibles.
- Duracion correcta.

## Definition of Done

Un demo pasa si genera:

- `script.md`
- `voiceover.mp3`
- `edit.json`
- `output.mp4`
- `sources.md`
