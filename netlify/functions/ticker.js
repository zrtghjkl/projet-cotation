import { getStore } from "@netlify/blobs";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const store = getStore("ticker-cache");
    const val = await store.get("latest");

    if (!val) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: false,
          error: "Cache vide (le refresh n'a pas encore tourné). Attends 5 minutes.",
          data: {}
        })
      };
    }

    return { statusCode: 200, headers, body: val };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: "Erreur lecture cache",
        details: e?.message || String(e)
      })
    };
  }
};
