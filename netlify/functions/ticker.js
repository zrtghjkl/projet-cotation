import { connectLambda, getStore } from "@netlify/blobs";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "Surrogate-Control": "no-store",
};

const TTL_MS = 300_000; // 5 minutes

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  connectLambda(event);
  const store = getStore("ticker-cache");

  let payload = null;

  try {
    const raw = await store.get("latest");
    if (raw) payload = JSON.parse(raw);
  } catch {}

  const now = Date.now();
  const lastTs = payload?.timestamp ? new Date(payload.timestamp).getTime() : 0;
  const isStale = !lastTs || now - lastTs > TTL_MS;

  // 🔥 Si cache vieux -> on déclenche un refresh côté serveur
  if (isStale) {
    try {
      await fetch(
        `https://${event.headers.host}/.netlify/functions/ticker-refresh`,
        { headers: { "x-nf-scheduled": "true" } }
      );

      const refreshed = await store.get("latest");
      if (refreshed) payload = JSON.parse(refreshed);
    } catch (e) {
      // si refresh échoue, on sert quand même ce qu'on a
      console.log("AUTO-REFRESH ERROR:", e?.message || String(e));
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(payload || { success: false, data: {} }),
  };
};
