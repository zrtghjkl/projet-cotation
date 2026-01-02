import { connectLambda, getStore } from "@netlify/blobs";

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

const parseStooqCSV = (csvText) => {
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

exports.handler = async (event) => {
  try {
    // ✅ IMPORTANT: init Blobs in Lambda compatibility mode
    connectLambda(event);

    const results = {};
    let stocksSuccess = false;

    // BTC/ETH CoinGecko (format identique)
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

    // Actions US + Melanion (tentative) via Stooq
    const stockMapping = {
      "MARA.US": { key: "mara", name: "Marathon Digital" },
      "BTBT.US": { key: "btbt", name: "Bit Digital" },
      "PYPL.US": { key: "pypl", name: "PayPal" },
      "BMNR.US": { key: "bmnr", name: "BMNR" }, // peut être absent => ignoré si N/A
      "MSTR.US": { key: "mstr", name: "MicroStrategy" },
      "BITF.US": { key: "bitf", name: "Bitfarms" },
      "BTC.PA": { key: "mlnx", name: "Melanion", isEuro: true }, // souvent indispo => ignoré si N/A
    };

    const symbols = Object.keys(stockMapping);

    const responses = await Promise.all(
      symbols.map(async (sym) => {
        const url = `https://stooq.com/q/l/?s=${encodeURIComponent(
          sym
        )}&f=sd2t2ohlcv&h&e=csv`;
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
        changeDayPct: parsed.changeDayPct,
        isEuro: mapping.isEuro || false,
        source: "stooq",
        last: `${parsed.date} ${parsed.time}`,
      };
      stocksSuccess = true;
    }

    const payload = {
      success: true,
      timestamp: new Date().toISOString(),
      cacheTtlSeconds: 300,
      stocksSuccess,
      data: results,
    };

    const store = getStore("ticker-cache");
    await store.set("latest", JSON.stringify(payload));

    return {
      statusCode: 200,
      body: "ok",
    };
  } catch (e) {
    return { statusCode: 500, body: e?.message || String(e) };
  }
};
