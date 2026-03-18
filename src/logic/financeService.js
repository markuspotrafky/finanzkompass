// src/logic/financeService.js – Alle Berechnungen für das Dashboard
// Dashboard = NUR Privatkonten (account_type = 'private')
// Fixkosten-Widget = NUR Gemeinschaftskonten (account_type = 'joint')

const db = require('../db/database');

function monthRange(year, month) {
  const first   = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate(); // lokal, kein UTC
  const last    = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { first, last };
}

// ── Hilfsfunktion: Lokales Datum als ISO-String (YYYY-MM-DD) ──────────────
// Verhindert UTC-Versatz um Mitternacht (z.B. in GMT+1/+2).
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── H) Prognose Kontostand Monatsende – NUR Privatkonten ─────────────────
//
// Berechnet ohne DB-Schreibzugriff den voraussichtlichen Gesamtkontostand
// aller Privatkonten am letzten Tag des aktuellen Monats.
//
// Formel:
//   projectedBalance = currentBalance
//                    + Σ(geplante Einnahmen heute..Monatsende)
//                    - Σ(geplante Ausgaben  heute..Monatsende)
//                    + Σ(Umbuchungs-Einnahmen heute..Monatsende, Privatkonto)
//                    - Σ(Umbuchungs-Ausgaben  heute..Monatsende, Privatkonto)
//
// "Heute" ist INKLUSIV — Buchungen von heute sind noch nicht gebucht,
// wenn sie als next_due_date = heute in scheduled stehen.
// "Letzter Monatstag" ist INKLUSIV.
//
// Edge cases:
//   keine geplanten Buchungen → projectedBalance = currentBalance
//   negativer Kontostand      → wird korrekt addiert (keine Untergrenze)
//   Buchung am letzten Tag    → next_due_date <= last → enthalten

function getProjectedEndOfMonthBalance() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const today = todayISO();
  const { last } = monthRange(year, month);

  const privateAccounts = db.getAllAccounts().filter(a => (a.account_type || 'private') === 'private');
  const privateIds      = new Set(privateAccounts.map(a => a.id));

  // Ausgangspunkt: aktueller Gesamtkontostand aller Privatkonten
  const currentBalance = privateAccounts.reduce((sum, a) => sum + (a.balance ?? 0), 0);

  // Gesamter Disporahmen aller Privatkonten
  const totalOverdraft = privateAccounts.reduce((sum, a) => sum + (a.overdraft_limit ?? 0), 0);

  const scheduled = db.getAllScheduled();

  // Filter: heute ≤ next_due_date ≤ Monatsende, nur Privatkonten, aktiv
  const remaining = scheduled.filter(s =>
    s.is_active === 1 &&
    privateIds.has(s.account_id) &&
    s.next_due_date >= today &&
    s.next_due_date <= last
  );

  const remainingIncome  = remaining
    .filter(s => s.type === 'income')
    .reduce((sum, s) => sum + s.amount, 0);

  const remainingExpense = remaining
    .filter(s => s.type === 'expense')
    .reduce((sum, s) => sum + s.amount, 0);

  // Projizierter Kontostand (realer Wert, kann negativ sein)
  const projectedBalance = parseFloat(
    (currentBalance + remainingIncome - remainingExpense).toFixed(2)
  );

  // Verfügbares Budget am Monatsende — das geht in die Prognose ein:
  //   projectedBalance >= 0 → verfügbar = projectedBalance (Dispo irrelevant)
  //   projectedBalance <  0 → verfügbar = projectedBalance + totalOverdraft
  //                           (ohne Dispo: totalOverdraft = 0 → gleich wie Kontostand)
  // Korrekt: kein Dispo → verfügbar = Kontostand auch im Minus (kein Clamp auf 0)
  const projectedAvailable = projectedBalance < 0
    ? parseFloat((projectedBalance + totalOverdraft).toFixed(2))
    : projectedBalance;

  return {
    currentBalance:      parseFloat(currentBalance.toFixed(2)),
    totalOverdraft:      parseFloat(totalOverdraft.toFixed(2)),
    remainingIncome:     parseFloat(remainingIncome.toFixed(2)),
    remainingExpense:    parseFloat(remainingExpense.toFixed(2)),
    projectedBalance,            // realer Kontostand am Monatsende
    projectedAvailable,          // inkl. Dispo — geht in Prognose ein
    usingOverdraft:      projectedBalance < 0 && totalOverdraft > 0,
    endOfMonth:          last,
    scheduledCount:      remaining.length,
  };
}

