import { connectLambda, getStore } from "@netlify/blobs";

export const handler = async (event) => {
  console.log("[PRICES] 📖 Lecture du cache");

  connectLambda(event);
  const store = getStore("ticker-cache");

  try {
    const raw = await store.get("latest");
    
    if (!raw) {
      return {
        statusCode: 404,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({ 
          success: false, 
          error: "Aucune donnée disponible" 
        })
      };
    }

    const cached = JSON.parse(raw);
    
    console.log(`[PRICES] ✅ ${Object.keys(cached.data || {}).length} actifs trouvés`);

    return {
      statusCode: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60"
      },
      body: JSON.stringify(cached)
    };

  } catch (error) {
    console.error("[PRICES] ❌ Erreur:", error);
    return {
      statusCode: 500,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ 
        success: false, 
        error: error.message 
      })
    };
  }
};