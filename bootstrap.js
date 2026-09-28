// ─── bootstrap.js ──────────────────────────────────────────────
// Logica de instalacion automatica del backend de Senna.
// Se ejecuta la primera vez que el usuario abre Senna.
// ───────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execSync } = require('child_process');
const { app } = require('electron');

const SENNA_DIR = path.join(app.getPath('userData'));
const BACKEND_DIR = path.join(SENNA_DIR, 'backend');
const DOWNLOAD_DIR = path.join(SENNA_DIR, 'downloads');
const PYTHON_DIR = path.join(SENNA_DIR, 'python');

const BACKEND_ZIP_URL = 'https://github.com/RafaelCort25/jarvis-asistente/archive/refs/heads/main.zip';
const PYTHON_EMBED_URL = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip';
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

// Modelos Ollama que se descargan por defecto (los mas importantes)
const OLLAMA_MODELS = [
  { id: 'llama3.2:3b', size: '2 GB', desc: 'Chat rapido (default)' },
  { id: 'qwen2.5-coder:7b', size: '4.7 GB', desc: 'Codigo y documentos' },
  { id: 'nomic-embed-text', size: '274 MB', desc: 'Embeddings para RAG' },
  { id: 'qwen2.5vl:7b', size: '6 GB', desc: 'Vision (el mejor)' },
];

// Tamano total descargable (para mostrar al usuario)
const MODELOS_TOTAL_MB = 13000;

// ─── Utilidades ──────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg, type = '') {
  console.log('[bootstrap]', msg);
  return { log: msg, type };
}

function step(name, percent) {
  return { step: name, percent };
}

async function downloadFile(url, dest, onProgress, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await downloadFileOnce(url, dest, onProgress);
    } catch (e) {
      if (attempt < retries) {
        console.log('[bootstrap] Reintentando descarga (' + attempt + '/' + retries + '):', e.message);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      } else {
        throw e;
      }
    }
  }
}

function downloadFileOnce(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error('HTTP ' + res.statusCode + ' on ' + url));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && total > 0) {
          onProgress((downloaded / total) * 100, downloaded, total);
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    }).on('error', (e) => {
      try { file.close(); } catch (_) {}
      try { fs.unlinkSync(dest); } catch (_) {}
      reject(e);
    });
  });
}

function unzip(zipPath, destDir) {
  ensureDir(destDir);
  // Windows 10+ tiene tar.exe (que extrae .zip)
  execSync(`tar -xf "${zipPath}" -C "${destDir}"`, { windowsHide: true, stdio: 'ignore' });
}

// ─── Fases del bootstrap ──────────────────────────────────────

async function ensurePython(onProgress) {
  const pythonExe = path.join(PYTHON_DIR, 'python.exe');
  if (fs.existsSync(pythonExe)) {
    onProgress({ ...step('Python listo', 100), ...log('Python ya instalado', 'ok') });
    return pythonExe;
  }

  onProgress({ ...step('Descargando Python', 0), ...log('Descargando Python embeddable...') });
  ensureDir(PYTHON_DIR);
  const zipPath = path.join(DOWNLOAD_DIR, 'python-embed.zip');
  await downloadFile(PYTHON_EMBED_URL, zipPath, (p) => {
    onProgress({ ...step('Descargando Python', Math.round(p * 0.5)), log: '' });
  });

  onProgress({ ...step('Extrayendo Python', 75), ...log('Extrayendo Python...') });
  unzip(zipPath, PYTHON_DIR);
  try { fs.unlinkSync(zipPath); } catch (_) {}

  // Habilitar "import site" en el _pth
  const pthFiles = fs.readdirSync(PYTHON_DIR).filter(f => f.endsWith('._pth'));
  for (const f of pthFiles) {
    const pthPath = path.join(PYTHON_DIR, f);
    let content = fs.readFileSync(pthPath, 'utf8');
    content = content.replace('#import site', 'import site');
    fs.writeFileSync(pthPath, content);
  }

  onProgress({ ...step('Python listo', 100), ...log('Python instalado', 'ok') });
  return pythonExe;
}

