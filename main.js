const { app, BrowserWindow, Tray, Menu, nativeImage, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

let mainWindow = null;
let tray = null;
let pythonProc = null;
let isQuitting = false;

const PYTHON_PORT = 8000;
const PROJECT_ROOT = 'C:/JARVIS';
const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');


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


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Jarvis — Asistente',
    backgroundColor: '#0a0908',
    icon: path.join(__dirname, 'assets', 'jarvis.ico'),
    autoHideMenuBar: true,
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
    { label: 'Mostrar Jarvis', click: () => mainWindow.show() },
    { label: 'Ocultar', click: () => mainWindow.hide() },
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

  await startPython();
  createWindow();
  createTray();
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