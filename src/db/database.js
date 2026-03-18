// src/db/database.js – SQLite via sql.js
const path = require('path');
const fs   = require('fs');
const { app } = require('electron');

let db;
let dbPath;

function initialize(customDbPath) {
  const initSqlJs = require('sql.js');

  // WASM-Pfad: Im gepackten Build liegt die Datei in resources/ (extraResources).
  // Im Entwicklungsmodus liegt sie im node_modules-Ordner.
  const isPackaged = app.isPackaged;
  const wasmPath   = isPackaged
    ? path.join(process.resourcesPath, 'sql-wasm.wasm')
    : path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');

  // Bevorzuge den übergebenen Pfad, Fallback auf Standard-AppData
  dbPath = customDbPath || path.join(app.getPath('userData'), 'finanzkompass.db');
  return initSqlJs({ locateFile: () => wasmPath }).then(SQL => {
    const Database = SQL.Database;
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new Database(fileBuffer);
    } else {
      db = new Database();
    }
    db.run('PRAGMA foreign_keys = ON;');
    createTables();
    migrateReservesTable(); // Alte Spalten → neue Spalten
    seedCategories();
    persist();
    console.log('Datenbank bereit:', dbPath);
  });
}

// ── F4: persist() mit Error-Handling ─────────────────────────────────────
// Schreibt die In-Memory-DB auf Disk. Kein Crash bei gesperrter Datei
// (z.B. OneDrive-Sync). Fehler werden geloggt, App läuft weiter.
function persist() {
  if (!db || !dbPath) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (e) {
    console.error('WARNUNG: DB-Speicherung fehlgeschlagen:', e.message);
    // Kein Crash — nächste Operation versucht erneut zu persistieren.
    // Alle RAM-Änderungen sind noch intakt.
  }
}

