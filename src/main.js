// src/main.js – Electron Hauptprozess
'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

const config             = require('./config');
const db                 = require('./db/database');
const financeService     = require('./logic/financeService');
const reserveService     = require('./logic/reserveService');
const installmentService = require('./logic/installmentService');
const autoService        = require('./logic/autoService');

// ── Single-Instance-Lock ──────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── Fenster-Referenzen ────────────────────────────────────────────────────
let splashWindow = null;
let mainWindow   = null;

// ══════════════════════════════════════════════════════════════════════════
// AUTO-UPDATER
//
// REPARIERTE VERSION — behobene Probleme:
//   1. package.json owner war "DEIN-GITHUB-USERNAME" → jetzt "markuspotrafky"
//   2. electron-log wird VOR autoUpdater.logger zugewiesen und vollständig
//      konfiguriert (Pfad explizit auf app.getPath('userData')/logs/updater.log)
//   3. autoUpdater.setFeedURL() explizit gesetzt — kein Vertrauen auf asar-Lesefehler
//   4. allowPrerelease, allowDowngrade explizit gesetzt
//   5. Fallback-IPC-Handler außerhalb von initAutoUpdater registriert
//   6. Debug-Modus: UPDATE_DEBUG=1 erlaubt Test im Dev-Modus
// ══════════════════════════════════════════════════════════════════════════

// Fallback-IPC-Handler — immer registrieren, bevor initAutoUpdater läuft.
// Verhindert "No handler registered"-Crash wenn Updater-Import fehlschlägt.
ipcMain.handle('update:installNow', () => {
  console.warn('[Updater] installNow aufgerufen, aber Updater nicht initialisiert');
});

