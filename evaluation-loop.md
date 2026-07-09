# Evaluation Loop

## Objetivo

Llegar a un video final mediante iteraciones de agentes locales.

## Principio

- Las instancias IA corren localmente por ahora.
- Cada agente evalua un aspecto concreto.
- Lo paralelizable se ejecuta en paralelo.
- Un orquestador decide cambios finales.

## Loop

```text
draft video / artefactos
-> evaluadores criticos en paralelo
-> reportes
-> orquestador prioriza
-> editor agent aplica cambios
-> render nuevo
-> repetir hasta aprobar
```

## Evaluadores

### Editorial

- Hook.
- Claridad.
- Ritmo narrativo.
- Cierre.
- No consejo financiero.

### Data / fuentes

- Datos trazables.
- Claims sin fuente.
- Fechas.
- Tickers correctos.
- Catalizadores coherentes.

### Visual

- Graficos legibles.
- Captions claros.
- Estilo consistente.
- Assets bien usados.
- No parece template generico.

### Audio

- Voz clara.
- Ritmo.
- Volumen.
- Sin cortes raros.
- Sin musica pisando voz.

### Render tecnico

- MP4 existe.
- Duracion correcta.
- Video no negro.
- Audio presente.
- Sin overflow/texto cortado.

## Paralelizacion

Despues de generar draft:

```text
editorial_eval
data_eval
visual_eval
audio_eval
technical_eval
```

corren en paralelo.

No paralelizar:

- aplicar cambios al mismo `edit.json`.
- render final.
- decision de aprobacion.

## Artefactos

```text
evaluations/
  editorial.md
  data.md
  visual.md
  audio.md
  technical.md
  decision.md
```

## Decision final

El orquestador produce:

```text
approved: true/false
required_changes:
  - cambio concreto
  - archivo afectado
  - prioridad
```

## Stop condition

Aceptar cuando:

- No hay errores P0/P1.
- Datos tienen fuente.
- Audio y video correctos.
- Estilo cumple skill.
- Owner aprueba o QA aprueba.