async function ensurePip(pythonExe, onProgress) {
  onProgress({ ...step('Instalando pip', 0), ...log('Instalando pip...') });
  const getPipPath = path.join(DOWNLOAD_DIR, 'get-pip.py');
  await downloadFile(GET_PIP_URL, getPipPath, () => {});
  try {
    execSync(`"${pythonExe}" "${getPipPath}" --no-warn-script-location`, {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (e) {
    onProgress({ ...step('Instalando pip', 100), ...log('Error instalando pip: ' + e.message, 'error') });
    throw e;
  }
  try { fs.unlinkSync(getPipPath); } catch (_) {}
  onProgress({ ...step('pip listo', 100), ...log('pip instalado', 'ok') });
}

async function ensureBackend(onProgress) {
  if (fs.existsSync(path.join(BACKEND_DIR, 'api_server.py'))) {
    onProgress({ ...step('Backend listo', 100), ...log('Backend ya presente', 'ok') });
    return;
  }

  onProgress({ ...step('Descargando Senna', 0), ...log('Descargando backend de Senna...') });
  ensureDir(BACKEND_DIR);
  ensureDir(DOWNLOAD_DIR);
  const zipPath = path.join(DOWNLOAD_DIR, 'backend.zip');
  await downloadFile(BACKEND_ZIP_URL, zipPath, (p) => {
    onProgress({ ...step('Descargando Senna', Math.round(p * 0.6)), log: '' });
  });

  onProgress({ ...step('Extrayendo Senna', 70), ...log('Extrayendo backend...') });
  const tmpDir = path.join(DOWNLOAD_DIR, '_extract');
  ensureDir(tmpDir);
  unzip(zipPath, tmpDir);

  // El ZIP contiene "jarvis-asistente-main/"
  const extracted = path.join(tmpDir, 'jarvis-asistente-main');
  if (!fs.existsSync(extracted)) {
    throw new Error('Estructura del ZIP inesperada');
  }

  // Mover a BACKEND_DIR
  fs.cpSync(extracted, BACKEND_DIR, { recursive: true, force: true });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.unlinkSync(zipPath); } catch (_) {}

  onProgress({ ...step('Backend listo', 100), ...log('Backend instalado', 'ok') });
}

async function installDeps(pythonExe, onProgress) {
  const reqFile = path.join(BACKEND_DIR, 'requirements.txt');
  if (!fs.existsSync(reqFile)) {
    onProgress({ ...step('Sin dependencias', 100), ...log('No hay requirements.txt', 'error') });
    return;
  }

  onProgress({ ...step('Instalando dependencias', 0), ...log('Instalando dependencias (2-3 min)...') });

  return new Promise((resolve, reject) => {
    const proc = spawn(
      pythonExe,
      ['-m', 'pip', 'install', '-r', reqFile, '--no-warn-script-location'],
      { cwd: BACKEND_DIR, windowsHide: true }
    );

    let lastLog = '';
    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      if (lines.length) lastLog = lines[lines.length - 1].slice(0, 100);
    });
    proc.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      if (lines.length) lastLog = lines[lines.length - 1].slice(0, 100);
    });

    // Como no tenemos % real, mostramos progreso simulado con log
    let fakePercent = 0;
    const iv = setInterval(() => {
      fakePercent = Math.min(fakePercent + 2, 95);
      onProgress({ step: 'Instalando dependencias', percent: fakePercent, log: lastLog });
    }, 1500);

    proc.on('close', (code) => {
      clearInterval(iv);
      if (code === 0) {
        onProgress({ ...step('Dependencias listas', 100), ...log('Dependencias instaladas', 'ok') });
        resolve();
      } else {
        onProgress({ ...step('Error en dependencias', 100), ...log('Fallo pip: ' + lastLog, 'error') });
        reject(new Error('pip install fallo con codigo ' + code));
      }
    });
  });
}

async function ensureOllama(onProgress) {
  onProgress({ ...step('Verificando Ollama', 0), ...log('Verificando Ollama...') });
  try {
    execSync('ollama --version', { windowsHide: true, stdio: 'ignore' });
    onProgress({ ...step('Ollama OK', 100), ...log('Ollama detectado correctamente', 'ok') });
    return true;
  } catch (e) {
    onProgress({
      ...step('Instala Ollama', 0),
      ...log('Ollama no esta instalado en tu PC.', 'error'),
      type: 'need_ollama',
    });
    onProgress({
      ...step('Instala Ollama', 0),
      ...log('1. Se abrira la pagina de descarga', ''),
    });
    onProgress({
      ...step('Instala Ollama', 0),
      ...log('2. Descarga OllamaSetup.exe (~500 MB)', ''),
    });
    onProgress({
      ...step('Instala Ollama', 0),
      ...log('3. Ejecutalo (instalacion automatica, 1 min)', ''),
    });
    onProgress({
      ...step('Instala Ollama', 0),
      ...log('4. Vuelve aqui y pulsa Reintentar', ''),
    });
    return false;
  }
}

