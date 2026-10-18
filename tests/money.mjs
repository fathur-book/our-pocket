// Money checks for FlowPocket: every kind of entry changes balances, and deleting it puts them back exactly.
// Also checks the sync-conflict merge and one Safe-to-Spend example.
// Run: NODE_PATH=$(npm root -g) node tests/money.mjs   (needs Playwright with Chromium)
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const { chromium } = createRequire(import.meta.url)('playwright');
const page_url = 'file://' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.html');

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : r.abort()); // offline: no login, no CDN
await page.goto(page_url);

const results = await page.evaluate(async () => {
  const out = [];
  const check = (name, ok, detail) => out.push({ name, ok: !!ok, detail: ok ? '' : detail });
  const today = todayISO(), day = Number(today.slice(8));
  confirm = () => true; // card payoff and similar ask first

  function reset() {
    accounts = [
      { id: 'a1', name: 'Bank A', type: 'bank', balance: 1000000, icon: 'landmark', color: '#1e293b' },
      { id: 'a2', name: 'Bank B', type: 'bank', balance: 500000, icon: 'landmark', color: '#1e293b' },
      { id: 'c1', name: 'Card', type: 'credit', balance: -300000, icon: 'credit-card', color: '#d97706' },
    ];
    pockets = [{ id: 'p1', name: 'Darurat', description: '', targetDate: '', icon: 'shield', currentAmount: 200000, targetAmount: 1000000, monthlyHint: 0 }];
    recurringItems = [{ id: 'r1', name: 'Internet', note: '', dueDay: day, expectedAmount: 100000, actualAmount: null, status: 'upcoming', categoryId: 'cat_utilities', statusMonth: null }];
    essentials = [{ id: 'e1', name: 'Beras', unitPrice: 50000, targetQty: 2, categoryId: 'cat_food' }];
    transactions = [];
    settings = { ...DEFAULT_SETTINGS, payday: 25, paydaySet: true, setupDismissed: true };
    rolloverBills();
  }
  const state = () => JSON.stringify({
    acc: accounts.map(a => [a.id, a.balance]), pock: pockets.map(p => [p.id, p.currentAmount]),
    bills: recurringItems.map(r => [r.id, r.status, r.txId]),
  });
  const log = (o) => { logState = { ...freshLogState(), date: today, ...o }; saveQuickLog(); };
  const pocketAction = (mode, amt, acc) => { openPocketAction('p1', mode); setAmt(document.getElementById('pockAmt'), amt); if (acc) document.getElementById('pockAcc').value = acc; confirmPocketAction(); };

  const flows = {
    'expense': () => log({ type: 'expense', amount: '50000', accountId: 'a1' }),
    'expense on credit card': () => log({ type: 'expense', amount: '75000', accountId: 'c1' }),
    'income': () => log({ type: 'income', amount: '900000', accountId: 'a2', categoryId: 'cat_salary' }),
    'refund': () => log({ type: 'refund', amount: '20000', accountId: 'a1' }),
    'essential purchase': () => log({ type: 'expense', amount: '100000', accountId: 'a1', essentialId: 'e1', essentialQty: 2 }),
    'bill paid from Quick Log': () => log({ type: 'expense', amount: '110000', accountId: 'a1', billId: 'r1' }),
    'transfer account to account': () => log({ type: 'transfer', amount: '40000', accountId: 'a1', transferTo: 'acc:a2' }),
    'transfer pays credit card': () => log({ type: 'transfer', amount: '60000', accountId: 'a1', transferTo: 'acc:c1' }),
    'save into pocket': () => log({ type: 'transfer', amount: '30000', accountId: 'a1', transferTo: 'pock:p1' }),
    'take out of pocket': () => log({ type: 'transfer', amount: '25000', fromPocket: 'p1', transferTo: 'acc:a2' }),
    'pocket top-up': () => pocketAction('topup', 15000, 'a2'),
    'spend from pocket': () => pocketAction('spend', 35000),
    'bill paid from bills list': () => { openPayModal('r1'); setAmt(document.getElementById('payAmt'), 95000); confirmPay(); },
    'card payoff': () => { payoffCredit(); document.getElementById('payoffAcc').value = 'a2'; confirmPayoff(); },
    'receipt with two items': () => { rcpt = { date: today, accountId: 'a1', items: [{ name: 'Telur', amount: 30000, include: true, qty: 1, categoryId: 'cat_food' }, { name: 'Beras', amount: 50000, include: true, qty: 1, essentialId: 'e1', categoryId: 'cat_food' }] }; rcSave(); },
    'card statement import': () => { stmt = { accountId: 'c1', items: [{ name: 'Resto', amount: 45000, date: today, include: true, link: '', categoryId: 'cat_food' }, { name: 'Top up', amount: 50000, date: today, include: true, link: 'acc:a2', categoryId: 'cat_food' }, { name: 'Internet', amount: 100000, date: today, include: true, link: 'bill:r1', categoryId: 'cat_utilities' }] }; stSave(); },
  };

  for (const [name, run] of Object.entries(flows)) {
    reset(); const before = state(), oldIds = new Set(transactions.map(t => t.id));
    run(); closeModal();
    const created = transactions.filter(t => !oldIds.has(t.id)), after = state();
    if (!created.length || after === before) { check(name + ': changes balances', false, 'no entry created or nothing changed'); continue; }
    // applyTx must be the exact opposite of reverseTx (used to keep entries on a sync conflict).
    created.forEach(t => { reverseTx(t); applyTx(t); });
    check(name + ': applyTx re-applies exactly', state() === after, `${after} -> ${state()}`);
    created.forEach(t => deleteTx(t.id));
    check(name + ': delete restores everything', state() === before && transactions.length === 0, `${before} -> ${state()}`);
  }

  // Sync conflict: the other phone added X, this phone added Y before seeing X. Both must survive, balances include both.
  reset();
  const base = JSON.parse(stateJSON());
  log({ type: 'expense', amount: '10000', accountId: 'a1', title: 'Y here' });
  const cloud = JSON.parse(JSON.stringify(base));
  cloud.transactions = [{ id: 'tx_other', date: today, title: 'X other phone', amount: 20000, type: 'expense', categoryId: 'cat_food', accountId: 'a2', tag: '#quick-log', pocketId: null }];
  cloud.accounts.find(a => a.id === 'a2').balance -= 20000;
  cloudUser = { id: 'u1' }; STORE_KEY = 'test.money'; initialPullDone = true; cloudUpdatedAt = 'v1';
  lastPushed = JSON.stringify(base);
  sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { data: cloud, updated_at: 'v2' }, error: null }) }) }) }) };
  clearTimeout(pushTimer); const realPush = cloudPush; cloudPush = async () => {};
  await cloudPull(true); clearTimeout(pushTimer); cloudPush = realPush;
  const titles = transactions.map(t => t.title).sort().join(', ');
  check('sync conflict keeps both entries', titles === 'X other phone, Y here', titles);
  check('sync conflict balances include both', accById('a1').balance === 990000 && accById('a2').balance === 480000, `${accById('a1').balance} / ${accById('a2').balance}`);
  check('sync conflict queues a save', stateJSON() !== lastPushed, 'merged state would not be pushed');
  // An entry deleted on the other phone must not come back.
  reset(); log({ type: 'expense', amount: '10000', accountId: 'a1', title: 'Old' });
  lastPushed = stateJSON(); const deletedElsewhere = JSON.parse(stateJSON());
  deletedElsewhere.transactions = []; deletedElsewhere.accounts.find(a => a.id === 'a1').balance += 10000;
  log({ type: 'expense', amount: '5000', accountId: 'a1', title: 'New' });
  sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { data: deletedElsewhere, updated_at: 'v3' }, error: null }) }) }) }) };
  cloudPush = async () => {}; await cloudPull(true); clearTimeout(pushTimer); cloudPush = realPush;
  check('sync conflict does not bring back deleted entries', transactions.map(t => t.title).join() === 'New' && accById('a1').balance === 995000, transactions.map(t => t.title).join() + ' / ' + accById('a1').balance);
  cloudUser = null; sb = null; STORE_KEY = null;

  // Safe-to-Spend: opening 2.000.000 − spent 150.000 − unpaid bill 100.000 − Essentials still to buy 2×50.000 = 1.650.000
  reset();
  const cycleStart = cycleBounds().start;
  transactions = [
    { id: 'o1', date: cycleStart, title: 'Saldo awal', amount: 2000000, type: 'income', categoryId: 'cat_opening', accountId: 'a1', tag: '#saldo-awal', pocketId: null, opening: true },
    { id: 's1', date: today, title: 'Makan', amount: 150000, type: 'expense', categoryId: 'cat_food', accountId: 'a1', tag: '', pocketId: null },
  ];
  rolloverBills();
  const billDue = billsDueUnpaid().total;
  const s2s = financialSummary().safeToSpend;
  check('Safe-to-Spend example', s2s === 2000000 - 150000 - billDue - 100000, `got ${s2s}, bill reserved ${billDue}`);
  return out;
});

let failed = 0;
for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '  — ' + r.detail}`); }
if (pageErrors.length) { failed++; console.log('FAIL page errors:', pageErrors.join(' | ')); }
console.log(`\n${results.length - (failed - (pageErrors.length ? 1 : 0))}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
