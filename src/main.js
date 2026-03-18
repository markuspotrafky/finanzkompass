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
// Verhindert Doppel-Start (Doppelklick auf Icon) → verhindert Doppelbuchungen.
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
// Läuft vollständig im Hintergrund — blockiert weder Splash noch App-Start.
// Nutzer sieht einen Banner wenn ein Update heruntergeladen wurde.
// Installation erfolgt beim nächsten Neustart (quitAndInstall).
// ══════════════════════════════════════════════════════════════════════════

function initAutoUpdater() {
  // Nur im gepackten Build aktiv — im Entwicklungsmodus überspringen.
  // electron-updater prüft sonst auf eine nicht existierende Update-URL.
  if (!app.isPackaged) {
    console.log('[Updater] Entwicklungsmodus — Update-Prüfung deaktiviert.');
    return;
  }

  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.error('[Updater] electron-updater nicht gefunden:', e.message);
    return;
  }

  // ── Logging ────────────────────────────────────────────────────────────
  autoUpdater.logger          = require('electron-log');
  autoUpdater.logger.transports.file.level = 'info';
  // Log-Datei: %APPDATA%\FinanzKompass\logs\main.log
  console.log('[Updater] Log-Datei:', autoUpdater.logger.transports.file.getFile()?.path ?? 'n/a');

  // Kein Dialog automatisch — wir steuern die UX selbst
  autoUpdater.autoDownload        = true;   // Download startet automatisch im Hintergrund
  autoUpdater.autoInstallOnAppQuit = true;  // Installation beim nächsten Beenden

  // ── Events ─────────────────────────────────────────────────────────────

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Suche nach Updates…');
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update verfügbar: v${info.version} (aktuell: v${app.getVersion()})`);
    // Nutzer wird erst nach dem Download informiert — kein Dialog jetzt
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log(`[Updater] Kein Update — v${info.version} ist aktuell.`);
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    console.log(`[Updater] Download: ${pct}% (${Math.round(progress.transferred / 1024)} KB / ${Math.round(progress.total / 1024)} KB)`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update v${info.version} heruntergeladen — wird beim nächsten Start installiert.`);

    // Hauptfenster informieren sobald es bereit ist
    const sendUpdateReady = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:downloaded', {
          version:     info.version,
          releaseNotes: info.releaseNotes || null,
        });
      }
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      sendUpdateReady();
    } else {
      // Fenster noch nicht fertig → warten
      const interval = setInterval(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          clearInterval(interval);
          // Kurzes Delay damit die UI vollständig initialisiert ist
          setTimeout(sendUpdateReady, 1500);
        }
      }, 500);
    }
  });

  autoUpdater.on('error', (err) => {
    // Fehler beim Update-Check → App läuft normal weiter, kein Crash
    console.error('[Updater] Fehler:', err.message ?? err);
  });

  // ── Update-Check starten (verzögert, blockiert Start nicht) ────────────
  // 5 Sekunden Verzögerung: App ist vollständig geladen bevor Netzwerk-Request
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.error('[Updater] checkForUpdates fehlgeschlagen:', err.message ?? err);
    });
  }, 5000);

  // IPC: Nutzer klickt "Jetzt neu starten und installieren"
  ipcMain.handle('update:installNow', () => {
    autoUpdater.quitAndInstall(false, true);
    // false = kein Silent-Install, true = App neu starten nach Install
  });
}

// ── Splash Screen erstellen ───────────────────────────────────────────────
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width:           400,
    height:          320,
    frame:           false,
    transparent:     false,
    resizable:       false,
    center:          true,
    alwaysOnTop:     true,
    skipTaskbar:     true,
    backgroundColor: '#0B0F17',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    show: false,
  });

  splashWindow.loadFile(path.join(__dirname, 'ui', 'splash.html'));

  splashWindow.once('ready-to-show', () => {
    splashWindow.show();
  });
}

// ── Splash: Fortschritt aktualisieren ─────────────────────────────────────
async function setSplashProgress(percent, text) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try {
    await splashWindow.webContents.executeJavaScript(
      `window.setProgress && window.setProgress(${percent}, ${JSON.stringify(text)})`
    );
  } catch (_) { /* Splash bereits geschlossen */ }
}

