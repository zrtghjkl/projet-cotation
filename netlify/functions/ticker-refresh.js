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

// Daily CSV: Date,Open,High,Low,Close,Volume
const fetchLastDailyCloseFromStooq = async (symbolLower) => {
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
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const getQuoteFromStooq = async (sym) => {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  const r = await fetchWithTimeout(url, 9000);
  if (!r.ok) return null;
  const text = await r.text();
  return parseStooqQuoteCSV(text);
};

/* =========================
   REFRESH + "LAST KNOWN" SERVER
========================= */

async function refreshAndStore(event) {
  connectLambda(event);
  const store = getStore("ticker-cache");

  // Lire ancien cache (pour garder dernier cours connu)
  let previousPayload = null;
  try {
    const prevStr = await store.get("latest");
    previousPayload = safeJsonParse(prevStr);
  } catch {}
  const previousData = previousPayload?.data || {};

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

  // === ACTIONS US (Stooq) ===
  const stockMapping = {
    "MARA.US": { key: "mara", name: "Marathon Digital", isEuro: false },
    "BTBT.US": { key: "btbt", name: "Bit Digital", isEuro: false },
    "PYPL.US": { key: "pypl", name: "PayPal", isEuro: false },
    "BMNR.US": { key: "bmnr", name: "BMNR", isEuro: false },
    "MSTR.US": { key: "mstr", name: "MicroStrategy", isEuro: false },
    "BITF.US": { key: "bitf", name: "Bitfarms", isEuro: false },
  };

  // Quotes US
  const symbols = Object.keys(stockMapping);
  const quoteResponses = await Promise.all(
    symbols.map(async (sym) => {
      try {
        const parsed = await getQuoteFromStooq(sym);
        return { sym, parsed };
      } catch {
        return { sym, parsed: null };
      }
    })
  );

  for (const item of quoteResponses) {
    const mapping = stockMapping[item.sym];
    if (!mapping || !item.parsed) continue;

    results[mapping.key] = {
      name: mapping.name,
      symbol: item.sym,
      currentPrice: item.parsed.close,
      changeDayPct: item.parsed.changeDayPct || 0,
      isEuro: false,
      source: "stooq",
      last: `${item.parsed.date} ${item.parsed.time}`,
    };
    stocksSuccess = true;
  }

  // =========================
  // ✅ MELANION (YAHOO) — COMME SUR YAHOO FINANCE
  // Ticker Yahoo: BTC.MI (Milan, EUR) — "Mélanion BTC Equities Universe UCITS ETF"
  // Clé attendue côté front : results.mlnx
  // =========================
  const MELANION_SYMBOL = "BTC.MI";

  try {
    const res = await fetchWithTimeout(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        MELANION_SYMBOL
      )}?interval=1d&range=10d`,
      9000
    );

    if (res.ok) {
      const json = await res.json();
      const result = json?.chart?.result?.[0];

      if (result) {
        const prices = result?.indicators?.quote?.[0]?.close || [];
        const clean = prices.filter((v) => Number.isFinite(v));

        if (clean.length >= 2) {
          const last = clean[clean.length - 1];
          const prev = clean[clean.length - 2] || last;
          const changeDayPct = prev !== 0 ? ((last / prev) - 1) * 100 : 0;

          results.mlnx = {
            name: "Melanion",
            symbol: MELANION_SYMBOL,
            currentPrice: last,
            changeDayPct,
            isEuro: true,
            source: "yahoo",
            last: new Date().toISOString(),
          };

          stocksSuccess = true;
        }
      }
    }
  } catch {}

  // ✅ GARANTIE "DERNIER COURS CONNU" POUR ACTIONS + MELANION
  // (si marché fermé / API renvoie rien => on garde le dernier stocké sur le serveur)
  const alwaysKeep = ["mara", "btbt", "pypl", "bmnr", "mstr", "bitf", "mlnx"];
  for (const k of alwaysKeep) {
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
  const force = event?.queryStringParameters?.force === "1";

  if (!isCron && key !== process.env.REFRESH_KEY) {
    return {
      statusCode: 401,
      body: JSON.stringify({ ok: false, error: "Unauthorized" }),
    };
  }

  try {
    const payload = await refreshAndStore(event);

    // Option debug: renvoie le payload complet
    if (force) {
      return { statusCode: 200, body: JSON.stringify(payload) };
    }

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
