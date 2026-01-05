import { connectLambda, getStore } from "@netlify/blobs";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "public, s-maxage=0, max-age=0, must-revalidate",
  "Netlify-CDN-Cache-Control": "public, s-maxage=0, max-age=0, must-revalidate",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  connectLambda(event);
  const store = getStore("ticker-cache");

  try {
    // ✅ LECTURE DU BLOB (mis à jour par le CRON)
    const raw = await store.get("latest");
    
    if (!raw) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: "Aucune donnée disponible" 
        })
      };
    }

    const payload = JSON.parse(raw);
    const age = Date.now() - new Date(payload.timestamp).getTime();

    console.log(`[TICKER] 📦 Blob lu (âge: ${Math.round(age / 1000)}s)`);

    return {
      statusCode: 200,
      headers: {
        ...headers,
        "X-Cache-Age": String(Math.round(age / 1000)),
        "X-Data-Source": payload.meta?.source || "unknown"
      },
      body: JSON.stringify(payload)
    };

  } catch (error) {
    console.error("[TICKER] ❌", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: error.message 
      })
    };
  }
};
```

---

## 🎯 **COMMENT ÇA MARCHE MAINTENANT**

### **Scénario 1 : Vendredi 20h59 (juste avant clôture)**
```
🤖 CRON exécute ticker-refresh.js
↓
Yahoo Finance renvoie : MARA = $18.45 (frais < 1h)
↓
💾 BLOB sauvegardé avec MARA = $18.45
```

### **Scénario 2 : Vendredi 21h05 (marché fermé)**
```
🤖 CRON exécute ticker-refresh.js
↓
Yahoo Finance renvoie : MARA = $18.45 (obsolète > 1h)
↓
⚠️ Prix ignoré (garde l'ancien du blob)
↓
💾 BLOB garde MARA = $18.45 (cours de clôture)
```

### **Scénario 3 : Samedi 14h (marché fermé)**
```
👤 Client ouvre le site
↓
ticker.js lit le BLOB
↓
✅ Affiche MARA = $18.45 (dernier cours du vendredi)
✅ Affiche BTC = $96234.12 (cours live du samedi)
