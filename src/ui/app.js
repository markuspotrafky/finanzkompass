// src/ui/app.js – Frontend-Router und App-Logik

// ── Globaler State ────────────────────────────────────────────────────────
let currentPage = 'accounts';
let accounts = [];
let categories = [];

// ── Farbpalette & Color Picker ────────────────────────────────────────────
const COLOR_PALETTE = [
  '#1DB954', '#4d9fff', '#ff6b6b', '#ffc145', '#b07fff',
  '#3df0b0', '#ff8c42', '#69c0ff', '#ff77c8', '#f06595',
  '#a9e34b', '#ffd43b', '#e599f7', '#74c0fc', '#c8d6e5'
];

// Baut das flexible Color-Picker-Widget:
// - Natives Farbrad (input[type=color])
// - Hex-Eingabefeld
// - Vorschau-Chip
// - Schnellauswahl-Swatches
// inputId: ID des hidden input das den Wert hält
// initialColor: Startwert
function buildColorPicker(inputId, initialColor = '#4d9fff') {
  const swatches = COLOR_PALETTE.map(c => `
    <button type="button" class="color-swatch ${c.toLowerCase() === initialColor.toLowerCase() ? 'selected' : ''}"
            style="background:${c}" data-color="${c}"
            onclick="colorPickerSelectSwatch('${inputId}', '${c}')"></button>
  `).join('');

  return `
    <div class="color-picker-widget" id="${inputId}-widget">
      <div class="color-picker-top">
        <input type="color" class="color-picker-native" id="${inputId}-native"
               value="${initialColor}"
               oninput="colorPickerFromNative('${inputId}')" />
        <input type="text" class="color-picker-hex" id="${inputId}-hex"
               value="${initialColor.toUpperCase()}"
               placeholder="#RRGGBB"
               maxlength="7"
               oninput="colorPickerFromHex('${inputId}')" />
        <div class="color-picker-preview" id="${inputId}-preview"
             style="background:${initialColor}"></div>
      </div>
      <div class="color-picker-swatches">${swatches}</div>
    </div>
    <input type="hidden" id="${inputId}" value="${initialColor}" />
  `;
}

// Swatch geklickt → alle Felder synchronisieren
function colorPickerSelectSwatch(inputId, color) {
  _colorPickerSync(inputId, color);
}

// Natives Farbrad geändert
function colorPickerFromNative(inputId) {
  const native = document.getElementById(inputId + '-native');
  if (native) _colorPickerSync(inputId, native.value);
}

// Hex-Feld geändert (nur wenn gültig)
function colorPickerFromHex(inputId) {
  const hex = document.getElementById(inputId + '-hex');
  if (!hex) return;
  const val = hex.value.trim();
  const full = val.startsWith('#') ? val : '#' + val;
  if (/^#[0-9a-fA-F]{6}$/.test(full)) {
    _colorPickerSync(inputId, full, true); // skipHex = true um Cursor nicht zu stören
  }
}

// Interne Sync-Funktion: setzt alle Elemente auf dieselbe Farbe
function _colorPickerSync(inputId, color, skipHex = false) {
  const hidden   = document.getElementById(inputId);
  const native   = document.getElementById(inputId + '-native');
  const hex      = document.getElementById(inputId + '-hex');
  const preview  = document.getElementById(inputId + '-preview');
  const widget   = document.getElementById(inputId + '-widget');

  if (hidden)  hidden.value  = color;
  if (native)  native.value  = color;
  if (preview) preview.style.background = color;
  if (!skipHex && hex) hex.value = color.toUpperCase();

  // Swatches: ausgewählten markieren
  if (widget) {
    widget.querySelectorAll('.color-swatch').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.color.toLowerCase() === color.toLowerCase());
    });
  }
}

// Legacy-Kompatibilität: selectColor wird von alten Aufrufen nicht mehr verwendet,
// aber zur Sicherheit als No-Op erhalten
function selectColor() {}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────

function formatAmount(amount) {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR'
  }).format(amount);
}

function formatDate(dateStr) {
  if (!dateStr) return '–';
  const d = new Date(dateStr);
  return d.toLocaleDateString('de-DE');
}

function getTodayISO() {
  // Lokales Datum (nicht UTC) — verhindert Fehler um Mitternacht für DE-Nutzer (GMT+1/+2)
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Sichere Monatsaddition im Renderer (gespiegelt von database.js addMonthsSafe).
// Verhindert JavaScript-Rollover: 31. Jan + 1 → 28. Feb, nicht 3. März.
function addMonthsSafeStr(dateStr, months) {
  const parts = dateStr.split('-');
  const year  = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day   = parseInt(parts[2], 10);
  let newMonth = month + months;
  let newYear  = year;
  while (newMonth > 12) { newMonth -= 12; newYear++; }
  while (newMonth < 1)  { newMonth += 12; newYear--; }
  const lastDay = new Date(newYear, newMonth, 0).getDate();
  const newDay  = Math.min(day, lastDay);
  return `${newYear}-${String(newMonth).padStart(2, '0')}-${String(newDay).padStart(2, '0')}`;
}

// ── F1: Zentrale Betrags-Parsing-Funktion ─────────────────────────────────
// Verarbeitet deutsche UND englische Zahlenformate korrekt:
//   "2.800,00" → 2800.00  (Deutsch: Punkt=Tausender, Komma=Dezimal)
//   "1234,56"  → 1234.56  (Deutsch ohne Tausendertrenner)
//   "1234.56"  → 1234.56  (Englisch: Punkt=Dezimal)
//   "1.234"    → 1234     (Tausendertrenner erkannt: genau 3 Stellen nach Punkt)
//   "1.5"      → 1.5      (Dezimal: nicht genau 3 Stellen nach Punkt)
//
// Erkennungsstrategie:
//   Beide Zeichen vorhanden → letztes bestimmt Dezimalzeichen
//   Nur Komma              → Komma ist Dezimal
//   Nur Punkt + 3 Nachkomma → Tausendertrenner
//   Nur Punkt + ≠3 Nachkomma → Dezimal
function parseAmount(rawValue, fallback = 0) {
  if (rawValue === null || rawValue === undefined) return fallback;
  const str = String(rawValue).trim();
  if (str === '') return fallback;

  const hasComma = str.includes(',');
  const hasDot   = str.includes('.');
  let normalized;

  if (hasComma && hasDot) {
    // Beide vorhanden → letztes Zeichen bestimmt das Dezimalzeichen
    const lastComma = str.lastIndexOf(',');
    const lastDot   = str.lastIndexOf('.');
    if (lastComma > lastDot) {
      // Deutsch: "1.234,56" → Punkte entfernen, Komma → Punkt
      normalized = str.replace(/\./g, '').replace(',', '.');
    } else {
      // Englisch: "1,234.56" → Kommas entfernen
      normalized = str.replace(/,/g, '');
    }
  } else if (hasComma && !hasDot) {
    // Nur Komma → Komma ist Dezimal: "1234,56" → "1234.56"
    normalized = str.replace(',', '.');
  } else if (hasDot && !hasComma) {
    // Nur Punkt → Tausendertrenner wenn genau 3 Stellen danach: "1.234" → 1234
    // Sonst Dezimal: "1234.56" → 1234.56
    const afterLastDot = str.split('.').pop();
    normalized = afterLastDot.length === 3
      ? str.replace(/\./g, '')   // Tausendertrenner entfernen
      : str;                     // Dezimalpunkt behalten
  } else {
    normalized = str;
  }

  const parsed = parseFloat(normalized);
  // isFinite() schließt Infinity und -Infinity aus (parseFloat('Infinity') = Infinity)
  return (isNaN(parsed) || !isFinite(parsed)) ? fallback : parsed;
}

// ── F6: Zentrale Betrags-Validierung ─────────────────────────────────────
// Prüft ob ein Betrag gültig und verwendbar ist.
// isFinite() schließt Infinity und NaN aus.
// Optionales minValue (default 0) erlaubt auch Null-Beträge (z.B. Startsaldo).
function isValidAmount(value, { allowZero = false, allowNegative = false } = {}) {
  if (!isFinite(value) || isNaN(value)) return false;
  if (!allowNegative && value < 0)     return false;
  if (!allowZero     && value === 0)   return false;
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// TABELLEN-SORTIERUNG
// ══════════════════════════════════════════════════════════════════════════
//
// Architektur:
//   tableSort     — zentraler State pro Tabellen-ID { col, dir }
//   sortData()    — sortiert ein Array nach col+dir, kein DOM
//   sortTh()      — baut <th>-HTML mit data-sort Attribut + Pfeil
//   applySort()   — State-Toggle + Re-Render (wird von onclick aufgerufen)
//
// Verwendung in Render-Funktionen:
//   1. Daten mit sortData(data, tableId, col) vor dem Row-Mapping sortieren
//   2. <th> durch sortTh(tableId, 'col', 'Text', 'type') ersetzen
//   3. applySort(tableId, renderFn) als onclick übergeben
//
// Spalten-Typen:
//   'text'   → localeCompare('de') — alphabetisch, Umlaute korrekt
//   'number' → numerisch
//   'date'   → ISO-Datum-String chronologisch (lexikographisch vergleichbar)
// ══════════════════════════════════════════════════════════════════════════

const tableSort = {}; // { [tableId]: { col: string, dir: 1|-1 } }

// Sortiert ein Array in-place. Gibt dasselbe Array zurück.
// col        = Schlüssel im Objekt (z.B. 'date', 'amount')
// type       = 'text' | 'number' | 'date'
// Leere/null Werte landen immer am Ende, unabhängig von der Richtung.
// Sortiert ein Array in-place. Gibt dasselbe Array zurück.
// Liest col und type aus tableSort[tableId] — kein Aufruf nötig wenn kein State.
// Leere/null Werte landen immer am Ende, unabhängig von der Richtung.
function sortData(arr, tableId) {
  const state = tableSort[tableId];
  if (!state) return arr; // Kein Sort-State → Originalreihenfolge

  const { col, type, dir } = state;

  return arr.slice().sort((a, b) => {
    let va = a[col];
    let vb = b[col];

    // Leere Werte immer ans Ende
    const emptyA = (va === null || va === undefined || va === '');
    const emptyB = (vb === null || vb === undefined || vb === '');
    if (emptyA && emptyB)  return 0;
    if (emptyA)            return 1;
    if (emptyB)            return -1;

    switch (type) {
      case 'number':
        return (Number(va) - Number(vb)) * dir;

      case 'date':
        // ISO-Strings ('2026-03-01') sind lexikographisch direkt vergleichbar
        return va < vb ? -dir : va > vb ? dir : 0;

      case 'text':
      default:
        return String(va).localeCompare(String(vb), 'de', { sensitivity: 'base' }) * dir;
    }
  });
}

// Gibt HTML für einen sortierbaren <th> zurück.
// tableId    = eindeutige ID der Tabelle (z.B. 'tx-booked')
// col        = Daten-Schlüssel der Spalte
// label      = Anzeigetext
// type       = 'text' | 'number' | 'date'
// renderCall = JS-Ausdruck als String für onclick (z.B. 'renderTransactionsPage(...)')
function sortTh(tableId, col, label, type, renderCall) {
  const state   = tableSort[tableId];
  const active  = state && state.col === col;
  const dir     = active ? state.dir : 0;
  const arrow   = active ? (dir === 1 ? ' <span class="sort-arrow sort-arrow-asc">↑</span>'
                                       : ' <span class="sort-arrow sort-arrow-desc">↓</span>') : '';
  const cls     = active ? ' class="th-sort-active"' : '';
  const onclick = `applySort('${tableId}','${col}','${type}',()=>{${renderCall}})`;
  return `<th${cls} onclick="${onclick}" style="cursor:pointer;user-select:none">${label}${arrow}</th>`;
}

// Toggle-Funktion: wird bei Klick auf <th> aufgerufen.
// Schaltet col um oder dreht Richtung um, dann ruft renderFn() auf.
function applySort(tableId, col, type, renderFn) {
  const state = tableSort[tableId];
  if (!state || state.col !== col) {
    // Neue Spalte: aufsteigend starten
    tableSort[tableId] = { col, type, dir: 1 };
  } else {
    // Gleiche Spalte: Richtung umkehren
    tableSort[tableId] = { col, type, dir: state.dir * -1 };
  }
  renderFn();
}

// ── Notification ──────────────────────────────────────────────────────────

function showNotification(msg, type = 'success') {
  const el = document.getElementById('notification');
  el.textContent = msg;
  el.className = `notification ${type} show`;
  setTimeout(() => { el.className = 'notification'; }, 3000);
}

// ── Modal ─────────────────────────────────────────────────────────────────

function openModal(title, bodyHTML) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  document.getElementById('modal-overlay').classList.add('open');
  document.querySelectorAll('.filter-bar select').forEach(el => el.disabled = true);

  // Fokus in zwei Stufen: sofort ans Fenster, dann nach kurzem Delay
  // ans erste Input-Feld im Modal übergeben.
  window.focus();
  if (window.api?.window?.focus) window.api.window.focus();

  // 120ms reicht damit Electron den DOM-Paint abschließt
  setTimeout(() => {
    if (window.api?.window?.focus) window.api.window.focus();
    const firstInput = document.querySelector('#modal-body input, #modal-body select, #modal-body textarea');
    if (firstInput) firstInput.focus();
  }, 120);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.querySelectorAll('.filter-bar select').forEach(el => el.disabled = false);
  // Fokus nach Modal-Schließen sicherstellen
  window.focus();
  if (window.api?.window?.focus) window.api.window.focus();
}

document.getElementById('modal-close').addEventListener('click', closeModal);

// Modal-Overlay: nur schließen wenn der Klick WIRKLICH auf dem Overlay
// started UND endet — nicht wenn der Nutzer Text markiert und dabei
// den Mauszeiger auf das Overlay zieht.
let overlayMousedownTarget = null;
document.getElementById('modal-overlay').addEventListener('mousedown', e => {
  overlayMousedownTarget = e.target;
});
document.getElementById('modal-overlay').addEventListener('click', e => {
  const overlay = document.getElementById('modal-overlay');
  // Nur schließen wenn mousedown UND click auf dem Overlay selbst waren
  if (e.target === overlay && overlayMousedownTarget === overlay) {
    closeModal();
  }
  overlayMousedownTarget = null;
});

// ── Fokus-Wiederherstellung ───────────────────────────────────────────────
// Electron verliert nach Fensterwechsel oder nativen Dialogen den Webview-Fokus.
//
// WICHTIG: mousedown NICHT auf document registrieren – das unterbricht
// Text-Markierung in Inputs (Electron feuert den Handler auch während drag).
// Stattdessen: nur beim Zurückkehren zum Fenster und bei direktem Klick
// auf ein Input-Element korrigieren.

// Jedes Input-Feld: beim Klick direkt fokussieren.
// Nur ausführen wenn das Element noch NICHT aktiv ist (= kein Eingriff
// während der Nutzer bereits tippt oder Text markiert).
document.addEventListener('pointerdown', e => {
  const tag = e.target?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    setTimeout(() => {
      if (document.activeElement !== e.target) {
        e.target.focus();
      }
    }, 0);
  }
}, true);

