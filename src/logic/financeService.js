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

// ── C) Prognose nächster Monat – NUR Privatkonten, OHNE Verteilungseinträge ─

function getForecastNextMonth() {
  const now       = new Date();
  let   year      = now.getFullYear();
  let   nextMonth = now.getMonth() + 2;
  if (nextMonth > 12) { nextMonth = 1; year++; }

  const { first, last } = monthRange(year, nextMonth);

  const privateIds = new Set(
    db.getAllAccounts()
      .filter(a => (a.account_type || 'private') === 'private')
      .map(a => a.id)
  );

  const scheduled    = db.getAllScheduled();
  const dueNextMonth = scheduled.filter(s =>
    s.is_active === 1 &&
    s.group_id === null &&              // Keine Verteilungseinträge
    privateIds.has(s.account_id) &&    // Nur Privatkonten
    s.next_due_date >= first &&
    s.next_due_date <= last
  );

  const income  = dueNextMonth.filter(s => s.type === 'income').reduce((sum, s) => sum + s.amount, 0);
  const expense = dueNextMonth.filter(s => s.type === 'expense').reduce((sum, s) => sum + s.amount, 0);

  return {
    income,
    expense,
    restbudget: income - expense,
    month: `${String(nextMonth).padStart(2, '0')}/${year}`
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

function getDashboardData() {
  return {
    accounts:           getAccountBalances(),
    budget:             getBudgetCurrentMonth(),
    forecast:           getForecastNextMonth(),
    fixedCosts:         getFixedCostsCurrentMonth(),
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
