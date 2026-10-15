/* =====================================================================
   نظام متابعة المناديب - Worker
   - API للمندوب: تسجيل الدخول، الحالة، الرد، الموقع، الإشعارات
   - API للإدارة: لوحة المتابعة وإضافة المناديب (محمي بـ ADMIN_KEY)
   - جدولة كل دقيقة (Cron): بتبعت الأسئلة وبتسجّل "لم يرد"
   ===================================================================== */

const MIN = 60 * 1000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

/* ---------------------------- الإعدادات ---------------------------- */
// كل القيم دي ممكن تتغير من wrangler.jsonc (قسم vars) من غير ما نلمس الكود
const DEFAULTS = {
  TIMEZONE: "Africa/Cairo",
  WORK_START_HOUR: 9, // أول ساعة بيتبعت فيها أسئلة
  WORK_END_HOUR: 23, // آخر ساعة (مش شاملة)
  ASK_EVERY_MIN: 30, // "معاك أوردر؟" كل كام دقيقة
  PICKUP_AFTER_MIN: 15, // بعد "أيوه معايا أوردر" نسأل "استلمت؟"
  DELIVER_AFTER_MIN: 10, // بعد الاستلام نسأل "سلّمت؟"
  REPEAT_MIN: 10, // لو ما ردّش أو قال "لسه" نكرر السؤال بعد كام دقيقة
  MISS_AFTER_MIN: 10, // بعد كام دقيقة بدون رد نسجّل "لم يرد"
  MAX_ATTEMPTS: 3, // أقصى عدد مرات تكرار السؤال لنفس الأوردر
  STALE_HOURS: 4, // أوردر مفتوح من غير أي حركة يتقفل تلقائيًا
  MAX_SENDS_PER_TICK: 20, // حد الإرسال في الدقيقة (حدود الخطة المجانية)
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

// الساعة والدقيقة وبداية اليوم بتوقيت الشغل
function tzParts(now, tz) {
  let f;
  try {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: DEFAULTS.TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  }
  const p = {};
  for (const x of f.formatToParts(new Date(now))) p[x.type] = x.value;
  const y = +p.year, mo = +p.month, d = +p.day;
  const h = +p.hour % 24, mi = +p.minute, s = +p.second;
  const localAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = localAsUtc - Math.floor(now / 1000) * 1000;
  return { hour: h, minute: mi, dayStart: Date.UTC(y, mo - 1, d) - offset };
}

function inWorkHours(hour, start, end) {
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/* ---------------------------- نصوص الإشعارات ---------------------------- */
const PROMPTS = {
  have_order: {
    title: "معاك أوردر؟",
    body: "افتح التطبيق وجاوب: معاك أوردر دلوقتي؟",
  },
  picked_up: {
    title: "استلمت الأوردر؟",
    body: "افتح التطبيق وأكّد لو استلمت الأوردر من المطعم.",
  },
  delivered: {
    title: "سلّمت الأوردر؟",
    body: "افتح التطبيق وأكّد لو سلّمت الأوردر للعميل.",
  },
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
  const payload = b64u.fromBytes(
    enc.encode(JSON.stringify({ aud, exp, sub: env.VAPID_SUBJECT }))
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await signingKey(env),
    enc.encode(header + "." + payload)
  );
  const value = `vapid t=${header}.${payload}.${b64u.fromBytes(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
  jwtCache.set(aud, { value, exp });
  return value;
}

// إشعار من غير محتوى: الـ Service Worker بيسأل السيرفر عن نص السؤال
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

/* ---------------------------- مساعدات القاعدة ---------------------------- */
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
      `SELECT d.id, d.rider_id, d.push_subscription IS NOT NULL AS push_enabled
       FROM devices d JOIN riders r ON r.id = d.rider_id
       WHERE d.token = ? AND r.active = 1`
    )
    .bind(String(token || ""))
    .first();
}

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

// حالة المندوب: الأوردر المفتوح + آخر سؤال لسه ما اتردّش عليه
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
    .bind(riderId, now - 2 * 60 * MIN)
    .first();
  return { order: order || null, prompt: prompt || null };
}

/* ---------------------------- رد المندوب ---------------------------- */
const ACTIONS = ["have_order", "no_order", "arrived", "picked_up", "delivered", "cancel", "not_yet"];

function answerPrompts(env, riderId, types, answer, now) {
  const marks = types.map(() => "?").join(",");
  return env.DB
    .prepare(
      `UPDATE prompts SET status = CASE status WHEN 'missed' THEN 'late' ELSE 'answered' END,
         answered_at = ?, answer = ?
       WHERE rider_id = ? AND answered_at IS NULL AND type IN (${marks}) AND sent_at >= ?`
    )
    .bind(now, answer, riderId, ...types, now - 2 * 60 * MIN);
}

function eventStmt(env, riderId, orderId, type, loc, now) {
  return env.DB
    .prepare(
      `INSERT INTO events (rider_id, order_id, type, lat, lng, at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(riderId, orderId, type, loc ? loc.lat : null, loc ? loc.lng : null, now);
}

async function handleRespond(env, body, now) {
  const device = await getDevice(env, body.token);
  if (!device) return json({ ok: false, error: "غير مصرح" }, 401);

  const action = String(body.action || "");
  if (!ACTIONS.includes(action)) return json({ ok: false, error: "إجراء غير معروف" }, 400);

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
    if (!order) {
      return json({ ok: false, error: "سجّل الأوردر الأول (معايا أوردر)" }, 409);
    }
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
        env.DB
          .prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?")
          .bind(now, order.id)
      );
      stmts.push(eventStmt(env, riderId, order.id, "cancelled", loc, now));
      stmts.push(answerPrompts(env, riderId, ["picked_up", "delivered"], "cancel", now));
    }
  }

  if (stmts.length) await env.DB.batch(stmts);
  const fresh = await riderState(env, riderId, now);
  return json({ ok: true, ...fresh });
}