// Beim Zurückkehren zum Fenster (z.B. Alt+Tab)
window.addEventListener('focus', () => {
  if (window.api?.window?.focus) window.api.window.focus();
});

// Heartbeat: nur aktiv wenn kein Input fokussiert ist → Fenster-Fokus
// anfordern, aber niemals ein bestimmtes Feld überschreiben.
setInterval(() => {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay?.classList.contains('open')) return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return;
  if (window.api?.window?.focus) window.api.window.focus();
}, 500);

// ── Navigation ────────────────────────────────────────────────────────────

async function navigateTo(page) {
  currentPage = page;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  const content = document.getElementById('main-content');

  switch (page) {
    case 'dashboard':
      await renderDashboardPage(content);
      initDonutHover();
      break;
    case 'accounts':
      await renderAccountsPage(content);
      break;
    case 'transactions':
      await renderTransactionsPage(content);
      break;
    case 'savings':
      await renderSavingsPage(content);
      break;
    case 'installments':
      await renderInstallmentsPage(content);
      break;
    case 'fixcosts':
      await renderFixcostsPage(content);
      break;
    case 'distributions':
      await renderDistributionsPage(content);
      break;
    case 'analytics':
      await renderAnalyticsPage(content);
      initDonutHover();
      break;
    case 'settings':
      await renderSettingsPage(content);
      break;
    default:
      renderPlaceholderPage(content, page);
  }
}

// Klick-Handler für Sidebar – immer neu rendern, auch bei aktiver Seite
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', () => navigateTo(el.dataset.page));
});

// ── Seite: Platzhalter ────────────────────────────────────────────────────

const placeholderConfig = {
  savings:      { icon: '◎', title: 'Rücklagen',      desc: 'Sparziele und Rücklagen verwalten – kommt bald.' },
  installments: { icon: '≡', title: 'Ratenkäufe',     desc: 'Laufende Ratenkäufe verfolgen – kommt bald.' },
  analytics:    { icon: '∿', title: 'Auswertungen',   desc: 'Diagramme und Berichte – kommt bald.' },
  settings:     { icon: '⚙', title: 'Einstellungen',  desc: 'Datenbank-Pfad und App-Optionen – kommt bald.' }
};

function renderPlaceholderPage(container, page) {
  const cfg = placeholderConfig[page] || { icon: '?', title: page, desc: '' };
  container.innerHTML = `
    <div class="placeholder-page">
      <div class="placeholder-icon">${cfg.icon}</div>
      <h2>${cfg.title}</h2>
      <p>${cfg.desc}</p>
    </div>
  `;
}

// ── Seite: Dashboard ──────────────────────────────────────────────────────

async function renderDashboardPage(container) {
  const data = await window.api.dashboard.getData();
  const { accounts, budget, forecast, fixedCosts, expensesByCategory } = data;

  const monthNames = ['Januar','Februar','März','April','Mai','Juni',
                      'Juli','August','September','Oktober','November','Dezember'];
  const now            = new Date();
  const monthLabel     = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
  const nextMonthIdx   = (now.getMonth() + 1) % 12;
  const nextMonthYear  = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const nextMonthLabel = `${monthNames[nextMonthIdx]} ${nextMonthYear}`;

  const heroValueClass = budget.restbudget >= 0 ? 'ds-hero-value ds-positive' : 'ds-hero-value ds-negative';

  // Kontostände mit Farb-Punkt (nutzt a.color aus DB)
  const accountRows = accounts.length
    ? accounts.map(a => {
        const dot = `<span class="ds-row-dot" style="background:${a.color || '#4d9fff'}"></span>`;
        return `
          <div class="ds-row">
            <span class="ds-row-label">${dot}${escHtml(a.name)}</span>
            <span class="ds-row-value ${a.balance < 0 ? 'ds-negative' : ''}">${formatAmount(a.balance)}</span>
          </div>`;
      }).join('')
    : `<div class="ds-empty">Keine Privatkonten angelegt</div>`;

  // Prognose-Trend: Pfeil zeigt ob besser/schlechter als aktueller Monat
  const trendDiff   = forecast.restbudget - budget.restbudget;
  const trendArrow  = trendDiff > 0 ? '↑' : trendDiff < 0 ? '↓' : '→';
  const trendClass  = trendDiff > 0 ? 'ds-positive' : trendDiff < 0 ? 'ds-negative' : '';
  const trendLabel  = trendDiff !== 0
    ? `<span class="${trendClass}" style="font-size:11px;font-weight:700;margin-left:4px">${trendArrow} ${formatAmount(Math.abs(trendDiff))}</span>`
    : '';

  const MAX_FIXED  = 4;
  const fixedSlice = fixedCosts.items.slice(0, MAX_FIXED);
  const fixedMore  = fixedCosts.items.length - MAX_FIXED;
  const fixedRows  = fixedSlice.length
    ? fixedSlice.map(s => `
        <div class="ds-row">
          <span class="ds-row-label">${escHtml(s.description || s.category_name || '–')}</span>
          <span class="ds-row-value ds-negative">–${formatAmount(s.amount)}</span>
        </div>`).join('') +
      (fixedMore > 0 ? `<div class="ds-row-more">+${fixedMore} weitere</div>` : '')
    : `<div class="ds-empty">Keine Fixkosten diesen Monat</div>`;

  const chartHtml = buildDonutChart(expensesByCategory, monthLabel);

  container.innerHTML = `
    <div class="ds-layout">

      <!-- ① HERO -->
      <div class="ds-hero">
        <div class="ds-hero-glow"></div>
        <div class="ds-hero-content">
          <p class="ds-hero-label">Restbudget · ${monthLabel}</p>
          <p class="${heroValueClass}">${formatAmount(budget.restbudget)}</p>
          <div class="ds-hero-stats">
            <div class="ds-hero-stat">
              <span class="ds-hero-stat-label">Kontostand</span>
              <span class="ds-hero-stat-value">${formatAmount(budget.totalBalance)}</span>
            </div>
            <div class="ds-hero-sep"></div>
            <div class="ds-hero-stat">
              <span class="ds-hero-stat-label">Einnahmen</span>
              <span class="ds-hero-stat-value ds-positive">+${formatAmount(budget.plannedIncome)}</span>
            </div>
            <div class="ds-hero-sep"></div>
            <div class="ds-hero-stat">
              <span class="ds-hero-stat-label">Ausgaben</span>
              <span class="ds-hero-stat-value ds-negative">–${formatAmount(budget.plannedExpense)}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ② SEKUNDÄR-REIHE -->
      <div class="ds-row-grid">

        <div class="ds-card">
          <div class="ds-card-head">
            <span class="ds-card-title">Kontostände</span>
            <span class="ds-card-tag">${accounts.length} Konto${accounts.length !== 1 ? 'en' : ''}</span>
          </div>
          <div class="ds-card-body">${accountRows}</div>
          <div class="ds-card-foot">
            <span class="ds-foot-label">Gesamt</span>
            <span class="ds-foot-value ${budget.totalBalance < 0 ? 'ds-negative' : ''}">${formatAmount(budget.totalBalance)}</span>
          </div>
        </div>

        <div class="ds-card">
          <div class="ds-card-head">
            <span class="ds-card-title">Prognose</span>
            <span class="ds-card-tag">${nextMonthLabel}</span>
          </div>
          <div class="ds-card-body">
            <div class="ds-row">
              <span class="ds-row-label">Einnahmen</span>
              <span class="ds-row-value ds-positive">+${formatAmount(forecast.income)}</span>
            </div>
            <div class="ds-row">
              <span class="ds-row-label">Ausgaben</span>
              <span class="ds-row-value ds-negative">–${formatAmount(forecast.expense)}</span>
            </div>
          </div>
          <div class="ds-card-foot">
            <span class="ds-foot-label">Restbudget ${trendLabel}</span>
            <span class="ds-foot-value ${forecast.restbudget < 0 ? 'ds-negative' : 'ds-positive'}">${formatAmount(forecast.restbudget)}</span>
          </div>
        </div>

      </div>

      <!-- ③ DONUT-CHART -->
      ${chartHtml}

      <!-- ④ FIXKOSTEN -->
      <div class="ds-card ds-card-flat">
        <div class="ds-card-head">
          <span class="ds-card-title">Fixkosten diesen Monat</span>
          <span class="ds-foot-value ds-negative">–${formatAmount(fixedCosts.total)}</span>
        </div>
        <div class="ds-fixed-grid">${fixedRows}</div>
      </div>

    </div>

    <!-- FAB -->
    <button class="ds-fab" onclick="openNewTransactionModal()" title="Neue Transaktion">+</button>
  `;
}

// ── Donut-Chart: Ausgaben nach Kategorie ─────────────────────────────────

const DONUT_COLORS = [
  '#4d9fff', '#2dca5c', '#ff6b6b', '#ffc145', '#b07fff',
  '#3df0b0', '#ff8c42', '#69c0ff', '#ff77c8', '#c8d6e5'
];

// Gibt einen Punkt auf einem Kreis zurück (Winkel 0 = oben, im Uhrzeigersinn)
function polarPoint(cx, cy, r, angleDeg) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad)
  };
}

