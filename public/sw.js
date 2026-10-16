/* Rider Tracking - service worker
   - shows the "live" notification; while an order is open it stays pinned (best effort)
   - the page keeps it in sync after each step */
const TAG = "rider-live";
const ICON = "/icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
// Required for the browser to treat the site as an installable app
self.addEventListener("fetch", () => {});

/* ---- tiny key/value store (the page saves the rider token here) ---- */
function kv() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("rider-sw", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kvGet(key) {
  try {
    const db = await kv();
    return await new Promise((res) => {
      const q = db.transaction("kv").objectStore("kv").get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(undefined);
    });
  } catch {
    return undefined;
  }
}
async function kvSet(key, value) {
  try {
    const db = await kv();
    await new Promise((res) => {
      const tx = db.transaction("kv", "readwrite");
      if (value === null || value === undefined) tx.objectStore("kv").delete(key);
      else tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch {
    /* ignore */
  }
}

const FALLBACK = {
  kind: "none",
  sticky: false,
  title: "متابعة المناديب",
  body: "Rider Tracking",
  actions: [],
  dir: "auto",
  lang: "ar",
};

async function fetchNotice() {
  try {
    const token = await kvGet("token");
    const body = token ? { token } : {};
    if (!token) {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) body.endpoint = sub.endpoint;
    }
    const res = await fetch("/api/notice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data && data.ok && data.notice) return data.notice;
  } catch {
    /* fall through */
  }
  return null;
}

async function show(n) {
  const opts = {
    body: n.body,
    icon: ICON,
    badge: ICON,
    tag: TAG,
    renotify: !n.sticky || n.kind === "prompt",
    requireInteraction: !!n.sticky || n.kind === "prompt",
    dir: n.dir || "auto",
    lang: n.lang || "ar",
    data: { url: "/", kind: n.kind, sticky: !!n.sticky },
  };
  const actions = (n.actions || []).slice(0, 2).map((a) => ({ action: a.action, title: a.title }));
  if (actions.length) opts.actions = actions;
  try {
    await self.registration.showNotification(n.title, opts);
  } catch {
    delete opts.actions;
    await self.registration.showNotification(n.title, opts);
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const n = (await fetchNotice()) || FALLBACK;
      // Always show something, otherwise iOS stops the subscription
      await show(n);
    })()
  );
});

// The page tells us the state changed: refresh or clear the pinned notification
self.addEventListener("message", (event) => {
  const d = event.data || {};
  event.waitUntil(
    (async () => {
      if (d.type === "token") {
        await kvSet("token", d.token || null);
        return;
      }
      if (d.type === "sync") {
        if (d.token) await kvSet("token", d.token);
        const n = d.notice || (await fetchNotice());
        const current = await self.registration.getNotifications({ tag: TAG });
        if (!n || n.kind === "none") {
          current.forEach((x) => x.close());
          return;
        }
        // update the pinned one only if something is showing or an order is open
        if (current.length || n.sticky) await show({ ...n, renotify: false });
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  const action = event.action || "";
  event.notification.close();
  event.waitUntil(
    (async () => {
      const target = action ? "/?do=" + encodeURIComponent(action) : "/";
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          if (action) w.postMessage({ type: "do", action });
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});

// Swiped away while the order is still open: bring it back (best effort)
self.addEventListener("notificationclose", (event) => {
  const d = event.notification.data || {};
  if (!d.sticky) return;
  event.waitUntil(
    (async () => {
      const n = await fetchNotice();
      if (n && n.sticky) await show({ ...n, renotify: false });
    })()
  );
});
