import { connectLambda, getStore } from "@netlify/blobs";

const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';
const YAHOO_API = 'https://query1.finance.yahoo.com/v8/finance/chart';

export const handler = async (event) => {
  const isCron = event.headers?.['x-nf-scheduled'] === 'true';
  const source = isCron ? 'CRON' : 'MANUAL';
  
  console.log(`[REFRESH] 🚀 Démarrage (source: ${source})`);

  connectLambda(event);
  const store = getStore("ticker-cache");

  try {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 1️⃣ LIRE LE CACHE ACTUEL (TOUJOURS)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let cachedData = {};
    try {
      const raw = await store.get("latest");
      if (raw) {
        const cached = JSON.parse(raw);
        cachedData = cached.data || {};
        console.log(`[REFRESH] 💾 Cache chargé: ${Object.keys(cachedData).length} actifs`);
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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 3️⃣ FUSION INTELLIGENTE
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const finalData = { ...cachedData }; // On part du cache
    let updateCount = 0;

    // 🔥 CRYPTOS : TOUJOURS prioritaires (remplace TOUJOURS le cache)
    Object.keys(cryptoData).forEach(key => {
      if (cryptoData[key]?.currentPrice !== null && cryptoData[key]?.currentPrice !== undefined) {
        finalData[key] = cryptoData[key];
        updateCount++;
        console.log(`[REFRESH] ✅ ${key.toUpperCase()} = $${cryptoData[key].currentPrice} (NOUVEAU)`);
      } else if (cachedData[key]) {
        console.log(`[REFRESH] ⚠️ ${key.toUpperCase()} = $${cachedData[key].currentPrice} (CACHE - API FAILED)`);
      }
    });

    // 🔥 ACTIONS : Nouveau cours > Ancien cours, sinon garde l'ancien
    Object.keys(stocksData).forEach(key => {
      if (stocksData[key]?.currentPrice !== null && stocksData[key]?.currentPrice !== undefined) {
        // ✅ Nouveau cours disponible
        finalData[key] = stocksData[key];
        updateCount++;
        const currency = stocksData[key].isEuro ? '€' : '$';
        console.log(`[REFRESH] ✅ ${key.toUpperCase()} = ${currency}${stocksData[key].currentPrice} (NOUVEAU)`);
      } else if (cachedData[key]) {
        // ⏸️ Pas de nouveau cours, on garde l'ancien
        const currency = cachedData[key].isEuro ? '€' : '$';
        console.log(`[REFRESH] ⏸️ ${key.toUpperCase()} = ${currency}${cachedData[key].currentPrice} (CACHE - Marché fermé)`);
      } else {
        // ❌ Ni nouveau ni cache (première fois)
        console.log(`[REFRESH] ❌ ${key.toUpperCase()} = Pas de données disponibles`);
      }
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 4️⃣ SAUVEGARDE (TOUJOURS)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const payload = {
      success: true,
      timestamp: new Date().toISOString(),
      data: finalData,
      meta: {
        source: source,
        updated: updateCount,
        total: Object.keys(finalData).length
      }
    };

    await store.set("latest", JSON.stringify(payload));

    console.log(`[REFRESH] 💾 Sauvegardé: ${updateCount} nouveaux / ${Object.keys(finalData).length} total`);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        timestamp: payload.timestamp,
        updated: updateCount,
        total: Object.keys(finalData).length
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
// CRYPTOS (TOUJOURS 24/7)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchCryptoPrices() {
  try {
    const response = await fetch(
      `${COINGECKO_API}?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!response.ok) {
      throw new Error(`CoinGecko HTTP ${response.status}`);
    }

    const data = await response.json();
    
    console.log("[CRYPTO] Réponse CoinGecko:", JSON.stringify(data));

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
    console.error("[CRYPTO] ❌ Erreur:", error.message);
    // Retourne des objets vides (pas null) pour trigger le fallback au cache
    return {
      bitcoin: { currentPrice: null },
      ethereum: { currentPrice: null }
    };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ACTIONS (Nouveau si dispo, sinon cache)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchStockPrices() {
  const symbols = ['MARA', 'MSTR', 'BTBT', 'PYPL', 'BITF', 'BMNR', 'BTC.MI'];
  const results = {};

  for (const symbol of symbols) {
    try {
      const response = await fetch(
        `${YAHOO_API}/${symbol}?interval=1m&range=1d`,
        { signal: AbortSignal.timeout(8000) }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const quote = data?.chart?.result?.[0];
      const meta = quote?.meta;
      const prices = quote?.indicators?.quote?.[0];

      if (meta && prices) {
        const currentPrice = meta.regularMarketPrice || prices.close?.[prices.close.length - 1];
        const previousClose = meta.chartPreviousClose || meta.previousClose;

        if (currentPrice) {
          const changePct = previousClose 
            ? ((currentPrice - previousClose) / previousClose) * 100 
            : 0;

          // 🔥 Renomme BTC.MI en "melanion" pour éviter confusion avec Bitcoin
          const key = symbol === 'BTC.MI' ? 'melanion' : symbol.toLowerCase();
          const isEuro = symbol.endsWith('.MI') || symbol.endsWith('.PA');

          results[key] = {
            currentPrice: currentPrice,
            changeDayPct: changePct,
            isEuro: isEuro
          };
          
          const currency = isEuro ? '€' : '$';
          console.log(`[${symbol}] ✅ ${currency}${currentPrice}`);
        } else {
          const key = symbol === 'BTC.MI' ? 'melanion' : symbol.toLowerCase();
          results[key] = { currentPrice: null };
          console.log(`[${symbol}] ⚠️ Pas de prix disponible`);
        }
      } else {
        const key = symbol === 'BTC.MI' ? 'melanion' : symbol.toLowerCase();
        results[key] = { currentPrice: null };
      }

    } catch (error) {
      console.error(`[${symbol}] ❌`, error.message);
      const key = symbol === 'BTC.MI' ? 'melanion' : symbol.toLowerCase();
      results[key] = { currentPrice: null };
    }
  }

  return results;
}