async function ensureModels(onProgress) {
  for (let i = 0; i < OLLAMA_MODELS.length; i++) {
    const m = OLLAMA_MODELS[i];
    const model = m.id;
    const basePercent = Math.round((i / OLLAMA_MODELS.length) * 100);
    onProgress({ ...step('Descargando ' + model + ' (' + m.size + ')', basePercent), ...log('Descargando modelo ' + model + ' - ' + m.desc) });

    await new Promise((resolve, reject) => {
      const proc = spawn('ollama', ['pull', model], { windowsHide: true });
      let lastLog = '';
      proc.stdout.on('data', (c) => { lastLog = c.toString().trim().slice(-80); });
      proc.stderr.on('data', (c) => { lastLog = c.toString().trim().slice(-80); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ollama pull ' + model + ' fallo'));
      });
      const iv = setInterval(() => {
        onProgress({ step: 'Descargando ' + model, percent: basePercent + 5, log: lastLog });
      }, 2000);
      proc.on('close', () => clearInterval(iv));
    });

    onProgress({ ...step(model + ' listo', Math.round(((i + 1) / OLLAMA_MODELS.length) * 100)), ...log(model + ' instalado', 'ok') });
  }
}

// ─── Orquestador ──────────────────────────────────────────────

async function installAll(onProgress) {
  // Test mode: solo verifica la UI sin descargar nada
  if (process.env.SENNA_TEST_WINDOW_ONLY === '1') {
    console.log('[bootstrap] TEST MODE - sin descargas reales');
    onProgress({ step: 'Verificando Python', percent: 15, log: 'Paso 1/5 — Python incluido en el .exe', type: 'ok' });
    await new Promise(r => setTimeout(r, 1500));
    onProgress({ step: 'Descargando Senna', percent: 35, log: 'Paso 2/5 — Descargando backend (30 MB)...' });
    await new Promise(r => setTimeout(r, 1500));
    onProgress({ step: 'Instalando dependencias', percent: 60, log: 'Paso 3/5 — Instalando dependencias pip...' });
    await new Promise(r => setTimeout(r, 1500));
    onProgress({ step: 'Verificando Ollama', percent: 80, log: 'Paso 4/5 — Ollama detectado', type: 'ok' });
    await new Promise(r => setTimeout(r, 1500));
    onProgress({ step: 'Descargando modelos', percent: 95, log: 'Paso 5/5 — Modelos IA (puede tardar 10 min)...' });
    await new Promise(r => setTimeout(r, 1500));
    onProgress({ step: 'Instalacion completa', percent: 100, log: '*** Senna listo para usar ***', type: 'ok' });
    return { ok: true, test: true };
  }

  try {
    ensureDir(SENNA_DIR);
    ensureDir(DOWNLOAD_DIR);

    onProgress({ ...step('Iniciando', 0), ...log('=== Instalacion de Senna ===') });

    const pythonExe = await ensurePython(onProgress);
    await ensurePip(pythonExe, onProgress);
    await ensureBackend(onProgress);
    await installDeps(pythonExe, onProgress);

    const ollamaOk = await ensureOllama(onProgress);
    if (!ollamaOk) {
      onProgress({ type: 'paused', log: 'Instala Ollama y pulsa Reintentar' });
      return { ok: false, reason: 'ollama-missing' };
    }

    await ensureModels(onProgress);

    onProgress({ ...step('Instalacion completa', 100), ...log('*** Senna listo para usar ***', 'ok') });
    return { ok: true };
  } catch (e) {
    onProgress({ ...step('Error', 100), ...log('ERROR: ' + e.message, 'error') });
    return { ok: false, reason: 'error', error: e.message };
  }
}

module.exports = {
  installAll,
  SENNA_DIR,
  BACKEND_DIR,
  PYTHON_DIR,
  getPythonExe: () => path.join(PYTHON_DIR, 'python.exe'),
  isBackendReady: () => fs.existsSync(path.join(BACKEND_DIR, 'api_server.py')),
};
