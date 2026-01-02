import { getStore } from "@netlify/blobs";

const fetchWithTimeout = async (url, ms = 9000) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
  } finally {
    clearTimeout(t);
  }
};

const parseStooqCSV = (csvText) => {
  const text = (csvText || "").trim();
  const lines = text.split("\n");
  if (lines.length < 2) return null;

  const row = lines[1].split(",");
  // Symbol,Date,Time,Open,High,Low,Close,Volume
  if (row.length < 8) return null;

  const [symbol, date, time, open, high, low, close, volume] = row;
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

export default async () => {
  const results = {};
  let stocksSuccess = false;

  // 1) BTC & ETH via CoinGecko (format identique à ce que tu avais)
  try {
    const cryptoRes = await fetchWithTimeout(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true"
    );
    if (cryptoRes.ok) {
      const cryptoData = await cryptoRes.json();

      if (cryptoData.bitcoin) {
        results.bitcoin = {
          name: "Bitcoin",
          currentPrice: cryptoData.bitcoin.usd,
          change24h: cryptoData.bitcoin.usd_24h_change || 0
        };
      }
      if (cryptoData.ethereum) {
        results.ethereum = {
          name: "Ethereum",
          currentPrice: cryptoData.ethereum.usd,
          change24h: cryptoData.ethereum.usd_24h_change || 0
        };
      }
    }
  } catch (e) {
    console.error("Erreur CoinGecko:", e?.message || e);
  }

  // 2) Actions US + Melanion (tentative) via Stooq (gratuit)
  const stockMapping = {
    "MARA.US": { key: "mara", name: "Marathon Digital" },
    "BTBT.US": { key: "btbt", name: "Bit Digital" },
    "PYPL.US": { key: "pypl", name: "PayPal" },
    "BMNR.US": { key: "bmnr", name: "BMNR" }, // peut être absent sur Stooq => sera ignoré si N/A
    "MSTR.US": { key: "mstr", name: "MicroStrategy" },
    "BITF.US": { key: "bitf", name: "Bitfarms" },

    // Melanion (tu veux le garder) : souvent indisponible sur Stooq => sera ignoré si N/A
    "BTC.PA": { key: "mlnx", name: "Melanion", isEuro: true }
  };

  const symbols = Object.keys(stockMapping);

  const responses = await Promise.all(
    symbols.map(async (sym) => {
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
      try {
        const r = await fetchWithTimeout(url);
        if (!r.ok) return null;
        const text = await r.text();
        return { sym, text };
      } catch {
        return null;
      }
    })
  );

  for (const item of responses) {
    if (!item?.text) continue;

    const parsed = parseStooqCSV(item.text);
    if (!parsed) continue;

    const mapping = stockMapping[item.sym];
    if (!mapping) continue;

    results[mapping.key] = {
      name: mapping.name,
      symbol: item.sym,
      currentPrice: parsed.close,
      changeDayPct: parsed.changeDayPct, // (variation journée/séance)
      isEuro: mapping.isEuro || false,
      source: "stooq",
      last: `${parsed.date} ${parsed.time}`
    };

    stocksSuccess = true;
  }

  const payload = {
    success: true,
    timestamp: new Date().toISOString(),
    cacheTtlSeconds: 300,
    stocksSuccess,
    data: results
  };

  // Stockage partagé = 1 seul refresh / 5 minutes, peu importe le nombre de visiteurs
  const store = getStore("ticker-cache");
  await store.set("latest", JSON.stringify(payload));

  return payload;
};
