/* =====================================================================
   Rider Tracking System - Worker
   - Rider API: login, state, respond, live location, notifications, language
   - Admin API: live board, reports, riders (protected by ADMIN_KEY)
   - Cron (every minute): sends the questions and records "no response"
   ===================================================================== */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
const fail = (code, error, status) => json({ ok: false, code, error }, status);

/* ---------------------------- Settings ---------------------------- */
// All of these can be changed from wrangler.jsonc ("vars") without touching the code
const DEFAULTS = {
  TIMEZONE: "Asia/Riyadh",
  WORK_START_HOUR: 9, // first hour questions are sent
  WORK_END_HOUR: 23, // last hour (exclusive)
  ASK_EVERY_MIN: 30, // "do you have an order?" every N minutes
  PICKUP_AFTER_MIN: 15, // after "yes, I have an order" ask "picked up?"
  DELIVER_AFTER_MIN: 10, // after pickup ask "delivered?"
  REPEAT_MIN: 10, // repeat the question if unanswered or "not yet"
  MISS_AFTER_MIN: 10, // minutes before an unanswered question is "missed"
  MAX_ATTEMPTS: 3, // max repeats of the same question for one order
  STALE_HOURS: 4, // an open order with no movement closes itself
  MAX_SENDS_PER_TICK: 20, // send cap per minute (free plan limits)
  ASK_STAGES: 0, // 0 = one question only ("do you have an order now?"); 1 = also ask picked up / delivered
  ORDER_HOLD_MIN: 45, // (simple mode) a reported order closes itself if the rider stops confirming
  SUP_AFTER_MIN: 10, // supervisors are asked to confirm attendance this long after the shift starts
  SHIFT_LEAD_MIN: 15, // first shift reminder this many minutes before the shift starts
  SHIFT_NAG_MIN: 5, // repeat the reminder every N minutes until the rider confirms
  SHIFT_OPEN_MIN: 30, // the rider may confirm from this many minutes before the start
  SHIFT_GRACE_MIN: 5, // confirming later than this after the start counts as late
  SHIFT_MAX_NAGS: 1, // one reminder, SHIFT_LEAD_MIN minutes before the shift starts
  SUP_MAX_NAGS: 30, // supervisor confirm reminders limit
  SHIFT_SENDS_PER_TICK: 15, // shift reminders sent per minute (free plan limits)
};

function cfg(env) {
  const c = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const raw = env[k];
    if (raw === undefined || raw === null || raw === "") continue;
    if (k === "TIMEZONE") c[k] = String(raw);
    else if (Number.isFinite(Number(raw))) c[k] = Number(raw);
  }
  return c;
}

function makeFormatter(tz) {
  const opts = {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  };
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts });
  } catch {
    return new Intl.DateTimeFormat("en-GB", { timeZone: DEFAULTS.TIMEZONE, ...opts });
  }
}

// hour / minute / start of today / offset from UTC, in the operating timezone
function tzParts(now, tz) {
  const p = {};
  for (const x of makeFormatter(tz).formatToParts(new Date(now))) p[x.type] = x.value;
  const y = +p.year, mo = +p.month, d = +p.day;
  const h = +p.hour % 24, mi = +p.minute, s = +p.second;
  const offset = Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(now / 1000) * 1000;
  return { hour: h, minute: mi, offset, dayStart: Date.UTC(y, mo - 1, d) - offset };
}