function initAutoUpdater() {
  // Debug-Modus: UPDATE_DEBUG=1 npm start → läuft auch ohne app.isPackaged
  const debugMode = process.env.UPDATE_DEBUG === '1';

  if (!app.isPackaged && !debugMode) {
    console.log('[Updater] Entwicklungsmodus — deaktiviert. (UPDATE_DEBUG=1 zum Testen)');
    return;
  }

  // ── SCHRITT 1: electron-log vollständig initialisieren ────────────────
  // MUSS vor autoUpdater.logger = log passieren, sonst kein Log-File.
  let log;
  try {
    log = require('electron-log');
  } catch (e) {
    console.error('[Updater] electron-log nicht installiert:', e.message);
    return;
  }

  // Expliziter Log-Pfad: %APPDATA%\FinanzKompass\logs\updater.log
  // app.getPath('userData') = C:\Users\<n>\AppData\Roaming\FinanzKompass
  const logDir  = path.join(app.getPath('userData'), 'logs');
  const logFile = path.join(logDir, 'updater.log');

  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    console.error('[Updater] Log-Ordner konnte nicht erstellt werden:', e.message);
  }

  log.transports.file.resolvePathFn = () => logFile;
  log.transports.file.level  = 'debug'; // 'debug' statt 'info' → mehr Infos
  log.transports.console.level = 'debug';
  log.info('[Updater] electron-log initialisiert. Logdatei:', logFile);

  // ── SCHRITT 2: electron-updater importieren ───────────────────────────
  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    log.error('[Updater] electron-updater nicht installiert:', e.message);
    return;
  }

  // ── SCHRITT 3: Logger zuweisen (nach vollständiger Konfiguration) ──────
  autoUpdater.logger = log;

  // ── SCHRITT 4: Update-Verhalten konfigurieren ─────────────────────────
  autoUpdater.autoDownload         = true;  // Hintergrund-Download
  autoUpdater.autoInstallOnAppQuit = true;  // Installation beim Beenden
  autoUpdater.allowPrerelease      = false; // Keine Pre-releases
  autoUpdater.allowDowngrade       = false; // Keine Downgrades
  autoUpdater.fullChangelog        = false;

  // ── SCHRITT 5: Feed-URL explizit setzen ───────────────────────────────
  // Nicht auf asar-Package.json-Parsing vertrauen — direkt setzen.
  // Format: https://github.com/{owner}/{repo}/releases/latest/download
  try {
    autoUpdater.setFeedURL({
      provider:    'github',
      owner:       'markuspotrafky',
      repo:        'finanzkompass',
      releaseType: 'release',
    });
    log.info('[Updater] Feed-URL gesetzt: github/markuspotrafky/finanzkompass');
  } catch (e) {
    log.error('[Updater] setFeedURL fehlgeschlagen:', e.message);
    // Nicht abbrechen — electron-updater liest ggf. trotzdem aus package.json
  }

  // ── SCHRITT 6: Events registrieren ───────────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Suche nach Updates…');
  });

  autoUpdater.on('update-available', (info) => {
    log.info(`[Updater] Update verfügbar: v${info.version} (aktuell: v${app.getVersion()})`);
    log.info('[Updater] Download startet automatisch im Hintergrund…');
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info(`[Updater] Kein Update — v${info.version} ist die aktuelle Version.`);
  });

  autoUpdater.on('download-progress', (progress) => {
    log.debug(`[Updater] Download: ${Math.round(progress.percent)}% ` +
      `(${Math.round(progress.transferred / 1024)} KB / ${Math.round(progress.total / 1024)} KB, ` +
      `${Math.round(progress.bytesPerSecond / 1024)} KB/s)`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[Updater] Update v${info.version} vollständig heruntergeladen — bereit zur Installation.`);

    // ── SCHRITT 7: Renderer benachrichtigen ──────────────────────────────
    // Fenster könnte noch nicht offen sein → mit Retry senden
    const payload = {
      version:      info.version,
      releaseNotes: info.releaseNotes || null,
    };

    const sendToRenderer = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:downloaded', payload);
        log.info('[Updater] Banner-Event an Renderer gesendet.');
        return true;
      }
      return false;
    };

    if (!sendToRenderer()) {
      // Fenster noch nicht bereit → alle 500ms nochmal versuchen (max. 30s)
      let attempts = 0;
      const retry = setInterval(() => {
        attempts++;
        if (sendToRenderer() || attempts > 60) clearInterval(retry);
      }, 500);
    }
  });

  autoUpdater.on('error', (err) => {
    // Detailliertes Logging — häufige Ursachen:
    // - Kein Netzwerk
    // - owner/repo falsch → 404
    // - latest.yml fehlt im Release
    log.error('[Updater] FEHLER:', err.message ?? err);
    log.error('[Updater] Stack:', err.stack ?? 'kein Stack');

    // Nutzer NICHT mit Dialog stören — nur loggen
    // (Netzwerkfehler sind normal wenn offline)
  });

  // ── SCHRITT 8: IPC-Handler überschreiben mit funktionierendem autoUpdater ─
  // Überschreibt den Fallback-Handler von oben
  try {
    ipcMain.removeHandler('update:installNow');
  } catch (_) {}

  ipcMain.handle('update:installNow', () => {
    log.info('[Updater] Nutzer hat Installation angefordert — quitAndInstall…');
    autoUpdater.quitAndInstall(
      false, // silent: false = zeigt Installer-Fenster (für NSIS-Installer)
      true   // forceRunAfter: true = App startet nach Install neu
    );
  });

  // ── SCHRITT 9: Update-Check starten ─────────────────────────────────
  // 5s Verzögerung: App vollständig geladen, Netzwerk verfügbar
  const delay = debugMode ? 3000 : 5000;
  setTimeout(() => {
    log.info('[Updater] Starte checkForUpdates()…');
    autoUpdater
      .checkForUpdates()
      .then(result => {
        if (result) {
          log.info('[Updater] checkForUpdates abgeschlossen:', result.updateInfo?.version ?? 'kein Ergebnis');
        }
      })
      .catch(err => {
        log.error('[Updater] checkForUpdates fehlgeschlagen:', err.message ?? err);
      });
  }, delay);

  log.info(`[Updater] Initialisierung abgeschlossen. Update-Check in ${delay / 1000}s.`);
}

// ── Splash Screen ─────────────────────────────────────────────────────────
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 400, height: 320, frame: false, resizable: false,
    center: true, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#0B0F17', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
  });
  splashWindow.loadFile(path.join(__dirname, 'ui', 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());
}

async function setSplashProgress(percent, text) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try {
    await splashWindow.webContents.executeJavaScript(
      `window.setProgress && window.setProgress(${percent}, ${JSON.stringify(text)})`
    );
  } catch (_) {}
}

// ── Haupt-Fenster ─────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    show: false, backgroundColor: '#0B0F17',
    title: 'FinanzKompass',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    maximized: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.maximize();
  return mainWindow;
}

// ── Datenbankpfad ─────────────────────────────────────────────────────────
async function resolveDbPath() {
  const saved = config.get('dbPath');
  if (saved && fs.existsSync(path.dirname(saved))) return saved;

  const result = await dialog.showMessageBox(splashWindow, {
    type: 'question', title: 'FinanzKompass – Speicherort',
    message: 'Wo soll die Datenbank gespeichert werden?',
    detail: 'Empfehlung: OneDrive- oder Sync-Ordner für automatisches Backup.',
    buttons: ['Ordner wählen', 'Standard verwenden'], defaultId: 0, cancelId: 1,
  });

  if (result.response === 0) {
    const r = await dialog.showOpenDialog(splashWindow, {
      title: 'Speicherort wählen', properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Hier speichern',
    });
    if (!r.canceled && r.filePaths.length > 0) {
      const dbFile = path.join(r.filePaths[0], 'finanzkompass.db');
      config.set('dbPath', dbFile);
      return dbFile;
    }
  }

  const def = path.join(app.getPath('userData'), 'finanzkompass.db');
  config.set('dbPath', def);
  return def;
}

// ── App-Start ─────────────────────────────────────────────────────────────
async function startApp() {
  try {
    createSplashWindow();
    await setSplashProgress(10, 'Speicherort ermitteln…');

    const dbPath = await resolveDbPath();
    await setSplashProgress(20, 'Passwort abfragen…');

    // ── Passwort-Abfrage ──────────────────────────────────────────────────
    // Passwort wird NUR im RAM gehalten — niemals auf Disk geschrieben.
    // Maximale Versuche: 3, danach App-Beendigung.
    const password = await promptPassword(dbPath);
    if (!password) {
      // Nutzer hat abgebrochen
      app.quit();
      return;
    }

    await setSplashProgress(30, 'Datenbank laden…');

    // Passwort an DB-Schicht übergeben (einmalig beim Start)
    await db.initialize(dbPath, password);
    await setSplashProgress(50, 'Datenbank bereit');

    let bookedCount = 0;
    await new Promise(resolve => setImmediate(async () => {
      try {
        await setSplashProgress(65, 'Buchungen verarbeiten…');
        bookedCount = db.processScheduled();
        await setSplashProgress(80, 'Rücklagen aktualisieren…');
        autoService.processReserves();
        await setSplashProgress(90, 'Ratenkäufe aktualisieren…');
        autoService.processInstallments();
      } catch (e) { console.error('Start-Automatik:', e); }
      resolve();
    }));

    await setSplashProgress(100, 'Bereit!');
    createMainWindow();

    await new Promise(resolve => mainWindow.once('ready-to-show', resolve));
    mainWindow.show();

    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close(); splashWindow = null;
      }
    }, 200);

    if (bookedCount > 0) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('startup:booked', bookedCount);
      }, 1000);
    }

    // Auto-Updater NACH vollständigem Laden — blockiert nichts
    initAutoUpdater();

  } catch (e) {
    console.error('Kritischer Startfehler:', e);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();

    // Falsches Passwort → freundliche Meldung, dann beenden
    const isWrongPassword = e.message?.includes('Falsches Passwort');
    await dialog.showErrorBox(
      isWrongPassword ? 'FinanzKompass – Falsches Passwort' : 'FinanzKompass – Startfehler',
      isWrongPassword
        ? 'Das eingegebene Passwort ist falsch oder die Datenbank ist beschädigt.\n\nBitte starte die App neu und versuche es erneut.'
        : `Die App konnte nicht gestartet werden:\n\n${e.message}\n\nBitte starte die App neu.`
    );
    app.quit();
  }
}

// ── Passwort-Prompt ───────────────────────────────────────────────────────
// Zeigt einen nativen Electron-Dialog zur Passworteingabe.
// Gibt das Passwort als String zurück oder null wenn abgebrochen.
// Bei falschem Passwort: bis zu 3 Versuche, danach null.
async function promptPassword(dbPath) {
  const isNew = !require('fs').existsSync(dbPath);
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Electron hat keinen nativen Input-Dialog — wir öffnen ein kleines BrowserWindow
    const password = await showPasswordWindow(isNew, attempt, MAX_ATTEMPTS);
    if (password === null) return null;  // Nutzer hat abgebrochen
    if (password.length >= 1) return password;
  }

  return null;
}

// Öffnet ein minimales BrowserWindow für die Passworteingabe.
// Bei neuer DB (isNew=true): zwei Felder + Übereinstimmungsprüfung.
// Gibt Promise<string|null> zurück.
function showPasswordWindow(isNew, attempt, maxAttempts) {
  return new Promise(resolve => {
    const win = new BrowserWindow({
      width:           420,
      height:          isNew ? 340 : 280,
      frame:           false,
      resizable:       false,
      center:          true,
      alwaysOnTop:     true,
      backgroundColor: '#0B0F17',
      webPreferences:  {
        nodeIntegration:  true,
        contextIsolation: false,
      },
      show: false,
    });

    const attemptsLeft = maxAttempts - attempt + 1;
    const isRetry      = attempt > 1;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background:#0B0F17; color:#e8eaf0; font-family:-apple-system,sans-serif;
    display:flex; flex-direction:column; align-items:center;
    justify-content:center; height:100vh; padding:28px; gap:14px;
    user-select:none; -webkit-app-region:drag;
  }
  .logo { font-size:18px; font-weight:700; color:#1DB954; letter-spacing:-0.5px; }
  .logo span { color:#e8eaf0; }
  h2 { font-size:13.5px; color:#9ba4b5; font-weight:400; text-align:center; line-height:1.5; }
  .error { color:#ff4d4f; font-size:12px; background:rgba(255,77,79,0.1);
           border:1px solid rgba(255,77,79,0.25); border-radius:8px;
           padding:7px 12px; width:100%; text-align:center; }
  .field { display:flex; flex-direction:column; gap:5px; width:100%; }
  label { font-size:11px; color:#5a6478; text-transform:uppercase; letter-spacing:0.5px; }
  input {
    width:100%; padding:10px 14px; background:#141824;
    border:1px solid #2a3040; border-radius:10px;
    color:#e8eaf0; font-size:15px; outline:none;
    -webkit-app-region:no-drag;
  }
  input:focus { border-color:#1DB954; box-shadow:0 0 0 3px rgba(29,185,84,0.15); }
  input.invalid { border-color:#ff4d4f; box-shadow:0 0 0 3px rgba(255,77,79,0.15); }
  .hint { font-size:11px; color:#5a6478; text-align:center; line-height:1.5; }
  .hint strong { color:#ffc145; }
  .buttons { display:flex; gap:10px; width:100%; margin-top:2px; }
  button {
    flex:1; padding:10px; border:none; border-radius:10px;
    font-size:13px; font-weight:600; cursor:pointer;
    -webkit-app-region:no-drag;
  }
  .btn-cancel { background:#1e2535; color:#9ba4b5; }
  .btn-cancel:hover { background:#252f45; }
  .btn-ok { background:#1DB954; color:#0B0F17; }
  .btn-ok:hover { background:#17a349; }
  .btn-ok:disabled { background:#1a4a2a; color:#2d7a4a; cursor:default; }
</style>
</head>
<body>
<div class="logo">Finanz<span>Kompass</span></div>

${isNew ? `
<h2>Erstmaliger Start – lege ein Passwort fest.<br>Es schützt deine Datenbank.</h2>
<div class="field">
  <label>Passwort</label>
  <input type="password" id="pw" placeholder="Mindestens 4 Zeichen" autofocus />
</div>
<div class="field">
  <label>Passwort bestätigen</label>
  <input type="password" id="pw2" placeholder="Passwort wiederholen" />
</div>
<div class="hint"><strong>Wichtig:</strong> Dieses Passwort kann nicht wiederhergestellt werden.<br>Bitte notiere es sicher.</div>
` : `
<h2>Bitte gib dein Datenbankpasswort ein.</h2>
${isRetry ? `<div class="error">Falsches Passwort – noch ${attemptsLeft} Versuch${attemptsLeft !== 1 ? 'e' : ''}</div>` : ''}
<div class="field">
  <input type="password" id="pw" placeholder="Passwort" autofocus />
</div>
`}

<div class="buttons">
  <button class="btn-cancel" id="cancel">Abbrechen</button>
  <button class="btn-ok" id="ok" ${isNew ? 'disabled' : ''}>${isNew ? 'Passwort festlegen' : 'Entsperren'}</button>
</div>

<script>
  const { ipcRenderer } = require('electron');
  const pw  = document.getElementById('pw');
  const pw2 = document.getElementById('pw2');
  const ok  = document.getElementById('ok');
  const isNew = ${isNew};

  function validate() {
    if (!isNew) return;
    const v1 = pw.value;
    const v2 = pw2 ? pw2.value : '';
    const match = v1.length >= 4 && v1 === v2;
    ok.disabled = !match;
    if (pw2) {
      pw2.classList.toggle('invalid', v2.length > 0 && v1 !== v2);
    }
  }

  pw.addEventListener('input', validate);
  if (pw2) pw2.addEventListener('input', validate);

  ok.addEventListener('click', () => {
    const v = pw.value;
    if (!v || (isNew && v !== (pw2?.value ?? ''))) return;
    ipcRenderer.send('pw-result', v);
  });

  document.getElementById('cancel').onclick = () => ipcRenderer.send('pw-result', null);

  [pw, pw2].filter(Boolean).forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') ok.click();
      if (e.key === 'Escape') document.getElementById('cancel').click();
    });
  });

  setTimeout(() => pw.focus(), 80);
</script>
</body>
</html>`;

    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.once('ready-to-show', () => win.show());

    const { ipcMain } = require('electron');
    const handler = (_, value) => {
      if (!win.isDestroyed()) win.close();
      resolve(value);
    };
    ipcMain.once('pw-result', handler);

    win.on('closed', () => {
      ipcMain.removeListener('pw-result', handler);
      resolve(null);
    });
  });
}

