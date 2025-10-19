const Alexa = require('ask-sdk-core');
const admin = require('firebase-admin');
const express = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const getRawBody = require('raw-body');

// Global process-level diagnostics
try {
  process.on('unhandledRejection', (e) => {
    try { console.error('[process] unhandledRejection:', e && (e.stack || e.message || e)); } catch (_) {}
  });
  process.on('uncaughtException', (e) => {
    try { console.error('[process] uncaughtException:', e && (e.stack || e.message || e)); } catch (_) {}
  });
} catch (_) { /* ignore */ }

/* ---------------------- Firebase initialization (robust) ---------------------- */
function initFirebase() {
  if (admin.apps.length) return;

  const tryParseJSON = (text) => {
    try { return JSON.parse(text); } catch (_) { return null; }
  };
  const sanitize = (s) => (s || '').trim();

  // STRICT: Read credentials from env only
  const b64Raw = sanitize(process.env.FIREBASE_SA_B64 || '');
  const jsonRaw = sanitize(process.env.FIREBASE_SA_JSON || '');

  const projectIdEnv = sanitize(process.env.FIREBASE_PROJECT_ID || '');
  try {
    const src = b64Raw ? 'B64' : (jsonRaw ? 'JSON' : 'NONE');
    console.log('[initFirebase] start: credsSource=', src, 'projEnvSet=', Boolean(projectIdEnv));
  } catch (_) { /* ignore logging errors */ }

  let saObj = null;

  if (b64Raw) {
    try {
      const decoded = Buffer.from(b64Raw, 'base64').toString('utf8').trim();
      saObj = tryParseJSON(decoded) || tryParseJSON(b64Raw);
    } catch (e) {
      console.error('FIREBASE_SA_B64 base64 decode failed:', e);
    }
  }
  if (!saObj && jsonRaw) {
    saObj = tryParseJSON(jsonRaw);
  }
  if (!saObj) {
    console.error('[initFirebase] no service account parsed');
    throw new Error('Unable to read Firebase service account. Set FIREBASE_SA_B64 (base64 of JSON) or FIREBASE_SA_JSON (raw JSON).');
  }

  const projectId = projectIdEnv || saObj.project_id;
  try {
    console.log('[initFirebase] resolved projectId=', projectId ? 'present' : 'missing', 'hasClientEmail=', Boolean(saObj.client_email));
  } catch (_) { /* ignore */ }
  if (!projectId) {
    console.error('[initFirebase] projectId missing');
    throw new Error('Missing FIREBASE_PROJECT_ID and service account has no project_id.');
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert(saObj),
      projectId
    });
  } catch (e) {
    try {
      console.error('Firebase initializeApp failed:', e && (e.message || e.name || e));
    } catch (_) {
      console.error('Firebase initializeApp failed: <unprintable error>');
    }
    throw e;
  }
  try { console.log('[initFirebase] success'); } catch (_) { /* ignore */ }
}

/* ------------------------- Auth/Session helpers (safe) ------------------------- */
function getAccessToken(handlerInput) {
  try {
    const env = handlerInput && handlerInput.requestEnvelope;
    const ctx = env && env.context;
    const sys = ctx && ctx.System;
    const usr = sys && sys.user;
    const token = usr && usr.accessToken;
    return token || null;
  } catch (_) {
    return null;
  }
}

function requireAccountLinking(handlerInput) {
  const speak = 'Please link your account to continue. I sent a card to your Alexa app.';
  return handlerInput.responseBuilder
    .speak(speak)
    .withLinkAccountCard()
    .getResponse();
}

// Use Alexa per-user-per-skill id as subject key in Firestore
function userKey(handlerInput) {
  try {
    const env = handlerInput && handlerInput.requestEnvelope;
    const ctx = env && env.context;
    const sys = ctx && ctx.System;
    const usr = sys && sys.user;
    const id = usr && usr.userId;
    return id || 'anonymous';
  } catch (_) {
    return 'anonymous';
  }
}