// ── Haupt-Fenster erstellen ───────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width:     1280,
    height:    800,
    minWidth:  900,
    minHeight: 600,
    show:      false,
    backgroundColor: '#0B0F17',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    title: 'FinanzKompass',
    icon:  path.join(__dirname, '..', 'assets', 'icon.ico'),
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  return mainWindow;
}

// ── Datenbankpfad ermitteln ───────────────────────────────────────────────
async function resolveDbPath() {
  const saved = config.get('dbPath');
  if (saved && fs.existsSync(path.dirname(saved))) return saved;

  const result = await dialog.showMessageBox(splashWindow, {
    type:      'question',
    title:     'FinanzKompass – Speicherort',
    message:   'Wo soll die Datenbank gespeichert werden?',
    detail:    'Empfehlung: wähle einen OneDrive- oder anderen Sync-Ordner für automatisches Backup.',
    buttons:   ['Ordner wählen', 'Standard verwenden'],
    defaultId: 0,
    cancelId:  1,
  });

  if (result.response === 0) {
    const folderResult = await dialog.showOpenDialog(splashWindow, {
      title:       'Speicherort für Datenbank wählen',
      properties:  ['openDirectory', 'createDirectory'],
      buttonLabel: 'Hier speichern',
    });

    if (!folderResult.canceled && folderResult.filePaths.length > 0) {
      const dbFile = path.join(folderResult.filePaths[0], 'finanzkompass.db');
      config.set('dbPath', dbFile);
      return dbFile;
    }
  }

  const defaultPath = path.join(app.getPath('userData'), 'finanzkompass.db');
  config.set('dbPath', defaultPath);
  return defaultPath;
}

// ── App-Start: nicht-blockierende Sequenz ─────────────────────────────────
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
      } catch (e) {
        console.error('Fehler beim automatischen Start:', e);
      }
      resolve();
    }));

    await setSplashProgress(100, 'Bereit!');

    createMainWindow();

    await new Promise(resolve => {
      mainWindow.once('ready-to-show', resolve);
    });

    mainWindow.show();

    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
    }, 200);

    // Startup-Hinweis für nachgeholte Buchungen
    if (bookedCount > 0) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('startup:booked', bookedCount);
        }
      }, 1000);
    }

    // Auto-Updater initialisieren (NACH dem Hauptfenster — blockiert nichts)
    initAutoUpdater();

  } catch (e) {
    console.error('Kritischer Startfehler:', e);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    await dialog.showErrorBox(
      'FinanzKompass – Startfehler',
      `Die App konnte nicht gestartet werden:\n\n${e.message}\n\nBitte starte die App neu.`
    );
    app.quit();
  }
}

// ── App bereit ────────────────────────────────────────────────────────────
app.whenReady().then(startApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Fokus-Wiederherstellung ───────────────────────────────────────────────
app.on('browser-window-focus', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.focus();
      }
    }, 50);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// IPC Handler
// ══════════════════════════════════════════════════════════════════════════

// Konten
ipcMain.handle('accounts:getAll',     ()          => db.getAllAccounts());
ipcMain.handle('accounts:create',     (_, d)      => db.createAccount(d));
ipcMain.handle('accounts:delete',     (_, id)     => db.deleteAccount(id));
ipcMain.handle('accounts:updateType', (_, id, t)  => db.updateAccountType(id, t));
ipcMain.handle('accounts:update',     (_, id, d)  => db.updateAccount(id, d));

// Transaktionen
ipcMain.handle('transactions:getAll', ()      => db.getAllTransactions());
ipcMain.handle('transactions:create', (_, d)  => db.createTransaction(d));
ipcMain.handle('transactions:delete', (_, id) => db.deleteTransaction(id));
ipcMain.handle('transactions:adjust', (_, d)  => db.createAdjustment(d));

// Dashboard & Analytics
ipcMain.handle('dashboard:getData', () => financeService.getDashboardData());
ipcMain.handle('analytics:getData', () => financeService.getAnalyticsData());