app.whenReady().then(startApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('browser-window-focus', () => {
  // Nur Electron-Webview-Fokus setzen wenn tatsächlich nötig.
  // Kein blindes webContents.focus() — der Renderer erkennt den
  // OS-Fensterwechsel selbst via window blur/focus Events.
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Kurzes Delay damit OS-Fokus-Übergang abgeschlossen ist
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.focus();
      }
    }, 100);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// IPC Handler
// ══════════════════════════════════════════════════════════════════════════

ipcMain.handle('accounts:getAll',     ()          => db.getAllAccounts());
ipcMain.handle('accounts:create',     (_, d)      => db.createAccount(d));
ipcMain.handle('accounts:delete',     (_, id)     => db.deleteAccount(id));
ipcMain.handle('accounts:updateType', (_, id, t)  => db.updateAccountType(id, t));
ipcMain.handle('accounts:update',     (_, id, d)  => db.updateAccount(id, d));

ipcMain.handle('transactions:getAll', ()      => db.getAllTransactions());
ipcMain.handle('transactions:create', (_, d)  => db.createTransaction(d));
ipcMain.handle('transactions:delete', (_, id) => db.deleteTransaction(id));
ipcMain.handle('transactions:adjust', (_, d)  => db.createAdjustment(d));

ipcMain.handle('dashboard:getData', () => financeService.getDashboardData());
ipcMain.handle('analytics:getData', () => financeService.getAnalyticsData());