function getSession(h) {
  try {
    const attrs = h.attributesManager && h.attributesManager.getSessionAttributes();
    return attrs || {};
  } catch (_) {
    return {};
  }
}

function setSession(h, attrs) {
  try {
    if (h.attributesManager) {
      h.attributesManager.setSessionAttributes(attrs || {});
    }
  } catch (_) { /* ignore */ }
}

/* --------------------------- Timezone helpers ------------------------ */
const TIMEZONE_OFFSET_MINUTES = Number(process.env.TIMEZONE_OFFSET_MINUTES || 330); // IST

function localNowWithOffset() {
  const nowUtc = new Date();
  return new Date(nowUtc.getTime() + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
}

function localYMD() {
  const d = localNowWithOffset();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 1 = Monday ... 7 = Sunday
function localWeekday1Mon7Sun() {
  const d = localNowWithOffset();
  const zeroBased = d.getUTCDay(); // 0=Sun ... 6=Sat
  return zeroBased === 0 ? 7 : zeroBased;
}

/* ------------------------ Panel/index configuration ------------------ */
const PANEL_INDEX_PATH = process.env.PANEL_INDEX_PATH || 'panel/index';
let _panelConfigCache = { data: null, expAt: 0 }; // 5 min cache

async function getPanelConfig() {
  initFirebase();
  const now = Date.now();
  if (_panelConfigCache.data && _panelConfigCache.expAt > now) return _panelConfigCache.data;

  const db = admin.firestore();
  const [col, docId] = PANEL_INDEX_PATH.split('/');
  const snap = await db.collection(col).doc(docId).get();
  const cfg = snap.exists ? snap.data() : {};
  _panelConfigCache = { data: cfg, expAt: now + 5 * 60 * 1000 };
  return cfg;
}

function isDayOffToday(dateYmd, weekday1to7, cfg) {
  if (weekday1to7 === 7) return true; // Sunday always off
  const weekly = Array.isArray(cfg.weeklyDaysOff) ? cfg.weeklyDaysOff : [];
  return weekly.includes(weekday1to7);
}

/* ------------------------ Firestore attendance I/O ------------------- */
async function getDay(uid, date) {
  initFirebase();
  const db = admin.firestore();
  const [y, m] = date.split('-');
  const ref = db.collection('attendance').doc(uid).collection(y).doc(`${y}-${m}`).collection('days').doc(date);
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}

async function setStatusIfEmpty(uid, date, status, extra = {}) {
  initFirebase();
  const db = admin.firestore();
  const [y, m] = date.split('-');
  const ref = db.collection('attendance').doc(uid).collection(y).doc(`${y}-${m}`).collection('days').doc(date);

  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (doc.exists) {
        const existing = doc.data().status;
        throw { code: 'already_set', existing };
      }
      tx.set(ref, { status, ...extra, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    return { ok: true };
  } catch (e) {
    if (e && e.code === 'already_set') return { ok: false, reason: 'already_set', existing: e.existing };
    console.error('setStatusIfEmpty error', e);
    return { ok: false, reason: 'unknown' };
  }
}

async function setStatusOverwrite(uid, date, status, extra = {}) {
  initFirebase();
  const db = admin.firestore();
  const [y, m] = date.split('-');
  const ref = db.collection('attendance').doc(uid).collection(y).doc(`${y}-${m}`).collection('days').doc(date);
  await ref.set({ status, ...extra, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

/* --------------------------- Sessions (DB/attendance/{uid}/sessions) --------------------------- */
function toMillis(val) {
  if (!val) return 0;
  if (val && typeof val.toMillis === 'function') return val.toMillis();
  if (val instanceof Date) return val.getTime();
  const t = new Date(String(val)).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function listSessions(uid) {
  initFirebase();
  const db = admin.firestore();
  const col = db.collection('DB').doc('attendance').collection(uid).collection('sessions');
  let snap;
  try {
    snap = await col.orderBy('createdAt', 'desc').limit(20).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) {
    snap = await col.limit(20).get();
    const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    arr.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
    return arr;
  }
}

async function findSessionByName(uid, name) {
  const target = String(name || '').trim().toLowerCase();
  const sessions = await listSessions(uid);
  const matches = sessions.filter(s => String(s.name || '').trim().toLowerCase() === target);
  if (!matches.length) return null;
  matches.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  return matches[0];
}

async function fetchSessionByCreatedAt(uid, createdAtValue) {
  initFirebase();
  const db = admin.firestore();
  const sessionsCol = db.collection('DB').doc('attendance').collection(uid).collection('sessions');

  if (createdAtValue) {
    try {
      const qs = await sessionsCol.where('createdAt', '==', createdAtValue).limit(1).get();
      if (!qs.empty) {
        const d = qs.docs[0];
        return { id: d.id, ...d.data() };
      }
    } catch (_) { /* continue */ }

    try {
      let snap;
      try {
        snap = await sessionsCol.orderBy('createdAt', 'desc').limit(20).get();
      } catch (_) {
        snap = await sessionsCol.limit(20).get();
      }
      if (!snap.empty) {
        const targetMs = toMillis(createdAtValue);
        const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        let found = arr.find(s => toMillis(s.createdAt) === targetMs);
        if (found) return found;
        arr.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
        return arr[0] || null;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  try {
    let snap;
    try {
      snap = await sessionsCol.orderBy('createdAt', 'desc').limit(1).get();
    } catch (_) {
      snap = await sessionsCol.limit(10).get();
    }
    if (!snap.empty) {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      docs.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      return docs[0];
    }
  } catch (_) { /* ignore */ }
  return null;
}

async function getSelectedSession(uid) {
  initFirebase();
  const db = admin.firestore();
  const ref = db.collection('DB').doc('attendance').collection(uid).collection('meta').doc('selectedSession');
  const snap = await ref.get();
  if (!snap.exists) return null;
  return snap.data() || null;
}

async function setSelectedSession(uid, sessionInfo) {
  initFirebase();
  const db = admin.firestore();
  const ref = db.collection('DB').doc('attendance').collection(uid).collection('meta').doc('selectedSession');
  const createdAt = sessionInfo.createdAt;
  const createdAtMillis = toMillis(createdAt);
  await ref.set(
    { name: sessionInfo.name, startDate: sessionInfo.startDate, endDate: sessionInfo.endDate || null, createdAt, createdAtMillis },
    { merge: true }
  );
}

async function ensureSessionSelectedOrPrompt(h) {
  const uid = userKey(h);
  const chosen = await getSelectedSession(uid);
  if (chosen && (chosen.createdAt || chosen.startDate || chosen.start)) return true;

  const sessions = await listSessions(uid);
  if (!sessions.length) return true;

  const examples = sessions.slice(0, 3).map(s => s.name).filter(Boolean).join(', ');
  return h.responseBuilder
    .speak(examples ? `Which session do you want to use? For example: ${examples}.` : 'Which session do you want to use?')
    .reprompt('Please say the session name.')
    .addDelegateDirective({
      name: 'SelectSessionIntent',
      confirmationStatus: 'NONE',
      slots: { sessionName: { name: 'sessionName', value: '', confirmationStatus: 'NONE' } }
    })
    .getResponse();
}

async function getSessionWindow(uid) {
  const chosen = await getSelectedSession(uid);
  if (chosen && chosen.createdAt) {
    const resolved = await fetchSessionByCreatedAt(uid, chosen.createdAt);
    if (resolved && resolved.startDate) {
      return { start: resolved.startDate, end: resolved.endDate || localYMD() };
    }
    if (chosen.startDate || chosen.start) {
      return { start: chosen.startDate || chosen.start, end: chosen.endDate || chosen.end || localYMD() };
    }
  }

  const latest = await fetchSessionByCreatedAt(uid, null);
  if (latest && latest.startDate) {
    return { start: latest.startDate, end: latest.endDate || localYMD() };
  }

  const inferred = await inferSessionFromAttendance(uid);
  if (inferred) return inferred;

  const today = localYMD();
  return { start: today, end: today };
}

/* --------------------- Percentage computations ----------------------- */
async function computeMonthlyPct(uid, ym) {
  initFirebase();
  const db = admin.firestore();
  const [y, m] = ym.split('-');
  const col = db.collection('attendance').doc(uid).collection(y).doc(`${y}-${m}`).collection('days');
  const snap = await col.get();
  if (snap.empty) return 0;
  let present = 0, total = 0;
  snap.forEach(doc => {
    const s = doc.data().status;
    if (s === 'present') present += 1;
    if (['present', 'absent', 'holiday'].includes(s)) total += 1;
  });
  return total ? (present / total) * 100.0 : 0;
}

function ymRangeInclusive(startYMD, endYMD) {
  const [sy, sm] = startYMD.slice(0,7).split('-').map(Number);
  const [ey, em] = endYMD.slice(0,7).split('-').map(Number);
  const out = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2,'0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

async function computeSessionPct(uid) {
  const { start, end } = await getSessionWindow(uid);
  const months = ymRangeInclusive(start, end);
  if (!months.length) return 0;

  initFirebase();
  const db = admin.firestore();
  let present = 0, total = 0;

  for (const ym of months) {
    const [y, m] = ym.split('-');
    const col = db.collection('attendance').doc(uid).collection(y).doc(`${y}-${m}`).collection('days');
    const snap = await col.get();
    snap.forEach(doc => {
      const s = doc.data().status;
      if (s === 'present') present += 1;
      if (['present', 'absent', 'holiday'].includes(s)) total += 1;
    });
  }

  return total ? (present / total) * 100.0 : 0;
}

function deriveYearMonth(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  if (['PRESENT_REF', 'THIS_MONTH'].includes(dateStr)) {
    const d = localNowWithOffset();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  }
  const y = dateStr.match(/^(\d{4})$/);
  if (y) return `${y[1]}-01`;
  return null;
}

async function inferSessionFromAttendance(uid) {
  initFirebase();
  const db = admin.firestore();
  const userDoc = db.collection('attendance').doc(uid);

  try {
    const yearCollections = await userDoc.listCollections();
    if (!yearCollections.length) return null;

    const years = yearCollections.map(c => c.id).filter(id => /^\d{4}$/.test(id)).sort();

    let earliest = null;
    for (const y of years) {
      const yearCol = userDoc.collection(y);
      const monthDocs = await yearCol.listDocuments();
      const monthIds = monthDocs.map(d => d.id).filter(id => /^\d{4}-\d{2}$/.test(id)).sort();
      if (!monthIds.length) continue;
      const firstMonthId = monthIds[0];
      const daysCol = yearCol.doc(firstMonthId).collection('days');
      const dayDocs = await daysCol.listDocuments();
      const dayIds = dayDocs.map(d => d.id).filter(id => /^\d{4}-\d{2}-\d{2}$/.test(id)).sort();
      if (dayIds.length) { earliest = dayIds[0]; break; }
    }

    let latest = null;
    for (let yi = years.length - 1; yi >= 0; yi--) {
      const y = years[yi];
      const yearCol = userDoc.collection(y);
      const monthDocs = await yearCol.listDocuments();
      const monthIds = monthDocs.map(d => d.id).filter(id => /^\d{4}-\d{2}$/.test(id)).sort();
      if (!monthIds.length) continue;
      const lastMonthId = monthIds[monthIds.length - 1];
      const daysCol = yearCol.doc(lastMonthId).collection('days');
      const dayDocs = await daysCol.listDocuments();
      const dayIds = dayDocs.map(d => d.id).filter(id => /^\d{4}-\d{2}-\d{2}$/.test(id)).sort();
      if (dayIds.length) { latest = dayIds[dayIds.length - 1]; break; }
    }

    if (earliest) return { start: earliest, end: latest || localYMD() };
  } catch (e) {
    console.error('inferSessionFromAttendance error:', e);
  }
  return null;
}

/* --------------------------- Intent Handlers ------------------------- */
const LaunchRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest'; },
  handle(h) {
    console.log('[handler] LaunchRequest: entered');
    try {
      const token = getAccessToken(h);
      console.log('[handler] LaunchRequest: hasAccessToken=', Boolean(token));
      if (!token) {
        console.log('[handler] LaunchRequest: prompting account linking');
        const resp = requireAccountLinking(h);
        console.log('[handler] LaunchRequest: response built (link card)');
        return resp;
      }
      const speak = 'Welcome. You can say: mark present, mark absent, mark holiday, monthly attendance, or session attendance.';
      const resp = h.responseBuilder.speak(speak).reprompt('What would you like to do?').getResponse();
      console.log('[handler] LaunchRequest: response built (welcome)');
      return resp;
    } catch (e) {
      console.error('[handler] LaunchRequest error:', e && (e.stack || e.message || e));
      throw e;
    }
  }
};

const MarkPresentIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'MarkPresentIntent'; },
  async handle(h) {
    const token = getAccessToken(h); if (!token) return requireAccountLinking(h);
    try {
      const uid = userKey(h);
      const date = localYMD();
      const weekday = localWeekday1Mon7Sun();
      const cfg = await getPanelConfig();

      if (isDayOffToday(date, weekday, cfg)) return h.responseBuilder.speak('Today is a Day off.').getResponse();

      const existing = await getDay(uid, date);
      if (!existing || !existing.status) {
        const res = await setStatusIfEmpty(uid, date, 'present');
        if (res.ok) return h.responseBuilder.speak('Marked present.').getResponse();
        if (res.reason === 'already_set') return h.responseBuilder.speak('Today is already marked.').getResponse();
        return h.responseBuilder.speak('I could not mark you present right now. Please try again.').getResponse();
      }
      if (existing.status === 'present') return h.responseBuilder.speak('Today is already marked as present.').getResponse();

      const s = getSession(h);
      s.pendingChange = { date, newStatus: 'present' };
      setSession(h, s);
      return h.responseBuilder
        .speak(`Today is already marked as ${existing.status}. Do you want to change it to present?`)
        .reprompt('Do you want to change it?')
        .getResponse();
    } catch (e) {
      console.error(e);
      return h.responseBuilder.speak('I could not mark you present right now. Please try again.').getResponse();
    }
  }
};

const MarkAbsentIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'MarkAbsentIntent'; },
  async handle(h) {
    const token = getAccessToken(h); if (!token) return requireAccountLinking(h);
    try {
      const uid = userKey(h);
      const date = localYMD();
      const weekday = localWeekday1Mon7Sun();
      const cfg = await getPanelConfig();

      if (isDayOffToday(date, weekday, cfg)) return h.responseBuilder.speak('Today is a Day off.').getResponse();

      const existing = await getDay(uid, date);
      if (!existing || !existing.status) {
        const res = await setStatusIfEmpty(uid, date, 'absent');
        if (res.ok) return h.responseBuilder.speak('Marked absent.').getResponse();
        if (res.reason === 'already_set') return h.responseBuilder.speak('Today is already marked.').getResponse();
        return h.responseBuilder.speak('I could not mark you absent right now. Please try again.').getResponse();
      }
      if (existing.status === 'absent') return h.responseBuilder.speak('Today is already marked as absent.').getResponse();

      const s = getSession(h);
      s.pendingChange = { date, newStatus: 'absent' };
      setSession(h, s);
      return h.responseBuilder
        .speak(`Today is already marked as ${existing.status}. Do you want to change it to absent?`)
        .reprompt('Do you want to change it?')
        .getResponse();
    } catch (e) {
      console.error(e);
      return h.responseBuilder.speak('I could not mark you absent right now. Please try again.').getResponse();
    }
  }
};

const MarkHolidayIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'MarkHolidayIntent'; },
  async handle(h) {
    const token = getAccessToken(h); if (!token) return requireAccountLinking(h);

    const intent = h.requestEnvelope.request.intent;
    const holidayName = Alexa.getSlotValue(h.requestEnvelope, 'holidayName');
    if (!holidayName) {
      return h.responseBuilder
        .addElicitSlotDirective('holidayName', intent)
        .speak('What is the name of the holiday?')
        .reprompt('Please tell me the holiday name.')
        .getResponse();
    }

    try {
      const uid = userKey(h);
      const date = localYMD();
      const weekday = localWeekday1Mon7Sun();
      const cfg = await getPanelConfig();

      if (isDayOffToday(date, weekday, cfg)) return h.responseBuilder.speak('Today is a Day off.').getResponse();

      const existing = await getDay(uid, date);
      if (!existing || !existing.status) {
        const res = await setStatusIfEmpty(uid, date, 'holiday', { holidayName });
        if (res.ok) return h.responseBuilder.speak(`Marked holiday for ${holidayName}.`).getResponse();
        if (res.reason === 'already_set') return h.responseBuilder.speak('Today is already marked.').getResponse();
        return h.responseBuilder.speak('I could not mark the holiday right now. Please try again.').getResponse();
      }
      if (existing.status === 'holiday') return h.responseBuilder.speak('Today is already marked as holiday.').getResponse();

      const s = getSession(h);
      s.pendingChange = { date, newStatus: 'holiday', holidayName };
      setSession(h, s);
      return h.responseBuilder
        .speak(`Today is already marked as ${existing.status}. Do you want to change it to holiday for ${holidayName}?`)
        .reprompt('Do you want to change it?')
        .getResponse();
    } catch (e) {
      console.error(e);
      return h.responseBuilder.speak('I could not mark the holiday right now. Please try again.').getResponse();
    }
  }
};

const YesIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.YesIntent'; },
  async handle(h) {
    const token = getAccessToken(h); if (!token) return requireAccountLinking(h);

    const s = getSession(h);
    const pending = s.pendingChange;
    if (!pending) return h.responseBuilder.speak('There is nothing to confirm.').getResponse();

    try {
      const uid = userKey(h);
      const { date, newStatus, holidayName } = pending;

      const weekday = localWeekday1Mon7Sun();
      const cfg = await getPanelConfig();
      if (isDayOffToday(date, weekday, cfg)) {
        setSession(h, {});
        return h.responseBuilder.speak('Today is a Day off.').getResponse();
      }

      if (newStatus === 'holiday') {
        await setStatusOverwrite(uid, date, 'holiday', { holidayName });
        setSession(h, {});
        return h.responseBuilder.speak(`Changed to holiday for ${holidayName}.`).getResponse();
      }
      if (newStatus === 'present') {
        await setStatusOverwrite(uid, date, 'present');
        setSession(h, {});
        return h.responseBuilder.speak('Changed to present.').getResponse();
      }
      if (newStatus === 'absent') {
        await setStatusOverwrite(uid, date, 'absent');
        setSession(h, {});
        return h.responseBuilder.speak('Changed to absent.').getResponse();
      }

      setSession(h, {});
      return h.responseBuilder.speak('I could not update the status.').getResponse();
    } catch (e) {
      console.error(e);
      setSession(h, {});
      return h.responseBuilder.speak('I could not update the status right now. Please try again.').getResponse();
    }
  }
};

const NoIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.NoIntent'; },
  handle(h) {
    const s = getSession(h);
    if (s.pendingChange) {
      setSession(h, {});
      return h.responseBuilder.speak('Okay, I will keep the existing status.').getResponse();
    }
    return h.responseBuilder.speak('Okay.').getResponse();
  }
};

const SelectSessionIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'SelectSessionIntent';
  },
  async handle(h) {
    const token = getAccessToken(h);
    if (!token) return requireAccountLinking(h);

    const uid = userKey(h);
    const name = Alexa.getSlotValue(h.requestEnvelope, 'sessionName');
    if (!name) {
      return h.responseBuilder
        .speak('What is the session name you want to use?')
        .reprompt('Please say the session name.')
        .getResponse();
    }

    try {
      const found = await findSessionByName(uid, name);
      if (!found) {
        const sessions = await listSessions(uid);
        if (!sessions.length) {
          return h.responseBuilder.speak('I could not find any sessions configured for your account.').getResponse();
        }
        const names = sessions.slice(0, 5).map(s => s.name).filter(Boolean).join(', ');
        return h.responseBuilder
          .speak(`I could not find a session named ${name}. Available sessions are: ${names}. Which one do you want?`)
          .reprompt('Please say the session name.')
          .getResponse();
      }

      await setSelectedSession(uid, {
        name: found.name,
        startDate: found.startDate,
        endDate: found.endDate || null,
        createdAt: found.createdAt
      });

      return h.responseBuilder
        .speak(`Okay, I will use the session ${found.name} from now on.`)
        .getResponse();
    } catch (e) {
      console.error(e);
      return h.responseBuilder.speak('I could not set your session right now. Please try again.').getResponse();
    }
  }
};

const MonthlyAttendanceIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'MonthlyAttendanceIntent'; },
  async handle(h) {
    const token = getAccessToken(h); if (!token) return requireAccountLinking(h);

    const maybePrompt = await ensureSessionSelectedOrPrompt(h);
    if (maybePrompt !== true) return maybePrompt;

    try {
      const uid = userKey(h);
      const dateSlot = Alexa.getSlotValue(h.requestEnvelope, 'month');
      const ym = deriveYearMonth(dateSlot) || deriveYearMonth('THIS_MONTH');
      const pct = Math.round(await computeMonthlyPct(uid, ym));
      return h.responseBuilder.speak(`Your attendance for ${ym} is ${pct} percent.`).getResponse();
    } catch (e) {
      console.error(e);
      return h.responseBuilder.speak('I could not fetch the monthly attendance right now. Please try again.').getResponse();
    }
  }
};

const SessionAttendanceIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'SessionAttendanceIntent'; },
  async handle(h) {
    const token = getAccessToken(h); if (!token) return requireAccountLinking(h);

    const maybePrompt = await ensureSessionSelectedOrPrompt(h);
    if (maybePrompt !== true) return maybePrompt;

    try {
      const uid = userKey(h);
      const pct = Math.round(await computeSessionPct(uid));
      return h.responseBuilder.speak(`Your session attendance is ${pct} percent.`).getResponse();
    } catch (e) {
      console.error(e);
      return h.responseBuilder.speak('I could not fetch the session attendance right now. Please try again.').getResponse();
    }
  }
};

const HelpIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.HelpIntent'; },
  handle(h) {
    const speak = 'You can say: mark present, mark absent, mark holiday, use session by name, monthly attendance, or session attendance.';
    return h.responseBuilder.speak(speak).reprompt('What would you like to do?').getResponse();
  }
};

const CancelAndStopIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.CancelIntent' || Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.StopIntent');
  },
  handle(h) { return h.responseBuilder.speak('Goodbye!').getResponse(); }
};

const FallbackIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.FallbackIntent'; },
  handle(h) {
    return h.responseBuilder
      .speak('Sorry, I didn’t get that. You can say mark present or monthly attendance.')
      .reprompt('What would you like to do?')
      .getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest'; },
  handle(h) {
    try {
      const req = h && h.requestEnvelope && h.requestEnvelope.request;
      console.log('[handler] SessionEndedRequest:', req && (req.reason || 'no-reason'));
    } catch (_) { /* ignore */ }
    return h.responseBuilder.getResponse();
  }
};

/* --------------------------- Build Skill + Express ------------------------- */
const skill = Alexa.SkillBuilders.custom()
  .addRequestInterceptors({
    process(handlerInput) {
      try {
        const env = handlerInput && handlerInput.requestEnvelope;
        const t = env && env.request && env.request.type;
        const intent = env && env.request && env.request.intent && env.request.intent.name;
        console.log('[ask-sdk] request.type=', t || 'n/a', 'intent=', intent || 'n/a');
      } catch (_) { /* ignore */ }
    }
  })
  .addRequestHandlers(
    LaunchRequestHandler,
    MarkPresentIntentHandler,
    MarkAbsentIntentHandler,
    MarkHolidayIntentHandler,
    MonthlyAttendanceIntentHandler,
    SessionAttendanceIntentHandler,
    SelectSessionIntentHandler,
    YesIntentHandler,
    NoIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler
  )
  .addResponseInterceptors({
    process(handlerInput, response) {
      try {
        // Log minimal shape to avoid huge blobs
        const spoken = response && response.outputSpeech && (response.outputSpeech.text || response.outputSpeech.ssml);
        console.log('[ask-sdk] response prepared, hasOutputSpeech=', Boolean(spoken), 'shouldEndSession=', response && response.shouldEndSession);
      } catch (_) { /* ignore */ }
    }
  })
  .addErrorHandlers({
    canHandle() { return true; },
    handle(h, error) {
      console.error(`Error: ${error && (error.stack || error.message || error)}`);
      return h.responseBuilder.speak('Something went wrong. Please try again.').reprompt('Please try again.').getResponse();
    }
  })
  .create();
