// ═══════════════════════════════════════════════════════════════
//  ZING Partner Manager — Google Apps Script Backend
//  Deploy as: Web App → Execute as: Me → Access: Anyone
// ═══════════════════════════════════════════════════════════════

// ⚠️  Paste your Stripe Secret Key here (sk_test_... for test, sk_live_... for production)
// Find it at: https://dashboard.stripe.com/apikeys → "Secret key"
const STRIPE_SECRET = 'sk_test_REPLACE_WITH_YOUR_KEY';

// ── SHEET NAMES ────────────────────────────────────────────────
const SHEETS = { sources: 'LeadSources', deals: 'Deals', invoices: 'Invoices', meta: 'Meta' };

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function initSheets() {
  const headers = {
    LeadSources: ['id','name','contact','email','phone','addr','ein','type','inc','trig','terms','bank','an','rn','pm','status','pr','notes','created'],
    Deals:       ['id','customer','email','phone','loc','plan','mrr','commission','srcId','srcName','rep','date','otf','fd','ft','notes','stage','s1d','s2d','s2u','s2b','s3d','s3a','s3r','s4d','s4a','s4m','s4r','s4ab','sInvId','created'],
    Invoices:    ['id','cn','ce','ca','id2','dd','terms','notes','lines','tot','st','pd','pr2','stripeId','created'],
    Meta:        ['key','value']
  };
  for (const [name, cols] of Object.entries(headers)) {
    const sh = getSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(cols);
      sh.getRange(1, 1, 1, cols.length).setFontWeight('bold').setBackground('#050536').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
  }
  const meta = getSheet('Meta');
  const vals = meta.getDataRange().getValues();
  const keys = vals.map(r => r[0]);
  if (!keys.includes('nd')) meta.appendRow(['nd', 0]);
  if (!keys.includes('ni')) meta.appendRow(['ni', 0]);
  if (!keys.includes('ns')) meta.appendRow(['ns', 0]);
}

// ── HTTP HANDLER ───────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    let result = { ok: false };

    if      (action === 'init')     result = handleInit();
    else if (action === 'getAll')   result = handleGetAll();
    else if (action === 'saveSrc')  result = handleSaveSrc(body.src);
    else if (action === 'delSrc')   result = handleDelSrc(body.id);
    else if (action === 'saveDeal') result = handleSaveDeal(body.deal);
    else if (action === 'delDeal')  result = handleDelDeal(body.id);
    else if (action === 'saveInv')  result = handleSaveInv(body.inv);
    else if (action === 'charge')   result = handleCharge(body);
    else if (action === 'stripeInv') result = handleStripeInv(body);
    else result = { ok: false, err: 'Unknown action: ' + action };

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, err: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'ZING Partner Manager' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── INIT ───────────────────────────────────────────────────────
function handleInit() { initSheets(); return { ok: true }; }

// ── GET ALL ────────────────────────────────────────────────────
function handleGetAll() {
  initSheets();
  const sources  = sheetToObjects('LeadSources').map(s => ({ ...s, pr: tryParse(s.pr) }));
  const deals    = sheetToObjects('Deals').map(d => ({
    ...d, mrr: +d.mrr||0, commission: +d.commission||0, stage: +d.stage||1,
    otf: +d.otf||0, s3a: +d.s3a||0, s4a: +d.s4a||0
  }));
  const invoices = sheetToObjects('Invoices').map(i => ({ ...i, tot: +i.tot||0, lines: tryParse(i.lines) }));
  const meta     = getSheet('Meta').getDataRange().getValues();
  const nd       = +((meta.find(r => r[0]==='nd')||[])[1]||0);
  const ni       = +((meta.find(r => r[0]==='ni')||[])[1]||0);
  const ns       = +((meta.find(r => r[0]==='ns')||[])[1]||0);
  return { ok: true, sources, deals, invoices, nd, ni, ns };
}