// Kategorien
ipcMain.handle('categories:getAll',   ()           => db.getAllCategories());
ipcMain.handle('categories:create',   (_, d)       => db.createCategory(d));
ipcMain.handle('categories:update',   (_, id, d)   => db.updateCategory(id, d));
ipcMain.handle('categories:delete',   (_, id)      => db.deleteCategory(id));

// Geplante Transaktionen
ipcMain.handle('scheduled:getAll',  ()      => db.getAllScheduled());
ipcMain.handle('scheduled:create',  (_, d)  => db.createScheduled(d));
ipcMain.handle('scheduled:delete',  (_, id) => db.deleteScheduled(id));

// Verteilungen
ipcMain.handle('distributions:getAll',  ()      => db.getAllDistributions());
ipcMain.handle('distributions:create',  (_, d)  => db.createDistribution(d));
ipcMain.handle('distributions:delete',  (_, id) => db.deleteDistribution(id));

// Rücklagen
ipcMain.handle('reserves:getAll',       ()            => reserveService.getAllReservesWithProgress());
ipcMain.handle('reserves:create',       (_, d)        => reserveService.createReserve(d));
ipcMain.handle('reserves:updateAmount', (_, id, amt)  => reserveService.updateReserveAmount(id, amt));
ipcMain.handle('reserves:delete',       (_, id)       => reserveService.deleteReserve(id));

// Ratenkäufe
ipcMain.handle('installments:getAll',     ()             => installmentService.getAllInstallmentsWithProgress());
ipcMain.handle('installments:create',     (_, d)         => installmentService.createInstallment(d));
ipcMain.handle('installments:updatePaid', (_, id, paid)  => installmentService.updateInstallmentPaidMonths(id, paid));
ipcMain.handle('installments:delete',     (_, id)        => installmentService.deleteInstallment(id));

// Einstellungen
ipcMain.handle('settings:getDbPath', () => db.getDbPath());

ipcMain.handle('settings:changeDbPath', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:       'Neuen Speicherort wählen',
    properties:  ['openDirectory', 'createDirectory'],
    buttonLabel: 'Hier speichern',
  });

  if (result.canceled || !result.filePaths.length) {
    return { success: false, reason: 'Abgebrochen' };
  }

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

// Fenster-Fokus
ipcMain.handle('window:focus', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.webContents.focus();
      }
    }, 30);
  }
});
// Hinweis: ipcMain.handle('update:installNow') ist in initAutoUpdater() registriert

const config             = require('./config');
const db                 = require('./db/database');
const financeService     = require('./logic/financeService');
const reserveService     = require('./logic/reserveService');
const installmentService = require('./logic/installmentService');
const autoService        = require('./logic/autoService');

// ── Single-Instance-Lock ──────────────────────────────────────────────────
// Verhindert Doppel-Start (Doppelklick auf Icon) → verhindert Doppelbuchungen.
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

// ── Splash Screen erstellen ───────────────────────────────────────────────
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width:           400,
    height:          320,
    frame:           false,       // Kein Fensterrahmen → sauberes Design
    transparent:     false,
    resizable:       false,
    center:          true,
    alwaysOnTop:     true,
    skipTaskbar:     true,        // Nicht in Taskleiste anzeigen
    backgroundColor: '#0B0F17',  // Verhindert weißes Aufblitzen beim Laden
    webPreferences: {
      nodeIntegration:     false,
      contextIsolation:    true,
      // Kein preload nötig — Kommunikation über executeJavaScript
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    show: false,                  // Erst nach did-finish-load anzeigen
  });

  splashWindow.loadFile(path.join(__dirname, 'ui', 'splash.html'));

  // Sobald HTML geladen: sofort zeigen (kein Flackern)
  splashWindow.once('ready-to-show', () => {
    splashWindow.show();
  });
}

// ── Splash: Fortschritt aktualisieren ─────────────────────────────────────
// Sendet den Fortschritt sicher via executeJavaScript (kein IPC nötig).
async function setSplashProgress(percent, text) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try {
    await splashWindow.webContents.executeJavaScript(
      `window.setProgress && window.setProgress(${percent}, ${JSON.stringify(text)})`
    );
  } catch (_) { /* Splash bereits geschlossen */ }
}

