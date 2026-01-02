import { connectLambda, getStore } from "@netlify/blobs";

/* =========================
   OUTILS
========================= */

const fetchWithTimeout = async (url, ms = 9000) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
  } finally {
    clearTimeout(t);
  }
};

// Stooq quote CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
const parseStooqQuoteCSV = (csvText) => {
  const text = (csvText || "").trim();
  const lines = text.split("\n");
  if (lines.length < 2) return null;

  const row = lines[1].split(",");
  if (row.length < 8) return null;

  const [symbol, date, time, open, high, low, close] = row;
  if (!symbol || close === "N/A") return null;

  const closeNum = Number(close);
  const openNum = Number(open);
  if (!Number.isFinite(closeNum)) return null;

  const changeDayPct =
    Number.isFinite(openNum) && openNum !== 0
      ? ((closeNum - openNum) / openNum) * 100
      : 0;

  return { symbol, date, time, close: closeNum, changeDayPct };
};

// ✅ Fallback daily close (toujours dispo même marché fermé)
const fetchLastDailyCloseFromStooq = async (symbolLower) => {
  // CSV daily: Date,Open,High,Low,Close,Volume
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbolLower)}&i=d`;
  const r = await fetchWithTimeout(url, 9000);
  if (!r.ok) return null;

  const text = (await r.text()).trim();
  const lines = text.split("\n");
  if (lines.length < 3) return null;

  const last = lines[lines.length - 1].split(",");
  const prev = lines[lines.length - 2].split(",");
  if (last.length < 5 || prev.length < 5) return null;

  const date = last[0];
  const close = Number(last[4]);
  const prevClose = Number(prev[4]);

  if (!Number.isFinite(close)) return null;

  const changeDayPct =
    Number.isFinite(prevClose) && prevClose !== 0
      ? ((close - prevClose) / prevClose) * 100
      : 0;

  return { date, close, changeDayPct };
};

const safeJsonParse = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

/* =========================
   REFRESH + PERSIST "LAST KNOWN"
========================= */

async function refreshAndStore(event) {
  connectLambda(event);
  const store = getStore("ticker-cache");

  // 1) Lire l'ancien cache (pour garder le "dernier cours connu")
  let previousPayload = null;
  try {
    const prevStr = await store.get("latest");
    previousPayload = safeJsonParse(prevStr);
  } catch {}

  const previousData = previousPayload?.data || {};

  // 2) On construit les nouveaux résultats
  const results = {};
  let stocksSuccess = false;

  // === CRYPTO (CoinGecko) ===
  try {
    const cryptoRes = await fetchWithTimeout(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true",
      9000
    );
    if (cryptoRes.ok) {
      const cryptoData = await cryptoRes.json();

      if (cryptoData.bitcoin) {
        results.bitcoin = {
          name: "Bitcoin",
          currentPrice: cryptoData.bitcoin.usd,
          change24h: cryptoData.bitcoin.usd_24h_change || 0,
        };
      }
      if (cryptoData.ethereum) {
        results.ethereum = {
          name: "Ethereum",
          currentPrice: cryptoData.ethereum.usd,
          change24h: cryptoData.ethereum.usd_24h_change || 0,
        };
      }
    }
  } catch {}

  // === ACTIONS (Stooq) ===
  const stockMapping = {
    "MARA.US": { key: "mara", name: "Marathon Digital" },
    "BTBT.US": { key: "btbt", name: "Bit Digital" },
    "PYPL.US": { key: "pypl", name: "PayPal" },
    "BMNR.US": { key: "bmnr", name: "BMNR" },
    "MSTR.US": { key: "mstr", name: "MicroStrategy" },
    "BITF.US": { key: "bitf", name: "Bitfarms" },
    "BTC.PA":  { key: "mlnx", name: "Melanion", isEuro: true }, // <- Melanion
  };

  const symbols = Object.keys(stockMapping);

  // 2a) Quote instantané
  const quoteResponses = await Promise.all(
    symbols.map(async (sym) => {
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
      try {
        const r = await fetchWithTimeout(url, 9000);
        if (!r.ok) return { sym, text: null };
        return { sym, text: await r.text() };
      } catch {
        return { sym, text: null };
      }
    })
  );

  for (const item of quoteResponses) {
    const mapping = stockMapping[item.sym];
    if (!mapping) continue;

    let parsed = item.text ? parseStooqQuoteCSV(item.text) : null;

    // ✅ IMPORTANT : Melanion si quote vide => daily close
    if (!parsed && item.sym === "BTC.PA") {
      try {
        const daily = await fetchLastDailyCloseFromStooq("btc.pa");
        if (daily) {
          parsed = {
            symbol: "BTC.PA",
            date: daily.date,
            time: "CLOSE",
            close: daily.close,
            changeDayPct: daily.changeDayPct,
          };
        }
      } catch {}
    }

    if (!parsed) continue;

    results[mapping.key] = {
      name: mapping.name,
      symbol: item.sym,
      currentPrice: parsed.close,
      changeDayPct: parsed.changeDayPct || 0,
      isEuro: mapping.isEuro || false,
      source: "stooq",
      last: `${parsed.date} ${parsed.time}`,
    };

    stocksSuccess = true;
  }

  // 3) ✅ MAGIE : si une valeur manque, on garde le dernier cours connu du cache Blobs
  // (c’est EXACTEMENT ton besoin “fermé => dernier cours connu”)
  const keysToAlwaysKeep = [
    "bitcoin","ethereum","mara","btbt","pypl","bmnr","mstr","bitf","mlnx"
  ];

  for (const k of keysToAlwaysKeep) {
    if (!results[k] && previousData[k]?.currentPrice) {
      results[k] = previousData[k];
    }
  }

  const payload = {
    success: true,
    timestamp: new Date().toISOString(),
    cacheTtlSeconds: 300,
    stocksSuccess,
    data: results,
  };

  await store.set("latest", JSON.stringify(payload));
  return payload;
}

/* =========================
   HANDLER (CRON + CLÉ)
========================= */

export const handler = async (event) => {
  const key = event?.queryStringParameters?.key;
  const isCron = event?.headers?.["x-nf-scheduled"] === "true";

  if (!isCron && key !== process.env.REFRESH_KEY) {
    return {
      statusCode: 401,
      body: JSON.stringify({ ok: false, error: "Unauthorized" }),
    };
  }

  try {
    const payload = await refreshAndStore(event);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, timestamp: payload.timestamp }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
    };
  }
};