// ── A) Kontostände – NUR Privatkonten ─────────────────────────────────────

function getAccountBalances() {
  const all = db.getAllAccounts();
  return all.filter(a => (a.account_type || 'private') === 'private');
}

// ── B) Restbudget aktueller Monat – NUR Privatkonten ─────────────────────

function getBudgetCurrentMonth() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const { first, last } = monthRange(year, month);

  // Nur Privatkonten
  const privateAccounts = db.getAllAccounts().filter(a => (a.account_type || 'private') === 'private');
  const privateIds      = new Set(privateAccounts.map(a => a.id));

  const totalBalance = privateAccounts.reduce((sum, a) => sum + (a.balance ?? 0), 0);

  // Geplante Transaktionen nur für Privatkonten, OHNE Verteilungseinträge
  const scheduled = db.getAllScheduled();
  const dueThisMonth = scheduled.filter(s =>
    s.is_active === 1 &&
    s.group_id === null &&
    privateIds.has(s.account_id) &&
    s.next_due_date >= first &&
    s.next_due_date <= last
  );

  const plannedIncome  = dueThisMonth.filter(s => s.type === 'income').reduce((sum, s) => sum + s.amount, 0);
  const plannedExpense = dueThisMonth.filter(s => s.type === 'expense').reduce((sum, s) => sum + s.amount, 0);

  return {
    totalBalance,
    plannedIncome,
    plannedExpense,
    restbudget: totalBalance + plannedIncome - plannedExpense,
    month: `${String(month).padStart(2, '0')}/${year}`
  };
}

// ── C) Prognose nächster Monat – NUR Privatkonten ────────────────────────
// Enthält:
//   1. Wiederkehrende geplante Transaktionen ohne Gruppenkennung
//   2. Umbuchungsausgaben für Privatkonten (group_id gesetzt, type='expense')
//   3. Ratenkauf-Raten für Privatkonten
//   4. NEU: Projizierter Kontostand am Monatsende (aus H)
//
// Neue Formel:
//   restbudget = income - expense + projectedEndOfMonthBalance