// ── F3: Sichere Monatsaddition ohne JavaScript-Rollover ───────────────────
// Problem: new Date('2026-01-31').setMonth(1) → 3. März (JS rollt über)
// Lösung: Tag auf letzten gültigen Tag des Zielmonats klemmen.
// Beispiel: 31. Jan + 1 Monat → 28. Feb (nicht 3. März)
function addMonthsSafe(dateStr, months) {
  const parts = dateStr.split('-');
  const year  = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10); // 1-basiert
  const day   = parseInt(parts[2], 10);

  let newMonth = month + months;
  let newYear  = year;

  // Jahresüberlauf sauber behandeln
  while (newMonth > 12) { newMonth -= 12; newYear++; }
  while (newMonth < 1)  { newMonth += 12; newYear--; }

  // Letzten gültigen Tag des Zielmonats ermitteln
  const lastDay = new Date(newYear, newMonth, 0).getDate();
  const newDay  = Math.min(day, lastDay);

  return `${newYear}-${String(newMonth).padStart(2, '0')}-${String(newDay).padStart(2, '0')}`;
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      initial_balance  REAL    NOT NULL DEFAULT 0,
      overdraft_limit  REAL    NOT NULL DEFAULT 0,
      account_type     TEXT    NOT NULL DEFAULT 'private',
      color            TEXT    NOT NULL DEFAULT '#4d9fff'
    );
    CREATE TABLE IF NOT EXISTS categories (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#4d9fff',
      icon  TEXT NOT NULL DEFAULT '💡'
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER NOT NULL,
      amount      REAL    NOT NULL,
      date        TEXT    NOT NULL,
      type        TEXT    NOT NULL,
      category_id INTEGER,
      description TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS scheduled_transactions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id       INTEGER NOT NULL,
      amount           REAL    NOT NULL,
      type             TEXT    NOT NULL,
      category_id      INTEGER,
      description      TEXT,
      start_date       TEXT    NOT NULL,
      next_due_date    TEXT    NOT NULL,
      interval_months  INTEGER,
      is_active        INTEGER NOT NULL DEFAULT 1,
      group_id         INTEGER
    );
    CREATE TABLE IF NOT EXISTS transfer_groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT
    );
    CREATE TABLE IF NOT EXISTS transfer_group_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id   INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      amount     REAL    NOT NULL,
      type       TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reserves (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      target_amount    REAL    NOT NULL DEFAULT 0,
      current_amount   REAL    NOT NULL DEFAULT 0,
      deduction_day    INTEGER NOT NULL DEFAULT 1,
      interval_months  INTEGER NOT NULL DEFAULT 1,
      first_due_date   TEXT
    );
    CREATE TABLE IF NOT EXISTS installments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT    NOT NULL,
      total_amount   REAL    NOT NULL DEFAULT 0,
      monthly_rate   REAL    NOT NULL DEFAULT 0,
      total_months   INTEGER NOT NULL DEFAULT 1,
      paid_months    INTEGER NOT NULL DEFAULT 0,
      start_date     TEXT    NOT NULL,
      account_id     INTEGER,
      category_id    INTEGER,
      deduction_day  INTEGER NOT NULL DEFAULT 1
    );
  `);
}

// Migration: alte reserves-Spalten durch neue ersetzen (einmalig)
function migrateReservesTable() {
  // ── reserves ──────────────────────────────────────────────────────────────
  const cols = toObjects(db.exec("PRAGMA table_info(reserves)")).map(c => c.name);
  if (!cols.includes('deduction_day')) {
    db.run('ALTER TABLE reserves ADD COLUMN deduction_day INTEGER NOT NULL DEFAULT 1');
  }
  if (!cols.includes('interval_months')) {
    db.run('ALTER TABLE reserves ADD COLUMN interval_months INTEGER NOT NULL DEFAULT 1');
  }
  if (!cols.includes('first_due_date')) {
    db.run('ALTER TABLE reserves ADD COLUMN first_due_date TEXT');
    console.log('Migration: first_due_date zu reserves hinzugefügt');
  }

  // ── accounts: account_type ergänzen ───────────────────────────────────────
  const accCols = toObjects(db.exec("PRAGMA table_info(accounts)")).map(c => c.name);
  if (!accCols.includes('account_type')) {
    db.run("ALTER TABLE accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'private'");
    console.log('Migration: account_type zu accounts hinzugefügt');
  }

  // ── accounts: color ergänzen ──────────────────────────────────────────────
  const accCols2 = toObjects(db.exec("PRAGMA table_info(accounts)")).map(c => c.name);
  if (!accCols2.includes('color')) {
    db.run("ALTER TABLE accounts ADD COLUMN color TEXT NOT NULL DEFAULT '#4d9fff'");
    console.log('Migration: color zu accounts hinzugefügt');
  }

  // ── categories: color + icon ergänzen ────────────────────────────────────
  const catCols = toObjects(db.exec("PRAGMA table_info(categories)")).map(c => c.name);
  if (!catCols.includes('color')) {
    db.run("ALTER TABLE categories ADD COLUMN color TEXT NOT NULL DEFAULT '#4d9fff'");
    console.log('Migration: color zu categories hinzugefügt');
  }
  if (!catCols.includes('icon')) {
    db.run("ALTER TABLE categories ADD COLUMN icon TEXT NOT NULL DEFAULT '💡'");
    console.log('Migration: icon zu categories hinzugefügt');
  }

  // ── scheduled_transactions: group_id ergänzen ─────────────────────────────
  const schedCols = toObjects(db.exec("PRAGMA table_info(scheduled_transactions)")).map(c => c.name);
  if (!schedCols.includes('group_id')) {
    db.run('ALTER TABLE scheduled_transactions ADD COLUMN group_id INTEGER');
  }

  // ── installments: neue Felder ergänzen ────────────────────────────────────
  const instCols = toObjects(db.exec("PRAGMA table_info(installments)")).map(c => c.name);
  if (!instCols.includes('account_id'))    db.run('ALTER TABLE installments ADD COLUMN account_id INTEGER');
  if (!instCols.includes('category_id'))   db.run('ALTER TABLE installments ADD COLUMN category_id INTEGER');
  if (!instCols.includes('deduction_day')) db.run('ALTER TABLE installments ADD COLUMN deduction_day INTEGER NOT NULL DEFAULT 1');
}


function seedCategories() {
  const result = db.exec('SELECT COUNT(*) as n FROM categories');
  const count  = result[0]?.values[0][0] ?? 0;
  if (count > 0) return;
  const defaults = [
    { name: 'Gehalt',        color: '#2dca5c', icon: '💼' },
    { name: 'Miete',         color: '#ff6b6b', icon: '🏠' },
    { name: 'Lebensmittel',  color: '#ffc145', icon: '🛒' },
    { name: 'Transport',     color: '#4d9fff', icon: '🚗' },
    { name: 'Versicherung',  color: '#b07fff', icon: '🛡️' },
    { name: 'Freizeit',      color: '#3df0b0', icon: '🎉' },
    { name: 'Gesundheit',    color: '#ff8c42', icon: '❤️' },
    { name: 'Kleidung',      color: '#69c0ff', icon: '👕' },
    { name: 'Technik',       color: '#ff77c8', icon: '💻' },
    { name: 'Sonstiges',     color: '#c8d6e5', icon: '📦' },
  ];
  defaults.forEach(c => db.run(
    'INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)',
    [c.name, c.color, c.icon]
  ));
  persist();
}

function toObjects(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function query(sql, params = []) { return toObjects(db.exec(sql, params)); }

function run(sql, params = []) {
  db.run(sql, params);
  persist();
  const res = db.exec('SELECT last_insert_rowid() as id');
  return { lastInsertRowid: res[0]?.values[0][0] ?? null };
}

// ── Konten ────────────────────────────────────────────────────────────────
function getAllAccounts() {
  return query(`
    SELECT a.id, a.name, a.initial_balance, a.overdraft_limit,
      COALESCE(a.account_type, 'private') AS account_type,
      COALESCE(a.color, '#4d9fff') AS color,
      (a.initial_balance +
        COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id = a.id AND type = 'income'), 0) -
        COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id = a.id AND type = 'expense'), 0) +
        COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id = a.id AND type = 'adjustment'), 0)
      ) AS balance
    FROM accounts a ORDER BY a.id
  `);
}
function createAccount({ name, initial_balance = 0, overdraft_limit = 0, account_type = 'private', color = '#4d9fff' }) {
  const r = run(
    'INSERT INTO accounts (name, initial_balance, overdraft_limit, account_type, color) VALUES (?, ?, ?, ?, ?)',
    [name, initial_balance, overdraft_limit, account_type, color]
  );
  return { id: r.lastInsertRowid, name, initial_balance, overdraft_limit, account_type, color, balance: initial_balance };
}
function updateAccountType(id, account_type) {
  run('UPDATE accounts SET account_type = ? WHERE id = ?', [account_type, id]);
  return { success: true };
}

function updateAccount(id, { name, account_type, overdraft_limit, color }) {
  run(
    'UPDATE accounts SET name = ?, account_type = ?, overdraft_limit = ?, color = ? WHERE id = ?',
    [name, account_type, overdraft_limit, color || '#4d9fff', id]
  );
  return { success: true };
}
// F5: Konto löschen mit vollständigem Cascade.
// Löscht auch alle scheduled_transactions — inkl. Umbuchungsgruppen
// bei denen dieses Konto Mitglied ist. Verhindert verwaiste Einträge
// die beim nächsten processScheduled() zu FK-Fehlern führen würden.
function deleteAccount(id) {
  // 1. Umbuchungsgruppen ermitteln, in denen dieses Konto vorkommt
  const affectedGroups = query(
    'SELECT DISTINCT group_id FROM scheduled_transactions WHERE account_id = ? AND group_id IS NOT NULL',
    [id]
  );

  // 2. Gesamte Gruppe löschen (nicht nur den einen Eintrag) —
  //    eine Umbuchung ohne alle Mitglieder ist inkonsistent
  affectedGroups.forEach(row => {
    db.run('DELETE FROM scheduled_transactions WHERE group_id = ?', [row.group_id]);
  });

  // 3. Einzelne scheduled_transactions dieses Kontos löschen
  db.run('DELETE FROM scheduled_transactions WHERE account_id = ?', [id]);

  // 4. Transaktionen und Konto löschen
  run('DELETE FROM transactions WHERE account_id = ?', [id]);
  run('DELETE FROM accounts WHERE id = ?', [id]);

  return { success: true };
}

// ── Transaktionen ─────────────────────────────────────────────────────────
function getAllTransactions() {
  return query(`
    SELECT t.id, t.account_id, t.amount, t.date, t.type, t.description, t.created_at,
      a.name AS account_name, c.name AS category_name
    FROM transactions t
    LEFT JOIN accounts   a ON t.account_id  = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    ORDER BY t.date DESC, t.created_at DESC LIMIT 500
  `);
}
function createTransaction({ account_id, amount, date, type, category_id, description }) {
  const r = run(
    'INSERT INTO transactions (account_id, amount, date, type, category_id, description) VALUES (?, ?, ?, ?, ?, ?)',
    [account_id, amount, date, type, category_id || null, description || '']
  );
  return { id: r.lastInsertRowid, success: true };
}
function deleteTransaction(id) {
  run('DELETE FROM transactions WHERE id = ?', [id]);
  return { success: true };
}

// Kontostand-Korrektur: speichert eine Adjustment-Transaktion.
// amount = Differenz (positiv = Erhöhung, negativ = Senkung).
// Der Kontostand-Algorithmus addiert adjustments direkt.
function createAdjustment({ account_id, amount, date, description }) {
  const r = run(
    'INSERT INTO transactions (account_id, amount, date, type, description) VALUES (?, ?, ?, ?, ?)',
    [account_id, amount, date, 'adjustment', description || 'Kontostand-Korrektur']
  );
  return { id: r.lastInsertRowid, success: true };
}

// ── Kategorien ────────────────────────────────────────────────────────────
function getAllCategories() { return query('SELECT * FROM categories ORDER BY name'); }

function createCategory({ name, color = '#4d9fff', icon = '💡' }) {
  const r = run(
    'INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)',
    [name.trim(), color, icon]
  );
  return { id: r.lastInsertRowid, success: true };
}

function updateCategory(id, { name, color, icon }) {
  run(
    'UPDATE categories SET name = ?, color = ?, icon = ? WHERE id = ?',
    [name.trim(), color, icon, id]
  );
  return { success: true };
}

function deleteCategory(id) {
  // Referenzen auf NULL setzen, damit Transaktionen erhalten bleiben
  db.run('UPDATE transactions SET category_id = NULL WHERE category_id = ?', [id]);
  db.run('UPDATE scheduled_transactions SET category_id = NULL WHERE category_id = ?', [id]);
  db.run('UPDATE installments SET category_id = NULL WHERE category_id = ?', [id]);
  run('DELETE FROM categories WHERE id = ?', [id]);
  return { success: true };
}

// ── Geplante Transaktionen ────────────────────────────────────────────────
function getAllScheduled() {
  return query(`
    SELECT s.id, s.account_id, s.amount, s.type, s.description,
      s.start_date, s.next_due_date, s.interval_months, s.is_active,
      s.group_id,
      a.name AS account_name, c.name AS category_name
    FROM scheduled_transactions s
    LEFT JOIN accounts   a ON s.account_id  = a.id
    LEFT JOIN categories c ON s.category_id = c.id
    ORDER BY s.next_due_date ASC
  `);
}
function createScheduled({ account_id, amount, type, category_id, description, start_date, interval_months, group_id }) {
  const r = run(
    `INSERT INTO scheduled_transactions
       (account_id, amount, type, category_id, description, start_date, next_due_date, interval_months, is_active, group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [account_id, amount, type, category_id || null, description || '', start_date, start_date, interval_months || null, group_id || null]
  );
  return { id: r.lastInsertRowid, success: true };
}
function deleteScheduled(id) {
  run('DELETE FROM scheduled_transactions WHERE id = ?', [id]);
  return { success: true };
}