ipcMain.handle('categories:getAll',   ()           => db.getAllCategories());
ipcMain.handle('categories:create',   (_, d)       => db.createCategory(d));
ipcMain.handle('categories:update',   (_, id, d)   => db.updateCategory(id, d));
ipcMain.handle('categories:delete',   (_, id)      => db.deleteCategory(id));

ipcMain.handle('scheduled:getAll',  ()      => db.getAllScheduled());
ipcMain.handle('scheduled:create',  (_, d)  => db.createScheduled(d));
ipcMain.handle('scheduled:delete',  (_, id) => db.deleteScheduled(id));

ipcMain.handle('distributions:getAll',  ()      => db.getAllDistributions());
ipcMain.handle('distributions:create',  (_, d)  => db.createDistribution(d));
ipcMain.handle('distributions:delete',  (_, id) => db.deleteDistribution(id));

ipcMain.handle('reserves:getAll',       ()            => reserveService.getAllReservesWithProgress());
ipcMain.handle('reserves:create',       (_, d)        => reserveService.createReserve(d));
ipcMain.handle('reserves:updateAmount', (_, id, amt)  => reserveService.updateReserveAmount(id, amt));
ipcMain.handle('reserves:delete',       (_, id)       => reserveService.deleteReserve(id));

ipcMain.handle('installments:getAll',     ()             => installmentService.getAllInstallmentsWithProgress());
ipcMain.handle('installments:create',     (_, d)         => installmentService.createInstallment(d));
ipcMain.handle('installments:updatePaid', (_, id, paid)  => installmentService.updateInstallmentPaidMonths(id, paid));
ipcMain.handle('installments:delete',     (_, id)        => installmentService.deleteInstallment(id));

ipcMain.handle('settings:getDbPath', () => db.getDbPath());

ipcMain.handle('settings:changeDbPath', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Neuen Speicherort wählen',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Hier speichern',
  });
  if (result.canceled || !result.filePaths.length) return { success: false, reason: 'Abgebrochen' };

  const newPath = path.join(result.filePaths[0], 'finanzkompass.db');
  const oldPath = db.getDbPath();
  try {
    if (oldPath && fs.existsSync(oldPath)) fs.copyFileSync(oldPath, newPath);
    config.set('dbPath', newPath);
    return { success: true, path: newPath };
  } catch (e) {
    return { success: false, reason: e.message };
  }
});

ipcMain.handle('window:focus', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus(); mainWindow.webContents.focus();
      }
    }, 30);
  }
});
