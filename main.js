const { app, BrowserWindow, Tray, Menu, nativeImage, session, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

let mainWindow = null;
let tray = null;
let pythonProc = null;
let isQuitting = false;

const PYTHON_PORT = 8000;
// ─── DETECCION AUTOMATICA DEL BACKEND ─────────────────────────────────
// Orden de busqueda (primero el que gana):
//   1. JARVIS_ROOT env var (override manual)
//   2. ../JARVIS  (carpeta hermana del .exe portable)
//   3. JARVIS     (carpeta junto al .exe)
//   4. C:/JARVIS  (dev / instalacion original)
//   5. ~/JARVIS   (perfil usuario)
function findProjectRoot() {
  const fs = require('fs');
  const exeDir = path.dirname(process.execPath);
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const bootstrapBackend = path.join(appData, 'senna', 'backend');
  // Detectar entorno de desarrollo: si C:/JARVIS tiene venv/, es dev
  const devPath = 'C:/JARVIS';
  const isDevMode = fs.existsSync(path.join(devPath, 'venv', 'Scripts', 'python.exe'));

  const candidates = [
    process.env.JARVIS_ROOT,               // 1. override manual
    isDevMode ? devPath : null,            // 2. dev mode (C:/JARVIS con venv) ← PRIORIDAD
    bootstrapBackend,                      // 3. instalacion bootstrap
    path.join(exeDir, '..', 'JARVIS'),    // 4. portable: ../JARVIS desde el .exe
    path.join(exeDir, 'JARVIS'),           // 5. junto al .exe
    devPath,                                // 6. C:/JARVIS sin venv (fallback)
    path.join(process.env.USERPROFILE || '', 'JARVIS'),
    path.join(__dirname, '..', 'JARVIS'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const mainPy = path.join(c, 'main.py');
      const apiPy = path.join(c, 'api_server.py');
      if (fs.existsSync(mainPy) && fs.existsSync(apiPy)) {
        console.log('[Electron] Backend encontrado en:', c);
        return c;
      }
    } catch (e) {}
  }
  console.log('[Electron] Backend NO encontrado (buscado en ' + candidates.length + ' ubicaciones)');
  return null;  // indica que hay que hacer bootstrap
}

function findPythonExe(root) {
  if (!root) return null;
  const fs = require('fs');
  // Caso 1: venv de desarrollo
  const venvPy = path.join(root, 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPy)) return venvPy;
  // Caso 2: instalacion bootstrap (python vive al lado de backend/)
  const parentPy = path.join(path.dirname(root), 'python', 'python.exe');
  if (fs.existsSync(parentPy)) return parentPy;
  return null;
}

// Hook de desarrollo: fuerza el modo setup (sin tocar C:\JARVIS)
const FORCE_SETUP = process.env.SENNA_FORCE_SETUP === '1';
const PROJECT_ROOT = FORCE_SETUP ? null : findProjectRoot();
const PYTHON_EXE = findPythonExe(PROJECT_ROOT);
if (FORCE_SETUP) console.log('[Electron] SENNA_FORCE_SETUP=1 — modo setup forzado');
console.log('[Electron] PROJECT_ROOT =', PROJECT_ROOT);
console.log('[Electron] PYTHON_EXE =', PYTHON_EXE);

// Require del bootstrap (para la primera ejecucion)
const bootstrap = require('./bootstrap');


function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}