// ── F2: Geplante Transaktionen verarbeiten ────────────────────────────────
// Verbessert gegenüber Original:
//   1. NACHHOLSCHLEIFE: läuft so lange bis alle fälligen Perioden gebucht sind.
//      Bei 3 Monaten Pause werden alle 3 Monate in einem App-Start nachgeholt.
//   2. addMonthsSafe: kein Datum-Rollover bei Monaten mit weniger als 31 Tagen.
//   3. try/catch: ein fehlerhafter Eintrag bricht nicht die gesamte Schleife ab.
//   4. Lokales Datum statt UTC: korrekt für Nutzer in GMT+1/+2 (Deutschland).
function processScheduled() {
  // Lokales Datum (nicht UTC) — verhindert Fehler um Mitternacht für DE-Nutzer
  const now   = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let totalBooked  = 0;
  let iterations   = 0;
  const MAX_ITER   = 120; // Sicherheitslimit: max. 10 Jahre × 12 Monate

  // ── Nachholschleife ───────────────────────────────────────────────────────
  // Jede Iteration bucht alle aktuell fälligen Einträge und rückt deren
  // next_due_date vor. Danach prüft die nächste Iteration ob noch mehr fällig.
  // Terminiert sobald keine fälligen Einträge mehr existieren.
  while (iterations < MAX_ITER) {
    const due = query(
      'SELECT * FROM scheduled_transactions WHERE is_active = 1 AND next_due_date <= ?',
      [today]
    );
    if (due.length === 0) break;

    const groupedIds = new Set();
    const ungrouped  = [];

    due.forEach(s => {
      if (s.group_id !== null && s.group_id !== undefined) {
        groupedIds.add(s.group_id);
      } else {
        ungrouped.push(s);
      }
    });

    let bookedThisRound = 0;

    // ── Gruppierte Einträge (Umbuchungen) ─────────────────────────────────
    groupedIds.forEach(groupId => {
      try {
        const allInGroup = query(
          'SELECT * FROM scheduled_transactions WHERE group_id = ? AND is_active = 1',
          [groupId]
        );

        // Nur buchen wenn ALLE aktiven Mitglieder fällig sind
        const allDue = allInGroup.length > 0 &&
                       allInGroup.every(s => s.next_due_date <= today);
        if (!allDue) return;

        // Alle Buchungen eintragen
        allInGroup.forEach(s => {
          db.run(
            'INSERT INTO transactions (account_id, amount, date, type, category_id, description) VALUES (?, ?, ?, ?, ?, ?)',
            [s.account_id, s.amount, s.next_due_date, s.type, s.category_id, s.description || '']
          );
        });

        // Datum für alle Mitglieder sicher vorrücken (F3: kein Rollover)
        allInGroup.forEach(s => {
          const nextDate = addMonthsSafe(s.next_due_date, s.interval_months || 1);
          db.run('UPDATE scheduled_transactions SET next_due_date = ? WHERE id = ?',
            [nextDate, s.id]);
        });

        bookedThisRound += allInGroup.length;
        console.log(`Umbuchung Gruppe ${groupId}: ${allInGroup.length} Buchungen (${allInGroup[0]?.next_due_date})`);

      } catch (e) {
        // Einzelne Gruppe schlägt fehl (z.B. verwaister account_id) →
        // Eintrag überspringen, Rest der Gruppen weiterverarbeiten
        console.error(`Fehler bei Gruppe ${groupId}:`, e.message);
      }
    });

    // ── Einzelne Einträge (ohne Gruppe) ───────────────────────────────────
    ungrouped.forEach(s => {
      try {
        db.run(
          'INSERT INTO transactions (account_id, amount, date, type, category_id, description) VALUES (?, ?, ?, ?, ?, ?)',
          [s.account_id, s.amount, s.next_due_date, s.type, s.category_id, s.description || '']
        );

        if (s.interval_months === null) {
          // Einmalig: deaktivieren
          db.run('UPDATE scheduled_transactions SET is_active = 0 WHERE id = ?', [s.id]);
        } else {
          // Wiederkehrend: Datum sicher vorrücken (F3: kein Rollover)
          const nextDate = addMonthsSafe(s.next_due_date, s.interval_months);
          db.run('UPDATE scheduled_transactions SET next_due_date = ? WHERE id = ?',
            [nextDate, s.id]);
        }

        bookedThisRound++;

      } catch (e) {
        // Einzelner Eintrag schlägt fehl → überspringen, Rest weiterverarbeiten
        console.error(`Fehler bei scheduled_transaction id=${s.id}:`, e.message);
      }
    });

    totalBooked += bookedThisRound;
    iterations++;

    // Keine Buchungen in dieser Runde → alle Einträge ohne Gruppe
    // waren einmalig oder die Gruppen-Prüfung hat alle übersprungen
    if (bookedThisRound === 0) break;
  }

  // Einmalig persistieren nach allen Iterationen (F4: mit Error-Handling)
  if (totalBooked > 0) {
    persist();
    console.log(`processScheduled: ${totalBooked} Transaktionen in ${iterations} Iteration(en) gebucht`);
  }

  return totalBooked;
}

