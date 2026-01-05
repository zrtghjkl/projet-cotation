import { connectLambda, getStore } from "@netlify/blobs";

const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';
const YAHOO_API = 'https://query1.finance.yahoo.com/v8/finance/chart';

export const handler = async (event) => {
  // ✅ Détecte si c'est un appel CRON ou manuel
  const isCron = event.headers?.['x-nf-scheduled'] === 'true';
  const source = isCron ? 'CRON' : 'MANUAL';
  
  console.log(`[REFRESH] 🚀 Démarrage (source: ${source})`);

  connectLambda(event);
  const store = getStore("ticker-cache");

  try {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 1️⃣ LIRE LE CACHE ACTUEL (dernier cours connu)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let currentData = {};
    try {
      const raw = await store.get("latest");
      if (raw) {
        const cached = JSON.parse(raw);
        currentData = cached.data || {};
        const age = Date.now() - new Date(cached.timestamp).getTime();
        console.log(`[REFRESH] 💾 Cache actuel: ${Math.round(age / 1000)}s`);
      }
    } catch (e) {
      console.log("[REFRESH] ℹ️ Aucun cache existant");
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 2️⃣ RÉCUPÉRER LES NOUVEAUX COURS
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const [cryptoData, stocksData] = await Promise.all([
      fetchCryptoPrices(),
      fetchStockPrices()
    ]);

    console.log("[REFRESH] 📊 Cryptos:", Object.keys(cryptoData));
    console.log("[REFRESH] 📊 Actions:", Object.keys(stocksData));

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 3️⃣ FUSION : Nouveau cours > Ancien cours
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const mergedData = { ...currentData };
    let updateCount = 0;

    // Cryptos (toujours live 24/7)
    Object.keys(cryptoData).forEach(key => {
      if (cryptoData[key]?.currentPrice !== null) {
        mergedData[key] = cryptoData[key];
        updateCount++;
        console.log(`[REFRESH] ✅ ${key} = $${cryptoData[key].currentPrice} (crypto)`);
      }
    });

    // Actions (seulement si prix frais < 1h)
    Object.keys(stocksData).forEach(key => {
      if (stocksData[key] !== null && stocksData[key]?.currentPrice !== null) {
        mergedData[key] = stocksData[key];
        updateCount++;
        console.log(`[REFRESH] ✅ ${key} = $${stocksData[key].currentPrice} (action)`);
      } else if (mergedData[key]) {
        console.log(`[REFRESH] ⚠️ ${key} = $${mergedData[key].currentPrice} (cache)`);
      }
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 4️⃣ SAUVEGARDE DANS LE BLOB (TOUJOURS)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const payload = {
      success: true,
      timestamp: new Date().toISOString(),
      data: mergedData,
      meta: {
        source: source,
        updated: updateCount,
        total: Object.keys(mergedData).length
      }
    };

    await store.set("latest", JSON.stringify(payload));

    console.log(`[REFRESH] ✅ Blob sauvegardé (${updateCount}/${Object.keys(mergedData).length} mis à jour)`);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        timestamp: payload.timestamp,
        updated: updateCount,
        total: Object.keys(mergedData).length
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
// CRYPTOS (Bitcoin, Ethereum) - 24/7
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
    console.error("[CRYPTO] ❌", error.message);
    return {};
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ACTIONS (MARA, MSTR, etc.) - Avec vérification fraîcheur
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchStockPrices() {
  const symbols = ['MARA', 'MSTR', 'BTBT', 'PYPL', 'BITF', 'BMNR'];
  const results = {};
  const now = Date.now() / 1000;

  for (const symbol of symbols) {
    try {
      const response = await fetch(
        `${YAHOO_API}/${symbol}?interval=1d&range=2d`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const quote = data?.chart?.result?.[0];
      const meta = quote?.meta;
      const prices = quote?.indicators?.quote?.[0];

      if (meta && prices) {
        const currentPrice = meta.regularMarketPrice || prices.close?.[prices.close.length - 1];
        const previousClose = meta.chartPreviousClose || meta.previousClose;
        const marketTime = meta.regularMarketTime;

        // 🔥 Vérification : Prix frais (< 1 heure) ?
        const ageSeconds = now - marketTime;
        const ageMinutes = Math.round(ageSeconds / 60);
        const isFresh = ageSeconds < 3600; // < 1 heure

        console.log(`[${symbol}] $${currentPrice} | Âge: ${ageMinutes}min | Frais: ${isFresh}`);

        if (isFresh) {
          // ✅ Prix récent (marché ouvert)
          const changePct = previousClose 
            ? ((currentPrice - previousClose) / previousClose) * 100 
            : 0;

          results[symbol.toLowerCase()] = {
            currentPrice: currentPrice,
            changeDayPct: changePct,
            isEuro: false
          };
        } else {
          // ⚠️ Prix obsolète (marché fermé) → On garde l'ancien
          results[symbol.toLowerCase()] = null;
        }
      }

    } catch (error) {
      console.error(`[${symbol}] ❌`, error.message);
      results[symbol.toLowerCase()] = null;
    }
  }

  return results;
}