/* ---------------------------- الجدولة (كل دقيقة) ---------------------------- */
const LATEST_PUSH_DEVICE = (alias) =>
  `(SELECT d2.id FROM devices d2 WHERE d2.rider_id = ${alias}.rider_id
     AND d2.push_subscription IS NOT NULL ORDER BY d2.id DESC LIMIT 1)`;

async function tick(env) {
  const now = Date.now();
  const c = cfg(env);
  const tz = tzParts(now, c.TIMEZONE);
  const db = env.DB;
  const out = { sent: 0, failed: 0, skipped: null };

  // 1) تنظيف وتسجيل "لم يرد"
  await db
    .prepare("UPDATE prompts SET status = 'missed' WHERE status = 'pending' AND sent_at <= ?")
    .bind(now - c.MISS_AFTER_MIN * MIN)
    .run();
  await db
    .prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'active' AND updated_at <= ?")
    .bind(now, now - c.STALE_HOURS * 60 * MIN)
    .run();

  // تنظيف البيانات القديمة (أكتر من 90 يوم) الساعة 4 الصبح
  if (tz.hour === 4 && tz.minute === 0) {
    const cut = now - 90 * 24 * 60 * MIN;
    await db.batch([
      db.prepare("DELETE FROM events WHERE at < ?").bind(cut),
      db.prepare("DELETE FROM prompts WHERE sent_at < ?").bind(cut),
      db.prepare("DELETE FROM orders WHERE status != 'active' AND updated_at < ?").bind(cut),
    ]);
  }

  // 2) برا ساعات الشغل: مفيش أسئلة
  if (!inWorkHours(tz.hour, c.WORK_START_HOUR, c.WORK_END_HOUR)) {
    out.skipped = "outside_work_hours";
    return out;
  }

  // 3) مين محتاج سؤال دلوقتي؟
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
    db
      .prepare(
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

  // 4) نسجّل السؤال الأول (علشان الـ Service Worker يلاقيه) وبعدها نبعت الإشعار
  const inserted = await db.batch(
    jobs.map((j) =>
      db
        .prepare(
          "INSERT INTO prompts (rider_id, order_id, type, sent_at, status) VALUES (?, ?, ?, ?, 'pending')"
        )
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

  // 5) اللي فشل: نمسح سؤاله علشان يتحاول تاني، ولو الاشتراك انتهى نقفله
  const cleanup = [];
  results.forEach((status, i) => {
    const j = jobs[i];
    if (status >= 200 && status < 300) {
      out.sent++;
      return;
    }
    out.failed++;
    cleanup.push(db.prepare("DELETE FROM prompts WHERE id = ?").bind(j.prompt_id));
    if (status === 404 || status === 410) {
      cleanup.push(db.prepare("UPDATE devices SET push_subscription = NULL WHERE id = ?").bind(j.device_id));
    }
  });
  if (cleanup.length) await db.batch(cleanup);
  return out;
}

/* ---------------------------- الإدارة ---------------------------- */
async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return null; // null = المفتاح مش متضبط
  const given = request.headers.get("X-Admin-Key") || "";
  const [a, b] = await Promise.all([sha256(given), sha256(String(env.ADMIN_KEY))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function adminOverview(env, now) {
  const c = cfg(env);
  const tz = tzParts(now, c.TIMEZONE);
  const db = env.DB;
  const [riders, orders, opens, locs, pushes, delivered, missed, events] = await Promise.all([
    db.prepare("SELECT id, name FROM riders WHERE active = 1 ORDER BY id").all(),
    db
      .prepare(
        `SELECT id, rider_id, stage, declared_at, arrived_at, picked_at FROM orders
         WHERE status = 'active'`
      )
      .all(),
    db
      .prepare(
        `SELECT rider_id, type, status, sent_at FROM prompts
         WHERE answered_at IS NULL AND sent_at >= ? ORDER BY sent_at ASC`
      )
      .bind(now - 2 * 60 * MIN)
      .all(),
    db.prepare("SELECT rider_id, lat, lng, accuracy, updated_at FROM locations").all(),
    db
      .prepare("SELECT DISTINCT rider_id FROM devices WHERE push_subscription IS NOT NULL")
      .all(),
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

  const byRider = (rows, key = "rider_id") => {
    const m = new Map();
    for (const r of rows.results || []) m.set(r[key], r);
    return m;
  };
  const orderMap = byRider(orders);
  const locMap = byRider(locs);
  const pushSet = new Set((pushes.results || []).map((r) => r.rider_id));
  const deliveredMap = byRider(delivered);
  const missedMap = byRider(missed);
  const openMap = new Map(); // آخر سؤال مفتوح لكل مندوب (الترتيب تصاعدي فالأخير يكسب)
  for (const p of opens.results || []) openMap.set(p.rider_id, p);

  const list = (riders.results || []).map((r) => {
    const o = orderMap.get(r.id) || null;
    const l = locMap.get(r.id) || null;
    const p = openMap.get(r.id) || null;
    return {
      id: r.id,
      name: r.name,
      state: o ? o.stage : "idle",
      order: o
        ? { declared_at: o.declared_at, arrived_at: o.arrived_at, picked_at: o.picked_at }
        : null,
      loc: l ? { lat: l.lat, lng: l.lng, at: l.updated_at, accuracy: l.accuracy } : null,
      prompt: p ? { type: p.type, status: p.status, sent_at: p.sent_at } : null,
      late: !!(p && p.status === "missed"),
      push: pushSet.has(r.id),
      delivered_today: deliveredMap.has(r.id) ? deliveredMap.get(r.id).n : 0,
      missed_today: missedMap.has(r.id) ? missedMap.get(r.id).n : 0,
    };
  });

  const stats = {
    total: list.length,
    with_order: list.filter((r) => r.state !== "idle").length,
    delivered_today: list.reduce((s, r) => s + r.delivered_today, 0),
    late: list.filter((r) => r.late).length,
    push_off: list.filter((r) => !r.push).length,
  };

  return { ok: true, now, stats, riders: list, events: events.results || [] };
}

async function adminAddRiders(env, body) {
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
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO riders (id, name) VALUES (?, ?)").bind(id, name || id)
    );
  }
  let added = 0;
  if (stmts.length) {
    const res = await env.DB.batch(stmts);
    added = res.reduce((s, x) => s + ((x.meta && x.meta.changes) || 0), 0);
  }
  return { ok: true, added, existing: stmts.length - added, invalid };
}

/* ---------------------------- المسارات ---------------------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const now = Date.now();

    /* ---- المندوب ---- */
    if (path === "/api/login" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false, error: "بيانات غير صحيحة" }, 400);

      const id = String(body.id || "").trim();
      if (!id) return json({ ok: false, error: "اكتب رقم المندوب" }, 400);

      const rider = await env.DB
        .prepare("SELECT id, name FROM riders WHERE id = ? AND active = 1")
        .bind(id)
        .first();
      if (!rider) return json({ ok: false, error: "غير مسجّل" }, 404);

      const token = crypto.randomUUID();
      await env.DB
        .prepare("INSERT INTO devices (rider_id, token) VALUES (?, ?)")
        .bind(rider.id, token)
        .run();
      return json({ ok: true, token, rider: { id: rider.id, name: rider.name } });
    }

    if (path === "/api/me" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return json({ ok: false }, 401);
      const rider = await env.DB
        .prepare("SELECT id, name FROM riders WHERE id = ?")
        .bind(device.rider_id)
        .first();
      const state = await riderState(env, device.rider_id, now);
      return json({ ok: true, rider, pushEnabled: !!device.push_enabled, ...state });
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
      if (!device) return json({ ok: false, error: "غير مصرح" }, 401);
      const loc = parseLoc(body);
      if (!loc) return json({ ok: false, error: "موقع غير صحيح" }, 400);
      await upsertLocation(env, device.rider_id, loc, now).run();
      return json({ ok: true });
    }

    /* ---- الإشعارات ---- */
    if (path === "/api/vapid-key" && request.method === "GET") {
      return json({ ok: true, key: env.VAPID_PUBLIC_KEY });
    }

    if (path === "/api/subscribe" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || !body.subscription || !body.subscription.endpoint) {
        return json({ ok: false, error: "اشتراك غير صحيح" }, 400);
      }
      const device = await getDevice(env, body.token);
      if (!device) return json({ ok: false, error: "غير مصرح" }, 401);

      const endpoint = String(body.subscription.endpoint);
      await env.DB.batch([
        // الجهاز الواحد يتبع مندوب واحد بس
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

    // الـ Service Worker بيسأل: إيه نص الإشعار اللي وصل؟
    if (path === "/api/pending" && request.method === "POST") {
      const body = await readBody(request);
      const endpoint = body && body.endpoint ? String(body.endpoint) : "";
      if (!endpoint) return json({ ok: false }, 400);
      const dev = await env.DB
        .prepare(
          `SELECT rider_id FROM devices WHERE push_subscription IS NOT NULL
           AND json_extract(push_subscription, '$.endpoint') = ? ORDER BY id DESC LIMIT 1`
        )
        .bind(endpoint)
        .first();
      if (!dev) return json({ ok: true, prompt: null });
      const state = await riderState(env, dev.rider_id, now);
      const p = state.prompt && PROMPTS[state.prompt.type];
      return json({ ok: true, prompt: p || null });
    }

    if (path === "/api/test-push" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);
      const device = await getDevice(env, body.token);
      if (!device) return json({ ok: false, error: "غير مصرح" }, 401);
      const row = await env.DB
        .prepare("SELECT push_subscription FROM devices WHERE id = ?")
        .bind(device.id)
        .first();
      if (!row || !row.push_subscription) {
        return json({ ok: false, error: "الإشعارات غير مفعّلة على الجهاز ده" }, 400);
      }
      const status = await sendPush(JSON.parse(row.push_subscription), env, 60);
      if (status === 404 || status === 410) {
        await env.DB
          .prepare("UPDATE devices SET push_subscription = NULL WHERE id = ?")
          .bind(device.id)
          .run();
        return json({ ok: false, error: "اشتراك الجهاز انتهى، فعّل الإشعارات من جديد" }, 410);
      }
      if (status < 200 || status >= 300) {
        return json({ ok: false, error: "فشل الإرسال (" + status + ")" }, 502);
      }
      return json({ ok: true });
    }

    /* ---- الإدارة ---- */
    if (path.startsWith("/api/admin/")) {
      const auth = await isAdmin(request, env);
      if (auth === null) return json({ ok: false, error: "ADMIN_KEY غير مضبوط في Cloudflare" }, 503);
      if (!auth) return json({ ok: false, error: "مفتاح الإدارة غير صحيح" }, 401);

      if (path === "/api/admin/overview" && request.method === "GET") {
        return json(await adminOverview(env, now));
      }
      if (path === "/api/admin/riders" && request.method === "POST") {
        const body = await readBody(request);
        if (!body) return json({ ok: false }, 400);
        return json(await adminAddRiders(env, body));
      }
      return json({ ok: false, error: "غير موجود" }, 404);
    }

    if (path.startsWith("/api/")) {
      return json({ ok: false, error: "غير موجود" }, 404);
    }

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