// ── Verteilungen (Gruppen in scheduled_transactions) ──────────────────────
// Eine Verteilung = mehrere scheduled_transactions mit gleicher group_id.
// Beim Erstellen wird eine neue group_id generiert (max + 1).

function getNextGroupId() {
  const res = db.exec('SELECT MAX(group_id) as mx FROM scheduled_transactions');
  const max = res[0]?.values[0][0];
  return (max !== null && max !== undefined) ? max + 1 : 1;
}

// Gibt alle Verteilungen zurück (gruppiert nach group_id)
// MIN(next_due_date) liefert deterministisch das früheste Datum der Gruppe.
function getAllDistributions() {
  const rows = query(`
    SELECT
      s.group_id,
      MIN(s.description)    AS description,
      MIN(s.start_date)     AS start_date,
      MIN(s.next_due_date)  AS next_due_date,
      MIN(s.interval_months) AS interval_months,
      MIN(s.is_active)      AS is_active
    FROM scheduled_transactions s
    WHERE s.group_id IS NOT NULL
    GROUP BY s.group_id
    ORDER BY MIN(s.next_due_date) ASC
  `);

  return rows.map(g => ({
    group_id:        g.group_id,
    description:     g.description,
    next_due_date:   g.next_due_date,
    interval_months: g.interval_months,
    is_active:       g.is_active,
    items: query(`
      SELECT s.id, s.account_id, s.amount, s.type,
        a.name AS account_name,
        COALESCE(a.account_type, 'private') AS account_type
      FROM scheduled_transactions s
      LEFT JOIN accounts a ON s.account_id = a.id
      WHERE s.group_id = ?
      ORDER BY s.type DESC
    `, [g.group_id])
  }));
}