async function waitForPort(port, timeout = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isPortOpen(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}


let telegramProc = null;

async function startPython() {
  // 1. API server
  if (await isPortOpen(PYTHON_PORT)) {
    console.log('[Electron] Servidor ya corriendo en puerto', PYTHON_PORT);
  } else {
    console.log('[Electron] Iniciando API server...');
    pythonProc = spawn(PYTHON_EXE, [
      '-m', 'uvicorn', 'api_server:app',
      '--port', String(PYTHON_PORT),
      '--log-level', 'warning'
    ], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      detached: false,
    });

    pythonProc.stdout.on('data', d => console.log('[API]', d.toString().trim()));
    pythonProc.stderr.on('data', d => console.log('[API ERR]', d.toString().trim()));
    pythonProc.on('exit', code => console.log('[API] Proceso terminado con código', code));

    console.log('[Electron] Esperando al API server...');
    const ok = await waitForPort(PYTHON_PORT);
    console.log('[Electron] API server listo:', ok);
    if (!ok) return false;
  }

  // 2. Bot de Telegram (en segundo plano)
  // IMPORTANTE: matar cualquier instancia previa para evitar conflictos
  // de getUpdates (telegram.error.Conflict).
  console.log('[Electron] Limpiando bots de Telegram huerfanos...');
  try {
    const { execSync } = require('child_process');
    // Busca procesos python cuyo command line contenga "telegram_bot"
    const psCmd = 'Get-CimInstance Win32_Process -Filter "Name=\'python.exe\'" | ' +
                  'Where-Object { $_.CommandLine -like \'*telegram_bot*\' } | ' +
                  'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    execSync('powershell -NoProfile -Command "' + psCmd.replace(/"/g, '\"') + '"', {
      windowsHide: true,
      timeout: 5000,
    });
    console.log('[Electron] Limpieza de Telegram OK');
  } catch(e) {
    console.log('[Electron] Limpieza Telegram (no habia nada o fallo):', e.message);
  }

  console.log('[Electron] Iniciando bot de Telegram...');
  telegramProc = spawn(PYTHON_EXE, [
    '-m', 'integrations.telegram_bot'
  ], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    detached: false,
  });

  telegramProc.stdout.on('data', d => console.log('[TG]', d.toString().trim()));
  telegramProc.stderr.on('data', d => console.log('[TG ERR]', d.toString().trim()));
  telegramProc.on('exit', code => console.log('[TG] Proceso terminado con código', code));

  return true;
}


function stopPython() {
  console.log('[Electron] Deteniendo servicios...');
  if (pythonProc && !pythonProc.killed) {
    try {
      spawn('taskkill', ['/pid', pythonProc.pid, '/f', '/t'], { windowsHide: true });
    } catch(e) {
      try { pythonProc.kill(); } catch(e2) {}
    }
  }
  if (telegramProc && !telegramProc.killed) {
    try {
      spawn('taskkill', ['/pid', telegramProc.pid, '/f', '/t'], { windowsHide: true });
    } catch(e) {
      try { telegramProc.kill(); } catch(e2) {}
    }
  }
}


// ─── AUTO-UPDATE ──────────────────────────────────────────────────────
// Configura electron-updater para actualizaciones desde GitHub Releases.
// Los eventos se envian a la ventana para que la UI muestre el estado.

function setupAutoUpdater() {
  // Solo en produccion (app empaquetada)
  if (!app.isPackaged) {
    console.log('[Updater] Modo dev: auto-update desactivado');
    return;
  }

  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Buscando actualizaciones...');
    sendUpdaterStatus('checking');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Actualizacion disponible:', info.version);
    sendUpdaterStatus('available', info.version);
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[Updater] Sin actualizaciones. Version actual:', info.version);
    sendUpdaterStatus('not-available', info.version);
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err);
    sendUpdaterStatus('error', err.message);
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log('[Updater] Descargando:', progress.percent.toFixed(1), '%');
    sendUpdaterStatus('downloading', progress.percent.toFixed(1));
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Actualizacion descargada:', info.version);
    sendUpdaterStatus('downloaded', info.version);
    if (tray) {
      tray.displayBalloon({
        title: 'Senna - Actualizacion lista',
        content: 'La version ' + info.version + ' se instalara al reiniciar.',
      });
    }
    dialog.showMessageBox({
      type: 'info',
      title: 'Actualizacion lista',
      message: 'Senna ' + info.version + ' esta lista para instalarse.',
      detail: 'Se instalara la proxima vez que reinicies. ¿Reiniciar ahora?',
      buttons: ['Reiniciar ahora', 'Mas tarde'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) {
        isQuitting = true;
        stopPython();
        autoUpdater.quitAndInstall();
      }
    });
  });

  // Comprobar al arrancar (con delay de 10s para no bloquear)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => console.error('[Updater] Check fallo:', err));
  }, 10000);

  // Comprobar cada 6 horas
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(err => console.error('[Updater] Check fallo:', err));
  }, 6 * 60 * 60 * 1000);
}