// ── LEAD SOURCES ───────────────────────────────────────────────
function handleSaveSrc(src) {
  if (!src || !src.id) return { ok: false, err: 'No source data' };
  const sh = getSheet('LeadSources');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rows = sh.getDataRange().getValues();
  const existingRow = rows.findIndex((r, i) => i > 0 && r[0] === src.id);
  const toSave = { ...src, pr: JSON.stringify(src.pr || []) };
  const row = headers.map(h => toSave[h] !== undefined ? toSave[h] : '');
  if (existingRow > 0) {
    sh.getRange(existingRow + 1, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
    bumpMeta('ns');
  }
  return { ok: true };
}

function handleDelSrc(id) { return deleteRowById('LeadSources', id); }

// ── DEALS ──────────────────────────────────────────────────────
function handleSaveDeal(deal) {
  if (!deal || !deal.id) return { ok: false, err: 'No deal data' };
  const sh = getSheet('Deals');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rows = sh.getDataRange().getValues();
  const existingRow = rows.findIndex((r, i) => i > 0 && r[0] === deal.id);
  const row = headers.map(h => deal[h] !== undefined ? deal[h] : '');
  if (existingRow > 0) {
    sh.getRange(existingRow + 1, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
    bumpMeta('nd');
  }
  return { ok: true };
}

function handleDelDeal(id) { return deleteRowById('Deals', id); }

// ── INVOICES ───────────────────────────────────────────────────
function handleSaveInv(inv) {
  if (!inv || !inv.id) return { ok: false, err: 'No invoice data' };
  const sh = getSheet('Invoices');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rows = sh.getDataRange().getValues();
  const existingRow = rows.findIndex((r, i) => i > 0 && r[0] === inv.id);
  const toSave = { ...inv, lines: JSON.stringify(inv.lines || []) };
  const row = headers.map(h => toSave[h] !== undefined ? toSave[h] : '');
  if (existingRow > 0) {
    sh.getRange(existingRow + 1, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
    bumpMeta('ni');
  }
  return { ok: true };
}

// ── STRIPE: CREATE PAYMENT INTENT ─────────────────────────────
function handleCharge(body) {
  const { amount, desc } = body;
  if (!amount) return { ok: false, err: 'Missing amount' };
  const res = stripePost('https://api.stripe.com/v1/payment_intents', {
    amount: String(Math.round(amount)),
    currency: 'usd',
    'payment_method_types[]': 'card',
    description: desc || 'ZING payment'
  });
  Logger.log('PaymentIntent response: ' + JSON.stringify(res));
  if (res.client_secret) {
    return { ok: true, clientSecret: res.client_secret, id: res.id };
  }
  return { ok: false, err: res.error?.message || JSON.stringify(res).substring(0, 300) };
}

// ── STRIPE: SEND INVOICE ───────────────────────────────────────
function handleStripeInv(body) {
  const { cn, ce, lines, due, notes } = body;
  if (!cn || !ce) return { ok: false, err: 'Missing client name or email' };

  let custId = findStripeCustomer(ce);
  if (!custId) {
    const cust = stripePost('https://api.stripe.com/v1/customers', { name: cn, email: ce });
    if (!cust.id) return { ok: false, err: 'Could not create Stripe customer' };
    custId = cust.id;
  }

  const dueTs = due ? Math.floor(new Date(due).getTime() / 1000) : Math.floor(Date.now() / 1000) + 14 * 86400;
  const inv = stripePost('https://api.stripe.com/v1/invoices', {
    customer: custId,
    collection_method: 'send_invoice',
    due_date: String(dueTs),
    description: notes || ''
  });
  if (!inv.id) return { ok: false, err: 'Could not create Stripe invoice' };

  for (const line of (lines || [])) {
    if (!line.d || !line.a) continue;
    stripePost('https://api.stripe.com/v1/invoiceitems', {
      customer: custId,
      invoice: inv.id,
      description: line.d,
      quantity: String(line.q || 1),
      unit_amount: String(Math.round((line.a || 0) * 100)),
      currency: 'usd'
    });
  }

  stripePost('https://api.stripe.com/v1/invoices/' + inv.id + '/finalize', {});
  stripePost('https://api.stripe.com/v1/invoices/' + inv.id + '/send', {});
  return { ok: true, id: inv.id };
}

// ── STRIPE HELPERS ─────────────────────────────────────────────
function stripePost(url, params) {
  const body = Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET },
    payload: body,
    muteHttpExceptions: true
  });
  return JSON.parse(res.getContentText());
}

function findStripeCustomer(email) {
  const res = UrlFetchApp.fetch(
    "https://api.stripe.com/v1/customers/search?query=email:'" + email + "'&limit=1",
    { headers: { Authorization: 'Bearer ' + STRIPE_SECRET }, muteHttpExceptions: true }
  );
  const data = JSON.parse(res.getContentText());
  return data.data?.[0]?.id || null;
}

// ── SHEET UTILITIES ────────────────────────────────────────────
function sheetToObjects(sheetName) {
  const sh = getSheet(sheetName);
  if (sh.getLastRow() < 2) return [];
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  return rows.slice(1).filter(r => r[0]).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i]; });
    return obj;
  });
}

function deleteRowById(sheetName, id) {
  const sh = getSheet(sheetName);
  const rows = sh.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === id) { sh.deleteRow(i + 1); return { ok: true }; }
  }
  return { ok: false, err: 'Row not found' };
}

function bumpMeta(key) {
  const sh = getSheet('Meta');
  const rows = sh.getDataRange().getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === key) { sh.getRange(i + 1, 2).setValue((+rows[i][1] || 0) + 1); return; }
  }
  sh.appendRow([key, 1]);
}

function tryParse(val) {
  try { return typeof val === 'string' && val ? JSON.parse(val) : (val || []); }
  catch { return val || []; }
}

// ── TEST FUNCTION — run this directly in the editor ───────────
function testStripe() {
  const res = stripePost('https://api.stripe.com/v1/payment_intents', {
    amount: '100',
    currency: 'usd',
    'payment_method_types[]': 'card'
  });
  Logger.log('Stripe test result: ' + JSON.stringify(res));
}