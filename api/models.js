// Debug endpoint: GET /api/models — lists available Gemini models for the API key
module.exports = async function handler(req, res) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();

    // Filter to models supporting generateContent
    const supported = (data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
      .map(m => ({
        name: m.name,
        displayName: m.displayName,
        supportedGenerationMethods: m.supportedGenerationMethods,
      }));

    res.json({ count: supported.length, models: supported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
