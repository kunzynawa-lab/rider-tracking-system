self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// الإشعار بيوصل بدون محتوى حاليًا، فبنعرض نص افتراضي
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "متابعة المناديب", {
      body: data.body || "عندك إشعار جديد، افتح التطبيق للرد.",
      icon: "/icon.svg",
      data: data,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/"));
});
