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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
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
    await setSplashProgress(25, 'Datenbank laden…');

    await db.initialize(dbPath);
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
    await dialog.showErrorBox('FinanzKompass – Startfehler',
      `Die App konnte nicht gestartet werden:\n\n${e.message}\n\nBitte starte die App neu.`);
    app.quit();
  }
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