const skip = process.env.SKIP_ALEXA_VERIFICATION === '1';
const adapter = new ExpressAdapter(skill, !skip, !skip);
const app = express();

// Raw body for signature verification (POST only)
app.use(async (req, res, next) => {
  try {
    if (req.method === 'POST') {
      if (!req.rawBody) {
        req.rawBody = await getRawBody(req);
        try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { req.body = undefined; }
      }
    }
    next();
  } catch (e) {
    console.error('raw body error', e);
    res.status(400).send('Bad Request');
  }
});

// Diagnostics: confirm incoming Alexa signature headers and route
app.use((req, res, next) => {
  try {
    if (req.method === 'POST') {
      const hasSig = Boolean(req.headers['signature']);
      const hasChain = Boolean(req.headers['signaturecertchainurl']);
      console.log('[alexa] incoming', req.method, req.url, 'len=', req.headers['content-length'], 'sig=', hasSig, 'chain=', hasChain);
      if (hasChain) {
        try { console.log('[alexa] cert url=', String(req.headers['signaturecertchainurl'])); } catch (_) {}
      }
      const reqType = req.body && req.body.request && req.body.request.type;
      if (reqType) console.log('[alexa] request.type =', reqType);
      const intentName = req.body && req.body.request && req.body.request.intent && req.body.request.intent.name;
      if (intentName) console.log('[alexa] intent.name =', intentName);
    }
  } catch (_) { /* ignore */ }
  next();
});

