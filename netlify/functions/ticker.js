import { connectLambda, getStore } from "@netlify/blobs";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "public, s-maxage=0, max-age=0, must-revalidate",
  "Netlify-CDN-Cache-Control": "public, s-maxage=0, max-age=0, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
};

const TTL_MS = 300_000; // 5 minutes
const REFRESH_TIMEOUT = 10_000; // 10 secondes max

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  connectLambda(event);
  const store = getStore("ticker-cache");

  const now = Date.now();
  let cachedData = null;
  let liveData = null;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1️⃣ LECTURE DU CACHE (DERNIER COURS CONNU)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  try {
    const raw = await store.get("latest");
    if (raw) {
      cachedData = JSON.parse(raw);
      console.log("[TICKER] 💾 Cache chargé:", cachedData.timestamp);
    }
  } catch (e) {
    console.error("[TICKER] ❌ Erreur lecture cache:", e?.message);
  }

  const cacheAge = cachedData?.timestamp 
    ? now - new Date(cachedData.timestamp).getTime() 
    : Infinity;
  
  const isStale = cacheAge > TTL_MS;

  console.log(`[TICKER] Cache age: ${Math.round(cacheAge / 1000)}s | Stale: ${isStale}`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2️⃣ SI CACHE PÉRIMÉ → TENTER REFRESH LIVE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (isStale) {
    console.log("[TICKER] 🔄 Cache obsolète → Tentative refresh live...");

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REFRESH_TIMEOUT);

      const refreshResponse = await fetch(
        `https://${event.headers.host}/.netlify/functions/ticker-refresh`,
        {
          method: "POST",
          headers: { 
            "x-nf-scheduled": "true",
            "Content-Type": "application/json"
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (refreshResponse.ok) {
        const refreshResult = await refreshResponse.json();
        
        if (refreshResult.success) {
          // ✅ REFRESH RÉUSSI → RELIRE LE BLOB MIS À JOUR
          const freshRaw = await store.get("latest");
          if (freshRaw) {
            liveData = JSON.parse(freshRaw);
            console.log("[TICKER] ✅ Données LIVE récupérées:", liveData.timestamp);
          }
        }
      }

    } catch (e) {
      if (e.name === 'AbortError') {
        console.error("[TICKER] ⏱️ Refresh timeout");
      } else {
        console.error("[TICKER] ❌ Refresh error:", e?.message);
      }
      // On continue avec le cache
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3️⃣ LOGIQUE DE PRIORITÉ : LIVE > CACHE > VIDE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let finalData = null;
  let dataSource = "none";

  if (liveData && liveData.data) {
    // ✅ PRIORITÉ 1 : Données live (marché ouvert)
    finalData = liveData;
    dataSource = "live";
  } else if (cachedData && cachedData.data) {
    // ✅ PRIORITÉ 2 : Dernier cours connu (marché fermé)
    finalData = cachedData;
    dataSource = "cached";
  } else {
    // ❌ PRIORITÉ 3 : Aucune donnée disponible
    finalData = {
      success: false,
      timestamp: new Date().toISOString(),
      data: {}
    };
    dataSource = "empty";
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4️⃣ RÉPONSE AVEC MÉTADONNÉES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const response = {
    success: !!finalData.data && Object.keys(finalData.data).length > 0,
    data: finalData.data || {},
    meta: {
      timestamp: finalData.timestamp,
      source: dataSource, // "live", "cached", ou "empty"
      age: finalData.timestamp 
        ? Math.round((now - new Date(finalData.timestamp).getTime()) / 1000)
        : null,
      serverTime: new Date().toISOString()
    }
  };

  console.log(`[TICKER] 📤 Réponse envoyée (source: ${dataSource})`);

  return {
    statusCode: 200,
    headers: {
      ...headers,
      "X-Data-Source": dataSource,
      "X-Cache-Age": response.meta.age ? String(response.meta.age) : "0"
    },
    body: JSON.stringify(response)
  };
};