function getForecastNextMonth() {
  const now       = new Date();
  let   year      = now.getFullYear();
  let   nextMonth = now.getMonth() + 2;
  if (nextMonth > 12) { nextMonth = 1; year++; }

  const { first, last } = monthRange(year, nextMonth);

  const privateAccounts = db.getAllAccounts().filter(a => (a.account_type || 'private') === 'private');
  const privateIds      = new Set(privateAccounts.map(a => a.id));

  const scheduled = db.getAllScheduled();

  // ── 1) Normale geplante Transaktionen von Privatkonten (ohne Gruppe) ───
  const singleDue = scheduled.filter(s =>
    s.is_active === 1 &&
    s.group_id === null &&
    privateIds.has(s.account_id) &&
    s.next_due_date >= first &&
    s.next_due_date <= last
  );

  // ── 2) Umbuchungsausgaben von Privatkonten ─────────────────────────────
  const distExpenses = scheduled.filter(s =>
    s.is_active === 1 &&
    s.group_id !== null &&
    s.type === 'expense' &&
    privateIds.has(s.account_id) &&
    s.next_due_date >= first &&
    s.next_due_date <= last
  );

  // ── 3) Ratenkauf-Raten ─────────────────────────────────────────────────
  const installments = db.getAllInstallments().filter(inst =>
    inst.paid_months < inst.total_months &&
    (!inst.account_id || privateIds.has(inst.account_id))
  );
  const installmentExpense = installments.reduce((sum, inst) => sum + inst.monthly_rate, 0);

  // ── 4) NEU: Projizierter Kontostand Monatsende ─────────────────────────
  // Wird zur Prognose addiert, weil der nächste Monat mit diesem Stand startet.
  const projected = getProjectedEndOfMonthBalance();

  // ── Zusammenführen ─────────────────────────────────────────────────────
  const allScheduledExpenses = [...singleDue, ...distExpenses];

  const income  = singleDue
    .filter(s => s.type === 'income')
    .reduce((sum, s) => sum + s.amount, 0);

  const expense = allScheduledExpenses
    .filter(s => s.type === 'expense')
    .reduce((sum, s) => sum + s.amount, 0)
    + installmentExpense;

  // Restbudget = Netto nächster Monat + verfügbares Budget am Monatsende
  // projectedAvailable berücksichtigt Dispo wenn Kontostand < 0
  const restbudget = parseFloat((income - expense + projected.projectedAvailable).toFixed(2));

  return {
    income:              parseFloat(income.toFixed(2)),
    expense:             parseFloat(expense.toFixed(2)),
    expenseScheduled:    parseFloat(allScheduledExpenses.filter(s => s.type === 'expense').reduce((s, x) => s + x.amount, 0).toFixed(2)),
    expenseInstallments: parseFloat(installmentExpense.toFixed(2)),
    restbudget,
    projected,           // Vollständiges projected-Objekt für die UI
    month:               `${String(nextMonth).padStart(2, '0')}/${year}`
  };
}

// ── D) Fixkosten-Widget im Dashboard – NUR Gemeinschaftskonten ────────────
// Zeigt wiederkehrende Ausgaben von joint-Konten

function getFixedCostsCurrentMonth() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const { first, last } = monthRange(year, month);

  const jointIds = new Set(
    db.getAllAccounts()
      .filter(a => (a.account_type || 'private') === 'joint')
      .map(a => a.id)
  );

  const scheduled = db.getAllScheduled();
  const fixed     = scheduled.filter(s =>
    s.is_active === 1 &&
    s.type === 'expense' &&
    s.interval_months !== null &&
    s.group_id === null &&          // Keine Verteilungseinträge
    jointIds.has(s.account_id) &&
    s.next_due_date >= first &&
    s.next_due_date <= last
  );

  const total = fixed.reduce((sum, s) => sum + s.amount, 0);

  return {
    total,
    items: fixed,
    month: `${String(month).padStart(2, '0')}/${year}`
  };
}

// ── E) Ausgaben nach Kategorie – NUR Privatkonten, aktueller Monat ────────

