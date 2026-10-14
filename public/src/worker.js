const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/login" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "بيانات غير صحيحة" }, 400);
      }

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

    if (url.pathname === "/api/me" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false }, 400);
      }

      const token = String(body.token || "");
      const row = await env.DB
        .prepare(
          `SELECT r.id, r.name FROM devices d
           JOIN riders r ON r.id = d.rider_id
           WHERE d.token = ? AND r.active = 1`
        )
        .bind(token)
        .first();

      if (!row) return json({ ok: false }, 401);
      return json({ ok: true, rider: row });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "غير موجود" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
