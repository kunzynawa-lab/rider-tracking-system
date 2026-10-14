const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

/* ---------- base64url helpers ---------- */
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

/* ---------- Web Push (VAPID) ---------- */
async function vapidAuthHeader(endpoint, env) {
  const pub = b64u.toBytes(env.VAPID_PUBLIC_KEY);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64u.fromBytes(pub.slice(1, 33)),
    y: b64u.fromBytes(pub.slice(33, 65)),
    d: env.VAPID_PRIVATE_KEY,
    ext: true,
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const enc = new TextEncoder();
  const header = b64u.fromBytes(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u.fromBytes(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: env.VAPID_SUBJECT,
      })
    )
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(header + "." + payload)
  );
  return `vapid t=${header}.${payload}.${b64u.fromBytes(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// إرسال إشعار بدون محتوى (الـ Service Worker بيعرض النص الافتراضي)
async function sendPush(subscription, env) {
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthHeader(subscription.endpoint, env),
      TTL: "60",
      Urgency: "high",
    },
  });
  return res.status;
}

/* ---------- DB helpers ---------- */
async function getDevice(env, token) {
  return env.DB
    .prepare(
      `SELECT d.id, d.rider_id, d.push_subscription FROM devices d
       JOIN riders r ON r.id = d.rider_id
       WHERE d.token = ? AND r.active = 1`
    )
    .bind(String(token || ""))
    .first();
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

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

      const row = await env.DB
        .prepare(
          `SELECT r.id, r.name, d.push_subscription IS NOT NULL AS push_enabled
           FROM devices d JOIN riders r ON r.id = d.rider_id
           WHERE d.token = ? AND r.active = 1`
        )
        .bind(String(body.token || ""))
        .first();

      if (!row) return json({ ok: false }, 401);
      return json({
        ok: true,
        rider: { id: row.id, name: row.name },
        pushEnabled: !!row.push_enabled,
      });
    }

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

      await env.DB
        .prepare("UPDATE devices SET push_subscription = ? WHERE id = ?")
        .bind(JSON.stringify(body.subscription), device.id)
        .run();

      return json({ ok: true });
    }

    if (path === "/api/test-push" && request.method === "POST") {
      const body = await readBody(request);
      if (!body) return json({ ok: false }, 400);

      const device = await getDevice(env, body.token);
      if (!device) return json({ ok: false, error: "غير مصرح" }, 401);
      if (!device.push_subscription) {
        return json({ ok: false, error: "الإشعارات غير مفعّلة على الجهاز ده" }, 400);
      }

      const status = await sendPush(JSON.parse(device.push_subscription), env);

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

    if (path.startsWith("/api/")) {
      return json({ ok: false, error: "غير موجود" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
