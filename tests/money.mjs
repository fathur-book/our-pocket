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
page.on('dialog', d => d.dismiss()); // confirm/alert from the app
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
    'balance adjustment': () => { openAdjust('a1'); setAmt(document.getElementById('adjBal'), 940000); saveAdjust('a1'); },
    'card balance adjustment': () => { openAdjust('c1'); setAmt(document.getElementById('adjBal'), 350000); saveAdjust('c1'); },
    'balance changed in Settings': () => { openAccountForm('a2'); setAmt(document.getElementById('faBal'), 520000); saveAccount('a2'); },
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

  // Editing an entry in Riwayat: the result must equal logging the edited entry from scratch.
  const editTx = (amt, o = {}) => { const id = transactions[0].id; openTxEdit(id); setAmt(document.getElementById('teAmt'), amt);
    if (o.acc) document.getElementById('teAcc').value = o.acc; if (o.title) document.getElementById('teTitle').value = o.title; saveTxEdit(id); closeModal(); };
  const edits = {
    'expense, new amount and account': [() => log({ type: 'expense', amount: '50000', accountId: 'a1' }), () => editTx(80000, { acc: 'a2', title: 'Edited' }), () => log({ type: 'expense', amount: '80000', accountId: 'a2' })],
    'income, new amount': [() => log({ type: 'income', amount: '900000', accountId: 'a2', categoryId: 'cat_salary' }), () => editTx(950000), () => log({ type: 'income', amount: '950000', accountId: 'a2', categoryId: 'cat_salary' })],
    'bill payment, new amount': [() => log({ type: 'expense', amount: '110000', accountId: 'a1', billId: 'r1' }), () => editTx(120000), () => log({ type: 'expense', amount: '120000', accountId: 'a1', billId: 'r1' })],
    'transfer to account, new amount': [() => log({ type: 'transfer', amount: '40000', accountId: 'a1', transferTo: 'acc:a2' }), () => editTx(45000), () => log({ type: 'transfer', amount: '45000', accountId: 'a1', transferTo: 'acc:a2' })],
    'save into pocket, new amount': [() => log({ type: 'transfer', amount: '30000', accountId: 'a1', transferTo: 'pock:p1' }), () => editTx(10000), () => log({ type: 'transfer', amount: '10000', accountId: 'a1', transferTo: 'pock:p1' })],
    'take out of pocket, new amount': [() => log({ type: 'transfer', amount: '25000', fromPocket: 'p1', transferTo: 'acc:a2' }), () => editTx(50000), () => log({ type: 'transfer', amount: '50000', fromPocket: 'p1', transferTo: 'acc:a2' })],
    'spend from pocket, new amount': [() => pocketAction('spend', 35000), () => editTx(50000), () => pocketAction('spend', 50000)],
    'spend from pocket, new title only': [() => pocketAction('spend', 35000), () => editTx(35000, { title: 'Edited' }), () => pocketAction('spend', 35000)],
  };
  for (const [name, [create, edit, direct]] of Object.entries(edits)) {
    reset(); create(); closeModal(); edit();
    const noIds = s => s.replace(/"tx_[^"]*"/g, '"tx"'); // a bill links to its entry id, which differs between the two runs
    const edited = noIds(state()), title = transactions[0].title;
    reset(); direct(); closeModal();
    check('edit ' + name + ': same as logging it directly', edited === noIds(state()), `${edited} vs ${noIds(state())}`);
    if (name.startsWith('expense')) check('edit ' + name + ': title saved', title === 'Edited', title);
  }
  // Adjustments land exactly on the real balance, move Safe-to-Spend by the difference, and are not spending.
  reset(); const fin0 = financialSummary();
  openAdjust('a1'); setAmt(document.getElementById('adjBal'), 940000); saveAdjust('a1'); closeModal();
  const fin1 = financialSummary();
  check('adjustment sets the real balance', accById('a1').balance === 940000, accById('a1').balance);
  check('adjustment lowers Safe-to-Spend by the difference', fin1.safeToSpend === fin0.safeToSpend - 60000, `${fin0.safeToSpend} -> ${fin1.safeToSpend}`);
  check('adjustment is not spending or saving', fin1.cycleSpending === fin0.cycleSpending && fin1.cycleSaved === fin0.cycleSaved, JSON.stringify(fin1));
  editTx(70000);
  check('edited adjustment keeps its direction', accById('a1').balance === 930000, accById('a1').balance);
  openAdjust('c1'); setAmt(document.getElementById('adjBal'), 350000); saveAdjust('c1'); closeModal();
  check('card adjustment raises what is owed', accById('c1').balance === -350000, accById('c1').balance);
  reset(); openAdjust('a1'); setAmt(document.getElementById('adjBal'), 1000000); saveAdjust('a1'); closeModal();
  check('no adjustment when the balance already matches', transactions.length === 0, transactions.length);
  reset(); log({ type: 'transfer', amount: '30000', accountId: 'a1', transferTo: 'pock:p1' });
  pocketAction('spend', 220000); const spent = state();
  const saveId = transactions.find(t => t.tag === '#pocket-save').id;
  openTxEdit(saveId); setAmt(document.getElementById('teAmt'), 10000); saveTxEdit(saveId); closeModal();
  check('edit refuses a pocket transfer that was already spent', state() === spent, `${spent} -> ${state()}`);
  reset(); pocketAction('spend', 150000); const spentOnce = state(), spendId = transactions[0].id;
  openTxEdit(spendId); setAmt(document.getElementById('teAmt'), 500000); saveTxEdit(spendId); closeModal();
  check('edit refuses a pocket spend above what the pocket held', state() === spentOnce && transactions[0].amount === 150000, `${spentOnce} -> ${state()}`);

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

  // Security audit fix 1: parsers never produce values the loader rejects, and invalid state is never saved.
  const nines = '9'.repeat(400);
  check('receipt amount of 400 digits is not Infinity', rcNum(nines) === 0 && Number.isFinite(rcNum('Rp 12.500')) && rcNum('Rp 12.500') === 12500, String(rcNum(nines)));
  const d = s => stDate(s);
  check('statement dates: only real 2- or 4-digit-year dates', d('05 Jan 0999') === null && d('01 Jan 026') === null && d('31 Feb 2026') === null && d('00 Mar 2026') === null && d('05 Jan 26') === '2026-01-05' && d('29 Feb 2028') === '2028-02-29', [d('05 Jan 0999'), d('01 Jan 026'), d('31 Feb 2026'), d('05 Jan 26')].join());
  reset();
  stmt = { accountId: 'c1', items: [{ name: 'Bad', amount: 45000, date: '999-01-05', include: true, link: '', categoryId: 'cat_food' }] }; stSave(); closeModal();
  check('statement save refuses a malformed date', transactions.length === 0, String(transactions.length));
  reset(); STORE_KEY = 'test.invalid'; localStorage.removeItem('test.invalid');
  transactions = [{ id: 'x1', date: '999-01-05', title: 'Bad', amount: 1000, type: 'expense', categoryId: 'cat_food', accountId: 'a1', tag: '', pocketId: null }];
  saveState();
  check('invalid state is never written to the cache', localStorage.getItem('test.invalid') === null, 'cache was written');
  STORE_KEY = null; transactions = [];

  // A rejected cache must not be treated as synced: the valid cloud copy is loaded instead of an empty app.
  reset(); const good = JSON.parse(stateJSON()); accounts = []; transactions = []; pockets = []; recurringItems = []; essentials = [];
  localStorage.setItem('flowpocket.v1.u9', JSON.stringify({ v: 1, ...good, transactions: [{ id: 'bad', date: '999-01-05', title: 'Bad', amount: 1, type: 'expense', categoryId: 'cat_food', accountId: 'a1', tag: '', pocketId: null }] }));
  localStorage.setItem('flowpocket.v1.u9.meta', JSON.stringify({ base: 'v2', dirty: false }));
  let pushes = 0;
  sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { data: good, updated_at: 'v2' }, error: null }) }) }), insert: () => { pushes++; return { select: () => ({ single: async () => ({ error: { message: 'dup' } }) }) }; }, update: () => { pushes++; return { eq: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) }; } }) };
  cloudUser = null; cloudInvalid = false; initialPullDone = false; await onSignedIn({ id: 'u9', email: 'u9@example.test' }); clearTimeout(pushTimer);
  check('rejected cache: valid cloud copy is loaded, not an empty app', accounts.length === 3 && !!localStorage.getItem('flowpocket.v1.u9.bad'), `${accounts.length} accounts`);
  // An invalid cloud row is never overwritten by a "first sign-in" push.
  const badCloud = { ...good, transactions: [{ id: 'bad', date: '999-01-05', title: 'Bad', amount: 1, type: 'expense', categoryId: 'cat_food', accountId: 'a1', tag: '', pocketId: null }] };
  localStorage.removeItem('flowpocket.v1.u8'); localStorage.removeItem('flowpocket.v1.u8.meta');
  sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { data: badCloud, updated_at: 'v5' }, error: null }) }) }), insert: () => { pushes++; return { select: () => ({ single: async () => ({ error: { message: 'dup' } }) }) }; }, update: () => { pushes++; return { eq: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) }; } }) };
  pushes = 0; cloudUser = null; cloudInvalid = false; accounts = []; transactions = []; pockets = []; recurringItems = []; essentials = [];
  await onSignedIn({ id: 'u8', email: 'u8@example.test' }); await new Promise(r => setTimeout(r, 1500)); clearTimeout(pushTimer);
  check('invalid cloud row is not overwritten', pushes === 0, `${pushes} push attempts`);

  // Security audit fix 3: per-user caches are cleared whenever the session ends, not only from the Keluar button.
  let authCb = null;
  window.supabase = { createClient: () => ({ auth: { onAuthStateChange: cb => { authCb = cb; }, getSession: async () => ({ data: { session: null } }) } }) };
  localStorage.setItem('flowpocket.v1.lapsed', '{}'); localStorage.setItem('flowpocket.v1.lapsed.meta', '{}');
  initCloud(); await new Promise(r => setTimeout(r, 50));
  check('boot without a session clears leftover caches', !localStorage.getItem('flowpocket.v1.lapsed') && !localStorage.getItem('flowpocket.v1.lapsed.meta'), 'cache left behind');
  localStorage.setItem('flowpocket.v1.u7', '{}'); localStorage.setItem('flowpocket.v1.u7.meta', '{}'); cloudUser = null;
  authCb('SIGNED_OUT', null);
  check('SIGNED_OUT (e.g. remote sign-out) clears the cache', !localStorage.getItem('flowpocket.v1.u7') && !localStorage.getItem('flowpocket.v1.u7.meta') && STORE_KEY === null, 'cache left behind');
  cloudUser = null; sb = null; STORE_KEY = null;
  return out;
});

// Security audit fix 2: a sign-out whose server call fails still removes the stored session (checked after the reload).
await page.evaluate(() => {
  localStorage.setItem('sb-test-auth-token', '{"access_token":"dummy"}'); localStorage.setItem('flowpocket.v1.u6', '{}');
  STORE_KEY = 'flowpocket.v1.u6'; lastPushed = stateJSON();
  sb = { auth: { storageKey: 'sb-test-auth-token', signOut: async () => ({ error: new Error('network down') }) } };
  setTimeout(() => signOut(), 0);
});
await page.waitForEvent('load');
const afterSignOut = await page.evaluate(() => ({ token: localStorage.getItem('sb-test-auth-token'), cache: localStorage.getItem('flowpocket.v1.u6') }));
results.push({ name: 'failed sign-out still removes the stored session', ok: afterSignOut.token === null && afterSignOut.cache === null, detail: JSON.stringify(afterSignOut) });

let failed = 0;
for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '  — ' + r.detail}`); }
if (pageErrors.length) { failed++; console.log('FAIL page errors:', pageErrors.join(' | ')); }
console.log(`\n${results.length - (failed - (pageErrors.length ? 1 : 0))}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
