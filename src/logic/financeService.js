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
  const now      = new Date();
  const year     = now.getFullYear();
  const month    = now.getMonth() + 1;
  const today    = todayISO();
  const todayDay = now.getDate();
  const { last } = monthRange(year, month);

  const privateAccounts = db.getAllAccounts().filter(a => (a.account_type || 'private') === 'private');
  const privateIds      = new Set(privateAccounts.map(a => a.id));

  const currentBalance = privateAccounts.reduce((sum, a) => sum + (a.balance ?? 0), 0);
  const totalOverdraft = privateAccounts.reduce((sum, a) => sum + (a.overdraft_limit ?? 0), 0);

  // ── 1) Geplante Transaktionen (Fixkosten + einmalige + Umbuchungen) ───────
  const scheduled = db.getAllScheduled();
  const remaining = scheduled.filter(s =>
    s.is_active === 1 &&
    privateIds.has(s.account_id) &&
    s.next_due_date >= today &&
    s.next_due_date <= last
  );

  const scheduledIncome  = remaining
    .filter(s => s.type === 'income')
    .reduce((sum, s) => sum + s.amount, 0);
  const scheduledExpense = remaining
    .filter(s => s.type === 'expense')
    .reduce((sum, s) => sum + s.amount, 0);

  // ── 2) Ratenkäufe aus der installments-Tabelle ────────────────────────────
  // Ratenkäufe sind NICHT in scheduled_transactions gespeichert — sie haben
  // eine eigene Tabelle mit deduction_day (Abbuchungstag im Monat).
  // Wir berechnen welche Raten im aktuellen Monat noch NICHT abgebucht wurden:
  //   deduction_day >= heute → noch ausstehend diesen Monat
  // Nur aktive (paid_months < total_months), nur Privatkonten.
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const installments   = db.getAllInstallments();

  const installmentExpense = installments
    .filter(i =>
      i.paid_months < i.total_months &&
      (!i.account_id || privateIds.has(i.account_id)) &&
      Math.min(i.deduction_day, lastDayOfMonth) >= todayDay   // noch nicht abgebucht
    )
    .reduce((sum, i) => sum + i.monthly_rate, 0);

  // ── Projizierter Kontostand ───────────────────────────────────────────────
  const projectedBalance = parseFloat(
    (currentBalance + scheduledIncome - scheduledExpense - installmentExpense).toFixed(2)
  );

  const projectedAvailable = projectedBalance < 0
    ? parseFloat((projectedBalance + totalOverdraft).toFixed(2))
    : projectedBalance;

  return {
    currentBalance:       parseFloat(currentBalance.toFixed(2)),
    totalOverdraft:       parseFloat(totalOverdraft.toFixed(2)),
    remainingIncome:      parseFloat(scheduledIncome.toFixed(2)),
    remainingExpense:     parseFloat((scheduledExpense + installmentExpense).toFixed(2)),
    remainingInstallments:parseFloat(installmentExpense.toFixed(2)),
    projectedBalance,
    projectedAvailable,
    usingOverdraft:       projectedBalance < 0 && totalOverdraft > 0,
    endOfMonth:           last,
    scheduledCount:       remaining.length + (installmentExpense > 0 ? 1 : 0),
  };
}

// ── A) Kontostände – NUR Privatkonten ─────────────────────────────────────

function getAccountBalances() {
  const all = db.getAllAccounts();
  return all.filter(a => (a.account_type || 'private') === 'private');
}

// ── B) Restbudget aktueller Monat – NUR Privatkonten ─────────────────────
// Liefert Gesamtwerte UND pro-Konto-Aufschlüsselung für die Dashboard-Tabelle.