// Erstellt eine Verteilung: mehrere scheduled_transactions mit gleicher group_id
function createDistribution({ description, start_date, interval_months, items }) {
  // items = [{ account_id, amount, type }]
  const groupId = getNextGroupId();

  items.forEach(item => {
    db.run(
      `INSERT INTO scheduled_transactions
         (account_id, amount, type, description, start_date, next_due_date, interval_months, is_active, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [item.account_id, item.amount, item.type, description || '', start_date, start_date,
       interval_months, groupId]
    );
  });

  persist();
  return { group_id: groupId, success: true };
}

// Löscht alle scheduled_transactions einer Gruppe
function deleteDistribution(groupId) {
  db.run('DELETE FROM scheduled_transactions WHERE group_id = ?', [groupId]);
  persist();
  return { success: true };
}

// ── Rücklagen ─────────────────────────────────────────────────────────────
function getAllReserves() { return query('SELECT * FROM reserves ORDER BY name'); }
function createReserve({ name, target_amount, current_amount = 0, deduction_day = 1, interval_months = 1, first_due_date = null }) {
  const r = run(
    'INSERT INTO reserves (name, target_amount, current_amount, deduction_day, interval_months, first_due_date) VALUES (?, ?, ?, ?, ?, ?)',
    [name, target_amount, current_amount, deduction_day, interval_months, first_due_date || null]
  );
  return { id: r.lastInsertRowid, success: true };
}
function updateReserveAmount(id, current_amount) {
  run('UPDATE reserves SET current_amount = ? WHERE id = ?', [current_amount, id]);
  return { success: true };
}
function deleteReserve(id) { run('DELETE FROM reserves WHERE id = ?', [id]); return { success: true }; }

// ── Ratenkäufe ────────────────────────────────────────────────────────────
function getAllInstallments() {
  return query(`
    SELECT i.*, a.name AS account_name, c.name AS category_name
    FROM installments i
    LEFT JOIN accounts   a ON i.account_id  = a.id
    LEFT JOIN categories c ON i.category_id = c.id
    ORDER BY i.start_date DESC
  `);
}
function createInstallment({ name, total_amount, monthly_rate, total_months, paid_months = 0,
                              start_date, account_id, category_id, deduction_day = 1 }) {
  const r = run(
    `INSERT INTO installments
       (name, total_amount, monthly_rate, total_months, paid_months, start_date,
        account_id, category_id, deduction_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, total_amount, monthly_rate, total_months, paid_months, start_date,
     account_id || null, category_id || null, deduction_day]
  );
  return { id: r.lastInsertRowid, success: true };
}
function updateInstallmentPaidMonths(id, paid_months) {
  run('UPDATE installments SET paid_months = ? WHERE id = ?', [paid_months, id]);
  return { success: true };
}
function deleteInstallment(id) { run('DELETE FROM installments WHERE id = ?', [id]); return { success: true }; }

module.exports = {
  initialize,
  addMonthsSafe,
  getDbPath: () => dbPath,
  getAllAccounts, createAccount, deleteAccount, updateAccountType, updateAccount,
  getAllTransactions, createTransaction, deleteTransaction, createAdjustment,
  getAllCategories, createCategory, updateCategory, deleteCategory,
  getAllScheduled, createScheduled, deleteScheduled, processScheduled,
  getAllDistributions, createDistribution, deleteDistribution,
  getAllReserves, createReserve, updateReserveAmount, deleteReserve,
  getAllInstallments, createInstallment, updateInstallmentPaidMonths, deleteInstallment
};
