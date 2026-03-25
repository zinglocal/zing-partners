// ═══════════════════════════════════════════════════════════════
//  ZING Partner Manager — Google Apps Script Backend
//  Deploy as: Web App → Execute as: Me → Access: Anyone
// ═══════════════════════════════════════════════════════════════

// ⚠️  Paste your Stripe Secret Key here (sk_test_... for test, sk_live_... for production)
// Find it at: https://dashboard.stripe.com/apikeys → "Secret key"
const STRIPE_SECRET = 'sk_live_REPLACE_WITH_YOUR_KEY'; // ← paste your live key here before deploying

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

    // Stripe webhook events have a `type` field, not `action`
    if (body.type && body.data && body.data.object) {
      const result = handleStripeWebhook(body);
      return ContentService.createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const action = body.action;
    let result = { ok: false };

    if      (action === 'init')     result = handleInit();
    else if (action === 'getAll')   result = handleGetAll();
    else if (action === 'saveSrc')  result = handleSaveSrc(body.src);
    else if (action === 'delSrc')   result = handleDelSrc(body.id);
    else if (action === 'saveDeal') result = handleSaveDeal(body.deal);
    else if (action === 'delDeal')  result = handleDelDeal(body.id);
    else if (action === 'saveInv')  result = handleSaveInv(body.inv);
    else if (action === 'charge')     result = handleCharge(body);
    else if (action === 'subscribe')  result = handleSubscribe(body);
    else if (action === 'stripeInv')  result = handleStripeInv(body);
    else result = { ok: false, err: 'Unknown action: ' + action };

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, err: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── STRIPE WEBHOOK ─────────────────────────────────────────────
// Handles invoice.paid and invoice.payment_succeeded events from Stripe.
// Matches by stripeId field, updates status to Paid + records payment date.
function handleStripeWebhook(event) {
  const type = event.type;
  if (type !== 'invoice.paid' && type !== 'invoice.payment_succeeded') {
    return { ok: true, skipped: true, type };
  }

  const stripeInv = event.data.object;
  const stripeId  = stripeInv.id;
  const paidAt    = stripeInv.status_transitions && stripeInv.status_transitions.paid_at
                    ? new Date(stripeInv.status_transitions.paid_at * 1000).toISOString().split('T')[0]
                    : new Date().toISOString().split('T')[0];

  const sh      = getSheet('Invoices');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rows    = sh.getDataRange().getValues();

  const stripeIdCol = headers.indexOf('stripeId');
  const stCol       = headers.indexOf('st');
  const pdCol       = headers.indexOf('pd');

  if (stripeIdCol < 0 || stCol < 0) return { ok: false, err: 'Missing columns' };

  let updated = false;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][stripeIdCol] === stripeId) {
      sh.getRange(i + 1, stCol + 1).setValue('Paid');
      if (pdCol >= 0) sh.getRange(i + 1, pdCol + 1).setValue(paidAt);
      updated = true;
      break;
    }
  }

  return { ok: true, updated, stripeId };
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

// ── STRIPE PLAN → PRICE ID MAP ────────────────────────────────
const PRICE_IDS = {
  'DISCOVER': 'price_1ShamzJdCDYxERimazBbXFQM',
  'BOOST':    'price_1Sf2b9JdCDYxERimXLjtfVYq',
  'DOMINATE': 'price_1SmiAOJdCDYxERimC2HsmRW7'
};

// ── STRIPE: CREATE SUBSCRIPTION ───────────────────────────────
// Creates a Stripe Customer (or finds existing), optionally adds a
// one-time deposit as an invoice item, then creates a subscription
// with payment_behavior=default_incomplete so the first invoice's
// PaymentIntent client_secret can be confirmed in the browser.
function handleSubscribe(body) {
  const { email, name, plan, depositAmount, desc } = body;
  if (!email || !plan) return { ok: false, err: 'Missing email or plan' };

  const priceId = PRICE_IDS[plan];
  if (!priceId) return { ok: false, err: 'Unknown plan: ' + plan };

  // Find or create Stripe customer
  let custId = findStripeCustomer(email);
  if (!custId) {
    const cust = stripePost('https://api.stripe.com/v1/customers', { name: name || '', email: email });
    if (!cust.id) return { ok: false, err: 'Could not create Stripe customer: ' + (cust.error?.message || '') };
    custId = cust.id;
  }

  // Add deposit as a pending invoice item (will be included in the first subscription invoice)
  if (depositAmount && depositAmount > 0) {
    stripePost('https://api.stripe.com/v1/invoiceitems', {
      customer: custId,
      amount: String(Math.round(depositAmount)),
      currency: 'usd',
      description: desc || 'Website launch fee (deposit)'
    });
  }

  // Create subscription — first payment will include any pending invoice items
  const sub = stripePost('https://api.stripe.com/v1/subscriptions', {
    customer: custId,
    'items[0][price]': priceId,
    payment_behavior: 'default_incomplete',
    'payment_settings[save_default_payment_method]': 'on_subscription',
    'expand[]': 'latest_invoice.payment_intent'
  });

  Logger.log('Subscription response: ' + JSON.stringify(sub).substring(0, 500));

  if (!sub.id) return { ok: false, err: sub.error?.message || 'Could not create subscription' };

  const clientSecret = sub.latest_invoice && sub.latest_invoice.payment_intent
    ? sub.latest_invoice.payment_intent.client_secret
    : null;
  if (!clientSecret) return { ok: false, err: 'No client secret — subscription may already be active or expand failed' };

  return { ok: true, clientSecret: clientSecret, subscriptionId: sub.id, customerId: custId };
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