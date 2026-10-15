self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// مطلوب علشان أندرويد يعتبر الموقع تطبيق قابل للتثبيت (بيسيب الطلبات تعدي عادي)
self.addEventListener("fetch", () => {});

// الإشعار بيوصل فاضي، فبنسأل السيرفر إيه السؤال المطلوب ونعرضه
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let title = "متابعة المناديب";
      let body = "عندك سؤال جديد، افتح التطبيق للرد.";
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub) {
          const res = await fetch("/api/pending", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
          const data = await res.json();
          if (data && data.ok && data.prompt) {
            title = data.prompt.title;
            body = data.prompt.body;
          }
        }
      } catch (e) {
        /* بنعرض النص الافتراضي */
      }
      // لازم نعرض إشعار في كل مرة، وإلا آيفون بيوقف الاشتراك
      await self.registration.showNotification(title, {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: "rider-prompt",
        renotify: true,
        data: { url: "/" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          return;
        }
      }
      await self.clients.openWindow("/");
    })()
  );
});