function inWorkHours(hour, start, end) {
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function workMinutesPerDay(c) {
  if (c.WORK_START_HOUR === c.WORK_END_HOUR) return 24 * 60;
  return ((c.WORK_END_HOUR - c.WORK_START_HOUR + 24) % 24) * 60;
}

// work minutes elapsed so far today
function workElapsedToday(tz, c) {
  const perDay = workMinutesPerDay(c);
  const nowMin = tz.hour * 60 + tz.minute;
  const startMin = c.WORK_START_HOUR * 60;
  const since = (nowMin - startMin + 24 * 60) % (24 * 60);
  if (c.WORK_START_HOUR < c.WORK_END_HOUR && nowMin < startMin) return 0;
  return Math.min(perDay, since);
}

/* ---------------------------- Notification texts (ar / ur / bn) ---------------------------- */
const LANGS = ["ar", "ur", "bn", "en"];
const NOTICE = {
  en: {
    dir: "ltr",
    order_title: "Order in progress",
    open_app: "Open the app to answer.",
    stage: {
      declared: "On the way to the restaurant",
      arrived: "At the restaurant, waiting for the order",
      picked_up: "Order picked up, heading to the customer",
    },
    ask: {
      have_order: "Do you have an order now?",
      picked_up: "Did you pick up the order?",
      delivered: "Did you deliver the order?",
    },
    act: {
      have_order: "Yes, I have an order",
      no_order: "No",
      arrived: "Arrived at restaurant",
      picked_up: "Picked up",
      delivered: "Delivered",
    },
    app: "Link",
    uptodate: "Nothing new",
  },
  ar: {
    dir: "rtl",
    order_title: "طلب قيد التنفيذ",
    open_app: "افتح التطبيق للرد.",
    stage: {
      declared: "في الطريق إلى المطعم",
      arrived: "وصلت المطعم، بانتظار الاستلام",
      picked_up: "الطلب معك، في الطريق إلى العميل",
    },
    ask: {
      have_order: "هل معك طلب الآن؟",
      picked_up: "هل استلمت الطلب؟",
      delivered: "هل سلّمت الطلب؟",
    },
    act: {
      have_order: "نعم، معي طلب",
      no_order: "لا",
      arrived: "وصلت المطعم",
      picked_up: "استلمت الطلب",
      delivered: "سلّمت الطلب",
    },
    app: "لينك",
    uptodate: "لا يوجد جديد",
  },
  ur: {
    dir: "rtl",
    order_title: "آرڈر جاری ہے",
    open_app: "جواب دینے کے لیے ایپ کھولیں۔",
    stage: {
      declared: "ریسٹورنٹ کی طرف جا رہے ہیں",
      arrived: "ریسٹورنٹ پہنچ گئے، آرڈر کا انتظار",
      picked_up: "آرڈر آپ کے پاس ہے، کسٹمر کی طرف",
    },
    ask: {
      have_order: "کیا آپ کے پاس ابھی آرڈر ہے؟",
      picked_up: "کیا آپ نے آرڈر لے لیا؟",
      delivered: "کیا آپ نے آرڈر ڈیلیور کر دیا؟",
    },
    act: {
      have_order: "جی، آرڈر ہے",
      no_order: "نہیں",
      arrived: "ریسٹورنٹ پہنچ گیا",
      picked_up: "آرڈر لے لیا",
      delivered: "آرڈر ڈیلیور کر دیا",
    },
    app: "لنک",
    uptodate: "کوئی نئی اطلاع نہیں",
  },
  bn: {
    dir: "ltr",
    order_title: "অর্ডার চলমান",
    open_app: "উত্তর দিতে অ্যাপ খুলুন।",
    stage: {
      declared: "রেস্টুরেন্টের পথে",
      arrived: "রেস্টুরেন্টে পৌঁছেছেন, অর্ডারের অপেক্ষায়",
      picked_up: "অর্ডার আপনার কাছে, গ্রাহকের পথে",
    },
    ask: {
      have_order: "আপনার কাছে কি এখন অর্ডার আছে?",
      picked_up: "আপনি কি অর্ডার নিয়েছেন?",
      delivered: "আপনি কি অর্ডার ডেলিভারি দিয়েছেন?",
    },
    act: {
      have_order: "হ্যাঁ, অর্ডার আছে",
      no_order: "না",
      arrived: "রেস্টুরেন্টে পৌঁছেছি",
      picked_up: "অর্ডার নিয়েছি",
      delivered: "অর্ডার ডেলিভারি দিয়েছি",
    },
    app: "লিংক",
    uptodate: "নতুন কিছু নেই",
  },
};

const SHIFT_TXT = {
  en: {
    before: "{name}: starts in {n} min", now: "{name}: starting now", after: "{name}: started {n} min ago",
    body: "Open the delivery app, start your shift, then confirm here.", act: "I started my shift",
  },
  ar: {
    before: "{name}: يبدأ بعد {n} دقيقة", now: "{name}: يبدأ الآن", after: "{name}: بدأ منذ {n} دقيقة",
    body: "افتح تطبيق التوصيل وابدأ الشيفت، ثم أكّد من هنا.", act: "بدأت الشيفت",
  },
  ur: {
    before: "{name}: {n} منٹ میں شروع", now: "{name}: ابھی شروع", after: "{name}: {n} منٹ پہلے شروع ہوئی",
    body: "ڈیلیوری ایپ کھولیں، شفٹ شروع کریں، پھر یہاں تصدیق کریں۔", act: "میں نے شفٹ شروع کر دی",
  },
  bn: {
    before: "{name}: {n} মিনিট পরে শুরু", now: "{name}: এখনই শুরু", after: "{name}: {n} মিনিট আগে শুরু হয়েছে",
    body: "ডেলিভারি অ্যাপ খুলুন, শিফট শুরু করুন, তারপর এখানে নিশ্চিত করুন।", act: "আমি শিফট শুরু করেছি",
  },
};

// What the phone should show right now. While an order is open the notification is
// "sticky": it carries the current step and the button for the next one.
function buildNotice(state, lang, stages = true) {
  const L = NOTICE[lang] || NOTICE.ar;
  const base = { dir: L.dir, lang: NOTICE[lang] ? lang : "ar" };
  const o = state.order;
  const p = state.prompt;
  if (stages && o && L.stage[o.stage]) {
    const q = p && L.ask[p.type] ? L.ask[p.type] : null;
    const next = o.stage === "declared" ? ["arrived", "picked_up"] : o.stage === "arrived" ? ["picked_up"] : ["delivered"];
    return {
      ...base,
      kind: "order",
      sticky: true,
      title: q || L.order_title,
      body: q ? L.order_title + ": " + L.stage[o.stage] : L.stage[o.stage],
      actions: next.map((a) => ({ action: a, title: L.act[a] })),
    };
  }
  const sh = state.shift;
  if (sh && sh.need) {
    const X = SHIFT_TXT[lang] || SHIFT_TXT.ar;
    const tpl = sh.mins > 0 ? X.before : sh.mins === 0 ? X.now : X.after;
    return {
      ...base,
      kind: "shift",
      sticky: false,
      title: tpl.replace("{name}", sh.name).replace("{n}", String(Math.abs(sh.mins))),
      body: X.body,
      actions: [{ action: "shift_ok", title: X.act }],
    };
  }
  if (p && p.type === "have_order") {
    return {
      ...base,
      kind: "prompt",
      sticky: false,
      title: L.ask.have_order,
      body: L.open_app,
      actions: [
        { action: "have_order", title: L.act.have_order },
        { action: "no_order", title: L.act.no_order },
      ],
    };
  }
  return { ...base, kind: "none", sticky: false, title: L.app, body: L.uptodate, actions: [] };
}

// Old text-only helper (kept so devices on an older service worker keep working)
const PROMPTS = {
  have_order: { title: "معاك أوردر؟", body: "افتح التطبيق وجاوب: معاك أوردر دلوقتي؟" },
  picked_up: { title: "استلمت الأوردر؟", body: "افتح التطبيق وأكّد لو استلمت الأوردر من المطعم." },
  delivered: { title: "سلّمت الأوردر؟", body: "افتح التطبيق وأكّد لو سلّمت الأوردر للعميل." },
};

/* ---------------------------- Web Push (VAPID) ---------------------------- */
const b64u = {
  toBytes(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    s += "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
  fromBytes(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
};

let cachedKey = { d: null, key: null };
const jwtCache = new Map(); // origin -> { value, exp }

async function signingKey(env) {
  if (cachedKey.key && cachedKey.d === env.VAPID_PRIVATE_KEY) return cachedKey.key;
  const pub = b64u.toBytes(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64u.fromBytes(pub.slice(1, 33)),
      y: b64u.fromBytes(pub.slice(33, 65)),
      d: env.VAPID_PRIVATE_KEY,
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  cachedKey = { d: env.VAPID_PRIVATE_KEY, key };
  return key;
}

async function vapidAuthHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const nowSec = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(aud);
  if (hit && hit.exp - nowSec > 3600) return hit.value;

  const enc = new TextEncoder();
  const exp = nowSec + 12 * 3600;
  const header = b64u.fromBytes(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u.fromBytes(enc.encode(JSON.stringify({ aud, exp, sub: env.VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await signingKey(env),
    enc.encode(header + "." + payload)
  );
  const value = `vapid t=${header}.${payload}.${b64u.fromBytes(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
  jwtCache.set(aud, { value, exp });
  return value;
}

// Empty push: the service worker asks the server what to display
async function sendPush(subscription, env, ttlSec) {
  try {
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthHeader(subscription.endpoint, env),
        TTL: String(ttlSec),
        Urgency: "high",
      },
      signal: AbortSignal.timeout(8000),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/* ---------------------------- DB helpers ---------------------------- */
async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function getDevice(env, token) {
  return env.DB
    .prepare(
      `SELECT d.id, d.rider_id, d.lang, d.push_subscription IS NOT NULL AS push_enabled
       FROM devices d JOIN riders r ON r.id = d.rider_id
       WHERE d.token = ? AND r.active = 1`
    )
    .bind(String(token || ""))
    .first();
}

async function getDeviceByEndpoint(env, endpoint) {
  return env.DB
    .prepare(
      `SELECT d.id, d.rider_id, d.lang, 1 AS push_enabled
       FROM devices d JOIN riders r ON r.id = d.rider_id
       WHERE d.push_subscription IS NOT NULL
         AND json_extract(d.push_subscription, '$.endpoint') = ? AND r.active = 1
       ORDER BY d.id DESC LIMIT 1`
    )
    .bind(String(endpoint || ""))
    .first();
}

const cleanLang = (l) => (LANGS.includes(l) ? l : null);

function parseLoc(body) {
  const lat = Number(body && body.lat);
  const lng = Number(body && body.lng);
  if (
    body == null ||
    body.lat === null || body.lat === undefined || body.lat === "" ||
    body.lng === null || body.lng === undefined || body.lng === "" ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    Math.abs(lat) > 90 || Math.abs(lng) > 180
  ) {
    return null;
  }
  const acc = Number(body.accuracy);
  return { lat, lng, accuracy: Number.isFinite(acc) ? acc : null };
}

function upsertLocation(env, riderId, loc, now) {
  return env.DB
    .prepare(
      `INSERT INTO locations (rider_id, lat, lng, accuracy, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(rider_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng,
         accuracy = excluded.accuracy, updated_at = excluded.updated_at`
    )
    .bind(riderId, loc.lat, loc.lng, loc.accuracy, now);
}

// The "idle since" marker is optional: it must never break the main flow
async function safeRun(stmt) {
  try {
    await stmt.run();
  } catch {
    /* idle_since column not created yet */
  }
}

// Open order + latest unanswered question for a rider
async function riderState(env, riderId, now) {
  const order = await env.DB
    .prepare(
      `SELECT id, stage, declared_at, arrived_at, picked_at FROM orders
       WHERE rider_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
    )
    .bind(riderId)
    .first();
  const prompt = await env.DB
    .prepare(
      `SELECT type, status, sent_at FROM prompts
       WHERE rider_id = ? AND answered_at IS NULL AND sent_at >= ?
       ORDER BY sent_at DESC LIMIT 1`
    )
    .bind(riderId, now - 2 * HOUR)
    .first();
  return { order: order || null, prompt: prompt || null };
}

/* ---------------------------- Rider responses ---------------------------- */
const ACTIONS = ["have_order", "no_order", "arrived", "picked_up", "delivered", "cancel", "not_yet"];

function answerPrompts(env, riderId, types, answer, now) {
  const marks = types.map(() => "?").join(",");
  return env.DB
    .prepare(
      `UPDATE prompts SET status = CASE status WHEN 'missed' THEN 'late' ELSE 'answered' END,
         answered_at = ?, answer = ?
       WHERE rider_id = ? AND answered_at IS NULL AND type IN (${marks}) AND sent_at >= ?`
    )
    .bind(now, answer, riderId, ...types, now - 2 * HOUR);
}

function eventStmt(env, riderId, orderId, type, loc, now) {
  return env.DB
    .prepare(`INSERT INTO events (rider_id, order_id, type, lat, lng, at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(riderId, orderId, type, loc ? loc.lat : null, loc ? loc.lng : null, now);
}

async function handleRespond(env, body, now) {
  const device = await getDevice(env, body.token);
  if (!device) return fail("unauthorized", "Unauthorized", 401);

  const action = String(body.action || "");
  if (!ACTIONS.includes(action)) return fail("bad_action", "Unknown action", 400);

  const riderId = device.rider_id;
  const simple = !cfg(env).ASK_STAGES;
  const loc = parseLoc(body);
  const state = await riderState(env, riderId, now);
  const order = state.order;
  const stmts = [];

  if (loc) stmts.push(upsertLocation(env, riderId, loc, now));

  if (action === "have_order") {
    if (!order) {
      stmts.push(
        env.DB
          .prepare(
            `INSERT INTO orders (rider_id, status, stage, declared_at, updated_at)
             VALUES (?, 'active', 'declared', ?, ?)`
          )
          .bind(riderId, now, now)
      );
      stmts.push(
        env.DB
          .prepare(
            `INSERT INTO events (rider_id, order_id, type, lat, lng, at)
             VALUES (?, (SELECT MAX(id) FROM orders WHERE rider_id = ? AND status = 'active'), 'declared', ?, ?, ?)`
          )
          .bind(riderId, riderId, loc ? loc.lat : null, loc ? loc.lng : null, now)
      );
    }
    else if (simple) stmts.push(env.DB.prepare("UPDATE orders SET updated_at = ? WHERE id = ?").bind(now, order.id));
    stmts.push(answerPrompts(env, riderId, ["have_order"], "yes", now));
  } else if (action === "no_order") {
    if (order && simple) {
      stmts.push(
        env.DB
          .prepare("UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?")
          .bind(now, now, order.id)
      );
      stmts.push(eventStmt(env, riderId, order.id, "delivered", loc, now));
    }
    stmts.push(answerPrompts(env, riderId, ["have_order"], "no", now));
  } else if (action === "not_yet") {
    stmts.push(answerPrompts(env, riderId, ["picked_up", "delivered"], "no", now));
  } else {
    if (!order) return fail("no_order", "Register the order first", 409);
    if (action === "arrived") {
      if (order.stage === "declared") {
        stmts.push(
          env.DB
            .prepare("UPDATE orders SET stage = 'arrived', arrived_at = ?, updated_at = ? WHERE id = ?")
            .bind(now, now, order.id)
        );
        stmts.push(eventStmt(env, riderId, order.id, "arrived", loc, now));
      }
    } else if (action === "picked_up") {
      if (order.stage === "declared" || order.stage === "arrived") {
        stmts.push(
          env.DB
            .prepare("UPDATE orders SET stage = 'picked_up', picked_at = ?, updated_at = ? WHERE id = ?")
            .bind(now, now, order.id)
        );
        stmts.push(eventStmt(env, riderId, order.id, "picked_up", loc, now));
      }
      stmts.push(answerPrompts(env, riderId, ["picked_up"], "yes", now));
    } else if (action === "delivered") {
      stmts.push(
        env.DB
          .prepare(
            `UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(now, now, order.id)
      );
      stmts.push(eventStmt(env, riderId, order.id, "delivered", loc, now));
      stmts.push(answerPrompts(env, riderId, ["picked_up", "delivered"], "yes", now));
    } else if (action === "cancel") {
      stmts.push(
        env.DB.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(now, order.id)
      );
      stmts.push(eventStmt(env, riderId, order.id, "cancelled", loc, now));
      stmts.push(answerPrompts(env, riderId, ["picked_up", "delivered"], "cancel", now));
    }
  }

  if (stmts.length) await env.DB.batch(stmts);
  if (order && (action === "delivered" || action === "cancel" || (simple && action === "no_order"))) {
    await safeRun(env.DB.prepare("UPDATE riders SET idle_since = ? WHERE id = ?").bind(now, riderId));
  }
  const fresh = await riderState(env, riderId, now);
  return json({ ok: true, ...fresh });
}

/* ---------------------------- Scheduler (every minute) ---------------------------- */
const LATEST_PUSH_DEVICE = (alias) =>
  `(SELECT d2.id FROM devices d2 WHERE d2.rider_id = ${alias}.rider_id
     AND d2.push_subscription IS NOT NULL ORDER BY d2.id DESC LIMIT 1)`;

// SQL fragment (alias r = riders): the rider is inside one of his own shifts right now, or he has
// no schedule at all and the general working hours are open.
async function riderGate(db, now, tz, globalOk) {
  const fallback = globalOk ? "" : "AND 0";
  try {
    await db.prepare("SELECT 1 FROM rider_shifts LIMIT 1").first();
  } catch {
    return fallback;
  }
  const d0 = Math.round(tz.dayStart), dm = d0 - DAY;
  const dayStr = (ms) => new Date(ms + tz.offset).toISOString().slice(0, 10);
  const len = "(CASE WHEN rs.end_min = rs.start_min THEN 1440 ELSE ((rs.end_min - rs.start_min + 1440) % 1440) END)";
  const inShift = (day, base) =>
    `(rs.day = '${day}' AND ${now} >= ${base} + rs.start_min * 60000 AND ${now} < ${base} + (rs.start_min + ${len}) * 60000)`;
  return `AND (
    EXISTS (SELECT 1 FROM rider_shifts rs WHERE rs.rider_id = r.id AND (${inShift(dayStr(d0), d0)} OR ${inShift(dayStr(dm), dm)}))
    ${globalOk ? `OR NOT EXISTS (SELECT 1 FROM rider_shifts rs WHERE rs.rider_id = r.id AND rs.day >= '${dayStr(dm)}')` : ""}
  )`;
}

async function saveTick(env, v) {
  try { await setSetting(env, "last_tick", JSON.stringify(v)); } catch (e) { console.error("saveTick failed", e && e.message ? e.message : e); }
}

async function tick(env) {
  const now = Date.now();
  const c = cfg(env);
  const tz = tzParts(now, c.TIMEZONE);
  const db = env.DB;
  const out = { sent: 0, failed: 0, skipped: null };

  // 1) housekeeping: "no response" + orders left open too long
  await db
    .prepare("UPDATE prompts SET status = 'missed' WHERE status = 'pending' AND sent_at <= ?")
    .bind(now - c.MISS_AFTER_MIN * MIN)
    .run();
  const simple = !c.ASK_STAGES;
  const staleBefore = simple ? now - c.ORDER_HOLD_MIN * MIN : now - c.STALE_HOURS * HOUR;
  await safeRun(
    db
      .prepare(
        `UPDATE riders SET idle_since = ? WHERE id IN
           (SELECT rider_id FROM orders WHERE status = 'active' AND updated_at <= ?)`
      )
      .bind(now, staleBefore)
  );
  await db
    .prepare(
      simple
        ? "UPDATE orders SET status = 'delivered', stage = 'delivered', delivered_at = updated_at, updated_at = ? WHERE status = 'active' AND updated_at <= ?"
        : "UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'active' AND updated_at <= ?"
    )
    .bind(now, staleBefore)
    .run();

  // purge data older than 90 days at 04:00
  if (tz.hour === 4 && tz.minute === 0) {
    const cut = now - 90 * DAY;
    await db.batch([
      db.prepare("DELETE FROM events WHERE at < ?").bind(cut),
      db.prepare("DELETE FROM prompts WHERE sent_at < ?").bind(cut),
      db.prepare("DELETE FROM orders WHERE status != 'active' AND updated_at < ?").bind(cut),
    ]);
    const oldDay = new Date(cut).toISOString().slice(0, 10);
    await safeRun(db.prepare("DELETE FROM attendance WHERE day < ?").bind(oldDay));
    await safeRun(db.prepare("DELETE FROM rider_shifts WHERE day < ?").bind(oldDay));
  }

  // shift reminders go first and ignore the working hours (a shift can start early)
  let shiftSent = 0;
  try {
    const r = await shiftTick(env, now, tz, c, Math.min(c.SHIFT_SENDS_PER_TICK, c.MAX_SENDS_PER_TICK));
    out.shift = r;
    shiftSent = r.sent + r.failed;
    try {
      const u = await supTick(env, now, tz, c, 5);
      out.sup = u;
      shiftSent += u.sent + u.failed;
    } catch (e) {
      console.error("supTick failed", e && e.message ? e.message : e);
    }
  } catch (e) {
    console.error("shiftTick failed", e && e.message ? e.message : e);
  }

  // 2) questions only reach a rider during HIS OWN shift. A rider who has not set any shift
  //    falls back to the general working hours.
  const globalOk = inWorkHours(tz.hour, c.WORK_START_HOUR, c.WORK_END_HOUR);
  const gate = await riderGate(db, now, tz, globalOk);

  // 3) who needs a question now?
  const cap = c.MAX_SENDS_PER_TICK - shiftSent;
  if (cap <= 0) return out;
  const jobs = [];

  const haveOrder = await db
    .prepare(
      `SELECT r.id AS rider_id, d.id AS device_id, d.push_subscription AS sub
       FROM riders r
       JOIN devices d ON d.id = (SELECT d2.id FROM devices d2 WHERE d2.rider_id = r.id
         AND d2.push_subscription IS NOT NULL ORDER BY d2.id DESC LIMIT 1)
       WHERE r.active = 1
         ${simple ? "" : "AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.rider_id = r.id AND o.status = 'active')"}
         ${gate}
         AND NOT EXISTS (SELECT 1 FROM prompts p WHERE p.rider_id = r.id AND p.status = 'pending')
         AND COALESCE((SELECT MAX(p.sent_at) FROM prompts p
               WHERE p.rider_id = r.id AND p.type = 'have_order'), 0) <= ?
       LIMIT ?`
    )
    .bind(now - c.ASK_EVERY_MIN * MIN, cap)
    .all();
  for (const r of haveOrder.results || []) jobs.push({ ...r, order_id: null, type: "have_order" });

  const stageQuery = (stages, promptType, baseCol) =>
    db.prepare(
      `SELECT o.id AS order_id, o.rider_id AS rider_id, d.id AS device_id, d.push_subscription AS sub
       FROM orders o
       JOIN riders r ON r.id = o.rider_id AND r.active = 1
       JOIN devices d ON d.id = ${LATEST_PUSH_DEVICE("o")}
       WHERE o.status = 'active' AND o.stage IN (${stages}) ${gate}
         AND NOT EXISTS (SELECT 1 FROM prompts p WHERE p.rider_id = o.rider_id AND p.status = 'pending')
         AND (SELECT COUNT(*) FROM prompts p WHERE p.order_id = o.id AND p.type = '${promptType}') < ?
         AND COALESCE((SELECT MAX(p.sent_at) + ? FROM prompts p
               WHERE p.order_id = o.id AND p.type = '${promptType}'), o.${baseCol} + ?) <= ?
       LIMIT ?`
    );

  if (!simple && jobs.length < cap) {
    const rows = await stageQuery("'declared','arrived'", "picked_up", "declared_at")
      .bind(c.MAX_ATTEMPTS, c.REPEAT_MIN * MIN, c.PICKUP_AFTER_MIN * MIN, now, cap - jobs.length)
      .all();
    for (const r of rows.results || []) jobs.push({ ...r, type: "picked_up" });
  }
  if (!simple && jobs.length < cap) {
    const rows = await stageQuery("'picked_up'", "delivered", "picked_at")
      .bind(c.MAX_ATTEMPTS, c.REPEAT_MIN * MIN, c.DELIVER_AFTER_MIN * MIN, now, cap - jobs.length)
      .all();
    for (const r of rows.results || []) jobs.push({ ...r, type: "delivered" });
  }

  if (!jobs.length) {
    if (!globalOk) out.skipped = "outside_work_hours";
    return out;
  }

  // 4) record the question first (the service worker will look it up), then push
  const inserted = await db.batch(
    jobs.map((j) =>
      db
        .prepare("INSERT INTO prompts (rider_id, order_id, type, sent_at, status) VALUES (?, ?, ?, ?, 'pending')")
        .bind(j.rider_id, j.order_id, j.type, now)
    )
  );
  jobs.forEach((j, i) => {
    j.prompt_id = inserted[i].meta.last_row_id;
  });

  const ttl = Math.max(60, c.MISS_AFTER_MIN * 60);
  const results = await Promise.all(
    jobs.map(async (j) => {
      let sub;
      try {
        sub = JSON.parse(j.sub);
      } catch {
        return 410;
      }
      return sendPush(sub, env, ttl);
    })
  );

  // 5) failed: delete the question so it is retried; expired subscription: switch it off
  const cleanup = [];
  const started = [];
  results.forEach((status, i) => {
    const j = jobs[i];
    if (status >= 200 && status < 300) {
      out.sent++;
      if (j.type === "have_order") started.push(j.rider_id);
      return;
    }
    out.failed++;
    cleanup.push(db.prepare("DELETE FROM prompts WHERE id = ?").bind(j.prompt_id));
    if (status === 404 || status === 410) {
      cleanup.push(db.prepare("UPDATE devices SET push_subscription = NULL WHERE id = ?").bind(j.device_id));
    }
  });
  if (cleanup.length) await db.batch(cleanup);
  // first question of the day marks the start of idleness for riders that never had one
  for (const id of started) {
    await safeRun(db.prepare("UPDATE riders SET idle_since = COALESCE(idle_since, ?) WHERE id = ?").bind(now, id));
  }
  return out;
}

async function adminDiagnose(env, now) {
  const c = cfg(env);
  const tz = tzParts(now, c.TIMEZONE);
  const db = env.DB;
  const one = async (q) => {
    try { return (await db.prepare(q).first()) || {}; } catch (e) { return { error: String(e.message || e) }; }
  };
  const lt = await one("SELECT value FROM settings WHERE key = 'last_tick'");
  let last = null;
  try { last = lt.value ? JSON.parse(lt.value) : null; } catch {}
  const globalOk = inWorkHours(tz.hour, c.WORK_START_HOUR, c.WORK_END_HOUR);
  const gateSql = await riderGate(db, now, tz, globalOk);
  const riders = await one("SELECT COUNT(*) AS n FROM riders WHERE active = 1");
  const withPush = await one("SELECT COUNT(DISTINCT rider_id) AS n FROM devices WHERE push_subscription IS NOT NULL");
  const eligible = await one(`SELECT COUNT(*) AS n FROM riders r WHERE r.active = 1 ${gateSql}`);
  const eligiblePush = await one(
    `SELECT COUNT(*) AS n FROM riders r WHERE r.active = 1 ${gateSql} AND EXISTS (SELECT 1 FROM devices d WHERE d.rider_id = r.id AND d.push_subscription IS NOT NULL)`
  );
  const lastPrompt = await one("SELECT MAX(sent_at) AS at FROM prompts");
  let settingsErr = null;
  try { await setSetting(env, "diag_probe", now); } catch (e) { settingsErr = String((e && e.message) || e); }
  const hasKeys = { vapid_public: !!env.VAPID_PUBLIC_KEY, vapid_private: !!env.VAPID_PRIVATE_KEY };
  const problems = [];
  if (settingsErr) problems.push("Cannot write to the settings table (online status and scheduler log need it): " + settingsErr);
  if (!hasKeys.vapid_private) problems.push("VAPID_PRIVATE_KEY secret is missing");
  if (!last) problems.push("The scheduler has not run yet (check Triggers -> Cron in Cloudflare)");
  else if (now - last.at > 5 * MIN) problems.push("The scheduler last ran more than 5 minutes ago");
  else if (last.ok === false) problems.push("Last run failed: " + last.error);
  if (!withPush.n) problems.push("No rider has enabled notifications on his phone");
  else if (!eligiblePush.n) problems.push("No rider with notifications is inside his shift / working hours right now");
  return {
    ok: true, now, timezone: c.TIMEZONE, local_time: String(tz.hour).padStart(2, "0") + ":" + String(tz.minute).padStart(2, "0"),
    work_hours: c.WORK_START_HOUR + "-" + c.WORK_END_HOUR, general_hours_open: globalOk,
    riders: riders.n, with_push: withPush.n, eligible_now: eligible.n, eligible_with_push: eligiblePush.n,
    last_prompt_at: lastPrompt.at || null, last_tick: last, keys: hasKeys, problems,
  };
}

async function adminTestPush(env, now) {
  const rows = await safeAll(env.DB.prepare(
    `SELECT d.rider_id AS rider_id, d.push_subscription AS sub, d.id AS id FROM devices d
     WHERE d.push_subscription IS NOT NULL AND d.id = (SELECT MAX(d2.id) FROM devices d2 WHERE d2.rider_id = d.rider_id AND d2.push_subscription IS NOT NULL) LIMIT 40`
  ));
  let sent = 0, failed = 0;
  const codes = {};
  await Promise.all(rows.map(async (r) => {
    let sub; try { sub = JSON.parse(r.sub); } catch { failed++; return; }
    const st = await sendPush(sub, env, 120);
    codes[st] = (codes[st] || 0) + 1;
    if (st >= 200 && st < 300) sent++; else { failed++; if (st === 404 || st === 410) await safeRun(env.DB.prepare("UPDATE devices SET push_subscription = NULL WHERE id = ?").bind(r.id)); }
  }));
  return { ok: true, total: rows.length, sent, failed, codes };
}

async function adminSetRiderSup(env, body) {
  const rid = String((body && body.rider_id) || "").trim();
  if (!rid) return fail("bad_request", "rider_id required", 400);
  const sid = body && body.sup_id ? Number(body.sup_id) : 0;
  if (sid) await setSetting(env, "rsup:" + rid, sid);
  else await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind("rsup:" + rid).run();
  return json({ ok: true });
}

/* ---------------------------- Admin ---------------------------- */
async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return null; // null = key not configured
  const given = request.headers.get("X-Admin-Key") || "";
  const [a, b] = await Promise.all([sha256(given), sha256(String(env.ADMIN_KEY))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const byKey = (rows, key = "rider_id") => {
  const m = new Map();
  for (const r of (rows && rows.results) || []) m.set(r[key], r);
  return m;
};

// upsert that does not depend on a UNIQUE constraint existing on settings.key
async function setSetting(env, key, value) {
  let u;
  try {
    u = await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(String(value), key).run();
  } catch {
    // the table may be missing if an old migration was not fully applied
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)").run();
    u = await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(String(value), key).run();
  }
  const ch = u && u.meta ? u.meta.changes : 0;
  if (!ch) await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(key, String(value)).run();
}

async function safeAll(stmt) {
  try {
    const r = await stmt.all();
    return (r && r.results) || [];
  } catch {
    return [];
  }
}

async function adminOverview(env, now) {
  const c = cfg(env);
  const tz = tzParts(now, c.TIMEZONE);
  const db = env.DB;

  let ridersQuery;
  try {
    ridersQuery = await db.prepare("SELECT id, name, idle_since FROM riders WHERE active = 1 ORDER BY id").all();
  } catch {
    ridersQuery = await db.prepare("SELECT id, name FROM riders WHERE active = 1 ORDER BY id").all();
  }

  const [orders, opens, locs, pushes, delivered, missed, events] = await Promise.all([
    db.prepare(`SELECT id, rider_id, stage, declared_at, arrived_at, picked_at FROM orders WHERE status = 'active'`).all(),
    db
      .prepare(
        `SELECT rider_id, type, status, sent_at FROM prompts
         WHERE answered_at IS NULL AND sent_at >= ? ORDER BY sent_at ASC`
      )
      .bind(now - 2 * HOUR)
      .all(),
    db.prepare("SELECT rider_id, lat, lng, accuracy, updated_at FROM locations").all(),
    db.prepare("SELECT DISTINCT rider_id FROM devices WHERE push_subscription IS NOT NULL").all(),
    db
      .prepare(
        `SELECT rider_id, COUNT(*) AS n FROM orders
         WHERE status = 'delivered' AND updated_at >= ? GROUP BY rider_id`
      )
      .bind(tz.dayStart)
      .all(),
    db
      .prepare(
        `SELECT rider_id, COUNT(*) AS n FROM prompts
         WHERE status = 'missed' AND sent_at >= ? GROUP BY rider_id`
      )
      .bind(tz.dayStart)
      .all(),
    db
      .prepare(
        `SELECT e.id, e.rider_id, r.name, e.type, e.lat, e.lng, e.at
         FROM events e LEFT JOIN riders r ON r.id = e.rider_id
         ORDER BY e.id DESC LIMIT 30`
      )
      .all(),
  ]);

  const seenRows = await safeAll(db.prepare("SELECT key, value FROM settings WHERE key LIKE 'seen:%'"));
  const seenMap = new Map(seenRows.map((x) => [x.key.slice(5), Number(x.value)]));
  const c2 = cfg(env);
  const gateSql = await riderGate(db, now, tz, false);
  const shiftNow = new Set((await safeAll(db.prepare(`SELECT r.id AS id FROM riders r WHERE r.active = 1 ${gateSql}`))).map((x) => x.id));
  const orderMap = byKey(orders);
  const locMap = byKey(locs);
  const pushSet = new Set(((pushes && pushes.results) || []).map((r) => r.rider_id));
  const deliveredMap = byKey(delivered);
  const missedMap = byKey(missed);
  const openMap = new Map(); // latest open question per rider (ascending order: last wins)
  for (const p of (opens && opens.results) || []) openMap.set(p.rider_id, p);

  const list = ((ridersQuery && ridersQuery.results) || []).map((r) => {
    const o = orderMap.get(r.id) || null;
    const l = locMap.get(r.id) || null;
    const p = openMap.get(r.id) || null;
    return {
      id: r.id,
      name: r.name,
      state: o ? o.stage : "idle",
      order: o ? { declared_at: o.declared_at, arrived_at: o.arrived_at, picked_at: o.picked_at } : null,
      idle_since: o ? null : r.idle_since || null,
      loc: l ? { lat: l.lat, lng: l.lng, at: l.updated_at, accuracy: l.accuracy } : null,
      prompt: p ? { type: p.type, status: p.status, sent_at: p.sent_at } : null,
      late: !!(p && p.status === "missed"),
      push: pushSet.has(r.id),
      seen_at: seenMap.get(r.id) || null,
      online: !!(seenMap.get(r.id) && now - seenMap.get(r.id) <= 3 * MIN),
      scheduled: shiftNow.has(r.id),
      delivered_today: deliveredMap.has(r.id) ? deliveredMap.get(r.id).n : 0,
      missed_today: missedMap.has(r.id) ? missedMap.get(r.id).n : 0,
    };
  });

  const idleRiders = list.filter((r) => r.state === "idle");
  const idleDurations = idleRiders.filter((r) => r.idle_since).map((r) => Math.max(0, now - r.idle_since));
  const stats = {
    total: list.length,
    with_order: list.filter((r) => r.state !== "idle").length,
    idle: idleRiders.length,
    delivered_today: list.reduce((s, r) => s + r.delivered_today, 0),
    late: list.filter((r) => r.late).length,
    push_off: list.filter((r) => !r.push).length,
    online: list.filter((r) => r.online).length,
    scheduled: list.filter((r) => r.scheduled).length,
    sched_offline: list.filter((r) => r.scheduled && !r.online).length,
    longest_idle_ms: idleDurations.length ? Math.max(...idleDurations) : 0,
    avg_idle_ms: idleDurations.length ? Math.round(idleDurations.reduce((a, b) => a + b, 0) / idleDurations.length) : 0,
  };

  return { ok: true, now, stats, riders: list, events: (events && events.results) || [] };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

async function adminReport(env, range, now) {
  const c = cfg(env);
  const tz = tzParts(now, c.TIMEZONE);
  const db = env.DB;

  let from, to, work;
  const perDay = workMinutesPerDay(c);
  const today = workElapsedToday(tz, c);
  if (range === "yesterday") {
    from = tz.dayStart - DAY;
    to = tz.dayStart;
    work = perDay;
  } else if (range === "7d") {
    from = tz.dayStart - 6 * DAY;
    to = now + 1;
    work = 6 * perDay + today;
  } else if (range === "30d") {
    from = tz.dayStart - 29 * DAY;
    to = now + 1;
    work = 29 * perDay + today;
  } else {
    range = "today";
    from = tz.dayStart;
    to = now + 1;
    work = today;
  }

  const orderAggs = `
    COUNT(*) AS declared,
    SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
    SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
    SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
    AVG(CASE WHEN status = 'delivered' THEN delivered_at - declared_at END) AS avg_total_ms,
    AVG(CASE WHEN picked_at IS NOT NULL THEN picked_at - declared_at END) AS avg_pickup_ms,
    AVG(CASE WHEN arrived_at IS NOT NULL AND picked_at IS NOT NULL THEN picked_at - arrived_at END) AS avg_wait_ms,
    AVG(CASE WHEN status = 'delivered' AND picked_at IS NOT NULL THEN delivered_at - picked_at END) AS avg_delivery_ms,
    SUM(CASE WHEN status = 'delivered' THEN MIN(delivered_at - declared_at, 14400000) ELSE 0 END) AS busy_ms`;
  const promptAggs = `
    COUNT(*) AS sent,
    SUM(CASE WHEN status = 'answered' THEN 1 ELSE 0 END) AS answered,
    SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late,
    SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) AS missed,
    AVG(CASE WHEN answered_at IS NOT NULL THEN answered_at - sent_at END) AS avg_response_ms`;

  const [riders, perRiderOrders, totalOrders, perRiderPrompts, totalPrompts, byHour, byDay, recent] =
    await Promise.all([
      db.prepare("SELECT id, name FROM riders ORDER BY id").all(),
      db
        .prepare(`SELECT rider_id, ${orderAggs} FROM orders WHERE declared_at >= ? AND declared_at < ? GROUP BY rider_id`)
        .bind(from, to)
        .all(),
      db.prepare(`SELECT ${orderAggs} FROM orders WHERE declared_at >= ? AND declared_at < ?`).bind(from, to).first(),
      db
        .prepare(`SELECT rider_id, ${promptAggs} FROM prompts WHERE sent_at >= ? AND sent_at < ? GROUP BY rider_id`)
        .bind(from, to)
        .all(),
      db.prepare(`SELECT ${promptAggs} FROM prompts WHERE sent_at >= ? AND sent_at < ?`).bind(from, to).first(),
      db
        .prepare(
          `SELECT CAST((declared_at + ?) / 3600000 AS INTEGER) % 24 AS h, COUNT(*) AS n
           FROM orders WHERE declared_at >= ? AND declared_at < ? GROUP BY h`
        )
        .bind(tz.offset, from, to)
        .all(),
      db
        .prepare(
          `SELECT CAST((declared_at + ?) / 86400000 AS INTEGER) AS d, COUNT(*) AS total,
             SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered
           FROM orders WHERE declared_at >= ? AND declared_at < ? GROUP BY d ORDER BY d`
        )
        .bind(tz.offset, from, to)
        .all(),
      db
        .prepare(
          `SELECT o.id, o.rider_id, r.name, o.status, o.declared_at, o.arrived_at, o.picked_at, o.delivered_at
           FROM orders o LEFT JOIN riders r ON r.id = o.rider_id
           WHERE o.declared_at >= ? AND o.declared_at < ? ORDER BY o.declared_at DESC LIMIT 200`
        )
        .bind(from, to)
        .all(),
    ]);

  const oMap = byKey(perRiderOrders);
  const pMap = byKey(perRiderPrompts);
  const workMs = work * MIN;

  const rows = ((riders && riders.results) || []).map((r) => {
    const o = oMap.get(r.id) || {};
    const p = pMap.get(r.id) || {};
    const answeredAll = (p.answered || 0) + (p.late || 0);
    const asked = answeredAll + (p.missed || 0);
    const busy = o.busy_ms || 0;
    return {
      id: r.id,
      name: r.name,
      declared: o.declared || 0,
      delivered: o.delivered || 0,
      cancelled: o.cancelled || 0,
      expired: o.expired || 0,
      avg_total_ms: num(o.avg_total_ms),
      avg_pickup_ms: num(o.avg_pickup_ms),
      avg_wait_ms: num(o.avg_wait_ms),
      avg_delivery_ms: num(o.avg_delivery_ms),
      busy_ms: busy,
      utilization: workMs > 0 ? Math.min(1, busy / workMs) : 0,
      sent: p.sent || 0,
      answered: p.answered || 0,
      late: p.late || 0,
      missed: p.missed || 0,
      response_rate: asked ? answeredAll / asked : null,
      avg_response_ms: num(p.avg_response_ms),
    };
  });

  const t = totalOrders || {};
  const q = totalPrompts || {};
  const qAnswered = (q.answered || 0) + (q.late || 0);
  const qAsked = qAnswered + (q.missed || 0);
  const busyTotal = rows.reduce((s, r) => s + r.busy_ms, 0);
  const staff = rows.filter((r) => r.declared || r.sent).length;
  const hours = Array(24).fill(0);
  for (const r of (byHour && byHour.results) || []) hours[r.h] = r.n;

  return {
    ok: true,
    range,
    from,
    to,
    now,
    work_minutes: work,
    totals: {
      declared: t.declared || 0,
      delivered: t.delivered || 0,
      cancelled: t.cancelled || 0,
      expired: t.expired || 0,
      active: t.active || 0,
      avg_total_ms: num(t.avg_total_ms),
      avg_pickup_ms: num(t.avg_pickup_ms),
      avg_wait_ms: num(t.avg_wait_ms),
      avg_delivery_ms: num(t.avg_delivery_ms),
      prompts_sent: q.sent || 0,
      prompts_missed: q.missed || 0,
      response_rate: qAsked ? qAnswered / qAsked : null,
      avg_response_ms: num(q.avg_response_ms),
      riders_working: staff,
      utilization: staff && workMs > 0 ? Math.min(1, busyTotal / (workMs * staff)) : 0,
    },
    by_hour: hours,
    by_day: ((byDay && byDay.results) || []).map((r) => ({
      date: new Date(r.d * DAY).toISOString().slice(0, 10),
      total: r.total,
      delivered: r.delivered,
    })),
    riders: rows,
    orders: (recent && recent.results) || [],
  };
}

async function adminListRiders(env) {
  const [riders, pushes] = await Promise.all([
    env.DB.prepare("SELECT id, name, active FROM riders ORDER BY active DESC, id").all(),
    env.DB.prepare("SELECT DISTINCT rider_id FROM devices WHERE push_subscription IS NOT NULL").all(),
  ]);
  const pushSet = new Set(((pushes && pushes.results) || []).map((r) => r.rider_id));
  return {
    ok: true,
    riders: ((riders && riders.results) || []).map((r) => ({
      id: r.id,
      name: r.name,
      active: !!r.active,
      push: pushSet.has(r.id),
    })),
  };
}

async function adminAddRiders(env, body, now) {
  const input = Array.isArray(body && body.riders) ? body.riders.slice(0, 500) : [];
  const stmts = [];
  let invalid = 0;
  for (const r of input) {
    const id = String((r && r.id) || "").trim();
    const name = String((r && r.name) || "").trim().slice(0, 60);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      invalid++;
      continue;
    }
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO riders (id, name) VALUES (?, ?)").bind(id, name || id));
  }
  let added = 0;
  if (stmts.length) {
    const res = await env.DB.batch(stmts);
    added = res.reduce((s, x) => s + ((x.meta && x.meta.changes) || 0), 0);
    if (added) {
      await safeRun(
        env.DB.prepare("UPDATE riders SET idle_since = ? WHERE idle_since IS NULL").bind(now)
      );
    }
  }
  return { ok: true, added, existing: stmts.length - added, invalid };
}


/* ---------------------------- Performance module ---------------------------- */
const DEFAULT_TIPS = {
  en: {
    title: "How to improve your Segment",
    intro: "To improve your performance and raise your Segment, focus on these 3 metrics:",
    note: "Most riders struggle with On-Time, and everyone must improve it.",
    howto: "How to improve On-Time",
    steps: [
      ["At the restaurant", [
        "When you arrive at the restaurant, open the in-app chat between you and the customer and send:",
        "> Hello sir, I'm at the restaurant and the order is not ready",
        "Even if the order is ready, you must tell the customer it is not ready.",
      ]],
      ["After picking up the order", [
        "Take a photo of the order and send it to the customer.",
        "Take a screenshot of the distance between you and the customer and send it to them.",
        "If you face any traffic on the way, quickly take a photo and send it to the customer.",
        "If traffic happens repeatedly, take a photo and send it every time.",
      ]],
      ["When you reach the customer", [
        "In the chat, send the customer: I'm here",
        "Send a photo of the building.",
        "Call the customer.",
      ]],
    ],
    avoid_title: "Avoid this",
    avoid: "Talking to the customer on WhatsApp is strictly forbidden.",
    closing: "Follow the instructions above to improve your performance and your salary.",
    img: "Example of the messages to send in the chat",
  },
  ar: {
    title: "كيف ترفع الـ Segment الخاص بك",
    intro: "لتحسين أدائك ورفع الـ Segment لازم تركز على 3 نقاط:",
    note: "أغلب المناديب بيواجهوا مشكلة في الأون تايم، ولازم الجميع يحسّنه.",
    howto: "كيفية تحسين الأون تايم",
    steps: [
      ["عند الوصول للمطعم", [
        "عند وصولك إلى المطعم افتح الشات الموجود في التطبيق بينك وبين العميل وأرسل له:",
        "> هالو سير، أنا في المطعم والطلب غير جاهز",
        "حتى لو الأوردر جاهز، يجب أن ترسل له أنه غير جاهز.",
      ]],
      ["بعد استلام الطلب", [
        "التقط صورة للأوردر وأرسلها للعميل.",
        "التقط لقطة شاشة للمسافة بينك وبين العميل وأرسلها له.",
        "إذا واجهت أي ازدحام في الطريق، التقط صورة بسرعة وأرسلها للعميل.",
        "وإذا تكرر الازدحام، التقط صورة وأرسلها في كل مرة.",
      ]],
      ["عند الوصول للعميل", [
        "أرسل له في الشات: أنا هنا",
        "أرسل له صورة المبنى.",
        "واتصل به اتصالًا.",
      ]],
    ],
    avoid_title: "تجنب هذا",
    avoid: "يمنع منعًا باتًا التحدث مع العميل على واتساب.",
    closing: "اتبع التعليمات السابقة لتحسين أدائك وتحسين راتبك.",
    img: "مثال على الرسائل التي ترسلها في الشات",
  },
  ur: {
    title: "اپنا سیگمنٹ کیسے بہتر کریں",
    intro: "اپنی کارکردگی بہتر بنانے اور سیگمنٹ بڑھانے کے لیے ان 3 نکات پر توجہ دیں:",
    note: "اکثر رائیڈرز کو بروقت ڈیلیوری میں مسئلہ ہوتا ہے، اور سب کو اسے بہتر کرنا ہوگا۔",
    howto: "بروقت ڈیلیوری کیسے بہتر کریں",
    steps: [
      ["ریسٹورنٹ پہنچنے پر", [
        "ریسٹورنٹ پہنچتے ہی ایپ میں اپنے اور کسٹمر کے درمیان چیٹ کھولیں اور بھیجیں:",
        "> ہیلو سر، میں ریسٹورنٹ میں ہوں اور آرڈر تیار نہیں ہے",
        "چاہے آرڈر تیار ہو، پھر بھی کسٹمر کو بتانا ضروری ہے کہ آرڈر تیار نہیں ہے۔",
      ]],
      ["آرڈر لینے کے بعد", [
        "آرڈر کی تصویر لے کر کسٹمر کو بھیجیں۔",
        "اپنے اور کسٹمر کے درمیان فاصلے کا اسکرین شاٹ لے کر انہیں بھیجیں۔",
        "اگر راستے میں ٹریفک ہو تو فوراً تصویر لے کر کسٹمر کو بھیجیں۔",
        "اگر بار بار ٹریفک ہو تو ہر بار تصویر لے کر بھیجیں۔",
      ]],
      ["کسٹمر کے پاس پہنچ کر", [
        "چیٹ میں کسٹمر کو لکھیں: میں یہاں ہوں",
        "عمارت کی تصویر بھیجیں۔",
        "اور کسٹمر کو کال کریں۔",
      ]],
    ],
    avoid_title: "اس سے بچیں",
    avoid: "کسٹمر سے واٹس ایپ پر بات کرنا سختی سے منع ہے۔",
    closing: "اپنی کارکردگی اور تنخواہ بہتر بنانے کے لیے اوپر دی گئی ہدایات پر عمل کریں۔",
    img: "چیٹ میں بھیجے جانے والے پیغامات کی مثال",
  },
  bn: {
    title: "আপনার সেগমেন্ট কীভাবে উন্নত করবেন",
    intro: "পারফরম্যান্স ভালো করতে এবং সেগমেন্ট বাড়াতে এই ৩টি বিষয়ে মনোযোগ দিন:",
    note: "বেশিরভাগ রাইডারের সময়মতো ডেলিভারিতে সমস্যা হয়, এবং সবাইকে এটি উন্নত করতে হবে।",
    howto: "সময়মতো ডেলিভারি কীভাবে উন্নত করবেন",
    steps: [
      ["রেস্টুরেন্টে পৌঁছে", [
        "রেস্টুরেন্টে পৌঁছে অ্যাপে আপনার ও কাস্টমারের চ্যাট খুলুন এবং পাঠান:",
        "> হ্যালো স্যার, আমি রেস্টুরেন্টে আছি এবং অর্ডার এখনো প্রস্তুত নয়",
        "অর্ডার প্রস্তুত থাকলেও কাস্টমারকে জানাতে হবে যে এটি প্রস্তুত নয়।",
      ]],
      ["অর্ডার নেওয়ার পর", [
        "অর্ডারের ছবি তুলে কাস্টমারকে পাঠান।",
        "আপনার ও কাস্টমারের মধ্যে দূরত্বের স্ক্রিনশট নিয়ে তাকে পাঠান।",
        "রাস্তায় যানজট হলে দ্রুত একটি ছবি তুলে কাস্টমারকে পাঠান।",
        "বারবার যানজট হলে প্রতিবার ছবি তুলে পাঠান।",
      ]],
      ["কাস্টমারের কাছে পৌঁছে", [
        "চ্যাটে কাস্টমারকে লিখুন: আমি এখানে আছি",
        "ভবনের ছবি পাঠান।",
        "এবং কাস্টমারকে ফোন করুন।",
      ]],
    ],
    avoid_title: "এটি এড়িয়ে চলুন",
    avoid: "কাস্টমারের সাথে হোয়াটসঅ্যাপে কথা বলা কঠোরভাবে নিষিদ্ধ।",
    closing: "পারফরম্যান্স ও বেতন উন্নত করতে উপরের নির্দেশনাগুলো অনুসরণ করুন।",
    img: "চ্যাটে পাঠানোর মেসেজের উদাহরণ",
  },
};

const TIP_TEXT_KEYS = ["title", "intro", "note", "howto", "avoid_title", "avoid", "closing", "img"];

// accept only a well-formed tips object (this is edited from the admin page)
function cleanTip(t) {
  if (!t || typeof t !== "object") return null;
  const out = {};
  for (const k of TIP_TEXT_KEYS) out[k] = String(t[k] ?? "").slice(0, 600);
  const steps = Array.isArray(t.steps) ? t.steps.slice(0, 12) : [];
  out.steps = steps
    .map((st) => {
      if (!Array.isArray(st) || st.length < 2) return null;
      const lines = (Array.isArray(st[1]) ? st[1] : []).slice(0, 20).map((l) => String(l).slice(0, 400)).filter((l) => l.trim());
      return [String(st[0] ?? "").slice(0, 200), lines];
    })
    .filter((st) => st && (st[0].trim() || st[1].length));
  return out;
}

async function getAllTips(env) {
  const tips = JSON.parse(JSON.stringify(DEFAULT_TIPS));
  const custom = {};
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'tips_%' AND key <> 'tips_image'").all();
    for (const r of (rows && rows.results) || []) {
      const l = r.key.slice(5);
      if (!LANGS.includes(l)) continue;
      try {
        const t = cleanTip(JSON.parse(r.value));
        if (t) { tips[l] = t; custom[l] = true; }
      } catch { /* keep default */ }
    }
  } catch { /* settings table missing */ }
  return { tips, custom };
}

async function hasTipsImage(env) {
  try {
    const r = await env.DB.prepare("SELECT length(value) AS n FROM settings WHERE key = 'tips_image'").first();
    return !!(r && r.n);
  } catch { return false; }
}

const PERF_INT = ["orders", "orders_in_time", "late_orders", "failed_orders"];
const PERF_PCT = ["chat_rate", "acceptance_rate", "verification_rate", "on_time_rate", "fail_rate", "final_score"];
const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function adminPerfUpload(env, body, now) {
  const rows = Array.isArray(body && body.rows) ? body.rows.slice(0, 150) : [];
  const tpd = Math.max(0, Math.min(1000, Math.round(toNum(body && body.target_per_day))));
  const days = Math.max(0, Math.min(31, Math.round(toNum(body && body.days_covered))));
  const pre = [];
  if (body && body.first) {
    // keep the last segment/indicators of each rider, then replace everything
    pre.push(env.DB.prepare("DELETE FROM perf_prev"));
    pre.push(env.DB.prepare(
      `INSERT OR REPLACE INTO perf_prev (rider_id, segment, on_time, verification, fail, final)
       SELECT rider_id, segment, on_time_rate, verification_rate, fail_rate, final_score FROM performance`));
    pre.push(env.DB.prepare("DELETE FROM performance"));
  }
  const stmts = [];
  let skipped = 0;
  for (const r of rows) {
    const id = String((r && r.rider_id) ?? "").trim().replace(/\.0$/, "");
    if (!id || id.toLowerCase() === "nan" || id.length > 40) { skipped++; continue; }
    const v = [id, String(r.rider_name ?? "").trim().slice(0, 80)];
    for (const k of PERF_INT) v.push(Math.max(0, Math.round(toNum(r[k]))));
    for (const k of PERF_PCT) v.push(toNum(r[k]));
    v.push(String(r.segment ?? "—").trim().slice(0, 12) || "—");
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO performance
         (rider_id, rider_name, orders, orders_in_time, late_orders, failed_orders,
          chat_rate, acceptance_rate, verification_rate, on_time_rate, fail_rate, final_score, segment,
          prev_segment, prev_on_time, prev_verification, prev_fail, prev_final,
          target_per_day, days_covered, uploaded_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,
           (SELECT segment FROM perf_prev WHERE rider_id = ?1), (SELECT on_time FROM perf_prev WHERE rider_id = ?1),
           (SELECT verification FROM perf_prev WHERE rider_id = ?1), (SELECT fail FROM perf_prev WHERE rider_id = ?1),
           (SELECT final FROM perf_prev WHERE rider_id = ?1), ?14, ?15, ?16)`
      ).bind(...v, tpd, days, now)
    );
  }
  const all = [...pre, ...stmts];
  if (all.length) await env.DB.batch(all);
  return { ok: true, inserted: stmts.length, skipped };
}

async function adminPerfList(env) {
  const res = await env.DB.prepare("SELECT * FROM performance ORDER BY segment, rider_id").all();
  const rows = (res && res.results) || [];
  return {
    ok: true,
    rows,
    meta: rows.length
      ? { count: rows.length, uploaded_at: rows[0].uploaded_at, target_per_day: rows[0].target_per_day, days_covered: rows[0].days_covered }
      : { count: 0 },
  };
}

/* ---------------------------- Shifts, supervisors, attendance ---------------------------- */
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (m) => pad2(Math.floor(m / 60) % 24) + ":" + pad2(m % 60);
function parseHHMM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h > 23 || mi > 59 ? null : h * 60 + mi;
}

// the real start/end of a shift for yesterday, today and tomorrow (night shifts cross midnight)
function occurrences(now, tzp, s) {
  const len = (((s.end_min - s.start_min) % 1440) + 1440) % 1440 || 1440;
  return [-1, 0, 1].map((off) => {
    const base = tzp.dayStart + off * DAY;
    const startAt = base + s.start_min * MIN;
    return { day: new Date(base + tzp.offset).toISOString().slice(0, 10), startAt, endAt: startAt + len * MIN };
  });
}

// the occurrence that matters now: running, about to start (inside viewLead), or the next one
function pickOcc(now, tzp, s, viewLead) {
  const occ = occurrences(now, tzp, s);
  const cur = occ
    .filter((o) => now >= o.startAt - viewLead && now < o.endAt)
    .sort((a, b) => b.startAt - a.startAt)[0];
  if (cur) return { ...cur, phase: now < cur.startAt ? "before" : "running" };
  const next = occ.filter((o) => o.startAt > now).sort((a, b) => a.startAt - b.startAt)[0];
  return next ? { ...next, phase: "upcoming" } : null;
}

const DEFAULT_SHIFTS = [
  ["Shift 1", "07:00", "11:00"], ["Shift 2", "11:00", "15:00"], ["Shift 3", "15:00", "19:00"],
  ["Shift 4", "19:00", "23:00"], ["Shift 5", "23:00", "03:00"], ["Shift 6", "03:00", "07:00"],
];

async function seedShifts(env) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM shifts").first();
  if (n && n.n > 0) return;
  await env.DB.batch(
    DEFAULT_SHIFTS.map((x, i) =>
      env.DB.prepare("INSERT INTO shifts (name, start_min, end_min, sort) VALUES (?, ?, ?, ?)")
        .bind(x[0], parseHHMM(x[1]), parseHHMM(x[2]), i)
    )
  );
}

const PRESENT_SQL = "(a.sup_status = 'present' OR (a.sup_status IS NULL AND a.rider_at IS NOT NULL))";

const dayKey = (ms, tzp) => new Date(ms + tzp.offset).toISOString().slice(0, 10);
const dayStartMs = (day, tzp) => Date.parse(day + "T00:00:00Z") - tzp.offset;
const slotLen = (s) => ((((s.end_min - s.start_min) % 1440) + 1440) % 1440) || 1440;

async function activeBands(env) {
  const r = await env.DB.prepare("SELECT id, name, start_min, end_min FROM shifts WHERE active = 1 ORDER BY start_min, id").all();
  return (r && r.results) || [];
}
// the supervision window ("shift" in the admin) that contains a rider's shift start
function bandFor(bands, startMin) {
  for (const b of bands) if (((startMin - b.start_min + 1440) % 1440) < slotLen(b)) return b;
  return null;
}

// Riders of one supervision window for one day: everyone whose own shift starts inside it
const forSup = (riders, supId) => riders.filter((r) => !r.sup_override || r.sup_override === supId);

async function riderSupMap(env) {
  const rows = await safeAll(env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'rsup:%'"));
  return new Map(rows.map((x) => [x.key.slice(5), Number(x.value)]));
}

async function shiftRiders(env, band, occ, tzp) {
  const ov = await riderSupMap(env);
  const d0 = dayStartMs(occ.day, tzp);
  const days = [occ.day, dayKey(d0 + DAY, tzp)];
  const res = await env.DB
    .prepare(
      `SELECT r.id, r.name, rs.day, rs.start_min, rs.end_min, a.rider_at, a.sup_status, a.nags,
         (SELECT COUNT(*) FROM devices d WHERE d.rider_id = r.id) AS devices,
         (SELECT COUNT(*) FROM devices d WHERE d.rider_id = r.id AND d.push_subscription IS NOT NULL) AS pushes
       FROM rider_shifts rs
       JOIN riders r ON r.id = rs.rider_id AND r.active = 1
       LEFT JOIN attendance a ON a.day = rs.day AND a.rider_id = rs.rider_id AND a.start_min = rs.start_min
       WHERE rs.day IN (?1, ?2) ORDER BY rs.start_min, r.name, r.id LIMIT 900`
    )
    .bind(days[0], days[1])
    .all();
  const out = [];
  for (const r of (res && res.results) || []) {
    const startAt = dayStartMs(r.day, tzp) + r.start_min * MIN;
    if (!(startAt >= occ.startAt && startAt < occ.endAt)) continue;
    out.push({
      id: r.id,
      name: r.name,
      sup_override: ov.get(r.id) || null,
      day: r.day,
      slot: r.start_min,
      start: hhmm(r.start_min),
      end: hhmm(r.end_min),
      startAt,
      status: r.sup_status || (r.rider_at ? "present" : "pending"),
      by: r.sup_status ? "supervisor" : r.rider_at ? "rider" : null,
      rider_at: r.rider_at || null,
      late_min: r.rider_at ? Math.max(0, Math.floor((r.rider_at - startAt) / MIN)) : 0,
      nags: r.nags || 0,
      app: r.devices > 0,
      push: r.pushes > 0,
    });
  }
  return out;
}

function shiftCounts(riders, grace) {
  const c = { total: riders.length, present: 0, absent: 0, pending: 0, late: 0 };
  for (const r of riders) {
    c[r.status]++;
    if (r.status === "present" && r.late_min >= grace) c.late++;
  }
  return c;
}

async function shiftConfirms(env, shiftId, day) {
  const res = await env.DB
    .prepare(
      `SELECT sc.sup_id, su.name, sc.at, sc.present, sc.absent FROM shift_confirm sc
       JOIN supervisors su ON su.id = sc.sup_id WHERE sc.day = ? AND sc.shift_id = ?`
    )
    .bind(day, shiftId)
    .all();
  return (res && res.results) || [];
}

/* ---- the rider's own schedule: up to 3 shifts per day ---- */
const HHMM_RE = /^\d{1,2}:\d{2}$/;

function slotsOverlap(a, b) {
  return ((b.s - a.s + 1440) % 1440) < a.len || ((a.s - b.s + 1440) % 1440) < b.len;
}

async function riderSchedule(env, device, now, c) {
  const tzp = tzParts(now, c.TIMEZONE);
  const days = Array.from({ length: 7 }, (_, i) => dayKey(tzp.dayStart + i * DAY, tzp));
  const res = await env.DB
    .prepare("SELECT day, start_min, end_min FROM rider_shifts WHERE rider_id = ? AND day >= ? AND day <= ? ORDER BY day, start_min")
    .bind(device.rider_id, days[0], days[6])
    .all();
  const rows = (res && res.results) || [];
  return json({
    ok: true,
    today: days[0],
    days: days.map((d) => ({ day: d, slots: rows.filter((r) => r.day === d).map((r) => ({ start: hhmm(r.start_min), end: hhmm(r.end_min) })) })),
  });
}

async function riderSaveSchedule(env, device, body, now, c) {
  const tzp = tzParts(now, c.TIMEZONE);
  const today = dayKey(tzp.dayStart, tzp);
  const day = String((body && body.day) || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < today || day > dayKey(tzp.dayStart + 30 * DAY, tzp)) {
    return fail("bad_day", "Invalid day", 400);
  }
  const input = Array.isArray(body.slots) ? body.slots : [];
  if (input.length > 3) return fail("bad_slots", "Maximum 3 shifts a day", 400);
  const slots = [];
  for (const x of input) {
    const a = String((x && x.start) || "").trim(), z = String((x && x.end) || "").trim();
    if (!a && !z) continue; // empty row
    const s = HHMM_RE.test(a) ? parseHHMM(a) : null, e = HHMM_RE.test(z) ? parseHHMM(z) : null;
    if (s === null || e === null || s === e) return fail("bad_slots", "Invalid times", 400);
    slots.push({ s, e, len: slotLen({ start_min: s, end_min: e }) });
  }
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      if (slotsOverlap(slots[i], slots[j]) || slots[i].s === slots[j].s) return fail("bad_slots", "Shifts overlap", 400);
    }
  }
  const d0 = Date.parse(day + "T00:00:00Z");
  const days = body.scope === "week" ? Array.from({ length: 7 }, (_, i) => new Date(d0 + i * DAY).toISOString().slice(0, 10)) : [day];
  const stmts = [];
  for (const d of days) {
    stmts.push(env.DB.prepare("DELETE FROM rider_shifts WHERE rider_id = ? AND day = ?").bind(device.rider_id, d));
    for (const sl of slots) {
      stmts.push(env.DB.prepare("INSERT INTO rider_shifts (rider_id, day, start_min, end_min) VALUES (?, ?, ?, ?)").bind(device.rider_id, d, sl.s, sl.e));
    }
  }
  await env.DB.batch(stmts);
  return json({ ok: true, days: days.length });
}

// The rider's current or next shift (null when he has not set any)
async function riderShift(env, riderId, now, c) {
  try {
    const tzp = tzParts(now, c.TIMEZONE);
    const keys = [-1, 0, 1].map((o) => dayKey(tzp.dayStart + o * DAY, tzp));
    const res = await env.DB
      .prepare("SELECT day, start_min, end_min FROM rider_shifts WHERE rider_id = ? AND day IN (?, ?, ?)")
      .bind(riderId, ...keys)
      .all();
    const slots = ((res && res.results) || []).map((r) => {
      const startAt = dayStartMs(r.day, tzp) + r.start_min * MIN;
      return { ...r, startAt, endAt: startAt + slotLen(r) * MIN };
    });
    const open = c.SHIFT_OPEN_MIN * MIN;
    let o = slots.filter((x) => now >= x.startAt - open && now < x.endAt).sort((a, b) => b.startAt - a.startAt)[0];
    let phase = o ? (now < o.startAt ? "before" : "running") : "upcoming";
    if (!o) o = slots.filter((x) => x.startAt > now).sort((a, b) => a.startAt - b.startAt)[0];
    if (!o) return null;
    const a = await env.DB
      .prepare("SELECT rider_at, sup_status FROM attendance WHERE day = ? AND rider_id = ? AND start_min = ?")
      .bind(o.day, riderId, o.start_min)
      .first();
    const band = bandFor(await activeBands(env), o.start_min);
    let sups = [];
    if (band) {
      const sr = await env.DB
        .prepare(
          `SELECT su.name FROM shift_sups ss JOIN supervisors su ON su.id = ss.sup_id AND su.active = 1
           WHERE ss.shift_id = ? ORDER BY su.name`
        )
        .bind(band.id)
        .all();
      sups = ((sr && sr.results) || []).map((x) => x.name);
    }
    const at = (a && a.rider_at) || null;
    const can = phase !== "upcoming" && !at;
    return {
      name: hhmm(o.start_min) + " - " + hhmm(o.end_min),
      band: band ? band.name : "",
      start: hhmm(o.start_min),
      end: hhmm(o.end_min),
      day: o.day,
      slot: o.start_min,
      band_id: band ? band.id : null,
      startAt: o.startAt,
      endAt: o.endAt,
      phase,
      confirmed: !!at,
      confirmed_at: at,
      late_min: at ? Math.max(0, Math.floor((at - o.startAt) / MIN)) : 0,
      sup_status: (a && a.sup_status) || null,
      can_confirm: can,
      need: can && !(a && a.sup_status),
      mins: Math.round((o.startAt - now) / MIN),
      sups,
    };
  } catch {
    return null; // shifts not set up yet
  }
}

async function riderConfirmShift(env, device, now) {
  const c = cfg(env);
  const sh = await riderShift(env, device.rider_id, now, c);
  if (!sh) return fail("no_shift", "No shift set", 404);
  if (!sh.confirmed) {
    if (!sh.can_confirm) return fail("too_early", "Too early to confirm", 409);
    await env.DB
      .prepare(
        `INSERT INTO attendance (day, band_id, rider_id, start_min, rider_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(day, rider_id, start_min) DO UPDATE SET rider_at = COALESCE(attendance.rider_at, excluded.rider_at)`
      )
      .bind(sh.day, sh.band_id, device.rider_id, sh.slot, now)
      .run();
  }
  return json({ ok: true, shift: await riderShift(env, device.rider_id, now, c) });
}

// Cron: remind riders whose own shift is about to start (or has started) until they confirm
async function shiftTick(env, now, tzp, c, cap) {
  const out = { sent: 0, failed: 0 };
  if (cap <= 0) return out;
  const db = env.DB;
  const lead = c.SHIFT_LEAD_MIN * MIN;
  const every = c.SHIFT_NAG_MIN * MIN;
  const jobs = [];
  for (const off of [-1, 0, 1]) {
    if (jobs.length >= cap) break;
    const base = tzp.dayStart + off * DAY;
    const day = dayKey(base, tzp);
    let rows;
    try {
      rows = await db
        .prepare(
          `SELECT rs.rider_id, rs.start_min, d.id AS device_id, d.push_subscription AS sub
           FROM rider_shifts rs
           JOIN riders r ON r.id = rs.rider_id AND r.active = 1
           JOIN devices d ON d.id = (SELECT d2.id FROM devices d2 WHERE d2.rider_id = r.id
             AND d2.push_subscription IS NOT NULL ORDER BY d2.id DESC LIMIT 1)
           LEFT JOIN attendance a ON a.day = rs.day AND a.rider_id = rs.rider_id AND a.start_min = rs.start_min
           WHERE rs.day = ?1 AND a.rider_at IS NULL AND a.sup_status IS NULL
             AND COALESCE(a.last_nag, 0) <= ?2 AND COALESCE(a.nags, 0) < ?3
             AND ?4 + rs.start_min * 60000 <= ?5
             AND ?4 + rs.start_min * 60000 + (((rs.end_min - rs.start_min + 1440) % 1440) * 60000) > ?6
           LIMIT ?7`
        )
        .bind(day, now - every, c.SHIFT_MAX_NAGS, base, now + lead, now, cap - jobs.length)
        .all();
    } catch {
      return out; // migration4 not run yet
    }
    for (const r of (rows && rows.results) || []) {
      if (!jobs.some((j) => j.rider_id === r.rider_id)) jobs.push({ ...r, day });
    }
  }
  if (!jobs.length) return out;

  const ttl = Math.max(60, Math.min(600, c.SHIFT_NAG_MIN * 60));
  const results = await Promise.all(
    jobs.map(async (j) => {
      let sub;
      try { sub = JSON.parse(j.sub); } catch { return 410; }
      return sendPush(sub, env, ttl);
    })
  );
  let bands = [];
  try { bands = await activeBands(env); } catch { /* ignore */ }
  const stmts = [];
  results.forEach((status, i) => {
    const j = jobs[i];
    if (status >= 200 && status < 300) {
      out.sent++;
      const band = bandFor(bands, j.start_min);
      stmts.push(
        db.prepare(
          `INSERT INTO attendance (day, band_id, rider_id, start_min, nags, last_nag) VALUES (?1, ?2, ?3, ?4, 1, ?5)
           ON CONFLICT(day, rider_id, start_min) DO UPDATE SET nags = COALESCE(attendance.nags, 0) + 1,
             last_nag = excluded.last_nag`
        ).bind(j.day, band ? band.id : null, j.rider_id, j.start_min, now)
      );
      return;
    }
    out.failed++;
    if (status === 404 || status === 410) {
      stmts.push(db.prepare("UPDATE devices SET push_subscription = NULL WHERE id = ?").bind(j.device_id));
    }
  });
  if (stmts.length) await db.batch(stmts);
  return out;
}

/* ---- supervisor side (login = personal code) ---- */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode(len = 8) {
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
}

async function getSup(env, code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c || c.length > 20) return null;
  try {
    return await env.DB.prepare("SELECT id, name FROM supervisors WHERE code = ? AND active = 1").bind(c).first();
  } catch {
    return null;
  }
}

async function supShiftFor(env, sup, shiftId, now, c) {
  const s = await env.DB
    .prepare(
      `SELECT s.id, s.name, s.start_min, s.end_min FROM shift_sups ss
       JOIN shifts s ON s.id = ss.shift_id AND s.active = 1 WHERE ss.sup_id = ? AND s.id = ?`
    )
    .bind(sup.id, shiftId)
    .first();
  if (!s) return null;
  const tzp = tzParts(now, c.TIMEZONE);
  const occ = pickOcc(now, tzp, s, 2 * HOUR);
  return occ ? { s, occ, tzp } : null;
}

async function supBoard(env, sup, now, c) {
  const tzp = tzParts(now, c.TIMEZONE);
  const list = await env.DB
    .prepare(
      `SELECT s.id, s.name, s.start_min, s.end_min FROM shift_sups ss
       JOIN shifts s ON s.id = ss.shift_id AND s.active = 1 WHERE ss.sup_id = ? ORDER BY s.start_min`
    )
    .bind(sup.id)
    .all();
  const shifts = [];
  for (const s of (list && list.results) || []) {
    const occ = pickOcc(now, tzp, s, 2 * HOUR);
    if (!occ) continue;
    const riders = forSup(await shiftRiders(env, s, occ, tzp), sup.id);
    const confirms = await shiftConfirms(env, s.id, occ.day);
    shifts.push({
      id: s.id, name: s.name, start: hhmm(s.start_min), end: hhmm(s.end_min),
      day: occ.day, startAt: occ.startAt, endAt: occ.endAt, phase: occ.phase,
      riders, counts: shiftCounts(riders, c.SHIFT_GRACE_MIN),
      confirms: confirms.map((x) => ({ sup_id: x.sup_id, name: x.name, at: x.at, present: x.present, absent: x.absent })),
      mine: confirms.some((x) => x.sup_id === sup.id),
    });
  }
  return { ok: true, sup: { id: sup.id, name: sup.name }, now, grace: c.SHIFT_GRACE_MIN, shifts };
}

async function supMark(env, sup, body, now, c) {
  const rid = String((body && body.rider_id) || "");
  const status = body && body.status === "present" ? "present" : body && body.status === "absent" ? "absent" : null;
  const found = await supShiftFor(env, sup, +body.shift_id, now, c);
  if (!found) return fail("no_shift", "Shift not found", 404);
  const riders = await shiftRiders(env, found.s, found.occ, found.tzp);
  const r = riders.find((x) => x.id === rid && x.day === String(body.day) && x.slot === +body.slot);
  if (!r) return fail("no_rider", "Rider is not in this shift", 404);
  await env.DB
    .prepare(
      `INSERT INTO attendance (day, band_id, rider_id, start_min, sup_status, sup_id, sup_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(day, rider_id, start_min) DO UPDATE SET sup_status = excluded.sup_status, sup_id = excluded.sup_id,
         sup_at = excluded.sup_at, band_id = excluded.band_id`
    )
    .bind(r.day, found.s.id, rid, r.slot, status, sup.id, now)
    .run();
  return json({ ok: true });
}

async function supConfirm(env, sup, body, now, c) {
  const found = await supShiftFor(env, sup, +body.shift_id, now, c);
  if (!found) return fail("no_shift", "Shift not found", 404);
  const { s, occ, tzp } = found;
  if (now < occ.startAt - c.SHIFT_LEAD_MIN * MIN) return fail("too_early", "The shift has not started yet", 409);
  const riders = forSup(await shiftRiders(env, s, occ, tzp), sup.id);
  const pending = riders.filter((r) => r.status === "pending");
  if (pending.length && !body.absent_pending) {
    return json({ ok: false, code: "pending", pending: pending.map((r) => ({ id: r.id, name: r.name })) }, 409);
  }
  const stmts = pending.map((r) =>
    env.DB
      .prepare(
        `INSERT INTO attendance (day, band_id, rider_id, start_min, sup_status, sup_id, sup_at) VALUES (?1, ?2, ?3, ?4, 'absent', ?5, ?6)
         ON CONFLICT(day, rider_id, start_min) DO UPDATE SET sup_status = 'absent', sup_id = excluded.sup_id, sup_at = excluded.sup_at`
      )
      .bind(r.day, s.id, r.id, r.slot, sup.id, now)
  );
  const absent = riders.filter((r) => r.status === "absent").length + pending.length;
  stmts.push(
    env.DB
      .prepare(`INSERT OR REPLACE INTO shift_confirm (day, shift_id, sup_id, at, present, absent) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(occ.day, s.id, sup.id, now, riders.length - absent, absent)
  );
  await env.DB.batch(stmts);
  return json({ ok: true });
}

/* ---- admin side ---- */
async function adminShifts(env, now, c) {
  await seedShifts(env);
  const tzp = tzParts(now, c.TIMEZONE);
  const [shiftRows, supRows, linkRows] = await Promise.all([
    env.DB.prepare("SELECT id, name, start_min, end_min, active FROM shifts ORDER BY start_min, id").all(),
    env.DB.prepare("SELECT id, name, code, active FROM supervisors ORDER BY name, id").all(),
    env.DB.prepare("SELECT shift_id, sup_id FROM shift_sups").all(),
  ]);
  const links = (linkRows && linkRows.results) || [];
  const shifts = [];
  for (const s of (shiftRows && shiftRows.results) || []) {
    const item = {
      id: s.id, name: s.name, start: hhmm(s.start_min), end: hhmm(s.end_min), active: !!s.active,
      sup_ids: links.filter((l) => l.shift_id === s.id).map((l) => l.sup_id),
      rider_count: 0, occ: null, counts: null, confirms: [], riders: [],
    };
    const occ = s.active ? pickOcc(now, tzp, s, 2 * HOUR) : null;
    if (occ) {
      const riders = await shiftRiders(env, s, occ, tzp);
      item.occ = occ;
      item.riders = riders;
      item.rider_count = riders.length;
      item.counts = shiftCounts(riders, c.SHIFT_GRACE_MIN);
      item.confirms = (await shiftConfirms(env, s.id, occ.day)).map((x) => ({ sup_id: x.sup_id, name: x.name, at: x.at }));
    }
    shifts.push(item);
  }
  const since = new Date(tzp.dayStart + tzp.offset - 6 * DAY).toISOString().slice(0, 10);
  const [hist, hconf] = await Promise.all([
    env.DB
      .prepare(
        `SELECT a.day, a.band_id AS shift_id, SUM(CASE WHEN ${PRESENT_SQL} THEN 1 ELSE 0 END) AS present,
           SUM(CASE WHEN a.sup_status = 'absent' THEN 1 ELSE 0 END) AS absent, COUNT(*) AS touched
         FROM attendance a WHERE a.day >= ? GROUP BY a.day, a.band_id ORDER BY a.day DESC`
      )
      .bind(since)
      .all(),
    env.DB.prepare("SELECT day, shift_id, COUNT(*) AS n FROM shift_confirm WHERE day >= ? GROUP BY day, shift_id").bind(since).all(),
  ]);
  return {
    ok: true,
    now,
    grace: c.SHIFT_GRACE_MIN,
    config: { lead: c.SHIFT_LEAD_MIN, nag: c.SHIFT_NAG_MIN },
    shifts,
    supervisors: ((supRows && supRows.results) || []).map((x) => ({ id: x.id, name: x.name, code: x.code, active: !!x.active })),
    history: (hist && hist.results) || [],
    history_confirms: (hconf && hconf.results) || [],
  };
}

async function adminSaveShift(env, body) {
  const id = body && body.id ? +body.id : 0;
  if (body && body.delete) {
    if (!id) return fail("bad_request", "Missing id", 400);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM shift_sups WHERE shift_id = ?").bind(id),
      env.DB.prepare("DELETE FROM shifts WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }
  const name = String((body && body.name) || "").trim().slice(0, 40);
  const st = parseHHMM(body && body.start), en = parseHHMM(body && body.end);
  if (!name || st === null || en === null || st === en) return fail("bad_request", "Name, start and end are required", 400);
  const active = body.active === false ? 0 : 1;
  let sid = id;
  if (id) {
    await env.DB.prepare("UPDATE shifts SET name = ?, start_min = ?, end_min = ?, active = ? WHERE id = ?").bind(name, st, en, active, id).run();
  } else {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM shifts").first();
    if (n && n.n >= 12) return fail("too_many", "Maximum 12 shifts", 400);
    const r = await env.DB.prepare("INSERT INTO shifts (name, start_min, end_min, sort, active) VALUES (?, ?, ?, ?, ?)").bind(name, st, en, n ? n.n : 0, active).run();
    sid = r.meta.last_row_id;
  }
  const sups = Array.isArray(body.sup_ids) ? [...new Set(body.sup_ids.map(Number).filter((x) => x > 0))].slice(0, 6) : [];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM shift_sups WHERE shift_id = ?").bind(sid),
    ...sups.map((u) => env.DB.prepare("INSERT OR IGNORE INTO shift_sups (shift_id, sup_id) VALUES (?, ?)").bind(sid, u)),
  ]);
  return json({ ok: true, id: sid });
}

async function adminSaveSupervisor(env, body) {
  const id = body && body.id ? +body.id : 0;
  if (body && body.delete) {
    if (!id) return fail("bad_request", "Missing id", 400);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM shift_sups WHERE sup_id = ?").bind(id),
      env.DB.prepare("DELETE FROM supervisors WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }
  if (id && body.regen) {
    await env.DB.prepare("UPDATE supervisors SET code = ? WHERE id = ?").bind(newCode(), id).run();
    return json({ ok: true });
  }
  const name = String((body && body.name) || "").trim().slice(0, 60);
  if (!name) return fail("bad_request", "Name is required", 400);
  if (id) {
    await env.DB.prepare("UPDATE supervisors SET name = ?, active = ? WHERE id = ?").bind(name, body.active === false ? 0 : 1, id).run();
  } else {
    await env.DB.prepare("INSERT INTO supervisors (name, code) VALUES (?, ?)").bind(name, newCode()).run();
  }
  return json({ ok: true });
}

/* ---------------------------- Incentives (editable cards) ---------------------------- */
const DEFAULT_INCENTIVES = {
  en: [
    {
      icon: "⭐", color: "#f59e0b",
      title: "Incentive 1: Experience incentive",
      intro: "Keeta values the customer experience of every order, so we encourage customer-centric performance with the incentive below.",
      lines: [
        "Your performance level is evaluated by the Valid Rider's rank among Valid Riders.",
        "To enter the Rider Ranking pool you must complete at least 100 orders and keep your Cancellation Rate (D Liability) at or below 0.38%.",
        "Only a valid DA is entitled to the Experience incentive.",
      ],
      formulas: [
        "Total experience incentive = correlated amount of the performance level × number of DAs (only VDA) × rider attendance rate",
        "Attendance rate = number of valid days of the rider ÷ 26 days",
      ],
      table: {
        head: ["Performance level", "Rider rank (example, check the BOC for the exact distribution)", "Bike: per valid DA (SAR)", "Car: per valid DA (SAR)"],
        rows: [["A", "0% - 25%", "1,200", "2,000"], ["B", "25% - 55%", "800", "1,500"], ["C", "55% - 90%", "400", "1,000"], ["D", "90% - 100%", "0", "0"]],
      },
      note: "Rank ranges are an example. The exact distribution is in the BOC.",
    },
  ],
  ar: [
    {
      icon: "⭐", color: "#f59e0b",
      title: "الحافز 1: حافز التجربة (Experience incentive)",
      intro: "كيتا بتهتم بتجربة العميل في كل أوردر، ولهذا بنشجّع الأداء اللي يراعي العميل بالحافز ده.",
      lines: [
        "مستوى أدائك بيتحدد حسب ترتيب المندوب الصالح (Valid Rider) بين المناديب الصالحين.",
        "عشان تدخل في ترتيب المناديب لازم تكمّل 100 أوردر على الأقل، ويكون معدل الإلغاء (D Liability) 0.38% أو أقل.",
        "حافز التجربة للمندوب الصالح (Valid DA) فقط.",
      ],
      formulas: [
        "إجمالي حافز التجربة = قيمة مستوى الأداء × عدد المناديب الصالحين (VDA فقط) × معدل حضور المندوب",
        "معدل الحضور = عدد أيام المندوب الصالحة ÷ 26 يوم",
      ],
      table: {
        head: ["مستوى الأداء", "ترتيب المندوب (مثال، راجع BOC للتوزيع الدقيق)", "دراجة: لكل مندوب صالح (ريال)", "سيارة: لكل مندوب صالح (ريال)"],
        rows: [["A", "0% - 25%", "1,200", "2,000"], ["B", "25% - 55%", "800", "1,500"], ["C", "55% - 90%", "400", "1,000"], ["D", "90% - 100%", "0", "0"]],
      },
      note: "نطاقات الترتيب للتوضيح فقط. التوزيع الدقيق موجود في BOC.",
    },
  ],
};

function cleanCard(c) {
  if (!c || typeof c !== "object") return null;
  const s = (v, n) => String(v ?? "").slice(0, n);
  const arr = (v, n, m) => (Array.isArray(v) ? v.map((x) => s(x, n).trim()).filter(Boolean).slice(0, m) : []);
  const card = {
    icon: s(c.icon, 8).trim() || "🎁",
    color: /^#[0-9a-fA-F]{6}$/.test(c.color || "") ? c.color : "#f59e0b",
    title: s(c.title, 140).trim(),
    intro: s(c.intro, 700).trim(),
    lines: arr(c.lines, 500, 30),
    formulas: arr(c.formulas, 500, 10),
    note: s(c.note, 500).trim(),
    table: null,
  };
  if (c.table && Array.isArray(c.table.head) && Array.isArray(c.table.rows)) {
    const head = c.table.head.map((x) => s(x, 90).trim()).slice(0, 8);
    const rows = c.table.rows
      .filter(Array.isArray)
      .map((r) => r.map((x) => s(x, 80).trim()).slice(0, 8))
      .filter((r) => r.some(Boolean))
      .slice(0, 40);
    if (head.some(Boolean) && rows.length) card.table = { head, rows };
  }
  return card.title || card.intro || card.lines.length || card.formulas.length || card.table ? card : null;
}

async function getIncentives(env) {
  const out = {};
  const custom = {};
  for (const l of LANGS) out[l] = DEFAULT_INCENTIVES[l] ? JSON.parse(JSON.stringify(DEFAULT_INCENTIVES[l])) : null;
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'incentives_%'").all();
    for (const r of (rows && rows.results) || []) {
      const l = r.key.slice(11);
      if (!LANGS.includes(l)) continue;
      try {
        const list = JSON.parse(r.value);
        if (Array.isArray(list)) { out[l] = list.map(cleanCard).filter(Boolean); custom[l] = true; }
      } catch { /* keep default */ }
    }
  } catch { /* settings table missing */ }
  return { cards: out, custom };
}

/* ---------------------------- Supervisor notifications ---------------------------- */
const SUP_TXT = {
  en: {
    head: "{name} starts in {n} min", head_b: "{r} riders are scheduled. Be ready to confirm attendance.",
    conf: "Confirm attendance: {name}", conf_b: "{p} riders have not confirmed yet. Open the page and confirm.", app: "Link",
  },
  ar: {
    head: "{name} يبدأ بعد {n} دقيقة", head_b: "{r} مندوب مجدولون. كن جاهزاً لتأكيد الحضور.",
    conf: "أكّد حضور: {name}", conf_b: "{p} مندوب لم يؤكدوا بعد. افتح الصفحة وأكّد.", app: "لينك",
  },
};

// what a supervisor should be told right now (null = nothing)
function supDecide(item, supId, now, c) {
  const { occ, riders, confirms } = item;
  if (!riders.length) return null;
  if (now < occ.startAt) return { kind: "head", n: Math.max(0, Math.round((occ.startAt - now) / MIN)), r: riders.length };
  const mine = confirms.some((x) => x.sup_id === supId);
  if (!mine && now >= occ.startAt + c.SUP_AFTER_MIN * MIN) {
    return { kind: "conf", p: riders.filter((r) => r.status === "pending").length };
  }
  return null;
}

function supNoticeFrom(dec, band, lang) {
  const L = SUP_TXT[lang] || SUP_TXT.ar;
  const base = { dir: lang === "en" ? "ltr" : "rtl", lang: SUP_TXT[lang] ? lang : "ar", sticky: false, actions: [], url: "/sup" };
  if (!dec) return { ...base, kind: "none", title: L.app, body: "" };
  if (dec.kind === "head") {
    return { ...base, kind: "sup", title: L.head.replace("{name}", band.name).replace("{n}", dec.n), body: L.head_b.replace("{r}", dec.r) };
  }
  return { ...base, kind: "sup", title: L.conf.replace("{name}", band.name), body: L.conf_b.replace("{p}", dec.p) };
}

async function supNotice(env, sup, now, c) {
  const tzp = tzParts(now, c.TIMEZONE);
  const dev = await env.DB.prepare("SELECT lang FROM sup_devices WHERE sup_id = ?").bind(sup.id).first();
  const lang = (dev && dev.lang) || "ar";
  const list = await env.DB
    .prepare(
      `SELECT s.id, s.name, s.start_min, s.end_min FROM shift_sups ss
       JOIN shifts s ON s.id = ss.shift_id AND s.active = 1 WHERE ss.sup_id = ?`
    )
    .bind(sup.id)
    .all();
  let best = null;
  for (const b of (list && list.results) || []) {
    for (const o of occurrences(now, tzp, b)) {
      if (!(now >= o.startAt - c.SHIFT_LEAD_MIN * MIN && now < o.endAt)) continue;
      const riders = forSup(await shiftRiders(env, b, o, tzp), sup.id);
      const confirms = await shiftConfirms(env, b.id, o.day);
      const dec = supDecide({ occ: o, riders, confirms }, sup.id, now, c);
      if (dec && (!best || dec.kind === "conf")) best = { dec, band: b };
    }
  }
  return supNoticeFrom(best && best.dec, best && best.band, lang);
}

async function supTick(env, now, tzp, c, cap) {
  const out = { sent: 0, failed: 0 };
  if (cap <= 0) return out;
  const db = env.DB;
  let bands;
  try { bands = await activeBands(env); } catch { return out; }
  const lead = c.SHIFT_LEAD_MIN * MIN, every = c.SHIFT_NAG_MIN * MIN;
  const act = [];
  for (const b of bands) for (const o of occurrences(now, tzp, b)) if (now >= o.startAt - lead && now < o.endAt) act.push({ band: b, occ: o });
  if (!act.length) return out;
  const ids = [...new Set(act.map((x) => x.band.id))].join(",");
  let targets;
  try {
    targets = ((await db
      .prepare(
        `SELECT ss.shift_id, su.id AS sup_id, sd.subscription AS sub, sd.lang FROM shift_sups ss
         JOIN supervisors su ON su.id = ss.sup_id AND su.active = 1
         JOIN sup_devices sd ON sd.sup_id = su.id WHERE ss.shift_id IN (${ids})`
      )
      .all()).results) || [];
  } catch { return out; }
  if (!targets.length) return out;
  const nagRows = new Map();
  for (const day of [...new Set(act.map((x) => x.occ.day))]) {
    const r = await db.prepare("SELECT day, shift_id, sup_id, nags, last_nag FROM sup_nag WHERE day = ?").bind(day).all();
    for (const x of (r && r.results) || []) nagRows.set(x.day + "|" + x.shift_id + "|" + x.sup_id, x);
  }
  const jobs = [];
  for (const { band, occ } of act) {
    const mine = targets.filter((t) => t.shift_id === band.id);
    if (!mine.length) continue;
    const allRiders = await shiftRiders(env, band, occ, tzp);
    const confirms = await shiftConfirms(env, band.id, occ.day);
    for (const t of mine) {
      if (jobs.length >= cap) break;
      const dec = supDecide({ occ, riders: forSup(allRiders, t.sup_id), confirms }, t.sup_id, now, c);
      if (!dec) continue;
      const row = nagRows.get(occ.day + "|" + band.id + "|" + t.sup_id);
      const nags = row ? row.nags || 0 : 0, last = row ? row.last_nag || 0 : 0;
      if (dec.kind === "head" ? nags > 0 : last > now - every || nags >= c.SUP_MAX_NAGS) continue;
      jobs.push({ ...t, day: occ.day, band_id: band.id });
    }
  }
  if (!jobs.length) return out;
  const results = await Promise.all(
    jobs.map(async (j) => {
      let sub;
      try { sub = JSON.parse(j.sub); } catch { return 410; }
      return sendPush(sub, env, 600);
    })
  );
  const stmts = [];
  results.forEach((status, i) => {
    const j = jobs[i];
    if (status >= 200 && status < 300) {
      out.sent++;
      stmts.push(
        db.prepare(
          `INSERT INTO sup_nag (day, shift_id, sup_id, nags, last_nag) VALUES (?1, ?2, ?3, 1, ?4)
           ON CONFLICT(day, shift_id, sup_id) DO UPDATE SET nags = COALESCE(sup_nag.nags, 0) + 1, last_nag = excluded.last_nag`
        ).bind(j.day, j.band_id, j.sup_id, now)
      );
      return;
    }
    out.failed++;
    if (status === 404 || status === 410) stmts.push(db.prepare("DELETE FROM sup_devices WHERE sup_id = ?").bind(j.sup_id));
  });
  if (stmts.length) await db.batch(stmts);
  return out;
}

async function supSubscribe(env, sup, body) {
  const sub = body && body.subscription;
  if (!sub || !sub.endpoint) return fail("bad_request", "Invalid subscription", 400);
  const lang = body.lang === "en" ? "en" : "ar";
  await env.DB
    .prepare(
      `INSERT INTO sup_devices (sup_id, subscription, lang) VALUES (?, ?, ?)
       ON CONFLICT(sup_id) DO UPDATE SET subscription = excluded.subscription, lang = excluded.lang`
    )
    .bind(sup.id, JSON.stringify(sub), lang)
    .run();
  return json({ ok: true });
}

/* ---------------------------- Admin: delete riders, all schedules ---------------------------- */
async function adminDeleteRiders(env, body) {
  let ids = [];
  if (body && body.all) {
    const keep = new Set((Array.isArray(body.keep) ? body.keep : []).map((x) => String(x).trim()));
    const rows = await env.DB.prepare("SELECT id FROM riders").all();
    ids = ((rows && rows.results) || []).map((r) => r.id).filter((id) => !keep.has(String(id)));
  } else {
    ids = (Array.isArray(body && body.ids) ? body.ids : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 500);
  }
  const core = ["devices", "orders", "prompts", "events", "locations"];
  const optional = ["performance", "perf_prev", "rider_shifts", "attendance"];
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    const marks = part.map(() => "?").join(",");
    await env.DB.batch([
      ...core.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE rider_id IN (${marks})`).bind(...part)),
      env.DB.prepare(`DELETE FROM riders WHERE id IN (${marks})`).bind(...part),
    ]);
    for (const t of optional) await safeRun(env.DB.prepare(`DELETE FROM ${t} WHERE rider_id IN (${marks})`).bind(...part));
  }
  return { ok: true, deleted: ids.length };
}

async function adminSchedules(env, now, c) {
  const tzp = tzParts(now, c.TIMEZONE);
  const days = Array.from({ length: 7 }, (_, i) => dayKey(tzp.dayStart + i * DAY, tzp));
  const [riders, rows] = await Promise.all([
    env.DB.prepare("SELECT id, name FROM riders WHERE active = 1 ORDER BY name, id").all(),
    env.DB.prepare("SELECT rider_id, day, start_min, end_min FROM rider_shifts WHERE day >= ? AND day <= ? ORDER BY day, start_min").bind(days[0], days[6]).all(),
  ]);
  const by = new Map();
  for (const r of (rows && rows.results) || []) {
    const k = r.rider_id + "|" + r.day;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(hhmm(r.start_min) + "-" + hhmm(r.end_min));
  }
  return {
    ok: true,
    days,
    riders: ((riders && riders.results) || []).map((r) => ({ id: r.id, name: r.name, slots: days.map((d) => by.get(r.id + "|" + d) || []) })),
  };
}

/* ---------------------------- Routes ---------------------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const now = Date.now();

    /* ---- Rider ---- */
    if (path === "/api/login" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return fail("bad_request", "Invalid data", 400);

      const id = String(body.id || "").trim();
      if (!id) return fail("id_required", "Rider ID is required", 400);

      const rider = await env.DB
        .prepare("SELECT id, name FROM riders WHERE id = ? AND active = 1")
        .bind(id)
        .first();
      if (!rider) return fail("not_registered", "Not registered", 404);

      const token = crypto.randomUUID();
      const lang = cleanLang(body.lang) || "ar";
      await env.DB
        .prepare("INSERT INTO devices (rider_id, token, lang) VALUES (?, ?, ?)")
        .bind(rider.id, token, lang)
        .run();
      return json({ ok: true, token, lang, rider: { id: rider.id, name: rider.name } });
    }

    if (path === "/api/me" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return json({ ok: false }, 401);
      const rider = await env.DB.prepare("SELECT id, name FROM riders WHERE id = ?").bind(device.rider_id).first();
      try { await setSetting(env, "seen:" + device.rider_id, now); } catch (e) { console.error("heartbeat failed", e && e.message ? e.message : e); }
      const state = await riderState(env, device.rider_id, now);
      const shift = await riderShift(env, device.rider_id, now, cfg(env));
      return json({
        ok: true,
        rider,
        lang: cleanLang(device.lang) || "ar",
        pushEnabled: !!device.push_enabled,
        stages: !!cfg(env).ASK_STAGES,
        shift,
        ...state,
      });
    }

    if (path === "/api/logout" && request.method === "POST") {
      const body = await readBody(request);
      const device = body && (await getDevice(env, body.token));
      if (device) await safeRun(env.DB.prepare("DELETE FROM settings WHERE key = ?").bind("seen:" + device.rider_id));
      return json({ ok: true });
    }

    if (path === "/api/shift/confirm" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return fail("unauthorized", "Unauthorized", 401);
      return riderConfirmShift(env, device, now);
    }

    if (path === "/api/schedule" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return fail("unauthorized", "Unauthorized", 401);
      try { return await riderSchedule(env, device, now, cfg(env)); } catch { return fail("not_ready", "Shifts are not set up yet", 503); }
    }

    if (path === "/api/schedule/save" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return fail("unauthorized", "Unauthorized", 401);
      try { return await riderSaveSchedule(env, device, body, now, cfg(env)); } catch { return fail("not_ready", "Shifts are not set up yet", 503); }
    }

    if (path === "/api/incentives" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return fail("unauthorized", "Unauthorized", 401);
      const { cards } = await getIncentives(env);
      const lang = cleanLang(device.lang) || "ar";
      const l = body.lang && LANGS.includes(body.lang) ? body.lang : lang;
      const list = cards[l] && cards[l].length ? cards[l] : cards.en || [];
      return json({ ok: true, lang: l, cards: list });
    }

    /* ---- Supervisor (personal code) ---- */
    if (path.startsWith("/api/sup/") && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const sup = await getSup(env, body.code);
      if (!sup) return fail("bad_code", "Invalid code", 401);
      const c = cfg(env);
      if (path === "/api/sup/board") return json(await supBoard(env, sup, now, c));
      if (path === "/api/sup/notice") return json({ ok: true, notice: await supNotice(env, sup, now, c) });
      if (path === "/api/sup/subscribe") return supSubscribe(env, sup, body);
      if (path === "/api/sup/mark") return supMark(env, sup, body, now, c);
      if (path === "/api/sup/confirm") return supConfirm(env, sup, body, now, c);
      return fail("not_found", "Not found", 404);
    }

    if (path === "/api/lang" && request.method === "POST") {
      const body = await readBody(request);
      const lang = cleanLang(body && body.lang);
      if (!lang) return fail("bad_request", "Unsupported language", 400);
      const device = await getDevice(env, body.token);
      if (!device) return fail("unauthorized", "Unauthorized", 401);
      await env.DB.prepare("UPDATE devices SET lang = ? WHERE id = ?").bind(lang, device.id).run();
      return json({ ok: true, lang });
    }

    if (path === "/api/respond" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      return handleRespond(env, body, now);
    }

    if (path === "/api/location" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return fail("unauthorized", "Unauthorized", 401);
      const loc = parseLoc(body);
      if (!loc) return fail("bad_request", "Invalid location", 400);
      await upsertLocation(env, device.rider_id, loc, now).run();
      return json({ ok: true });
    }

    if (path === "/api/performance" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return fail("unauthorized", "Unauthorized", 401);
      let perf = null;
      try {
        perf = await env.DB.prepare("SELECT * FROM performance WHERE rider_id = ?").bind(device.rider_id).first();
      } catch { /* table not created yet */ }
      const { tips } = await getAllTips(env);
      return json({ ok: true, perf: perf || null, tips, image: await hasTipsImage(env) });
    }

    if (path === "/api/tips-image" && request.method === "GET") {
      let row = null;
      try { row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'tips_image'").first(); } catch {}
      const m = row && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(row.value || "");
      if (!m) return new Response("Not found", { status: 404 });
      const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      return new Response(bin, { headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=300" } });
    }

    /* ---- Notifications ---- */
    if (path === "/api/vapid-key" && request.method === "GET") {
      return json({ ok: true, key: env.VAPID_PUBLIC_KEY });
    }

    if (path === "/api/subscribe" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || !body.subscription || !body.subscription.endpoint) {
        return fail("bad_request", "Invalid subscription", 400);
      }
      const device = await getDevice(env, body.token);
      if (!device) return fail("unauthorized", "Unauthorized", 401);

      const endpoint = String(body.subscription.endpoint);
      await env.DB.batch([
        // one phone belongs to one rider
        env.DB
          .prepare(
            `UPDATE devices SET push_subscription = NULL
             WHERE push_subscription IS NOT NULL
               AND json_extract(push_subscription, '$.endpoint') = ? AND id <> ?`
          )
          .bind(endpoint, device.id),
        env.DB
          .prepare("UPDATE devices SET push_subscription = ? WHERE id = ?")
          .bind(JSON.stringify(body.subscription), device.id),
      ]);
      return json({ ok: true });
    }

    // What should the phone display right now? (used by the service worker and the page)
    if (path === "/api/notice" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      let device = body.token ? await getDevice(env, body.token) : null;
      if (!device && body.endpoint) device = await getDeviceByEndpoint(env, body.endpoint);
      if (!device) return json({ ok: true, notice: buildNotice({ order: null, prompt: null }, "ar") });
      const state = await riderState(env, device.rider_id, now);
      if (!state.order) state.shift = await riderShift(env, device.rider_id, now, cfg(env));
      return json({ ok: true, notice: buildNotice(state, cleanLang(device.lang) || "ar", !!cfg(env).ASK_STAGES) });
    }

    // Older service workers
    if (path === "/api/pending" && request.method === "POST") {
      const body = await readBody(request);
      const endpoint = body && body.endpoint ? String(body.endpoint) : "";
      if (!endpoint) return json({ ok: false }, 400);
      const dev = await getDeviceByEndpoint(env, endpoint);
      if (!dev) return json({ ok: true, prompt: null });
      const state = await riderState(env, dev.rider_id, now);
      return json({ ok: true, prompt: (state.prompt && PROMPTS[state.prompt.type]) || null });
    }

    if (path === "/api/test-push" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return fail("unauthorized", "Unauthorized", 401);
      const row = await env.DB.prepare("SELECT push_subscription FROM devices WHERE id = ?").bind(device.id).first();
      if (!row || !row.push_subscription) return fail("push_off", "Notifications are not enabled", 400);
      const status = await sendPush(JSON.parse(row.push_subscription), env, 60);
      if (status === 404 || status === 410) {
        await env.DB.prepare("UPDATE devices SET push_subscription = NULL WHERE id = ?").bind(device.id).run();
        return fail("push_expired", "Subscription expired", 410);
      }
      if (status < 200 || status >= 300) return fail("push_failed", "Send failed (" + status + ")", 502);
      return json({ ok: true });
    }

    /* ---- Admin ---- */
    if (path.startsWith("/api/admin/")) {
      const auth = await isAdmin(request, env);
      if (auth === null) return fail("admin_key_missing", "ADMIN_KEY is not set in Cloudflare", 503);
      if (!auth) return fail("admin_key_invalid", "Invalid admin key", 401);

      if (path === "/api/admin/overview" && request.method === "GET") {
        return json(await adminOverview(env, now));
      }
      if (path === "/api/admin/report" && request.method === "GET") {
        return json(await adminReport(env, url.searchParams.get("range") || "today", now));
      }
      if (path === "/api/admin/performance" && request.method === "GET") {
        return json(await adminPerfList(env));
      }
      if (path === "/api/admin/performance/upload" && request.method === "POST") {
        const body = await readBody(request);
        if (!body) return json({ ok: false }, 400);
        return json(await adminPerfUpload(env, body, now));
      }
      if (path === "/api/admin/tips" && request.method === "GET") {
        const { tips, custom } = await getAllTips(env);
        return json({ ok: true, tips, custom, defaults: DEFAULT_TIPS, image: await hasTipsImage(env) });
      }
      if (path === "/api/admin/tips" && request.method === "POST") {
        const body = await readBody(request);
        const lang = body && body.lang;
        if (!LANGS.includes(lang)) return fail("bad_request", "Unsupported language", 400);
        if (body.reset) {
          await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind("tips_" + lang).run();
          return json({ ok: true });
        }
        const tip = cleanTip(body.tip);
        if (!tip) return fail("bad_request", "Invalid tips", 400);
        await env.DB
          .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind("tips_" + lang, JSON.stringify(tip))
          .run();
        return json({ ok: true });
      }
      if (path === "/api/admin/tips-image" && request.method === "POST") {
        const body = await readBody(request);
        if (body && body.remove) {
          await env.DB.prepare("DELETE FROM settings WHERE key = 'tips_image'").run();
          return json({ ok: true });
        }
        const data = String((body && body.dataUrl) || "");
        if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 1_200_000) {
          return fail("bad_image", "Use a PNG/JPEG/WebP image under ~800 KB", 400);
        }
        await env.DB
          .prepare("INSERT INTO settings (key, value) VALUES ('tips_image', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(data)
          .run();
        return json({ ok: true });
      }
      if (path === "/api/admin/riders/supervisor" && request.method === "POST") {
        const body = await readBody(request);
        if (!body) return json({ ok: false }, 400);
        return adminSetRiderSup(env, body);
      }
      if (path === "/api/admin/diagnose" && request.method === "GET") return json(await adminDiagnose(env, now));
      if (path === "/api/admin/testpush" && request.method === "POST") return json(await adminTestPush(env, now));
      if (path === "/api/admin/riders/delete" && request.method === "POST") {
        const body = await readBody(request);
        if (!body) return json({ ok: false }, 400);
        return json(await adminDeleteRiders(env, body));
      }
      if (path === "/api/admin/schedules" && request.method === "GET") {
        return json(await adminSchedules(env, now, cfg(env)));
      }
      if (path === "/api/admin/shifts" && request.method === "GET") {
        return json(await adminShifts(env, now, cfg(env)));
      }
      if (path === "/api/admin/shifts/save" && request.method === "POST") {
        const body = await readBody(request);
        if (!body) return json({ ok: false }, 400);
        return adminSaveShift(env, body);
      }
      if (path === "/api/admin/supervisors/save" && request.method === "POST") {
        const body = await readBody(request);
        if (!body) return json({ ok: false }, 400);
        return adminSaveSupervisor(env, body);
      }
      if (path === "/api/admin/incentives" && request.method === "GET") {
        const { cards, custom } = await getIncentives(env);
        return json({ ok: true, cards, custom, defaults: DEFAULT_INCENTIVES });
      }
      if (path === "/api/admin/incentives" && request.method === "POST") {
        const body = await readBody(request);
        const lang = body && body.lang;
        if (!LANGS.includes(lang)) return fail("bad_request", "Unsupported language", 400);
        if (body.reset) {
          await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind("incentives_" + lang).run();
          return json({ ok: true });
        }
        const list = (Array.isArray(body.cards) ? body.cards : []).slice(0, 20).map(cleanCard).filter(Boolean);
        await env.DB
          .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind("incentives_" + lang, JSON.stringify(list))
          .run();
        return json({ ok: true, count: list.length });
      }
      if (path === "/api/admin/riders" && request.method === "GET") {
        return json(await adminListRiders(env));
      }
      if (path === "/api/admin/riders" && request.method === "POST") {
        const body = await readBody(request);
        if (!body) return json({ ok: false }, 400);
        return json(await adminAddRiders(env, body, now));
      }
      if (path === "/api/admin/riders/status" && request.method === "POST") {
        const body = await readBody(request);
        const id = String((body && body.id) || "");
        if (!id) return fail("bad_request", "Missing id", 400);
        await env.DB.prepare("UPDATE riders SET active = ? WHERE id = ?").bind(body.active ? 1 : 0, id).run();
        return json({ ok: true });
      }
      return fail("not_found", "Not found", 404);
    }

    if (path.startsWith("/api/")) return fail("not_found", "Not found", 404);

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      tick(env).then(
        async (r) => {
          console.log("tick", JSON.stringify(r));
          await saveTick(env, { at: Date.now(), ok: true, r });
        },
        async (e) => {
          console.error("tick failed", e && e.message ? e.message : e);
          await saveTick(env, { at: Date.now(), ok: false, error: String((e && e.message) || e) });
        }
      )
    );
  },
};
