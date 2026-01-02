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

const safeJsonParse = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

// Extracteurs HTML simples (Borsa Italiana)
const extractFirstNumberAfter = (html, marker) => {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const slice = html.slice(idx, idx + 200);
  const m = slice.match(/([-+]?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  return Number(m[1].replace(",", "."));
};

const extractStatus = (html) => {
  // Ex: "Status: Inaccessible" ou "Status: Continuous"
  const m = html.match(/Status:\s*([^<\n\r]+)/i);
  return m ? m[1].trim() : "";
};

/* =========================
   REFRESH
========================= */

async function refreshAndStore(event) {
  connectLambda(event);
  const store = getStore("ticker-cache");

  // Lire ancien cache (dernier cours connu)
  let previousPayload = null;
  try {
    const prevStr = await store.get("latest");
    previousPayload = safeJsonParse(prevStr);
  } catch {}

  const previousData = previousPayload?.data || {};

  const results = {};
  let stocksSuccess = false;

  // === CRYPTO (CoinGecko) ===
  // (pas besoin de close, 24/7)
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
  // Objectif: si Stooq renvoie rien -> on garde le dernier prix connu en Blobs
  const stockMapping = {
    "MARA.US": { key: "mara", name: "Marathon Digital" },
    "BTBT.US": { key: "btbt", name: "Bit Digital" },
    "PYPL.US": { key: "pypl", name: "PayPal" },
    "BMNR.US": { key: "bmnr", name: "BMNR" },
    "MSTR.US": { key: "mstr", name: "MicroStrategy" },
    "BITF.US": { key: "bitf", name: "Bitfarms" },
  };

  const symbols = Object.keys(stockMapping);

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

    const parsed = item.text ? parseStooqQuoteCSV(item.text) : null;
    if (!parsed) continue;

    results[mapping.key] = {
      name: mapping.name,
      symbol: item.sym,
      currentPrice: parsed.close,
      changeDayPct: parsed.changeDayPct || 0,
      isEuro: false,
      source: "stooq",
      last: `${parsed.date} ${parsed.time}`,
    };

    stocksSuccess = true;
  }

  // === MELANION (Borsa Italiana / ISIN FR0014002IH8) ===
  // Yahoo te donne BTC.MI, mais on n’utilise PAS Yahoo (bloque).
  // Ici: si marché fermé -> on affiche Reference Close (dernier close).
  // Si open -> on affiche Last Trade.
  try {
    const url = "https://www.borsaitaliana.it/borsa/etf/scheda/FR0014002IH8.html?lang=en";
    const r = await fetchWithTimeout(url, 9000);
    if (r.ok) {
      const html = await r.text();

      const status = extractStatus(html); // "Continuous" ou "Inaccessible"
      const isOpen = /Continuous/i.test(status);

      // Sur cette page, on a (en clair dans le HTML):
      // - un prix "15.564 +1.43%" (last trade)
      // - "Reference Close 15.658 - 26/01/02 ..."
      // - "Closing Price 15.658"
      const referenceClose = extractFirstNumberAfter(html, "Reference Close");
      const closingPrice = extractFirstNumberAfter(html, "Closing Price");

      // Last trade = le premier prix sous le titre (très tôt dans la page)
      // On récupère le premier nombre qui suit le nom (on simplifie en prenant le 1er float du HTML après </h1>)
      let lastTrade = null;
      const h1Index = html.toLowerCase().indexOf("</h1>");
      if (h1Index !== -1) {
        const slice = html.slice(h1Index, h1Index + 250);
        const m = slice.match(/([-+]?\d+(?:[.,]\d+)?)/);
        if (m) lastTrade = Number(m[1].replace(",", "."));
      }

      // Choix prix:
      // - si open => lastTrade
      // - si fermé => referenceClose (ou closingPrice fallback)
      const price =
        isOpen
          ? (Number.isFinite(lastTrade) ? lastTrade : null)
          : (Number.isFinite(referenceClose) ? referenceClose : (Number.isFinite(closingPrice) ? closingPrice : null));

      if (Number.isFinite(price)) {
        // % : si fermé, on calcule vs dernier prix connu (si dispo)
        // (sinon 0)
        let changeDayPct = 0;
        const prev = previousData?.mlnx?.currentPrice;
        if (!isOpen && Number.isFinite(prev) && prev !== 0) {
          changeDayPct = ((price - prev) / prev) * 100;
        } else if (isOpen && Number.isFinite(prev) && prev !== 0) {
          // open: calc rapide vs prev aussi (plutôt que dépendre d’un parsing fragile du %)
          changeDayPct = ((price - prev) / prev) * 100;
        }

        results.mlnx = {
          name: "Melanion",
          symbol: "BTC.MI",          // ✅ on affiche le code Yahoo demandé (mais data vient de Borsa)
          currentPrice: price,
          changeDayPct,
          isEuro: true,
          source: "borsaitaliana",
          last: isOpen ? "LIVE" : "CLOSE",
        };

        stocksSuccess = true;
      }
    }
  } catch {}

  // ✅ GARANTIE "dernier cours connu" POUR TOUTES LES ACTIONS + MELANION
  // Si une valeur manque (marché fermé / source down), on garde l’ancienne du cache Blobs.
  const alwaysKeep = ["mara","btbt","pypl","bmnr","mstr","bitf","mlnx"];
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

  if (!isCron && key !== process.env.REFRESH_KEY) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: "Unauthorized" }) };
  }

  try {
    const payload = await refreshAndStore(event);
    return { statusCode: 200, body: JSON.stringify({ ok: true, timestamp: payload.timestamp }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e?.message || String(e) }) };
  }
};