// Baut einen korrekten SVG-Pfad für ein Donut-Segment:
//   äußerer Bogen (startA → endA) + Linie nach innen + innerer Bogen (endA → startA) + Linie nach außen
function donutSegmentPath(cx, cy, rOuter, rInner, startA, endA) {
  // Schutz: fast 360° → 359.999 um degenerierten arc zu verhindern
  const safeEnd = endA - startA >= 359.99 ? startA + 359.99 : endA;
  const large   = safeEnd - startA > 180 ? 1 : 0;

  const p1 = polarPoint(cx, cy, rOuter, startA);  // äußerer Startpunkt
  const p2 = polarPoint(cx, cy, rOuter, safeEnd); // äußerer Endpunkt
  const p3 = polarPoint(cx, cy, rInner, safeEnd); // innerer Endpunkt
  const p4 = polarPoint(cx, cy, rInner, startA);  // innerer Startpunkt

  return [
    `M ${p1.x} ${p1.y}`,                                        // Start außen
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${p2.x} ${p2.y}`,      // Äußerer Bogen
    `L ${p3.x} ${p3.y}`,                                        // Linie nach innen
    `A ${rInner} ${rInner} 0 ${large} 0 ${p4.x} ${p4.y}`,      // Innerer Bogen (Gegenrichtung: sweep=0)
    'Z'                                                          // Schließen
  ].join(' ');
}

function buildDonutChart({ categories, total, month }, monthLabel) {
  if (!categories.length || total === 0) {
    return `
      <div class="ds-card">
        <div class="ds-card-head">
          <span class="ds-card-title">Ausgaben nach Kategorie</span>
          <span class="ds-card-tag">${monthLabel}</span>
        </div>
        <div class="ds-empty" style="padding:24px 0;text-align:center">
          Keine Ausgaben auf Privatkonten in diesem Monat
        </div>
      </div>`;
  }

  const CX = 110, CY = 110, R_OUTER = 90, R_INNER = 54;
  // Kleiner Gap zwischen Segmenten für sauberere Optik (in Grad)
  const GAP = categories.length > 1 ? 1.5 : 0;
  let angle = 0;

  const segments = categories.map((cat, i) => {
    const share  = cat.amount / total;
    const sweep  = share * 360;
    const startA = angle + GAP / 2;
    const endA   = angle + sweep - GAP / 2;
    const color  = DONUT_COLORS[i % DONUT_COLORS.length];
    const pct    = Math.round(share * 100);
    angle += sweep;
    return { ...cat, startA, endA, color, pct };
  });

  const paths = segments.map((s, i) => {
    const d = donutSegmentPath(CX, CY, R_OUTER, R_INNER, s.startA, s.endA);
    return `<path class="donut-seg" data-index="${i}"
      d="${d}"
      fill="${s.color}"
      style="cursor:pointer; transition:opacity 0.15s;" />`;
  }).join('');

  const legendItems = segments.map((s, i) => `
    <div class="donut-legend-item" data-index="${i}">
      <span class="donut-legend-dot" style="background:${s.color}"></span>
      <span class="donut-legend-name">${escHtml(s.name)}</span>
      <span class="donut-legend-amount">–${formatAmount(s.amount)}</span>
      <span class="donut-legend-pct">${s.pct}%</span>
    </div>`).join('');

  const segData = JSON.stringify(segments.map(s => ({
    name: s.name, amount: s.amount, pct: s.pct, color: s.color
  })));

  // SVG-Größe: 220×220 passend zu CX/CY=110
  return `
    <div class="ds-card" id="donut-card">
      <div class="ds-card-head">
        <span class="ds-card-title">Ausgaben nach Kategorie</span>
        <span class="ds-card-tag">${monthLabel}</span>
      </div>
      <div class="donut-wrap">
        <div class="donut-chart-wrap">
          <svg viewBox="0 0 220 220" width="220" height="220" id="donut-svg">
            ${paths}
            <!-- Zentrum als SVG-Text – liegt immer über den Segmenten, nie verdeckt -->
            <text x="${CX}" y="${CY - 8}" text-anchor="middle"
                  font-size="10" font-family="Inter, DM Sans, sans-serif"
                  fill="#A0A7B5" text-transform="uppercase"
                  letter-spacing="1">GESAMT</text>
            <text x="${CX}" y="${CY + 14}" text-anchor="middle"
                  font-size="17" font-weight="700"
                  font-family="DM Mono, monospace"
                  fill="#ff4d4f">–${formatAmount(total)}</text>
          </svg>
        </div>
        <div class="donut-legend" id="donut-legend">${legendItems}</div>
      </div>
      <script id="donut-data" type="application/json">${segData}</script>
    </div>`;
}

// Hover: nur opacity, kein transform, Tooltip folgt Maus
function initDonutHover() {
  const svg     = document.getElementById('donut-svg');
  const legend  = document.getElementById('donut-legend');
  const dataEl  = document.getElementById('donut-data');
  if (!svg || !dataEl) return;

  // Alten Tooltip vom body entfernen falls vorhanden
  const oldTip = document.getElementById('donut-tooltip');
  if (oldTip) oldTip.remove();

  // Tooltip direkt am body – verhindert dass parent-transforms die fixed-Position brechen
  let tooltip = document.createElement('div');
  tooltip.id        = 'donut-tooltip';
  tooltip.className = 'donut-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  const segments    = JSON.parse(dataEl.textContent);
  const paths       = svg.querySelectorAll('.donut-seg');
  const legendItems = legend ? legend.querySelectorAll('.donut-legend-item') : [];

  function highlight(idx) {
    paths.forEach((p, i) => {
      p.style.opacity = i === idx ? '1' : '0.3';
    });
    legendItems.forEach((li, i) => {
      li.style.opacity = i === idx ? '1' : '0.35';
    });
  }

  function reset() {
    paths.forEach(p => { p.style.opacity = '1'; });
    legendItems.forEach(li => { li.style.opacity = '1'; });
    tooltip.style.display = 'none';
  }

  function showTooltip(e, idx) {
    const seg = segments[idx];
    tooltip.innerHTML =
      `<span class="donut-tt-dot" style="background:${seg.color}"></span>` +
      `<span class="donut-tt-name">${escHtml(seg.name)}</span>` +
      `<span class="donut-tt-amount">–${formatAmount(seg.amount)}</span>` +
      `<span class="donut-tt-pct">${seg.pct}%</span>`;
    tooltip.style.display = 'flex';
    moveTooltip(e);
  }

  function moveTooltip(e) {
    if (tooltip.style.display === 'none') return;
    const ox = 14, oy = 14;
    let lx = e.clientX + ox;
    let ty = e.clientY + oy;
    // Rand-Überlauf verhindern
    const tw = tooltip.offsetWidth  || 180;
    const th = tooltip.offsetHeight || 36;
    if (lx + tw > window.innerWidth  - 8) lx = e.clientX - tw - ox;
    if (ty + th > window.innerHeight - 8) ty = e.clientY - th - oy;
    tooltip.style.left = lx + 'px';
    tooltip.style.top  = ty + 'px';
  }

  paths.forEach((p, i) => {
    p.addEventListener('mouseenter', e => { highlight(i); showTooltip(e, i); });
    p.addEventListener('mousemove',  e => moveTooltip(e));
    p.addEventListener('mouseleave', reset);
  });

  legendItems.forEach((li, i) => {
    li.addEventListener('mouseenter', e => { highlight(i); showTooltip(e, i); });
    li.addEventListener('mousemove',  e => moveTooltip(e));
    li.addEventListener('mouseleave', reset);
  });
}

// ── Seite: Konten ─────────────────────────────────────────────────────────

async function renderAccountsPage(container) {
  accounts = await window.api.accounts.getAll();

  const cards = accounts.length
    ? accounts.map(a => {
        const isJoint   = a.account_type === 'joint';
        const color     = a.color || '#4d9fff';
        const typeBadge = isJoint
          ? `<span class="acc-type-badge acc-type-joint">Gemeinschaft</span>`
          : `<span class="acc-type-badge acc-type-private">Privat</span>`;
        return `
          <div class="account-card ${isJoint ? 'account-card-joint' : ''}"
               style="border-top: 3px solid ${color}">
            <button class="account-delete-btn" onclick="deleteAccount(${a.id})" title="Konto löschen">✕</button>
            <div class="account-card-name" style="color:${color}">${escHtml(a.name)}</div>
            ${typeBadge}
            <div class="account-card-balance ${a.balance < 0 ? 'negative' : 'positive'}">
              ${formatAmount(a.balance)}
            </div>
            <div class="account-card-meta">
              Startwert: ${formatAmount(a.initial_balance)} &nbsp;·&nbsp;
              Dispo: ${formatAmount(a.overdraft_limit)}
            </div>
            <button class="btn btn-ghost acc-type-toggle"
                    onclick="openEditAccountModal(${a.id})">
              Bearbeiten
            </button>
          </div>`;
      }).join('')
    : `<div class="empty-state"><p>Noch keine Konten angelegt.</p></div>`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Konten</div>
        <div class="page-subtitle">${accounts.length} Konto${accounts.length !== 1 ? 'en' : ''}</div>
      </div>
      <button class="btn btn-primary" onclick="openNewAccountModal()">+ Konto anlegen</button>
    </div>
    <div class="card-grid" id="accounts-grid">${cards}</div>
  `;
}

function openNewAccountModal() {
  openModal('Neues Konto anlegen', `
    <div class="form-group">
      <label>Kontoname</label>
      <input type="text" id="acc-name" placeholder="z.B. Markus, GLS" />
    </div>
    <div class="form-group">
      <label>Kontotyp</label>
      <select id="acc-type">
        <option value="private">Privatkonto</option>
        <option value="joint">Gemeinschaftskonto</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Startsaldo (€)</label>
        <input type="text" inputmode="decimal" id="acc-balance" value="0" />
      </div>
      <div class="form-group">
        <label>Dispokredit (€)</label>
        <input type="text" inputmode="decimal" id="acc-overdraft" value="0" />
      </div>
    </div>
    <div class="form-group">
      <label>Farbe</label>
      ${buildColorPicker('acc-color', '#1DB954')}
    </div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitNewAccount()">Konto anlegen</button>
    </div>
  `);
  setTimeout(() => document.getElementById('acc-name').focus(), 50);
}

async function submitNewAccount() {
  const name         = document.getElementById('acc-name').value.trim();
  const account_type = document.getElementById('acc-type').value;
  const balance      = parseAmount(document.getElementById('acc-balance').value, 0);
  const overdraft    = parseAmount(document.getElementById('acc-overdraft').value, 0);
  const color        = document.getElementById('acc-color')?.value || '#4d9fff';

  if (!name) {
    showNotification('Bitte einen Namen eingeben.', 'error');
    return;
  }

  await window.api.accounts.create({ name, initial_balance: balance, overdraft_limit: overdraft, account_type, color });
  closeModal();
  showNotification(`Konto „${name}" angelegt.`);
  await navigateTo('accounts');
}

async function deleteAccount(id) {
  const acc = accounts.find(a => a.id === id);
  if (!confirm(`Konto „${acc?.name}" wirklich löschen? Alle Transaktionen werden ebenfalls entfernt.`)) return;
  await window.api.accounts.delete(id);
  showNotification('Konto gelöscht.', 'success');
  await navigateTo('accounts');
}

function openEditAccountModal(id) {
  const a = accounts.find(a => a.id === id);
  if (!a) return;
  const currentColor = a.color || '#4d9fff';

  openModal(`Konto bearbeiten – ${escHtml(a.name)}`, `
    <div class="form-group">
      <label>Kontoname</label>
      <input type="text" id="edit-acc-name" value="${escHtml(a.name)}" />
    </div>
    <div class="form-group">
      <label>Kontotyp</label>
      <select id="edit-acc-type">
        <option value="private" ${a.account_type !== 'joint' ? 'selected' : ''}>Privatkonto</option>
        <option value="joint"   ${a.account_type === 'joint' ? 'selected' : ''}>Gemeinschaftskonto</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Dispokredit (€)</label>
        <input type="text" inputmode="decimal" id="edit-acc-overdraft"
               value="${a.overdraft_limit.toString().replace('.', ',')}" />
      </div>
    </div>
    <div class="form-group">
      <label>Farbe</label>
      ${buildColorPicker('edit-acc-color', currentColor)}
    </div>

    <div class="form-group">
      <div class="adj-current-row">
        <span class="adj-label">Aktueller Kontostand</span>
        <span class="adj-current-value">${formatAmount(a.balance)}</span>
      </div>
    </div>
    <div class="form-group">
      <label>Kontostand korrigieren auf (€) <span style="color:var(--text-muted);font-weight:400">– leer lassen um nicht zu ändern</span></label>
      <input type="text" inputmode="decimal" id="edit-acc-balance"
             placeholder="${a.balance.toFixed(2).replace('.', ',')}"
             oninput="updateEditAccDiff(${a.balance})" />
    </div>
    <div id="edit-adj-diff-row" class="adj-diff-row" style="display:none">
      <span class="adj-label">Differenz</span>
      <span id="edit-adj-diff-value" class="adj-diff-value"></span>
    </div>

    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitEditAccount(${id}, ${a.balance})">Speichern</button>
    </div>
  `);
  setTimeout(() => document.getElementById('edit-acc-name').focus(), 50);
}

function updateEditAccDiff(currentBalance) {
  const rawStr  = document.getElementById('edit-acc-balance')?.value.trim();
  const diffRow = document.getElementById('edit-adj-diff-row');
  const diffVal = document.getElementById('edit-adj-diff-value');
  if (!diffRow || !diffVal) return;
  if (!rawStr) { diffRow.style.display = 'none'; return; }

  const newBal = parseAmount(rawStr);
  if (!isFinite(newBal) || isNaN(newBal)) { diffRow.style.display = 'none'; return; }

  const diff = parseFloat((newBal - currentBalance).toFixed(2));
  diffRow.style.display = 'flex';
  diffVal.textContent   = (diff >= 0 ? '+' : '') + formatAmount(diff);
  diffVal.className     = 'adj-diff-value ' + (diff > 0 ? 'amount-income' : diff < 0 ? 'amount-expense' : '');
}

async function submitEditAccount(id, currentBalance) {
  const name         = document.getElementById('edit-acc-name').value.trim();
  const account_type = document.getElementById('edit-acc-type').value;
  const overdraft    = parseAmount(document.getElementById('edit-acc-overdraft').value, 0);
  const color        = document.getElementById('edit-acc-color')?.value || '#4d9fff';
  const balRaw       = document.getElementById('edit-acc-balance').value.trim();

  if (!name) { showNotification('Bitte einen Namen eingeben.', 'error'); return; }

  await window.api.accounts.update(id, { name, account_type, overdraft_limit: overdraft, color });

  // Kontostand-Korrektur nur wenn Feld ausgefüllt
  if (balRaw !== '') {
    const newBal = parseAmount(balRaw);
    if (!isNaN(newBal)) {
      const diff = parseFloat((newBal - currentBalance).toFixed(2));
      if (diff !== 0) {
        await window.api.transactions.adjust({
          account_id:  id,
          amount:      diff,
          date:        getTodayISO(),
          description: `Kontostand-Korrektur (${diff >= 0 ? '+' : ''}${formatAmount(diff)})`
        });
      }
    }
  }

  closeModal();
  showNotification(`Konto „${name}" gespeichert.`);
  await navigateTo('accounts');
}

// ── Seite: Transaktionen (mit Tab: Gebucht / Geplant) ────────────────────

// Merkt sich welcher Tab aktiv ist, solange die Seite offen bleibt
let txActiveTab = 'booked';

async function renderTransactionsPage(container, tab) {
  if (tab) txActiveTab = tab;

  const [txs, scheduled, cats] = await Promise.all([
    window.api.transactions.getAll(),
    window.api.scheduled.getAll(),
    window.api.categories.getAll()
  ]);
  accounts   = await window.api.accounts.getAll();
  categories = cats;

  const filterAccount = document.getElementById('filter-account')?.value || '';
  const filterType    = document.getElementById('filter-type')?.value    || '';

  const accountOptions = accounts.map(a =>
    `<option value="${a.id}" ${filterAccount === String(a.id) ? 'selected' : ''}>${escHtml(a.name)}</option>`
  ).join('');

  // ── Tab: Gebuchte Transaktionen ──
  const filtered = txs.filter(t => {
    if (filterAccount && String(t.account_id) !== filterAccount) return false;
    if (filterType    && t.type !== filterType)                   return false;
    return true;
  });

  // Daten sortieren (nach aktuellem tableSort-State für 'tx-booked')
  const sortedFiltered = sortData(filtered, 'tx-booked');

  const reRenderBooked = `renderTransactionsPage(document.getElementById('main-content'),'booked')`;

  const bookedRows = sortedFiltered.length
    ? sortedFiltered.map(t => {
        const isAdj     = t.type === 'adjustment';
        const adjClass  = isAdj ? ' tx-adjustment' : '';
        const typeLabel = isAdj
          ? `<span class="badge badge-adjustment">Korrektur</span>`
          : `<span class="badge ${t.type === 'income' ? 'badge-income' : 'badge-expense'}">
               ${t.type === 'income' ? 'Einnahme' : 'Ausgabe'}
             </span>`;
        const amountStr = isAdj
          ? `<span class="amount-adjustment">${t.amount >= 0 ? '+' : ''}${formatAmount(t.amount)}</span>`
          : `<span class="amount-${t.type}">${t.type === 'income' ? '+' : '–'}${formatAmount(t.amount)}</span>`;
        return `
        <tr class="${adjClass}">
          <td>${formatDate(t.date)}</td>
          <td>${escHtml(t.account_name)}</td>
          <td>${escHtml(t.category_name || '–')}</td>
          <td>${escHtml(t.description || '–')}</td>
          <td>${typeLabel}</td>
          <td>${amountStr}</td>
          <td><button class="table-delete-btn" onclick="deleteTransaction(${t.id})" title="Löschen">✕</button></td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="7"><div class="empty-state"><p>Keine Transaktionen gefunden.</p></div></td></tr>`;

  // ── Tab: Geplante Transaktionen (alle OHNE group_id – also keine Umbuchungen) ──
  const filteredScheduled = scheduled.filter(s => {
    if (s.group_id !== null && s.group_id !== undefined) return false;
    if (filterAccount && String(s.account_id) !== filterAccount) return false;
    if (filterType    && s.type !== filterType)                   return false;
    return true;
  });

  // ── Umbuchungen des aktuellen Monats ─────────────────────────────────────
  const nowD      = new Date();
  const curYYYYMM = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}`;

  const distThisMonth = scheduled.filter(s =>
    s.group_id !== null && s.group_id !== undefined &&
    s.is_active === 1 &&
    s.next_due_date && s.next_due_date.startsWith(curYYYYMM)
  );

  // Nach group_id gruppieren
  const distGroups = {};
  distThisMonth.forEach(s => {
    if (!distGroups[s.group_id]) distGroups[s.group_id] = [];
    distGroups[s.group_id].push(s);
  });

  const distRows = Object.values(distGroups).map(items => {
    const desc     = items[0]?.description || 'Umbuchung';
    const dueDate  = items[0]?.next_due_date;
    const expenses = items.filter(i => i.type === 'expense');
    const income   = items.find(i => i.type === 'income');
    const total    = expenses.reduce((s, i) => s + i.amount, 0);
    const chips    = expenses.map(i =>
      `<span class="dist-tx-chip">${escHtml(i.account_name)}: –${formatAmount(i.amount)}</span>`
    ).join('') + (income
      ? `<span class="dist-tx-chip dist-tx-chip-in">${escHtml(income.account_name)}: +${formatAmount(total)}</span>`
      : '');
    return `
      <tr class="dist-tx-row">
        <td>${formatDate(dueDate)}</td>
        <td colspan="2">
          <span class="badge" style="background:rgba(176,127,255,0.15);color:#b07fff;border:1px solid rgba(176,127,255,0.3)">Umbuchung</span>
          &nbsp;${escHtml(desc)}
          <div class="dist-tx-detail">${chips}</div>
        </td>
        <td>–</td>
        <td><span class="badge" style="background:rgba(255,193,69,0.12);color:#ffc145;border:1px solid rgba(255,193,69,0.25)">Geplant</span></td>
        <td class="amount-expense">–${formatAmount(total)}</td>
        <td style="font-size:11.5px;color:var(--text-dim)">${intervalLabel[items[0]?.interval_months] ?? '–'}</td>
        <td>–</td>
        <td></td>
      </tr>`;
  }).join('');

  // Geplante Transaktionen sortieren
  const reRenderSched = `renderTransactionsPage(document.getElementById('main-content'),'scheduled')`;
  const sortedScheduled = sortData(filteredScheduled, 'tx-scheduled');

  const singleRows = sortedScheduled.map(s => {
    const intLabel    = s.interval_months
      ? (intervalLabel[s.interval_months] ?? `Alle ${s.interval_months} Monate`)
      : 'Einmalig';
    const statusBadge = s.is_active === 1
      ? `<span class="badge badge-income">Aktiv</span>`
      : `<span class="badge" style="background:#1a1a1a;color:var(--text-muted)">Inaktiv</span>`;
    return `
      <tr style="${s.is_active !== 1 ? 'opacity:0.45' : ''}">
        <td>${formatDate(s.next_due_date)}</td>
        <td>${escHtml(s.account_name)}</td>
        <td>${escHtml(s.category_name || '–')}</td>
        <td>${escHtml(s.description || '–')}</td>
        <td><span class="badge ${s.type === 'income' ? 'badge-income' : 'badge-expense'}">
          ${s.type === 'income' ? 'Einnahme' : 'Ausgabe'}
        </span></td>
        <td class="amount-${s.type}">${s.type === 'income' ? '+' : '–'}${formatAmount(s.amount)}</td>
        <td style="font-size:11.5px;color:var(--text-dim)">${intLabel}</td>
        <td>${statusBadge}</td>
        <td><button class="table-delete-btn" onclick="deleteScheduled(${s.id}, 'transactions')" title="Löschen">✕</button></td>
      </tr>`;
  }).join('');

  const allScheduledRows = singleRows + distRows;
  const scheduledRows = allScheduledRows
    ? allScheduledRows
    : `<tr><td colspan="9"><div class="empty-state"><p>Keine geplanten Transaktionen.</p></div></td></tr>`;

  const isBooked    = txActiveTab === 'booked';
  const countBooked = filtered.length;
  const countSched  = filteredScheduled.filter(s => s.is_active).length;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Transaktionen</div>
        <div class="page-subtitle">
          ${isBooked ? `${countBooked} Einträge` : `${countSched} aktive Einträge`}
        </div>
      </div>
      <button class="btn btn-primary" onclick="openNewTransactionModal()">+ Transaktion</button>
    </div>

    <!-- Tabs -->
    <div class="tab-bar">
      <button class="tab-btn ${isBooked ? 'active' : ''}"
              onclick="renderTransactionsPage(document.getElementById('main-content'), 'booked')">
        Gebucht
      </button>
      <button class="tab-btn ${!isBooked ? 'active' : ''}"
              onclick="renderTransactionsPage(document.getElementById('main-content'), 'scheduled')">
        Geplant
      </button>
    </div>

    <!-- Filter -->
    <div class="filter-bar">
      <select id="filter-account"
              onchange="if(!document.getElementById('modal-overlay').classList.contains('open')) renderTransactionsPage(document.getElementById('main-content'))">
        <option value="">Alle Konten</option>
        ${accountOptions}
      </select>
      <select id="filter-type"
              onchange="if(!document.getElementById('modal-overlay').classList.contains('open')) renderTransactionsPage(document.getElementById('main-content'))">
        <option value="" ${filterType === '' ? 'selected' : ''}>Alle Typen</option>
        <option value="income"  ${filterType === 'income'  ? 'selected' : ''}>Einnahmen</option>
        <option value="expense" ${filterType === 'expense' ? 'selected' : ''}>Ausgaben</option>
      </select>
    </div>

    <!-- Tabelle: Gebucht -->
    <div id="tab-booked" style="display:${isBooked ? 'block' : 'none'}">
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              ${sortTh('tx-booked','date',       'Datum',       'date',   reRenderBooked)}
              ${sortTh('tx-booked','account_name','Konto',       'text',   reRenderBooked)}
              ${sortTh('tx-booked','category_name','Kategorie',  'text',   reRenderBooked)}
              ${sortTh('tx-booked','description', 'Beschreibung','text',   reRenderBooked)}
              ${sortTh('tx-booked','type',        'Typ',         'text',   reRenderBooked)}
              ${sortTh('tx-booked','amount',      'Betrag',      'number', reRenderBooked)}
              <th></th>
            </tr>
          </thead>
          <tbody>${bookedRows}</tbody>
        </table>
      </div>
    </div>

    <!-- Tabelle: Geplant (alle ohne Umbuchungen) -->
    <div id="tab-scheduled" style="display:${!isBooked ? 'block' : 'none'}">
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              ${sortTh('tx-scheduled','next_due_date','Fälligkeit',  'date',   reRenderSched)}
              ${sortTh('tx-scheduled','account_name', 'Konto',       'text',   reRenderSched)}
              ${sortTh('tx-scheduled','category_name','Kategorie',   'text',   reRenderSched)}
              ${sortTh('tx-scheduled','description',  'Beschreibung','text',   reRenderSched)}
              ${sortTh('tx-scheduled','type',         'Typ',         'text',   reRenderSched)}
              ${sortTh('tx-scheduled','amount',       'Betrag',      'number', reRenderSched)}
              ${sortTh('tx-scheduled','interval_months','Intervall', 'number', reRenderSched)}
              ${sortTh('tx-scheduled','is_active',    'Status',      'number', reRenderSched)}
              <th></th>
            </tr>
          </thead>
          <tbody>${scheduledRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function openNewTransactionModal(fixcostMode = false) {
  if (!accounts.length) {
    showNotification('Bitte zuerst ein Konto anlegen.', 'error');
    return;
  }

  const accountOptions = accounts.map(a =>
    `<option value="${a.id}">${escHtml(a.name)}</option>`
  ).join('');

  const categoryOptions = categories.map(c =>
    `<option value="${c.id}">${escHtml(c.name)}</option>`
  ).join('');

  // Im Fixkosten-Modus: Checkbox vorausgewählt, Intervall auf "Monatlich"
  const scheduledChecked  = fixcostMode ? 'checked' : '';
  const scheduledDisplay  = fixcostMode ? 'block' : 'none';
  const dateDisplay       = fixcostMode ? 'none' : 'block';
  const defaultInterval   = fixcostMode ? '1' : '0';

  openModal(fixcostMode ? 'Neue Fixkosten anlegen' : 'Neue Transaktion', `
    <div class="form-row">
      <div class="form-group">
        <label>Konto</label>
        <select id="tx-account">${accountOptions}</select>
      </div>
      <div class="form-group">
        <label>Typ</label>
        <select id="tx-type">
          <option value="expense">Ausgabe</option>
          <option value="income">Einnahme</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Betrag (€)</label>
        <input type="text" inputmode="decimal" id="tx-amount" placeholder="0,00" />
      </div>
      <div class="form-group" style="display:${dateDisplay}" id="tx-date-group">
        <label>Datum</label>
        <input type="date" id="tx-date" value="${getTodayISO()}" max="${getTodayISO()}" />
      </div>
    </div>
    <div class="form-group">
      <label>Kategorie</label>
      <select id="tx-category">${categoryOptions}</select>
    </div>
    <div class="form-group">
      <label>Beschreibung</label>
      <input type="text" id="tx-desc" placeholder="z.B. Miete, Strom" />
    </div>

    <!-- Geplante / Fixkosten -->
    <div class="form-group" style="margin-top:16px; padding-top:14px; border-top:1px solid var(--border)">
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; text-transform:none; letter-spacing:0">
        <input type="checkbox" id="tx-scheduled" ${scheduledChecked} onchange="toggleScheduledFields()"
               style="width:auto; accent-color:var(--accent)" />
        Geplante / wiederkehrende Transaktion
      </label>
    </div>

    <div id="scheduled-fields" style="display:${scheduledDisplay}">
      <div class="form-row">
        <div class="form-group">
          <label>Startdatum</label>
          <input type="date" id="tx-start-date" value="${getTodayISO()}" />
        </div>
        <div class="form-group">
          <label>Intervall</label>
          <select id="tx-interval" onchange="updateScheduledLabel()">
            <option value="0"  ${defaultInterval === '0'  ? 'selected' : ''}>Einmalig (kein Intervall)</option>
            <option value="1"  ${defaultInterval === '1'  ? 'selected' : ''}>Monatlich</option>
            <option value="3"  ${defaultInterval === '3'  ? 'selected' : ''}>Vierteljährlich</option>
            <option value="6"  ${defaultInterval === '6'  ? 'selected' : ''}>Halbjährlich</option>
            <option value="12" ${defaultInterval === '12' ? 'selected' : ''}>Jährlich</option>
          </select>
        </div>
      </div>
      <div id="fixcost-hint" class="fixcost-modal-hint" style="display:${defaultInterval !== '0' ? 'block' : 'none'}">
        ↻ Wird als Fixkosten gespeichert und erscheint unter „Fixkosten"
      </div>
    </div>

    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitNewTransaction()">Speichern</button>
    </div>
  `);
  setTimeout(() => document.getElementById('tx-amount').focus(), 50);
}

// Geplante Felder ein-/ausblenden
function toggleScheduledFields() {
  const checked   = document.getElementById('tx-scheduled').checked;
  document.getElementById('scheduled-fields').style.display = checked ? 'block' : 'none';
  const dateGroup = document.getElementById('tx-date-group');
  if (dateGroup) dateGroup.style.display = checked ? 'none' : 'block';
  updateScheduledLabel();
}

// Fixkosten-Hinweis ein-/ausblenden je nach Intervall
function updateScheduledLabel() {
  const interval = document.getElementById('tx-interval')?.value;
  const hint     = document.getElementById('fixcost-hint');
  if (hint) hint.style.display = (interval && interval !== '0') ? 'block' : 'none';
}

async function submitNewTransaction() {
  const account_id  = parseInt(document.getElementById('tx-account').value);
  const type        = document.getElementById('tx-type').value;
  const amount      = parseAmount(document.getElementById('tx-amount').value);
  const category_id = parseInt(document.getElementById('tx-category').value) || null;
  const description = document.getElementById('tx-desc').value.trim();
  const isScheduled = document.getElementById('tx-scheduled').checked;

  if (!isValidAmount(amount)) {
    showNotification('Bitte einen gültigen Betrag eingeben (z.B. 1.234,56).', 'error');
    return;
  }

  if (isScheduled) {
    // ── Geplante Transaktion speichern ──
    const start_date      = document.getElementById('tx-start-date').value;
    const intervalVal     = parseInt(document.getElementById('tx-interval').value);
    const interval_months = intervalVal === 0 ? null : intervalVal;

    if (!start_date) {
      showNotification('Bitte ein Startdatum eingeben.', 'error');
      return;
    }

    await window.api.scheduled.create({
      account_id, amount, type, category_id, description,
      start_date, interval_months
    });
    closeModal();
    // Fixkosten (interval != null) → Fixkosten-Seite; einmalig → Transaktionen
    if (interval_months !== null) {
      showNotification('Fixkosten gespeichert.');
      if (currentPage === 'fixcosts') {
        await renderFixcostsPage(document.getElementById('main-content'));
      } else {
        await navigateTo('fixcosts');
      }
    } else {
      showNotification('Geplante Transaktion gespeichert.');
      await renderTransactionsPage(document.getElementById('main-content'), 'scheduled');
    }

  } else {
    // ── Normale Transaktion speichern ──
    const date = document.getElementById('tx-date').value;
    if (!date) {
      showNotification('Bitte ein Datum eingeben.', 'error');
      return;
    }
    if (date > getTodayISO()) {
      showNotification('Datum darf nicht in der Zukunft liegen.', 'error');
      return;
    }
    await window.api.transactions.create({ account_id, amount, date, type, category_id, description });
    closeModal();
    showNotification('Transaktion gespeichert.');
    await navigateTo('transactions');
  }
}

async function deleteTransaction(id) {
  if (!confirm('Transaktion wirklich löschen?')) return;
  await window.api.transactions.delete(id);
  showNotification('Transaktion gelöscht.');
  await navigateTo('transactions');
}

// ── Seite: Geplante Transaktionen ─────────────────────────────────────────

const intervalLabel = {
  null: 'Einmalig',
  1:    'Monatlich',
  3:    'Vierteljährlich',
  6:    'Halbjährlich',
  12:   'Jährlich'
};

async function deleteScheduled(id, source = 'transactions') {
  if (!confirm('Eintrag wirklich löschen?')) return;
  await window.api.scheduled.delete(id);
  showNotification('Eintrag gelöscht.');
  if (source === 'fixcosts') {
    await renderFixcostsPage(document.getElementById('main-content'));
  } else {
    await renderTransactionsPage(document.getElementById('main-content'), 'scheduled');
  }
}

// ── Seite: Fixkosten ──────────────────────────────────────────────────────
// Fixkosten = scheduled_transactions mit interval_months IS NOT NULL

async function renderFixcostsPage(container) {
  const [scheduled, cats] = await Promise.all([
    window.api.scheduled.getAll(),
    window.api.categories.getAll()
  ]);
  accounts   = await window.api.accounts.getAll();
  categories = cats;

  // Nur wiederkehrende, vom Gemeinschaftskonto, OHNE Verteilungseinträge (group_id === null)
  const jointIds = new Set(accounts.filter(a => a.account_type === 'joint').map(a => a.id));
  const fixcosts = scheduled.filter(s =>
    s.interval_months !== null &&
    s.group_id === null &&
    jointIds.has(s.account_id)
  );

  // Nach Typ aufteilen für Summen
  const activeFixcosts = fixcosts.filter(s => s.is_active === 1);
  const totalExpense   = activeFixcosts.filter(s => s.type === 'expense').reduce((sum, s) => sum + s.amount, 0);
  const totalIncome    = activeFixcosts.filter(s => s.type === 'income').reduce((sum, s) => sum + s.amount, 0);

  const filterAccount = document.getElementById('fc-filter-account')?.value || '';
  const filterType    = document.getElementById('fc-filter-type')?.value    || '';

  const filtered = fixcosts.filter(s => {
    if (filterAccount && String(s.account_id) !== filterAccount) return false;
    if (filterType    && s.type !== filterType)                   return false;
    return true;
  });

  const accountOptions = accounts.map(a =>
    `<option value="${a.id}" ${filterAccount === String(a.id) ? 'selected' : ''}>${escHtml(a.name)}</option>`
  ).join('');

  const reRenderFc = `renderFixcostsPage(document.getElementById('main-content'))`;
  const sortedFc = sortData(filtered, 'fc');

  const rows = sortedFc.length
    ? sortedFc.map(s => {
        const label = intervalLabel[s.interval_months] ?? `Alle ${s.interval_months} Monate`;
        const statusBadge = s.is_active
          ? `<span class="badge badge-income">Aktiv</span>`
          : `<span class="badge" style="background:#1a1a1a;color:var(--text-muted)">Inaktiv</span>`;
        return `
          <tr style="${!s.is_active ? 'opacity:0.45' : ''}">
            <td>${escHtml(s.description || '–')}</td>
            <td>${escHtml(s.account_name)}</td>
            <td>${escHtml(s.category_name || '–')}</td>
            <td><span class="badge ${s.type === 'income' ? 'badge-income' : 'badge-expense'}">
              ${s.type === 'income' ? 'Einnahme' : 'Ausgabe'}
            </span></td>
            <td class="amount-${s.type}">${s.type === 'income' ? '+' : '–'}${formatAmount(s.amount)}</td>
            <td>${label}</td>
            <td>${formatDate(s.next_due_date)}</td>
            <td>${statusBadge}</td>
            <td><button class="table-delete-btn" onclick="deleteScheduled(${s.id}, 'fixcosts')" title="Löschen">✕</button></td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="9"><div class="empty-state"><p>Keine Fixkosten für Gemeinschaftskonten gefunden.<br><small style="color:var(--text-muted)">Lege zuerst ein Gemeinschaftskonto an und erstelle dann wiederkehrende Transaktionen dafür.</small></p></div></td></tr>`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Fixkosten</div>
        <div class="page-subtitle">${activeFixcosts.length} aktive Einträge</div>
      </div>
      <button class="btn btn-primary" onclick="openNewFixcostModal()">+ Fixkosten anlegen</button>
    </div>

    <!-- Zusammenfassung -->
    <div class="fixcost-summary">
      <div class="fixcost-summary-item">
        <span class="fixcost-summary-label">Monatliche Ausgaben</span>
        <span class="fixcost-summary-value amount-expense">–${formatAmount(totalExpense)}</span>
      </div>
      <div class="fixcost-summary-sep"></div>
      <div class="fixcost-summary-item">
        <span class="fixcost-summary-label">Monatliche Einnahmen</span>
        <span class="fixcost-summary-value amount-income">+${formatAmount(totalIncome)}</span>
      </div>
      <div class="fixcost-summary-sep"></div>
      <div class="fixcost-summary-item">
        <span class="fixcost-summary-label">Saldo</span>
        <span class="fixcost-summary-value ${totalIncome - totalExpense < 0 ? 'amount-expense' : 'amount-income'}">
          ${formatAmount(totalIncome - totalExpense)}
        </span>
      </div>
    </div>

    <!-- Filter -->
    <div class="filter-bar">
      <select id="fc-filter-account"
              onchange="if(!document.getElementById('modal-overlay').classList.contains('open')) renderFixcostsPage(document.getElementById('main-content'))">
        <option value="">Alle Konten</option>
        ${accountOptions}
      </select>
      <select id="fc-filter-type"
              onchange="if(!document.getElementById('modal-overlay').classList.contains('open')) renderFixcostsPage(document.getElementById('main-content'))">
        <option value="" ${filterType === '' ? 'selected' : ''}>Alle Typen</option>
        <option value="income"  ${filterType === 'income'  ? 'selected' : ''}>Einnahmen</option>
        <option value="expense" ${filterType === 'expense' ? 'selected' : ''}>Ausgaben</option>
      </select>
    </div>

    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            ${sortTh('fc','description',   'Beschreibung',       'text',   reRenderFc)}
            ${sortTh('fc','account_name',  'Konto',              'text',   reRenderFc)}
            ${sortTh('fc','category_name', 'Kategorie',          'text',   reRenderFc)}
            ${sortTh('fc','type',          'Typ',                'text',   reRenderFc)}
            ${sortTh('fc','amount',        'Betrag',             'number', reRenderFc)}
            ${sortTh('fc','interval_months','Intervall',         'number', reRenderFc)}
            ${sortTh('fc','next_due_date', 'Nächste Fälligkeit', 'date',   reRenderFc)}
            ${sortTh('fc','is_active',     'Status',             'number', reRenderFc)}
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// Modal für neue Fixkosten – öffnet das normale Transaktionsmodal
// mit vorausgewähltem Intervall (nicht "Einmalig")
function openNewFixcostModal() {
  openNewTransactionModal(true); // true = Fixkosten-Modus
}

// ── Seite: Rücklagen ──────────────────────────────────────────────────────

async function renderSavingsPage(container) {
  const reserves = await window.api.reserves.getAll();

  const cards = reserves.length
    ? reserves.map(r => `
        <div class="progress-card">
          <button class="account-delete-btn" onclick="deleteReserve(${r.id})" title="Löschen">✕</button>
          <div class="progress-card-name">${escHtml(r.name)}</div>

          <div class="progress-amounts">
            <span class="amount-income" style="font-family:var(--font-mono)">${formatAmount(r.current_amount)}</span>
            <span class="progress-of"> von ${formatAmount(r.target_amount)}</span>
          </div>

          <div class="progress-bar-track">
            <div class="progress-bar-fill" style="width:${r.progress}%"></div>
          </div>
          <div class="progress-meta">
            <span>${r.progress}%</span>
            <span>Noch ${formatAmount(r.remaining)}</span>
          </div>

          <div class="progress-sub">
            ${r.intervalLabel} · Tag ${r.deduction_day}
            · nächste Abbuchung: ${formatDate(r.nextDeduction)}
            ${r.first_due_date ? `<br><span style="color:var(--accent);font-size:11px">Erste Abbuchung: ${formatDate(r.first_due_date)}</span>` : ''}
          </div>

          <div class="progress-actions">
            <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px"
                    onclick="openUpdateReserveModal(${r.id}, ${r.current_amount})">
              + Betrag anpassen
            </button>
          </div>
        </div>
      `).join('')
    : `<div class="empty-state"><p>Noch keine Rücklagen angelegt.</p></div>`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Rücklagen</div>
        <div class="page-subtitle">${reserves.length} Einträge</div>
      </div>
      <button class="btn btn-primary" onclick="openNewReserveModal()">+ Rücklage anlegen</button>
    </div>
    <div class="card-grid">${cards}</div>
  `;
}

function openNewReserveModal() {
  openModal('Neue Rücklage anlegen', `
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="res-name" placeholder="z.B. Urlaub, Auto-Reparatur" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Zielbetrag (€)</label>
        <input type="text" inputmode="decimal" id="res-target" placeholder="0,00"
               oninput="calcReserveContribution()" />
      </div>
      <div class="form-group">
        <label>Aktueller Stand (€)</label>
        <input type="text" inputmode="decimal" id="res-current" value="0"
               oninput="calcReserveContribution()" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Abbuchungsintervall</label>
        <select id="res-interval" onchange="calcReserveContribution()">
          <option value="1">Monatlich</option>
          <option value="3">Vierteljährlich</option>
          <option value="6">Halbjährlich</option>
          <option value="12">Jährlich</option>
        </select>
      </div>
      <div class="form-group">
        <label>Abbuchungstag (1–31)</label>
        <input type="text" inputmode="numeric" id="res-day" placeholder="1"
               oninput="calcReserveContribution()" />
      </div>
    </div>
    <div class="form-group">
      <label>Erstes Buchungsdatum
        <span style="color:var(--text-muted);font-weight:400"> – wann soll die erste Abbuchung stattfinden?</span>
      </label>
      <input type="date" id="res-first-due" value="${getTodayISO()}" />
    </div>

    <!-- Berechnete Vorschau -->
    <div class="form-group">
      <div id="res-calc-preview" class="calc-preview" style="display:none"></div>
    </div>

    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitNewReserve()">Anlegen</button>
    </div>
  `);
  setTimeout(() => document.getElementById('res-name').focus(), 50);
}

// Live-Berechnung: zeigt monatliches Äquivalent sobald Felder gefüllt sind
function calcReserveContribution() {
  const target   = parseAmount(document.getElementById('res-target')?.value, 0);
  const current  = parseAmount(document.getElementById('res-current')?.value, 0);
  const interval = parseInt(document.getElementById('res-interval')?.value) || 1;
  const preview  = document.getElementById('res-calc-preview');

  if (!preview) return;
  const remaining = Math.max(0, target - current);

  if (remaining <= 0 || target <= 0) {
    preview.style.display = 'none';
    return;
  }

  // Betrag pro Abbuchung = Restbetrag (keine feste Laufzeit → Nutzer spart bis Ziel)
  // Monatliches Äquivalent = Betrag pro Abbuchung ÷ Intervall
  const monthlyEquiv = remaining / interval;
  const intervalLabels = { 1: 'Monat', 3: 'Quartal', 6: 'Halbjahr', 12: 'Jahr' };
  const label = intervalLabels[interval] || `${interval} Monate`;

  preview.style.display = 'block';
  preview.innerHTML = `
    <div class="calc-preview-row">
      <span>Noch zu sparen</span>
      <strong>${formatAmount(remaining)}</strong>
    </div>
    <div class="calc-preview-row">
      <span>Monatliches Äquivalent</span>
      <strong class="amount-income">${formatAmount(monthlyEquiv)} / Monat</strong>
    </div>
  `;
}

async function submitNewReserve() {
  const name            = document.getElementById('res-name').value.trim();
  const target_amount   = parseAmount(document.getElementById('res-target').value);
  const current_amount  = parseAmount(document.getElementById('res-current').value, 0);
  const deduction_day   = parseInt(document.getElementById('res-day').value) || 1;
  const interval_months = parseInt(document.getElementById('res-interval').value) || 1;
  const first_due_date  = document.getElementById('res-first-due').value || null;

  if (!name)                          { showNotification('Bitte einen Namen eingeben.', 'error'); return; }
  if (!isValidAmount(target_amount))  { showNotification('Bitte einen gültigen Zielbetrag eingeben (z.B. 1.200,00).', 'error'); return; }
  if (deduction_day < 1 || deduction_day > 31) {
    showNotification('Abbuchungstag muss zwischen 1 und 31 liegen.', 'error'); return;
  }

  await window.api.reserves.create({ name, target_amount, current_amount, deduction_day, interval_months, first_due_date });
  closeModal();
  showNotification(`Rücklage „${name}" angelegt.`);
  await navigateTo('savings');
}

function openUpdateReserveModal(id, currentAmount) {
  openModal('Betrag anpassen', `
    <div class="form-group">
      <label>Neuer aktueller Stand (€)</label>
      <input type="text" inputmode="decimal" id="res-new-amount" value="${currentAmount}" />
    </div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitUpdateReserve(${id})">Speichern</button>
    </div>
  `);
  setTimeout(() => document.getElementById('res-new-amount').select(), 50);
}

async function submitUpdateReserve(id) {
  const amount = parseAmount(document.getElementById('res-new-amount').value, NaN);
  if (!isFinite(amount) || isNaN(amount) || amount < 0) { showNotification('Ungültiger Betrag.', 'error'); return; }
  await window.api.reserves.updateAmount(id, amount);
  closeModal();
  showNotification('Stand aktualisiert.');
  await navigateTo('savings');
}

async function deleteReserve(id) {
  if (!confirm('Rücklage wirklich löschen?')) return;
  await window.api.reserves.delete(id);
  showNotification('Rücklage gelöscht.');
  await navigateTo('savings');
}

// ── Seite: Ratenkäufe ─────────────────────────────────────────────────────

async function renderInstallmentsPage(container) {
  const items = await window.api.installments.getAll();

  const cards = items.length
    ? items.map(inst => {
        const endLabel = inst.endDate ? formatDate(inst.endDate) : '–';
        const accLabel = inst.account_name ? escHtml(inst.account_name) : '–';
        const catLabel = inst.category_name ? escHtml(inst.category_name) : '–';
        const dayLabel = inst.deduction_day ? `Tag ${inst.deduction_day}` : '';
        return `
        <div class="progress-card ${inst.isComplete ? 'progress-card-done' : ''}">
          <button class="account-delete-btn" onclick="deleteInstallment(${inst.id})" title="Löschen">✕</button>
          <div class="progress-card-name">${escHtml(inst.name)}</div>

          <div class="progress-amounts">
            <span style="font-family:var(--font-mono)">${inst.paid_months} von ${inst.total_months} Raten</span>
            ${inst.isComplete ? `<span class="badge badge-income" style="font-size:11px">Abgeschlossen</span>` : ''}
          </div>

          <div class="progress-bar-track">
            <div class="progress-bar-fill ${inst.isComplete ? 'progress-bar-done' : ''}"
                 style="width:${inst.progress}%"></div>
          </div>
          <div class="progress-meta">
            <span>${inst.progress}%</span>
            <span>Noch ${formatAmount(inst.remaining)}</span>
          </div>

          <div class="inst-detail-grid">
            <div class="inst-detail-item">
              <span class="inst-detail-label">Rate</span>
              <span class="inst-detail-value">${formatAmount(inst.monthly_rate)}</span>
            </div>
            <div class="inst-detail-item">
              <span class="inst-detail-label">Gesamt</span>
              <span class="inst-detail-value">${formatAmount(inst.total_amount)}</span>
            </div>
            <div class="inst-detail-item">
              <span class="inst-detail-label">Konto</span>
              <span class="inst-detail-value">${accLabel}</span>
            </div>
            <div class="inst-detail-item">
              <span class="inst-detail-label">Kategorie</span>
              <span class="inst-detail-value">${catLabel}</span>
            </div>
            <div class="inst-detail-item">
              <span class="inst-detail-label">Enddatum</span>
              <span class="inst-detail-value">${endLabel}</span>
            </div>
            <div class="inst-detail-item">
              <span class="inst-detail-label">Abbuchung</span>
              <span class="inst-detail-value">${dayLabel}</span>
            </div>
          </div>

          ${!inst.isComplete ? `
            <div class="progress-actions">
              <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px"
                      onclick="markInstallmentPaid(${inst.id}, ${inst.paid_months}, ${inst.total_months})">
                + Rate buchen
              </button>
            </div>` : ''}
        </div>`;
      }).join('')
    : `<div class="empty-state"><p>Noch keine Ratenkäufe angelegt.</p></div>`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Ratenkäufe</div>
        <div class="page-subtitle">${items.filter(i => !i.isComplete).length} aktiv</div>
      </div>
      <button class="btn btn-primary" onclick="openNewInstallmentModal()">+ Ratenkauf anlegen</button>
    </div>
    <div class="card-grid">${cards}</div>
  `;
}

async function openNewInstallmentModal() {
  const [allAccounts, allCats] = await Promise.all([
    window.api.accounts.getAll(),
    window.api.categories.getAll()
  ]);

  const accountOpts = allAccounts.map(a =>
    `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
  const catOpts = `<option value="">– Keine Kategorie –</option>` +
    allCats.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');

  openModal('Ratenkauf hinzufügen', `
    <div class="form-group">
      <label>Bezeichnung *</label>
      <input type="text" id="inst-name" placeholder="z.B. Handy, Sofa" oninput="calcInstPreview()" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Gesamtbetrag (€) *</label>
        <input type="text" inputmode="decimal" id="inst-total" placeholder="0,00" oninput="calcInstPreview()" />
      </div>
      <div class="form-group">
        <label>Monatliche Rate (€) *</label>
        <input type="text" inputmode="decimal" id="inst-rate" placeholder="0,00" oninput="calcInstPreview()" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Konto *</label>
        <select id="inst-account">${accountOpts}</select>
      </div>
      <div class="form-group">
        <label>Kategorie</label>
        <select id="inst-category">${catOpts}</select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Startdatum *</label>
        <input type="date" id="inst-start" value="${getTodayISO()}" oninput="calcInstPreview()" />
      </div>
      <div class="form-group">
        <label>Abbuchungstag (1–31)</label>
        <input type="text" inputmode="numeric" id="inst-day" placeholder="1" value="1" />
      </div>
    </div>
    <div class="form-group">
      <label>Bereits bezahlte Raten
        <span style="color:var(--text-muted);font-weight:400"> – Für Ratenkäufe die schon laufen</span>
      </label>
      <input type="text" inputmode="numeric" id="inst-paid" placeholder="0" value="0"
             oninput="calcInstPreview()" />
    </div>

    <div id="inst-preview" class="inst-preview" style="display:none"></div>

    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitNewInstallment()">Speichern</button>
    </div>
  `);
  setTimeout(() => document.getElementById('inst-name').focus(), 50);
}

// Live-Vorschau im Modal
function calcInstPreview() {
  const total     = parseAmount(document.getElementById('inst-total')?.value, 0);
  const rate      = parseAmount(document.getElementById('inst-rate')?.value, 0);
  const paid      = parseInt(document.getElementById('inst-paid')?.value)   || 0;
  const startVal  = document.getElementById('inst-start')?.value;
  const preview   = document.getElementById('inst-preview');
  if (!preview) return;

  if (total <= 0 || rate <= 0) { preview.style.display = 'none'; return; }

  const total_months = Math.ceil(total / rate);
  const paidAmount   = paid * rate;
  const remaining    = Math.max(0, total - paidAmount);
  const monthsLeft   = Math.max(0, total_months - paid);

  let endStr = '';
  if (startVal && total_months > 0) {
    // addMonthsSafe-Logik inline (Renderer hat keinen require()-Zugriff)
    endStr = formatDate(addMonthsSafeStr(startVal, total_months));
  }

  preview.style.display = 'block';
  preview.innerHTML = `
    <div class="inst-prev-row">
      <span>📅 Laufzeit gesamt: <strong>${total_months} Monate</strong>
        ${endStr ? ` · Enddatum: <strong>${endStr}</strong>` : ''}
        · Bereits bezahlt: <strong>${paid} Raten (${formatAmount(paidAmount)})</strong></span>
    </div>
    <div class="inst-prev-row">
      <span>📌 Noch offen: <strong>${monthsLeft} Raten</strong>
        · Restbetrag: <strong>${formatAmount(remaining)}</strong></span>
    </div>`;
}

async function submitNewInstallment() {
  const name         = document.getElementById('inst-name').value.trim();
  const total_amount  = parseAmount(document.getElementById('inst-total').value);
  const monthly_rate  = parseAmount(document.getElementById('inst-rate').value);
  const account_id    = parseInt(document.getElementById('inst-account').value)  || null;
  const category_id   = parseInt(document.getElementById('inst-category').value) || null;
  const start_date    = document.getElementById('inst-start').value;
  const deduction_day = parseInt(document.getElementById('inst-day').value) || 1;
  const paid_months   = parseInt(document.getElementById('inst-paid').value) || 0;

  if (!name)                            { showNotification('Bitte einen Namen eingeben.', 'error');          return; }
  if (!isValidAmount(total_amount))     { showNotification('Bitte einen gültigen Gesamtbetrag eingeben (z.B. 1.200,00).', 'error'); return; }
  if (!isValidAmount(monthly_rate))     { showNotification('Bitte eine gültige monatliche Rate eingeben.', 'error'); return; }
  if (!start_date)                      { showNotification('Bitte ein Startdatum eingeben.', 'error');       return; }

  const total_months = Math.ceil(total_amount / monthly_rate);
  if (!isFinite(total_months) || total_months <= 0) {
    showNotification('Ungültige Kombination aus Gesamt- und Ratenbetrag.', 'error'); return;
  }

  await window.api.installments.create({
    name, total_amount, monthly_rate, total_months, paid_months,
    start_date, account_id, category_id, deduction_day
  });
  closeModal();
  showNotification(`Ratenkauf „${name}" angelegt.`);
  await navigateTo('installments');
}

async function markInstallmentPaid(id, currentPaid, totalMonths) {
  const newPaid = Math.min(currentPaid + 1, totalMonths);
  await window.api.installments.updatePaid(id, newPaid);
  showNotification('Rate als bezahlt markiert.');
  await navigateTo('installments');
}

async function deleteInstallment(id) {
  if (!confirm('Ratenkauf wirklich löschen?')) return;
  await window.api.installments.delete(id);
  showNotification('Ratenkauf gelöscht.');
  await navigateTo('installments');
}

// ── Seite: Verteilungen ───────────────────────────────────────────────────
// Verteilungen = Gruppen von scheduled_transactions mit gleicher group_id.
// Beim App-Start werden alle Mitglieder einer Gruppe GLEICHZEITIG gebucht.

async function renderDistributionsPage(container) {
  const [distributions, allAccounts] = await Promise.all([
    window.api.distributions.getAll(),
    window.api.accounts.getAll()
  ]);
  accounts = allAccounts;

  const cards = distributions.length
    ? distributions.map(d => {
        const isActive = d.is_active === 1;
        const label    = intervalLabel[d.interval_months] ?? `Alle ${d.interval_months} Monate`;

        // Items aufteilen: Ausgaben (Privat) und Einnahmen (Gemeinschaft)
        const expenses = d.items.filter(i => i.type === 'expense');
        const incomes  = d.items.filter(i => i.type === 'income');
        const total    = expenses.reduce((s, i) => s + i.amount, 0);

        const expenseRows = expenses.map(i => `
          <div class="dist-item">
            <span class="dist-item-name">${escHtml(i.account_name)}</span>
            <span class="dist-item-amount amount-expense">–${formatAmount(i.amount)}</span>
          </div>`).join('');

        const incomeRows = incomes.map(i => `
          <div class="dist-item">
            <span class="dist-item-name">${escHtml(i.account_name)}</span>
            <span class="dist-item-amount amount-income">+${formatAmount(i.amount)}</span>
          </div>`).join('');

        return `
          <div class="dist-card ${!isActive ? 'dist-card-inactive' : ''}">
            <button class="dist-edit-btn"
                    onclick="openEditDistributionModal(${d.group_id})" title="Bearbeiten">✎</button>
            <button class="account-delete-btn"
                    onclick="deleteDistribution(${d.group_id})" title="Löschen">✕</button>
            <div class="dist-card-title">${escHtml(d.description || 'Umbuchung')}</div>
            <div class="dist-card-meta">${label} · nächste Ausführung: ${formatDate(d.next_due_date)}</div>

            <div class="dist-flow">
              <div class="dist-flow-col">
                <div class="dist-flow-label">Ausgänge</div>
                ${expenseRows || '<span class="dist-empty">–</span>'}
              </div>
              <div class="dist-flow-arrow">→</div>
              <div class="dist-flow-col">
                <div class="dist-flow-label">Eingang</div>
                ${incomeRows || '<span class="dist-empty">–</span>'}
              </div>
            </div>

            <div class="dist-total">
              Gesamt: <strong>${formatAmount(total)}</strong>
            </div>
          </div>`;
      }).join('')
    : `<div class="empty-state"><p>Noch keine Umbuchungen angelegt.</p></div>`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Umbuchungen</div>
        <div class="page-subtitle">${distributions.length} Einträge · automatisch beim App-Start</div>
      </div>
      <button class="btn btn-primary" onclick="openNewDistributionModal()">+ Umbuchung anlegen</button>
    </div>
    <div class="card-grid">${cards}</div>
  `;
}

function openNewDistributionModal() {
  const privateAccounts = accounts.filter(a => a.account_type !== 'joint');
  const jointAccounts   = accounts.filter(a => a.account_type === 'joint');

  if (!jointAccounts.length) {
    showNotification('Bitte zuerst ein Gemeinschaftskonto anlegen.', 'error');
    return;
  }
  if (!privateAccounts.length) {
    showNotification('Bitte zuerst ein Privatkonto anlegen.', 'error');
    return;
  }

  const jointOptions = jointAccounts.map(a =>
    `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');

  const participantRows = privateAccounts.map(a => `
    <div class="dist-modal-row">
      <span class="dist-modal-name">${escHtml(a.name)}</span>
      <input type="text" inputmode="decimal"
             id="dist-amount-${a.id}"
             data-account-id="${a.id}"
             placeholder="0,00"
             oninput="updateDistTotal()" />
    </div>`).join('');

  openModal('Neue Umbuchung anlegen', `
    <div class="form-group">
      <label>Beschreibung</label>
      <input type="text" id="dist-desc" placeholder="z.B. Monatsbeitrag GLS" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Buchungsdatum (erste Ausführung)</label>
        <input type="date" id="dist-start" value="${getTodayISO()}" />
      </div>
      <div class="form-group">
        <label>Intervall</label>
        <select id="dist-interval">
          <option value="1">Monatlich</option>
          <option value="3">Vierteljährlich</option>
          <option value="6">Halbjährlich</option>
          <option value="12">Jährlich</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>Zielkonto (Einnahme)</label>
      <select id="dist-joint">${jointOptions}</select>
    </div>
    <div class="form-group">
      <label>Beiträge pro Konto</label>
      ${participantRows}
    </div>
    <div id="dist-total-preview" class="dist-total-preview" style="display:none"></div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitNewDistribution()">Anlegen</button>
    </div>
  `);
  setTimeout(() => document.getElementById('dist-desc').focus(), 50);
}

function updateDistTotal() {
  const inputs = document.querySelectorAll('[id^="dist-amount-"]');
  let total = 0;
  inputs.forEach(inp => { total += parseAmount(inp.value, 0); });
  const preview = document.getElementById('dist-total-preview');
  if (!preview) return;
  if (total > 0) {
    preview.style.display = 'block';
    preview.textContent   = `Gesamtbetrag: ${formatAmount(total)}`;
  } else {
    preview.style.display = 'none';
  }
}

async function submitNewDistribution() {
  const description      = document.getElementById('dist-desc').value.trim();
  const start_date       = document.getElementById('dist-start').value;
  const interval_months  = parseInt(document.getElementById('dist-interval').value);
  const jointId          = parseInt(document.getElementById('dist-joint').value);

  if (!start_date) { showNotification('Bitte ein Startdatum eingeben.', 'error'); return; }

  const inputs = document.querySelectorAll('[id^="dist-amount-"]');
  const items  = [];
  let   total  = 0;

  inputs.forEach(inp => {
    const amount    = parseAmount(inp.value, 0);
    const accountId = parseInt(inp.dataset.accountId);
    if (isValidAmount(amount)) {
      items.push({ account_id: accountId, amount, type: 'expense' });
      total += amount;
    }
  });

  if (items.length === 0) {
    showNotification('Bitte mindestens einen Betrag eingeben.', 'error'); return;
  }

  // Einnahme auf Gemeinschaftskonto = Summe aller Ausgaben
  items.push({ account_id: jointId, amount: total, type: 'income' });

  await window.api.distributions.create({ description, start_date, interval_months, items });
  closeModal();
  showNotification('Umbuchung angelegt.');
  await navigateTo('distributions');
}

async function deleteDistribution(groupId) {
  openModal('Umbuchung löschen', `
    <p style="margin-bottom:20px;color:var(--text-dim)">
      Diese Umbuchung und alle zugehörigen geplanten Buchungen werden entfernt.<br>
      Bereits gebuchte Transaktionen bleiben in der Historie erhalten.
    </p>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn" style="background:#ff4d4f;color:#fff;border:none;padding:8px 20px;border-radius:var(--radius-sm);cursor:pointer"
              onclick="confirmDeleteDistribution(${groupId})">Löschen</button>
    </div>
  `);
}

async function confirmDeleteDistribution(groupId) {
  await window.api.distributions.delete(groupId);
  closeModal();
  showNotification('Umbuchung gelöscht.');
  await navigateTo('distributions');
}

async function openEditDistributionModal(groupId) {
  // Aktuelle Daten der Verteilung laden
  const all  = await window.api.distributions.getAll();
  const dist = all.find(d => d.group_id === groupId);
  if (!dist) { showNotification('Umbuchung nicht gefunden.', 'error'); return; }

  const allAccounts   = await window.api.accounts.getAll();
  const privateAccounts = allAccounts.filter(a => a.account_type !== 'joint');
  const jointAccounts   = allAccounts.filter(a => a.account_type === 'joint');

  const jointOptions = jointAccounts.map(a => {
    const isSelected = dist.items.some(i => i.type === 'income' && i.account_id === a.id);
    return `<option value="${a.id}" ${isSelected ? 'selected' : ''}>${escHtml(a.name)}</option>`;
  }).join('');

  // Bestehende Beträge vorausfüllen
  const participantRows = privateAccounts.map(a => {
    const existing = dist.items.find(i => i.account_id === a.id && i.type === 'expense');
    const val = existing ? existing.amount.toString().replace('.', ',') : '';
    return `
      <div class="dist-modal-row">
        <span class="dist-modal-name">${escHtml(a.name)}</span>
        <input type="text" inputmode="decimal"
               id="edit-dist-amount-${a.id}"
               data-account-id="${a.id}"
               value="${val}"
               placeholder="0,00"
               oninput="updateEditDistTotal()" />
      </div>`;
  }).join('');

  const currentTotal = dist.items
    .filter(i => i.type === 'expense')
    .reduce((s, i) => s + i.amount, 0);

  const intervalOptions = [
    { v: 1, l: 'Monatlich' }, { v: 3, l: 'Vierteljährlich' },
    { v: 6, l: 'Halbjährlich' }, { v: 12, l: 'Jährlich' }
  ].map(o =>
    `<option value="${o.v}" ${dist.interval_months === o.v ? 'selected' : ''}>${o.l}</option>`
  ).join('');

  openModal('Umbuchung bearbeiten', `
    <div class="form-group">
      <label>Beschreibung</label>
      <input type="text" id="edit-dist-desc" value="${escHtml(dist.description || '')}"
             placeholder="z.B. Monatsbeitrag GLS" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Buchungsdatum (nächste Ausführung)</label>
        <input type="date" id="edit-dist-next-due" value="${dist.next_due_date}" />
      </div>
      <div class="form-group">
        <label>Intervall</label>
        <select id="edit-dist-interval">${intervalOptions}</select>
      </div>
    </div>
    <div class="form-group">
      <label>Zielkonto (Einnahme)</label>
      <select id="edit-dist-joint">${jointOptions}</select>
    </div>
    <div class="form-group">
      <label>Beiträge pro Konto</label>
      ${participantRows}
    </div>
    <div id="edit-dist-total-preview" class="dist-total-preview"
         style="${currentTotal > 0 ? 'display:block' : 'display:none'}">
      ${currentTotal > 0 ? `Gesamtbetrag: ${formatAmount(currentTotal)}` : ''}
    </div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitEditDistribution(${groupId})">Speichern</button>
    </div>
  `);
}

function updateEditDistTotal() {
  const inputs = document.querySelectorAll('[id^="edit-dist-amount-"]');
  let total = 0;
  inputs.forEach(inp => { total += parseAmount(inp.value, 0); });
  const preview = document.getElementById('edit-dist-total-preview');
  if (!preview) return;
  if (total > 0) {
    preview.style.display = 'block';
    preview.textContent   = `Gesamtbetrag: ${formatAmount(total)}`;
  } else {
    preview.style.display = 'none';
  }
}

async function submitEditDistribution(groupId) {
  const description     = document.getElementById('edit-dist-desc').value.trim();
  const interval_months = parseInt(document.getElementById('edit-dist-interval').value);
  const jointId         = parseInt(document.getElementById('edit-dist-joint').value);

  const inputs = document.querySelectorAll('[id^="edit-dist-amount-"]');
  const items  = [];
  let   total  = 0;

  inputs.forEach(inp => {
    const amount    = parseAmount(inp.value, 0);
    const accountId = parseInt(inp.dataset.accountId);
    if (isValidAmount(amount)) {
      items.push({ account_id: accountId, amount, type: 'expense' });
      total += amount;
    }
  });

  if (items.length === 0) {
    showNotification('Bitte mindestens einen Betrag eingeben.', 'error'); return;
  }

  items.push({ account_id: jointId, amount: total, type: 'income' });

  // next_due_date aus dem Hidden-Feld lesen → Buchungsrhythmus bleibt erhalten
  const next_due = document.getElementById('edit-dist-next-due')?.value || getTodayISO();

  // Alte Umbuchung löschen und neu erstellen
  await window.api.distributions.delete(groupId);
  await window.api.distributions.create({ description, start_date: next_due, interval_months, items });
  closeModal();
  showNotification('Umbuchung aktualisiert.');
  await navigateTo('distributions');
}

// ── Seite: Auswertungen ───────────────────────────────────────────────────

async function renderAnalyticsPage(container) {
  const d = await window.api.analytics.getData();
  const { monthLabel, monthSummary, categories, catTotal, history, top3 } = d;

  const monthNames = ['Januar','Februar','März','April','Mai','Juni',
                      'Juli','August','September','Oktober','November','Dezember'];
  const now        = new Date();
  const label      = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;

  // ── 1) Monatsübersicht ────────────────────────────────────────────────────
  const diffClass = monthSummary.diff >= 0 ? 'amount-income' : 'amount-expense';
  const summaryHtml = `
    <div class="an-summary-grid">
      <div class="an-summary-card">
        <div class="an-summary-label">Einnahmen</div>
        <div class="an-summary-value amount-income">+${formatAmount(monthSummary.income)}</div>
      </div>
      <div class="an-summary-card">
        <div class="an-summary-label">Ausgaben</div>
        <div class="an-summary-value amount-expense">–${formatAmount(monthSummary.expense)}</div>
      </div>
      <div class="an-summary-card an-summary-card-diff">
        <div class="an-summary-label">Differenz</div>
        <div class="an-summary-value ${diffClass}">
          ${monthSummary.diff >= 0 ? '+' : '–'}${formatAmount(Math.abs(monthSummary.diff))}
        </div>
      </div>
    </div>`;

  // ── 2) Donut-Chart (Kategorie-Ausgaben) ───────────────────────────────────
  const donutData    = { categories, total: catTotal, month: monthLabel };
  const donutHtml    = buildDonutChart(donutData, label, true); // true = große Version

  // ── 3) Verlaufsdiagramm (SVG-Balken, letzte 6 Monate) ────────────────────
  const historyHtml  = buildHistoryChart(history);

  // ── 4) Top-3-Kategorien ───────────────────────────────────────────────────
  const top3Html = buildTop3(top3, catTotal);

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Auswertungen</div>
        <div class="page-subtitle">Privatkonten · ${label}</div>
      </div>
    </div>

    <!-- Monatsübersicht -->
    ${summaryHtml}

    <!-- Donut + Top-3 nebeneinander -->
    <div class="an-mid-row">
      <div class="an-donut-wrap ds-card">
        <div class="ds-card-head">
          <span class="ds-card-title">Ausgaben nach Kategorie</span>
          <span class="ds-card-tag">${label}</span>
        </div>
        ${donutHtml}
      </div>
      ${top3Html}
    </div>

    <!-- Verlauf -->
    ${historyHtml}
  `;
}

// Donut-Chart: optional großes Layout für Auswertungsseite
// buildDonutChart ist bereits definiert – wir rufen sie mit einem wrapper-div auf
// das größere Darstellung erzeugt
function buildDonutChart({ categories, total, month }, monthLabel, large = false) {
  if (!categories.length || total === 0) {
    return `
      <div ${large ? '' : 'class="ds-card"'}>
        ${!large ? `<div class="ds-card-head">
          <span class="ds-card-title">Ausgaben nach Kategorie</span>
          <span class="ds-card-tag">${monthLabel}</span>
        </div>` : ''}
        <div class="ds-empty" style="padding:24px 0;text-align:center">
          Keine Ausgaben auf Privatkonten in diesem Monat
        </div>
      </div>`;
  }

  const size    = large ? 260 : 220;
  const CX      = size / 2, CY = size / 2;
  const R_OUTER = large ? 110 : 90;
  const R_INNER = large ? 66  : 54;
  const GAP     = categories.length > 1 ? 1.5 : 0;
  let   angle   = 0;

  const segments = categories.map((cat, i) => {
    const share  = cat.amount / total;
    const sweep  = share * 360;
    const startA = angle + GAP / 2;
    const endA   = angle + sweep - GAP / 2;
    const color  = DONUT_COLORS[i % DONUT_COLORS.length];
    const pct    = Math.round(share * 100);
    angle += sweep;
    return { ...cat, startA, endA, color, pct };
  });

  const paths = segments.map((s, i) => {
    const d = donutSegmentPath(CX, CY, R_OUTER, R_INNER, s.startA, s.endA);
    return `<path class="donut-seg" data-index="${i}"
      d="${d}" fill="${s.color}"
      style="cursor:pointer; transition:opacity 0.15s;" />`;
  }).join('');

  const legendItems = segments.map((s, i) => `
    <div class="donut-legend-item" data-index="${i}">
      <span class="donut-legend-dot" style="background:${s.color}"></span>
      <span class="donut-legend-name">${escHtml(s.name)}</span>
      <span class="donut-legend-amount">–${formatAmount(s.amount)}</span>
      <span class="donut-legend-pct">${s.pct}%</span>
    </div>`).join('');

  const segData = JSON.stringify(segments.map(s => ({
    name: s.name, amount: s.amount, pct: s.pct, color: s.color
  })));

  const centerFontSize  = large ? 22 : 17;
  const centerLabelSize = large ? 11 : 10;

  if (large) {
    // Auf Auswertungsseite: kein äußeres ds-card wrapper (liegt schon in einem)
    return `
      <div class="donut-wrap">
        <div class="donut-chart-wrap">
          <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" id="donut-svg">
            ${paths}
            <text x="${CX}" y="${CY - 10}" text-anchor="middle"
                  font-size="${centerLabelSize}" font-family="Inter,DM Sans,sans-serif"
                  fill="#A0A7B5" letter-spacing="1">GESAMT</text>
            <text x="${CX}" y="${CY + 16}" text-anchor="middle"
                  font-size="${centerFontSize}" font-weight="700"
                  font-family="DM Mono,monospace" fill="#ff4d4f">–${formatAmount(total)}</text>
          </svg>
        </div>
        <div class="donut-legend" id="donut-legend">${legendItems}</div>
      </div>
      <script id="donut-data" type="application/json">${segData}</script>`;
  }

  // Dashboard-Version: mit Card-Wrapper
  return `
    <div class="ds-card" id="donut-card">
      <div class="ds-card-head">
        <span class="ds-card-title">Ausgaben nach Kategorie</span>
        <span class="ds-card-tag">${monthLabel}</span>
      </div>
      <div class="donut-wrap">
        <div class="donut-chart-wrap">
          <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" id="donut-svg">
            ${paths}
            <text x="${CX}" y="${CY - 8}" text-anchor="middle"
                  font-size="${centerLabelSize}" font-family="Inter,DM Sans,sans-serif"
                  fill="#A0A7B5" letter-spacing="1">GESAMT</text>
            <text x="${CX}" y="${CY + 14}" text-anchor="middle"
                  font-size="${centerFontSize}" font-weight="700"
                  font-family="DM Mono,monospace" fill="#ff4d4f">–${formatAmount(total)}</text>
          </svg>
        </div>
        <div class="donut-legend" id="donut-legend">${legendItems}</div>
      </div>
      <script id="donut-data" type="application/json">${segData}</script>
    </div>
    <div id="donut-tooltip" class="donut-tooltip" style="display:none;"></div>`;
}

// SVG-Balkendiagramm: Einnahmen (blau) und Ausgaben (rot) pro Monat
function buildHistoryChart(history) {
  const hasData = history.some(h => h.income > 0 || h.expense > 0);
  if (!hasData) {
    return `
      <div class="ds-card">
        <div class="ds-card-head"><span class="ds-card-title">Verlauf · letzte 6 Monate</span></div>
        <div class="ds-empty" style="padding:24px 0;text-align:center">Noch keine Transaktionen vorhanden</div>
      </div>`;
  }

  const W = 560, H = 200, PAD_L = 56, PAD_R = 16, PAD_T = 16, PAD_B = 36;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const n      = history.length;
  const barW   = Math.floor(chartW / n * 0.28);
  const maxVal = Math.max(...history.map(h => Math.max(h.income, h.expense)), 1);

  // Y-Achsen-Ticks (4 Stufen)
  const tickCount = 4;
  const ticks = [];
  for (let i = 0; i <= tickCount; i++) {
    const val = (maxVal / tickCount) * i;
    const y   = PAD_T + chartH - (val / maxVal) * chartH;
    ticks.push({ val, y });
  }

  const tickLines = ticks.map(t => `
    <line x1="${PAD_L}" y1="${t.y}" x2="${W - PAD_R}" y2="${t.y}"
          stroke="rgba(255,255,255,0.05)" stroke-width="1" />
    <text x="${PAD_L - 6}" y="${t.y + 4}" text-anchor="end"
          font-size="10" fill="#64748b" font-family="DM Mono,monospace">
      ${t.val >= 1000 ? Math.round(t.val / 100) / 10 + 'k' : Math.round(t.val)}
    </text>`).join('');

  const bars = history.map((h, i) => {
    const slotW   = chartW / n;
    const slotX   = PAD_L + slotW * i;
    const centerX = slotX + slotW / 2;

    const incH  = h.income  > 0 ? Math.max((h.income  / maxVal) * chartH, 2) : 0;
    const expH  = h.expense > 0 ? Math.max((h.expense / maxVal) * chartH, 2) : 0;

    const incX  = centerX - barW - 1;
    const expX  = centerX + 1;
    const baseY = PAD_T + chartH;

    return `
      <rect x="${incX}" y="${baseY - incH}" width="${barW}" height="${incH}"
            fill="#4d9fff" opacity="0.85" rx="2" />
      <rect x="${expX}" y="${baseY - expH}" width="${barW}" height="${expH}"
            fill="#ff6b6b" opacity="0.85" rx="2" />
      <text x="${centerX}" y="${baseY + 14}" text-anchor="middle"
            font-size="10" fill="#64748b" font-family="DM Sans,sans-serif">
        ${h.label.split(' ')[0]}
      </text>`;
  }).join('');

  return `
    <div class="ds-card">
      <div class="ds-card-head">
        <span class="ds-card-title">Verlauf · letzte 6 Monate</span>
        <span class="an-legend-row">
          <span class="an-legend-dot" style="background:#4d9fff"></span><span>Einnahmen</span>
          <span class="an-legend-dot" style="background:#ff6b6b"></span><span>Ausgaben</span>
        </span>
      </div>
      <div class="an-chart-scroll">
        <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
          ${tickLines}
          <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + chartH}"
                stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          ${bars}
        </svg>
      </div>
    </div>`;
}

// Top-3-Kategorien als kompakte Karte
function buildTop3(top3, catTotal) {
  if (!top3.length) {
    return `
      <div class="ds-card an-top3-card">
        <div class="ds-card-head"><span class="ds-card-title">Top Kategorien</span></div>
        <div class="ds-empty" style="padding:24px 0;text-align:center">Keine Daten</div>
      </div>`;
  }

  const rows = top3.map((c, i) => {
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    const pct   = catTotal > 0 ? Math.round((c.amount / catTotal) * 100) : 0;
    const barW  = pct;
    return `
      <div class="an-top3-item">
        <div class="an-top3-header">
          <div class="an-top3-rank">${i + 1}</div>
          <span class="an-top3-name">${escHtml(c.name)}</span>
          <span class="an-top3-amount">–${formatAmount(c.amount)}</span>
          <span class="an-top3-pct">${pct}%</span>
        </div>
        <div class="an-top3-bar-track">
          <div class="an-top3-bar-fill" style="width:${barW}%;background:${color}"></div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="ds-card an-top3-card">
      <div class="ds-card-head">
        <span class="ds-card-title">Top Kategorien</span>
        <span class="ds-card-tag">Ausgaben</span>
      </div>
      ${rows}
    </div>`;
}

// ── Seite: Einstellungen ──────────────────────────────────────────────────

async function renderSettingsPage(container) {
  const [dbPath, cats] = await Promise.all([
    window.api.settings.getDbPath(),
    window.api.categories.getAll()
  ]);
  categories = cats;

  const catRows = cats.length
    ? cats.map(c => `
        <div class="cat-row">
          <span class="cat-row-icon">${c.icon || '💡'}</span>
          <span class="cat-row-dot" style="background:${c.color || '#4d9fff'}"></span>
          <span class="cat-row-name">${escHtml(c.name)}</span>
          <div class="cat-row-actions">
            <button class="btn btn-ghost" style="font-size:12px;padding:4px 10px"
                    onclick="openEditCategoryModal(${c.id})">Bearbeiten</button>
            <button class="table-delete-btn" onclick="deleteCategory(${c.id})" title="Löschen">✕</button>
          </div>
        </div>`).join('')
    : `<div class="empty-state" style="padding:16px 0"><p>Keine Kategorien vorhanden.</p></div>`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Einstellungen</div>
        <div class="page-subtitle">App-Konfiguration</div>
      </div>
    </div>

    <!-- Datenbank -->
    <div class="settings-section">
      <div class="settings-section-title">Datenbank</div>
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-label">Speicherort</div>
          <div class="settings-row-value" id="db-path-display">${escHtml(dbPath || '–')}</div>
        </div>
        <button class="btn btn-ghost" onclick="changeDbPath()">Ordner wählen</button>
      </div>
      <div class="settings-hint">
        Tipp: Wähle einen OneDrive- oder Dropbox-Ordner, um die Datenbank automatisch zu sichern.
        Nach dem Ändern des Speicherorts wird die Datenbank in den neuen Ordner kopiert.
        Ein Neustart der App ist danach erforderlich.
      </div>
    </div>

    <!-- Kategorien -->
    <div class="settings-section">
      <div class="settings-section-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Kategorien</span>
        <button class="btn btn-primary" style="font-size:12px;padding:5px 12px"
                onclick="openNewCategoryModal()">+ Neue Kategorie</button>
      </div>
      <div id="cat-list">${catRows}</div>
    </div>
  `;
}

async function changeDbPath() {
  const result = await window.api.settings.changeDbPath();
  if (result.success) {
    document.getElementById('db-path-display').textContent = result.path;
    showNotification('Speicherort geändert. Bitte App neu starten.');
  } else if (result.reason !== 'Abgebrochen') {
    showNotification(`Fehler: ${result.reason}`, 'error');
  }
}

// ── Kategorie-Verwaltung (Einstellungen) ──────────────────────────────────

const ICON_LIST = [
  '💼','🏠','🛒','🚗','🛡️','🎉','❤️','👕','💻','📦',
  '✈️','🍕','📚','🎮','💊','🐾','🎵','🏋️','🌿','💡',
  '🔧','📱','🚿','💰','🎁','🏦','🌍','⚡','🧴','🍺'
];

function buildIconPicker(selectedIcon, inputId) {
  return `<div class="icon-picker" id="${inputId}-picker">
    ${ICON_LIST.map(ic => `
      <button type="button" class="icon-swatch ${ic === selectedIcon ? 'selected' : ''}"
              onclick="selectIcon('${inputId}', '${ic}')">${ic}</button>
    `).join('')}
  </div>
  <input type="hidden" id="${inputId}" value="${selectedIcon}" />`;
}

function selectIcon(inputId, icon) {
  const picker = document.getElementById(inputId + '-picker');
  if (picker) picker.querySelectorAll('.icon-swatch').forEach(b => {
    b.classList.toggle('selected', b.textContent === icon);
  });
  const input = document.getElementById(inputId);
  if (input) input.value = icon;
}

function openNewCategoryModal() {
  openModal('Neue Kategorie anlegen', `
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="cat-name" placeholder="z.B. Sport, Haustier" />
    </div>
    <div class="form-group">
      <label>Farbe</label>
      ${buildColorPicker('cat-color', '#4d9fff')}
    </div>
    <div class="form-group">
      <label>Icon</label>
      ${buildIconPicker('💡', 'cat-icon')}
    </div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitNewCategory()">Anlegen</button>
    </div>
  `);
  setTimeout(() => document.getElementById('cat-name').focus(), 50);
}

async function submitNewCategory() {
  const name  = document.getElementById('cat-name').value.trim();
  const color = document.getElementById('cat-color')?.value || '#4d9fff';
  const icon  = document.getElementById('cat-icon')?.value  || '💡';
  if (!name) { showNotification('Bitte einen Namen eingeben.', 'error'); return; }
  await window.api.categories.create({ name, color, icon });
  closeModal();
  showNotification(`Kategorie „${name}" angelegt.`);
  await navigateTo('settings');
}

async function openEditCategoryModal(id) {
  const cats = await window.api.categories.getAll();
  const c    = cats.find(x => x.id === id);
  if (!c) return;

  openModal(`Kategorie bearbeiten – ${escHtml(c.name)}`, `
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="edit-cat-name" value="${escHtml(c.name)}" />
    </div>
    <div class="form-group">
      <label>Farbe</label>
      ${buildColorPicker('edit-cat-color', c.color || '#4d9fff')}
    </div>
    <div class="form-group">
      <label>Icon</label>
      ${buildIconPicker(c.icon || '💡', 'edit-cat-icon')}
    </div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="submitEditCategory(${id})">Speichern</button>
    </div>
  `);
  setTimeout(() => document.getElementById('edit-cat-name').focus(), 50);
}

async function submitEditCategory(id) {
  const name  = document.getElementById('edit-cat-name').value.trim();
  const color = document.getElementById('edit-cat-color')?.value || '#4d9fff';
  const icon  = document.getElementById('edit-cat-icon')?.value  || '💡';
  if (!name) { showNotification('Bitte einen Namen eingeben.', 'error'); return; }
  await window.api.categories.update(id, { name, color, icon });
  closeModal();
  showNotification(`Kategorie „${name}" gespeichert.`);
  await navigateTo('settings');
}

async function deleteCategory(id) {
  if (!confirm('Kategorie löschen? Bestehende Transaktionen verlieren die Kategorie-Zuordnung.')) return;
  await window.api.categories.delete(id);
  showNotification('Kategorie gelöscht.');
  await navigateTo('settings');
}

// ── Hilfsfunktion: HTML-Escaping ──────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── App starten ───────────────────────────────────────────────────────────

navigateTo('dashboard');

// ── F7: Startup-Hinweis für automatisch verarbeitete Buchungen ────────────
// Wird vom Main-Prozess nach did-finish-load gesendet wenn Buchungen
// automatisch verarbeitet wurden (z.B. nach langer Pause).
// Zeigt einen persistenten Banner — kein Auto-Close, da die Info wichtig ist.
if (window.api?.onStartupBooked) {
  window.api.onStartupBooked((count) => {
    showStartupBanner(count);
  });
}

// ── Auto-Updater: Banner wenn Update heruntergeladen wurde ────────────────
// Der Main-Prozess sendet 'update:downloaded' sobald electron-updater
// das Update vollständig im Hintergrund geladen hat.
if (window.api?.updater?.onUpdateDownloaded) {
  window.api.updater.onUpdateDownloaded((info) => {
    showUpdateBanner(info.version);
  });
}

function showStartupBanner(count) {
  // Alten Banner entfernen falls vorhanden
  const existing = document.getElementById('startup-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id        = 'startup-banner';
  banner.className = 'startup-banner';
  banner.innerHTML = `
    <div class="startup-banner-content">
      <span class="startup-banner-icon">✓</span>
      <div class="startup-banner-text">
        <strong>${count} Buchung${count !== 1 ? 'en' : ''} automatisch verarbeitet</strong>
        <span>Fällige geplante Transaktionen wurden beim Start nachgeholt.</span>
      </div>
      <button class="startup-banner-close" onclick="this.closest('#startup-banner').remove()" title="Schließen">✕</button>
    </div>
  `;
  document.body.appendChild(banner);

  // Nach 12 Sekunden sanft ausblenden (aber nicht entfernen — Nutzer soll es lesen können)
  setTimeout(() => {
    if (banner.parentNode) banner.classList.add('startup-banner-fade');
  }, 12000);
}

// ── Update-Banner ─────────────────────────────────────────────────────────
// Erscheint wenn electron-updater ein Update heruntergeladen hat.
// Bleibt sichtbar bis der Nutzer reagiert — Update ist wichtig.
// "Jetzt neu starten" → quitAndInstall() → sofortige Installation.
// "Später" → Banner schließen, Update wird beim nächsten normalen Start installiert.
function showUpdateBanner(version) {
  const existing = document.getElementById('update-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id        = 'update-banner';
  banner.className = 'update-banner';
  banner.innerHTML = `
    <div class="update-banner-content">
      <span class="update-banner-icon">↑</span>
      <div class="update-banner-text">
        <strong>Update v${escHtml(version)} bereit</strong>
        <span>Heruntergeladen und bereit zur Installation.</span>
      </div>
      <div class="update-banner-actions">
        <button class="update-banner-btn-install" onclick="installUpdateNow()">
          Jetzt neu starten
        </button>
        <button class="update-banner-btn-later" onclick="this.closest('#update-banner').remove()" title="Später installieren">
          Später
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);
}

async function installUpdateNow() {
  const banner = document.getElementById('update-banner');
  if (banner) {
    // Feedback geben bevor App sich schließt
    const btn = banner.querySelector('.update-banner-btn-install');
    if (btn) { btn.textContent = 'Wird installiert…'; btn.disabled = true; }
  }
  try {
    await window.api.updater.installNow();
  } catch (e) {
    console.error('Update-Installation fehlgeschlagen:', e);
    if (banner) banner.remove();
    showNotification('Installation fehlgeschlagen — bitte App manuell neu starten.', 'error');
  }
}