function sendUpdaterStatus(status, data = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', { status, data });
  }
}


function checkForUpdatesManually() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Auto-update',
      message: 'Auto-update solo funciona en la version empaquetada.',
      detail: 'Estas ejecutando Senna en modo desarrollo.',
    });
    return;
  }
  autoUpdater.checkForUpdates().catch(err => {
    dialog.showMessageBox({
      type: 'error',
      title: 'Error de actualizacion',
      message: 'No se pudo comprobar: ' + err.message,
    });
  });
}

// senna-devtools-handler
const { globalShortcut } = require('electron');
app.whenReady().then(() => {
  // F12 y Ctrl+Shift+I abren DevTools en la ventana activa
  globalShortcut.register('F12', () => {
    const w = BrowserWindow.getFocusedWindow() || mainWindow;
    if (w) w.webContents.toggleDevTools();
  });
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    const w = BrowserWindow.getFocusedWindow() || mainWindow;
    if (w) w.webContents.toggleDevTools();
  });
});

let setupWindow = null;

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 720,
    height: 620,
    resizable: false,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#0a0908',
    webPreferences: {
      preload: path.join(__dirname, 'preload-setup.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWindow.loadFile('setup.html');
  setupWindow.on('closed', () => { setupWindow = null; });
}

// ─── IPC handlers para la ventana de setup ───
function sendSetupProgress(data) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.webContents.send('setup-progress', data);
  }
}

ipcMain.on('setup-quit', () => {
  app.quit();
});

ipcMain.on('setup-retry', async () => {
  const result = await bootstrap.installAll(sendSetupProgress);
  if (result.ok) {
    sendSetupProgress({ log: 'Iniciando Senna...', type: 'ok' });
    setTimeout(() => {
      if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.close();
      }
      // Recargar PROJECT_ROOT (ahora el backend ya existe)
      app.relaunch();
      app.exit(0);
    }, 1500);
  }
});

ipcMain.on('setup-launch', () => {
  // Cerrar setup y relanzar la app limpia
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
  }
  app.relaunch();
  app.exit(0);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Jarvis — Asistente',
    backgroundColor: '#0a0908',
    icon: path.join(__dirname, 'assets', 'jarvis.ico'),
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${PYTHON_PORT}/`);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}


function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'jarvis.ico');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar Senna', click: () => mainWindow.show() },
    { label: 'Ocultar', click: () => mainWindow.hide() },
    { type: 'separator' },
    { label: 'Buscar actualizaciones', click: () => checkForUpdatesManually() },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        isQuitting = true;
        stopPython();
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Jarvis — Asistente');
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}


// ─── IPC HANDLERS ─────────────────────────────────────────────────────
// Permiten a la UI (frontend) interactuar con el updater y la app.

ipcMain.on('check-for-updates', () => {
  checkForUpdatesManually();
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});


app.whenReady().then(async () => {
  // IMPORTANTE: permitir micrófono automáticamente (Solicitudes)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'mediaKeySystem') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // IMPORTANTE: verificación de permisos de micrófono
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'audioCapture') return true;
    return false;
  });

  // ─── Decidir flujo: setup (primera vez) o app normal ───
  if (!PROJECT_ROOT || !PYTHON_EXE) {
    console.log('[Electron] Primera ejecucion detectada. Abriendo setup...');
    createSetupWindow();
    // Arrancar el bootstrap en cuanto la ventana este lista
    setupWindow.webContents.once('did-finish-load', () => {
      bootstrap.installAll(sendSetupProgress).then((result) => {
        if (result.ok) {
          sendSetupProgress({ log: 'Todo listo. Pulsa "Iniciar Senna"', type: 'ok', done: true });
        }
      });
    });
    return;  // no arrancar python todavia
  }

  await startPython();
  createWindow();
  createTray();
  setupAutoUpdater();
});


app.on('window-all-closed', () => {
  // No cerrar, quedarse en bandeja
});


app.on('before-quit', () => {
  isQuitting = true;
  stopPython();
});


app.on('will-quit', () => {
  stopPython();
});