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
  TIMEZONE: "Africa/Cairo",
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
    app: "Rider Tracking",
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
    app: "متابعة المناديب",
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
    app: "رائیڈر ٹریکنگ",
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
    app: "রাইডার ট্র্যাকিং",
    uptodate: "নতুন কিছু নেই",
  },
};

// What the phone should show right now. While an order is open the notification is
// "sticky": it carries the current step and the button for the next one.
function buildNotice(state, lang) {
  const L = NOTICE[lang] || NOTICE.ar;
  const base = { dir: L.dir, lang: NOTICE[lang] ? lang : "ar" };
  const o = state.order;
  const p = state.prompt;
  if (o && L.stage[o.stage]) {
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
    stmts.push(answerPrompts(env, riderId, ["have_order"], "yes", now));
  } else if (action === "no_order") {
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
  if (order && (action === "delivered" || action === "cancel")) {
    await safeRun(env.DB.prepare("UPDATE riders SET idle_since = ? WHERE id = ?").bind(now, riderId));
  }
  const fresh = await riderState(env, riderId, now);
  return json({ ok: true, ...fresh });
}

/* ---------------------------- Scheduler (every minute) ---------------------------- */
const LATEST_PUSH_DEVICE = (alias) =>
  `(SELECT d2.id FROM devices d2 WHERE d2.rider_id = ${alias}.rider_id
     AND d2.push_subscription IS NOT NULL ORDER BY d2.id DESC LIMIT 1)`;

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
  const staleBefore = now - c.STALE_HOURS * HOUR;
  await safeRun(
    db
      .prepare(
        `UPDATE riders SET idle_since = ? WHERE id IN
           (SELECT rider_id FROM orders WHERE status = 'active' AND updated_at <= ?)`
      )
      .bind(now, staleBefore)
  );
  await db
    .prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'active' AND updated_at <= ?")
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
  }

  // 2) outside working hours: no questions
  if (!inWorkHours(tz.hour, c.WORK_START_HOUR, c.WORK_END_HOUR)) {
    out.skipped = "outside_work_hours";
    return out;
  }

  // 3) who needs a question now?
  const cap = c.MAX_SENDS_PER_TICK;
  const jobs = [];

  const haveOrder = await db
    .prepare(
      `SELECT r.id AS rider_id, d.id AS device_id, d.push_subscription AS sub
       FROM riders r
       JOIN devices d ON d.id = (SELECT d2.id FROM devices d2 WHERE d2.rider_id = r.id
         AND d2.push_subscription IS NOT NULL ORDER BY d2.id DESC LIMIT 1)
       WHERE r.active = 1
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.rider_id = r.id AND o.status = 'active')
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
       WHERE o.status = 'active' AND o.stage IN (${stages})
         AND NOT EXISTS (SELECT 1 FROM prompts p WHERE p.rider_id = o.rider_id AND p.status = 'pending')
         AND (SELECT COUNT(*) FROM prompts p WHERE p.order_id = o.id AND p.type = '${promptType}') < ?
         AND COALESCE((SELECT MAX(p.sent_at) + ? FROM prompts p
               WHERE p.order_id = o.id AND p.type = '${promptType}'), o.${baseCol} + ?) <= ?
       LIMIT ?`
    );

  if (jobs.length < cap) {
    const rows = await stageQuery("'declared','arrived'", "picked_up", "declared_at")
      .bind(c.MAX_ATTEMPTS, c.REPEAT_MIN * MIN, c.PICKUP_AFTER_MIN * MIN, now, cap - jobs.length)
      .all();
    for (const r of rows.results || []) jobs.push({ ...r, type: "picked_up" });
  }
  if (jobs.length < cap) {
    const rows = await stageQuery("'picked_up'", "delivered", "picked_at")
      .bind(c.MAX_ATTEMPTS, c.REPEAT_MIN * MIN, c.DELIVER_AFTER_MIN * MIN, now, cap - jobs.length)
      .all();
    for (const r of rows.results || []) jobs.push({ ...r, type: "delivered" });
  }

  if (!jobs.length) return out;

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
      const state = await riderState(env, device.rider_id, now);
      return json({
        ok: true,
        rider,
        lang: cleanLang(device.lang) || "ar",
        pushEnabled: !!device.push_enabled,
        ...state,
      });
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
      return json({ ok: true, notice: buildNotice(state, cleanLang(device.lang) || "ar") });
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
        (r) => console.log("tick", JSON.stringify(r)),
        (e) => console.error("tick failed", e && e.message ? e.message : e)
      )
    );
  },
};
