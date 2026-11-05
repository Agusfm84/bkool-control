# Bkool Control — design record

Written from what was built (T015, 2026-11-05) so later edits keep the look.

- **Surface / mode:** phone app screen, Operate. One question first: "¿cuánto estoy dando y a qué
  dureza voy?" → power is the largest figure; level/target right under it.
- **Colour:** one hue, power orange (`--power` #e8590c light / #ff7a2f dark), only on the power
  figure, the gear ladder and the active press. Everything else neutral. Red only for the lost-link
  banner and the confirm button. Light and dark follow the phone (`prefers-color-scheme`).
- **Type:** system UI face (no web fonts: the app makes no network requests beyond itself);
  tabular figures on every number. Power 88-128 px on purpose (read at ~60 cm while pedalling).
- **Signature element:** the 20-step gear ladder (rising ticks, lit to the current level). Hidden
  in ERG, where the bike sets the resistance; ERG shows "Objetivo N W" and "±10 W por toque".
- **Controls:** −/+ 96 px tall; workout buttons 56 px at the bottom (thumb). Pausa is the primary,
  Terminar quiet and confirmed; Descartar confirmed. Connection chips say device + state; the bike
  chip only informs, "Desconectar bici" is its own link.
- **States:** start, riding (Cambios / ERG), paused ("EN PAUSA", grey power), lost (red banner,
  live region), confirm, summary, recovered ("Entrenamiento sin guardar"), unsupported.
- **Preview:** `preview.html?state=…` renders each state with invented data.