// ── Haupt-Fenster erstellen ───────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width:    1280,
    height:   800,
    minWidth: 900,
    minHeight:600,
    show:     false,             // Erst nach vollständigem Laden zeigen
    backgroundColor: '#0B0F17', // Verhindert weißes Flackern
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    title: 'FinanzKompass',
    icon:  path.join(__dirname, '..', 'assets', 'icon.ico'),
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  return mainWindow;
}

// ── Datenbankpfad ermitteln ───────────────────────────────────────────────
async function resolveDbPath() {
  const saved = config.get('dbPath');
  if (saved && fs.existsSync(path.dirname(saved))) return saved;

  // Ersten-Start-Dialog (erscheint über dem Splash)
  const result = await dialog.showMessageBox(splashWindow, {
    type:      'question',
    title:     'FinanzKompass – Speicherort',
    message:   'Wo soll die Datenbank gespeichert werden?',
    detail:    'Empfehlung: wähle einen OneDrive- oder anderen Sync-Ordner für automatisches Backup.',
    buttons:   ['Ordner wählen', 'Standard verwenden'],
    defaultId: 0,
    cancelId:  1,
  });

  if (result.response === 0) {
    const folderResult = await dialog.showOpenDialog(splashWindow, {
      title:       'Speicherort für Datenbank wählen',
      properties:  ['openDirectory', 'createDirectory'],
      buttonLabel: 'Hier speichern',
    });

    if (!folderResult.canceled && folderResult.filePaths.length > 0) {
      const dbFile = path.join(folderResult.filePaths[0], 'finanzkompass.db');
      config.set('dbPath', dbFile);
      return dbFile;
    }
  }

  const defaultPath = path.join(app.getPath('userData'), 'finanzkompass.db');
  config.set('dbPath', defaultPath);
  return defaultPath;
}

// ── App-Start: nicht-blockierende Sequenz ─────────────────────────────────
// processScheduled() ist synchron (sql.js RAM-Modell), aber in einen
// eigenen Tick verlagert damit der Splash-Screen seine Updates rendern kann.
async function startApp() {
  try {
    // 1. Splash zeigen
    createSplashWindow();
    await setSplashProgress(10, 'Speicherort ermitteln…');

    // 2. DB-Pfad auflösen (evtl. Dialog)
    const dbPath = await resolveDbPath();
    await setSplashProgress(25, 'Datenbank laden…');

    // 3. DB initialisieren
    await db.initialize(dbPath);
    await setSplashProgress(50, 'Datenbank bereit');

    // 4. Automatiken im nächsten Tick ausführen (Splash kann rendern)
    let bookedCount = 0;
    await new Promise(resolve => setImmediate(async () => {
      try {
        await setSplashProgress(65, 'Buchungen verarbeiten…');
        bookedCount = db.processScheduled();

        await setSplashProgress(80, 'Rücklagen aktualisieren…');
        autoService.processReserves();

        await setSplashProgress(90, 'Ratenkäufe aktualisieren…');
        autoService.processInstallments();
      } catch (e) {
        console.error('Fehler beim automatischen Start:', e);
        // Kein Crash — App läuft weiter, fehlende Buchungen werden beim nächsten Start nachgeholt
      }
      resolve();
    }));

    await setSplashProgress(100, 'Bereit!');

    // 5. Hauptfenster erstellen
    createMainWindow();

    // 6. Hauptfenster laden und auf ready-to-show warten
    await new Promise(resolve => {
      mainWindow.once('ready-to-show', resolve);
    });

    // 7. Sanfter Übergang: Hauptfenster einblenden, Splash ausblenden
    mainWindow.show();

    // Kurze Überlappung für nahtlosen Übergang
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
    }, 200);

    // 8. Startup-Hinweis senden falls Buchungen verarbeitet wurden
    if (bookedCount > 0) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('startup:booked', bookedCount);
        }
      }, 1000); // Nach vollständigem UI-Aufbau
    }

  } catch (e) {
    console.error('Kritischer Startfehler:', e);

    // Splash schließen falls offen
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }

    // Fehlermeldung anzeigen und beenden
    await dialog.showErrorBox(
      'FinanzKompass – Startfehler',
      `Die App konnte nicht gestartet werden:\n\n${e.message}\n\nBitte starte die App neu.`
    );
    app.quit();
  }
}

