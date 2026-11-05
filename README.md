# Bkool Control

App web para controlar la resistencia de la **Bkool Smart Bike** desde el móvil:
cambio virtual (niveles 1-20), modo ERG (vatios fijos), pulsómetro, cronómetro y
archivo para subir a Strava.

## Dónde funciona

- **Android:** Chrome.
- **iPhone:** la app gratuita **Bluefy** (Safari no permite Bluetooth).
- **PC con Windows:** Chrome, si el PC tiene Bluetooth.

## Probarla en el PC

Necesitas Node.js (versión 22 o superior). En esta carpeta:

```
npm start
```

Abre http://localhost:8080 en Chrome.

## Comprobaciones (para desarrollo)

```
npm test         # pruebas automáticas
npm run check    # formato y errores de estilo
```

Descripción completa: `02-DOCS/wiki/sdd/specs/bkool-control.md`.