// Log response status codes returned to Alexa
app.use((req, res, next) => {
  const origEnd = res.end;
  res.end = function (chunk, encoding, cb) {
    try { console.log('[alexa] response status=', res.statusCode); } catch (_) { /* ignore */ }
    return origEnd.call(this, chunk, encoding, cb);
  };
  next();
});

// Global error handler to capture adapter/handler errors
app.use((err, req, res, next) => {
  try {
    console.error('[alexa] express error:', err && (err.stack || err.message || err));
  } catch (_) { /* ignore */ }
  try { res.status(500).send('Internal Server Error'); } catch (_) { /* ignore */ }
});

if (process.env.SKIP_ALEXA_VERIFICATION === '1') {
  app.post('/', adapter.getRequestHandlers());
  // Catch-all POST to avoid 404s from minor path mismatches
  app.post('*', adapter.getRequestHandlers());
  app.post('/test', async (req, res) => {
    try {
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('test endpoint error', e);
      return res.status(500).json({ ok: false });
    }
  });
} else {
  app.post('/', adapter.getRequestHandlers());
  // Catch-all POST to avoid 404s from minor path mismatches
  app.post('*', adapter.getRequestHandlers());
}

// Health check for GET requests (useful for browser checks)
app.get('*', (req, res) => {
  res.status(200).send('ok');
});

// Vercel Node function export
module.exports = (req, res) => {
  if (req.method === 'POST') {
    try { initFirebase(); }
    catch (e) {
      console.error('Firebase init failed:', e);
      return res.status(500).json({ error: 'Firebase init failed' });
    }
  }
  return app(req, res);
};
