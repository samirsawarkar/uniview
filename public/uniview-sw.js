// UniView service worker: serves /__uniview_stream/<id>/<name> range requests by asking the page that owns the
// stream for decrypted bytes. Every other request passes through untouched; nothing is cached.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function parseRange(header) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header || "");
  if (!m) return { start: 0, end: null };
  return { start: Number(m[1]), end: m[2] === "" ? null : Number(m[2]) };
}

function askPage(client, id, start, end) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({ status: 504 }), 30000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    client.postMessage({ type: "uniview-stream-read", id, start, end }, [channel.port2]);
  });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const at = url.pathname.indexOf("/__uniview_stream/");
  if (at < 0) return;
  const id = url.pathname.slice(at + "/__uniview_stream/".length).split("/")[0];
  event.respondWith(
    (async () => {
      const clientId = event.clientId || event.resultingClientId;
      let client = clientId ? await self.clients.get(clientId) : null;
      if (!client) client = (await self.clients.matchAll({ type: "window" }))[0];
      if (!client) return new Response("No page", { status: 503 });
      const { start, end } = parseRange(event.request.headers.get("range"));
      const r = await askPage(client, id, start, end);
      if (r.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${r.size}` } });
      if (r.status !== 206) return new Response(r.error || "Stream unavailable", { status: r.status || 502 });
      return new Response(r.bytes, {
        status: 206,
        headers: {
          "Content-Type": r.type,
          "Content-Range": `bytes ${r.start}-${r.end}/${r.size}`,
          "Content-Length": String(r.end - r.start + 1),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    })(),
  );
});