// ── App bereit ────────────────────────────────────────────────────────────
app.whenReady().then(startApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Fokus-Wiederherstellung ───────────────────────────────────────────────
app.on('browser-window-focus', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.focus();
      }
    }, 50);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// IPC Handler
// ══════════════════════════════════════════════════════════════════════════

// Konten
ipcMain.handle('accounts:getAll',     ()          => db.getAllAccounts());
ipcMain.handle('accounts:create',     (_, d)      => db.createAccount(d));
ipcMain.handle('accounts:delete',     (_, id)     => db.deleteAccount(id));
ipcMain.handle('accounts:updateType', (_, id, t)  => db.updateAccountType(id, t));
ipcMain.handle('accounts:update',     (_, id, d)  => db.updateAccount(id, d));

// Transaktionen
ipcMain.handle('transactions:getAll', ()      => db.getAllTransactions());
ipcMain.handle('transactions:create', (_, d)  => db.createTransaction(d));
ipcMain.handle('transactions:delete', (_, id) => db.deleteTransaction(id));
ipcMain.handle('transactions:adjust', (_, d)  => db.createAdjustment(d));

// Dashboard & Analytics
ipcMain.handle('dashboard:getData', () => financeService.getDashboardData());
ipcMain.handle('analytics:getData', () => financeService.getAnalyticsData());

// Kategorien
ipcMain.handle('categories:getAll',   ()           => db.getAllCategories());
ipcMain.handle('categories:create',   (_, d)       => db.createCategory(d));
ipcMain.handle('categories:update',   (_, id, d)   => db.updateCategory(id, d));
ipcMain.handle('categories:delete',   (_, id)      => db.deleteCategory(id));

// Geplante Transaktionen
ipcMain.handle('scheduled:getAll',  ()      => db.getAllScheduled());
ipcMain.handle('scheduled:create',  (_, d)  => db.createScheduled(d));
ipcMain.handle('scheduled:delete',  (_, id) => db.deleteScheduled(id));

// Verteilungen
ipcMain.handle('distributions:getAll',  ()      => db.getAllDistributions());
ipcMain.handle('distributions:create',  (_, d)  => db.createDistribution(d));
ipcMain.handle('distributions:delete',  (_, id) => db.deleteDistribution(id));

// Rücklagen
ipcMain.handle('reserves:getAll',       ()            => reserveService.getAllReservesWithProgress());
ipcMain.handle('reserves:create',       (_, d)        => reserveService.createReserve(d));
ipcMain.handle('reserves:updateAmount', (_, id, amt)  => reserveService.updateReserveAmount(id, amt));
ipcMain.handle('reserves:delete',       (_, id)       => reserveService.deleteReserve(id));

// Ratenkäufe
ipcMain.handle('installments:getAll',     ()             => installmentService.getAllInstallmentsWithProgress());
ipcMain.handle('installments:create',     (_, d)         => installmentService.createInstallment(d));
ipcMain.handle('installments:updatePaid', (_, id, paid)  => installmentService.updateInstallmentPaidMonths(id, paid));
ipcMain.handle('installments:delete',     (_, id)        => installmentService.deleteInstallment(id));

// Einstellungen
ipcMain.handle('settings:getDbPath', () => db.getDbPath());

ipcMain.handle('settings:changeDbPath', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:       'Neuen Speicherort wählen',
    properties:  ['openDirectory', 'createDirectory'],
    buttonLabel: 'Hier speichern',
  });

  if (result.canceled || !result.filePaths.length) {
    return { success: false, reason: 'Abgebrochen' };
  }

  const newPath = path.join(result.filePaths[0], 'finanzkompass.db');
  const oldPath = db.getDbPath();
  try {
    if (oldPath && fs.existsSync(oldPath)) {
      fs.copyFileSync(oldPath, newPath);
    }
    config.set('dbPath', newPath);
    return { success: true, path: newPath };
  } catch (e) {
    return { success: false, reason: e.message };
  }
});

// Fenster-Fokus
ipcMain.handle('window:focus', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.webContents.focus();
      }
    }, 30);
  }
});
