# Senna - Electron Wrapper

Wrapper de Electron que arranca el backend Python (FastAPI) y abre la interfaz grafica en una ventana nativa de escritorio.

## Que hace

Este proyecto es un **wrapper delgado** que:

1. Detecta el backend Python en `C:\JARVIS\`
2. Arranca `python -m uvicorn api_server:app --port 8000` en segundo plano
3. Detecta y mata instancias huerfanas del bot de Telegram (evita conflictos)
4. Abre una ventana de Electron que carga `http://127.0.0.1:8000/`
5. Gestiona auto-actualizaciones via GitHub Releases (electron-updater)

El codigo del backend (skills, router, multiagente, UI HTML) vive en el repo [jarvis-asistente](https://github.com/RafaelCort25/jarvis-asistente).

## Requisitos

- **Windows 10/11** (64 bits)
- **Python 3.10+** en `C:\JARVIS\venv\Scripts\python.exe`
- **Node.js 18+** (para desarrollo)
- **Backend clonado** en `C:\JARVIS\`

## Estructura

    jarvis-electron/
    |-- main.js              # Proceso principal de Electron
    |-- preload.js           # Bridge seguro renderer <-> main
    |-- package.json         # Deps + config de build (electron-builder)
    |-- dist/                # Instaladores generados
    |-- node_modules/

## Desarrollo

    # Instalar dependencias
    npm install

    # Arrancar en modo dev (abre una ventana con DevTools)
    npm start

    # Abrir DevTools manualmente: F12 o Ctrl+Shift+I

## Build

    # Build del instalador NSIS (Windows)
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    npm run build

Genera en `dist/`:
- `Senna-Setup-X.Y.Z.exe` (instalador NSIS)
- `Senna-Setup-X.Y.Z.exe.blockmap`
- `latest.yml` (usado por electron-updater)

## Release + Auto-update

    # 1. Bump version en package.json
    # 2. Build
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    npm run build

    # 3. Publicar a GitHub Releases (requiere GH_TOKEN con scope repo)
    $env:GH_TOKEN = "ghp_..."
    npm run release

Los usuarios con una version anterior reciben el aviso de update en 10s al abrir Senna.

## Version actual

Ver `package.json` → campo `version`. Ultima publicada: **1.3.0**.

---

**Repo relacionado:** [jarvis-asistente](https://github.com/RafaelCort25/jarvis-asistente) (backend + UI)
