import { connectLambda, getStore } from "@netlify/blobs";

// ✅ Tes APIs (adapte selon tes besoins)
const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';
const YAHOO_API = 'https://query1.finance.yahoo.com/v8/finance/chart';

export const handler = async (event) => {
  console.log("[REFRESH] 🚀 Démarrage du refresh...");

  connectLambda(event);
  const store = getStore("ticker-cache");

  try {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 1️⃣ RÉCUPÉRER LES COURS EN TEMPS RÉEL
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const [cryptoData, stocksData] = await Promise.all([
      fetchCryptoPrices(),
      fetchStockPrices()
    ]);

    const allData = {
      ...cryptoData,
      ...stocksData
    };

    console.log("[REFRESH] 📊 Données récupérées:", Object.keys(allData));

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 2️⃣ SAUVEGARDER DANS LE BLOB (= DERNIER COURS CONNU)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const payload = {
      success: true,
      timestamp: new Date().toISOString(),
      data: allData
    };

    await store.set("latest", JSON.stringify(payload));

    console.log("[REFRESH] ✅ Blob mis à jour avec succès");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        timestamp: payload.timestamp,
        count: Object.keys(allData).length
      })
    };

  } catch (error) {
    console.error("[REFRESH] ❌ Erreur:", error);

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FONCTION : RÉCUPÉRER LES CRYPTOS (Bitcoin, Ethereum)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchCryptoPrices() {
  try {
    const response = await fetch(
      `${COINGECKO_API}?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!response.ok) throw new Error(`CoinGecko: ${response.status}`);

    const data = await response.json();

    return {
      bitcoin: {
        currentPrice: data.bitcoin?.usd || null,
        change24h: data.bitcoin?.usd_24h_change || null,
        isEuro: false
      },
      ethereum: {
        currentPrice: data.ethereum?.usd || null,
        change24h: data.ethereum?.usd_24h_change || null,
        isEuro: false
      }
    };

  } catch (error) {
    console.error("[REFRESH] ❌ CoinGecko error:", error.message);
    return {};
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FONCTION : RÉCUPÉRER LES ACTIONS (MARA, MSTR, etc.)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchStockPrices() {
  const symbols = ['MARA', 'MSTR', 'BTBT', 'PYPL', 'BITF'];
  const results = {};

  try {
    const promises = symbols.map(async (symbol) => {
      try {
        const response = await fetch(
          `${YAHOO_API}/${symbol}?interval=1d&range=2d`,
          { signal: AbortSignal.timeout(5000) }
        );

        if (!response.ok) throw new Error(`Yahoo: ${response.status}`);

        const data = await response.json();
        const quote = data?.chart?.result?.[0];
        const meta = quote?.meta;
        const prices = quote?.indicators?.quote?.[0];

        if (meta && prices) {
          const currentPrice = meta.regularMarketPrice || prices.close?.[prices.close.length - 1];
          const previousClose = meta.chartPreviousClose || meta.previousClose;
          
          const changePct = previousClose 
            ? ((currentPrice - previousClose) / previousClose) * 100 
            : 0;

          results[symbol.toLowerCase()] = {
            currentPrice: currentPrice || null,
            changeDayPct: changePct || null,
            isEuro: false
          };
        }

      } catch (error) {
        console.error(`[REFRESH] ❌ ${symbol} error:`, error.message);
      }
    });

    await Promise.allSettled(promises);

  } catch (error) {
    console.error("[REFRESH] ❌ Stocks error:", error.message);
  }

  return results;
}
```

---

## 🎯 **LOGIQUE FINALE**

### **Scénario 1 : Marché ouvert (lundi 14h)**
```
1. Cache vieux de 10 min → isStale = true
2. Appel ticker-refresh → Récupère cours live
3. Sauvegarde dans Blob
4. Renvoie données LIVE (source: "live")
```

### **Scénario 2 : Marché fermé (samedi 14h)**
```
1. Cache vieux de 10 min → isStale = true
2. Appel ticker-refresh → APIs renvoient "market closed"
3. Blob NON mis à jour (garde dernier cours de vendredi)
4. Renvoie données CACHED (source: "cached")
```

### **Scénario 3 : Premier démarrage (pas de cache)**
```
1. Aucun cache → cachedData = null
2. Appel ticker-refresh → Récupère cours live
3. Sauvegarde dans Blob
4. Renvoie données LIVE (source: "live")
