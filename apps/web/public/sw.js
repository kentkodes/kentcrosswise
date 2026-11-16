// Service worker for web push (scope "/"). The payload is generic text from the server: {title, body, url}.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// A path on this origin, or /inbox for anything else (the server only ever sends "/inbox").
function sameOriginPath(value) {
  if (typeof value !== "string") return "/inbox";
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : "/inbox";
  } catch {
    return "/inbox";
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Kentcrosswise";
  const body = typeof data.body === "string" ? data.body : "";
  const url = sameOriginPath(data.url);
  event.waitUntil(
    self.registration.showNotification(title, { body, data: { url }, icon: "/icon-192.png", badge: "/icon-192.png", tag: "kcw-inbox" }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(sameOriginPath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((all) => {
      for (const client of all) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          return client.focus().then((c) => ("navigate" in c ? c.navigate(target) : c));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