function getExpensesByCategory() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const { first, last } = monthRange(year, month);

  const privateIds = new Set(
    db.getAllAccounts()
      .filter(a => (a.account_type || 'private') === 'private')
      .map(a => a.id)
  );

  const transactions = db.getAllTransactions();

  // Nur Ausgaben, nur Privatkonten, nur aktueller Monat
  const filtered = transactions.filter(t =>
    t.type === 'expense' &&
    privateIds.has(t.account_id) &&
    t.date >= first &&
    t.date <= last
  );

  // Summiere pro Kategorie
  const map = {};
  filtered.forEach(t => {
    const key = t.category_name || 'Sonstiges';
    map[key] = (map[key] || 0) + t.amount;
  });

  // Sortiert absteigend nach Betrag
  const categories = Object.entries(map)
    .map(([name, amount]) => ({ name, amount: parseFloat(amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);

  const total = parseFloat(categories.reduce((s, c) => s + c.amount, 0).toFixed(2));

  return { categories, total, month: `${String(month).padStart(2, '0')}/${year}` };
}

// ── G) Ratenkauf-Zusammenfassung für Dashboard ────────────────────────────
function getInstallmentSummary() {
  const all    = db.getAllInstallments();
  const active = all.filter(i => i.paid_months < i.total_months);

  const totalMonthlyRate = parseFloat(
    active.reduce((s, i) => s + i.monthly_rate, 0).toFixed(2)
  );
  const totalRemaining = parseFloat(
    active.reduce((s, i) => s + Math.max(0, i.total_amount - i.paid_months * i.monthly_rate), 0).toFixed(2)
  );
  const totalAmount = parseFloat(
    active.reduce((s, i) => s + i.total_amount, 0).toFixed(2)
  );

  // Für Dashboard: die 3 nächsten noch nicht abgeschlossenen
  const preview = active.slice(0, 3).map(i => ({
    name:        i.name,
    paid_months: i.paid_months,
    total_months:i.total_months,
    progress:    i.total_months > 0 ? Math.round((i.paid_months / i.total_months) * 100) : 0,
    monthly_rate:i.monthly_rate,
  }));

  return {
    count:            active.length,
    totalMonthlyRate,
    totalRemaining,
    totalAmount,
    preview,
  };
}

function getDashboardData() {
  return {
    accounts:           getAccountBalances(),
    budget:             getBudgetCurrentMonth(),
    forecast:           getForecastNextMonth(),
    installmentSummary: getInstallmentSummary(),
    expensesByCategory: getExpensesByCategory()
  };
}

// ── F) Auswertungen ────────────────────────────────────────────────────────
// Alle Berechnungen NUR für Privatkonten.

function getAnalyticsData() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  const privateIds = new Set(
    db.getAllAccounts()
      .filter(a => (a.account_type || 'private') === 'private')
      .map(a => a.id)
  );

  const allTx = db.getAllTransactions();
  // Nur Privatkonten, nur income/expense (keine adjustments)
  const privateTx = allTx.filter(t =>
    privateIds.has(t.account_id) &&
    (t.type === 'income' || t.type === 'expense')
  );

  // ── 1) Monatsübersicht aktueller Monat ────────────────────────────────────
  const { first: mFirst, last: mLast } = monthRange(year, month);
  const thisMon = privateTx.filter(t => t.date >= mFirst && t.date <= mLast);
  const totalIncome  = parseFloat(thisMon.filter(t => t.type === 'income') .reduce((s, t) => s + t.amount, 0).toFixed(2));
  const totalExpense = parseFloat(thisMon.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0).toFixed(2));
  const monthSummary = {
    income:  totalIncome,
    expense: totalExpense,
    diff:    parseFloat((totalIncome - totalExpense).toFixed(2))
  };

  // ── 2) Ausgaben nach Kategorie (aktueller Monat) ──────────────────────────
  const catMap = {};
  thisMon.filter(t => t.type === 'expense').forEach(t => {
    const k = t.category_name || 'Sonstiges';
    catMap[k] = (catMap[k] || 0) + t.amount;
  });
  const categories = Object.entries(catMap)
    .map(([name, amount]) => ({ name, amount: parseFloat(amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);
  const catTotal = parseFloat(categories.reduce((s, c) => s + c.amount, 0).toFixed(2));

  // ── 3) Verlauf letzte 6 Monate ────────────────────────────────────────────
  const monthNames = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  const history = [];
  for (let i = 5; i >= 0; i--) {
    let   m = month - i;
    let   y = year;
    if (m <= 0) { m += 12; y--; }
    const { first, last } = monthRange(y, m);
    const slice = privateTx.filter(t => t.date >= first && t.date <= last);
    history.push({
      label:   `${monthNames[m - 1]} ${y}`,
      income:  parseFloat(slice.filter(t => t.type === 'income') .reduce((s, t) => s + t.amount, 0).toFixed(2)),
      expense: parseFloat(slice.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0).toFixed(2))
    });
  }

  // ── 4) Top-3-Kategorien ───────────────────────────────────────────────────
  const top3 = categories.slice(0, 3);

  return {
    monthLabel: `${String(month).padStart(2, '0')}/${year}`,
    monthSummary,
    categories,
    catTotal,
    history,
    top3
  };
}

module.exports = { getDashboardData, getAnalyticsData };