function getBudgetCurrentMonth() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const today = todayISO();
  const { first, last } = monthRange(year, month);

  const privateAccounts = db.getAllAccounts().filter(a => (a.account_type || 'private') === 'private');
  const privateIds      = new Set(privateAccounts.map(a => a.id));
  const totalBalance    = privateAccounts.reduce((sum, a) => sum + (a.balance ?? 0), 0);

  // Gesamter verfügbarer Stand inkl. Dispo (für Hero-Anzeige und Restbudget-Basis)
  const totalAvailableBalance = parseFloat(
    privateAccounts.reduce((sum, a) => {
      const bal   = a.balance ?? 0;
      const dispo = a.overdraft_limit ?? 0;
      return sum + (bal < 0 ? bal + dispo : bal);
    }, 0).toFixed(2)
  );

  const scheduled    = db.getAllScheduled();
  const transactions = db.getAllTransactions();

  // ── Geplante Transaktionen diesen Monat (noch nicht gebucht) ─────────────
  const dueThisMonth = scheduled.filter(s =>
    s.is_active === 1 &&
    s.group_id === null &&
    privateIds.has(s.account_id) &&
    s.next_due_date >= first &&
    s.next_due_date <= last
  );

  // ── Bereits gebuchte Transaktionen diesen Monat ───────────────────────────
  const bookedThisMonth = transactions.filter(t =>
    (t.type === 'income' || t.type === 'expense') &&
    privateIds.has(t.account_id) &&
    t.date >= first &&
    t.date <= last
  );

  // ── Ratenkäufe: noch ausstehend diesen Monat ─────────────────────────────
  const todayDay       = now.getDate();
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const installments   = db.getAllInstallments();

  // ── Gesamt-Aggregation ───────────────────────────────────────────────────
  const plannedIncome   = dueThisMonth.filter(s => s.type === 'income') .reduce((sum, s) => sum + s.amount, 0);
  const plannedExpense  = dueThisMonth.filter(s => s.type === 'expense').reduce((sum, s) => sum + s.amount, 0);
  const bookedIncome    = bookedThisMonth.filter(t => t.type === 'income') .reduce((sum, t) => sum + t.amount, 0);
  const bookedExpense   = bookedThisMonth.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);

  // ── Pro-Konto-Aufschlüsselung ─────────────────────────────────────────────
  const perAccount = privateAccounts.map(a => {
    const instStillDue = installments
      .filter(i =>
        i.paid_months < i.total_months &&
        i.account_id === a.id &&
        Math.min(i.deduction_day, lastDayOfMonth) >= todayDay
      )
      .reduce((sum, i) => sum + i.monthly_rate, 0);

    const plannedIn  = dueThisMonth.filter(s => s.account_id === a.id && s.type === 'income') .reduce((sum, s) => sum + s.amount, 0);
    const plannedOut = dueThisMonth.filter(s => s.account_id === a.id && s.type === 'expense').reduce((sum, s) => sum + s.amount, 0);
    const bookedIn   = bookedThisMonth.filter(t => t.account_id === a.id && t.type === 'income') .reduce((sum, t) => sum + t.amount, 0);
    const bookedOut  = bookedThisMonth.filter(t => t.account_id === a.id && t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);

    // Verfügbarer Kontostand inkl. Dispo als Basis für Restbudget
    const bal      = a.balance ?? 0;
    const dispo    = a.overdraft_limit ?? 0;
    const availBal = bal < 0 ? bal + dispo : bal;

    // Restbudget = verfügbarer Stand + geplante Einnahmen - geplante Ausgaben - ausstehende Raten
    const restbudget = parseFloat((availBal + plannedIn - plannedOut - instStillDue).toFixed(2));

    return {
      id:           a.id,
      name:         a.name,
      color:        a.color || '#4d9fff',
      balance:      parseFloat(bal.toFixed(2)),
      overdraft:    dispo,
      availBal:     parseFloat(availBal.toFixed(2)),
      plannedIn:    parseFloat(plannedIn.toFixed(2)),
      plannedOut:   parseFloat(plannedOut.toFixed(2)),
      bookedIn:     parseFloat(bookedIn.toFixed(2)),
      bookedOut:    parseFloat(bookedOut.toFixed(2)),
      instStillDue: parseFloat(instStillDue.toFixed(2)),
      restbudget,
    };
  });

  const totalRestbudget = parseFloat(perAccount.reduce((sum, a) => sum + a.restbudget, 0).toFixed(2));

  return {
    totalBalance,
    totalAvailableBalance,
    plannedIncome:  parseFloat(plannedIncome.toFixed(2)),
    plannedExpense: parseFloat(plannedExpense.toFixed(2)),
    bookedIncome:   parseFloat(bookedIncome.toFixed(2)),
    bookedExpense:  parseFloat(bookedExpense.toFixed(2)),
    restbudget:     parseFloat((totalAvailableBalance + plannedIncome - plannedExpense).toFixed(2)),
    totalRestbudget,
    perAccount,
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
