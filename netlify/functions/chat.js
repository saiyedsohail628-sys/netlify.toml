// Netlify server-side proxy: the Gemini key is read from the function environment,
// never sent to or embedded in the browser code.
exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const respond = (statusCode, payload) => ({ statusCode, headers, body: JSON.stringify(payload) });

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Use POST to send a message.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not configured for this Netlify site.');
    return respond(500, { error: 'AI is not configured yet. Add GEMINI_API_KEY in Netlify site environment variables.' });
  }

  if (!event.body || event.body.length > 40000) {
    return respond(413, { error: 'Request is too large.' });
  }

  let input;
  try {
    input = JSON.parse(event.body);
  } catch (_) {
    return respond(400, { error: 'Invalid request body.' });
  }

  const language = input.language === 'hi-IN' ? 'Hindi' : 'English';
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 12) {
    return respond(400, { error: 'Send between 1 and 12 conversation messages.' });
  }

  const contents = [];
  for (const message of input.messages) {
    if (!message || !['user', 'model'].includes(message.role) || typeof message.text !== 'string') {
      return respond(400, { error: 'Invalid conversation message.' });
    }
    const text = message.text.trim();
    if (!text || text.length > 2000) {
      return respond(400, { error: 'Each message must be between 1 and 2000 characters.' });
    }
    contents.push({ role: message.role, parts: [{ text }] });
  }
  if (contents[contents.length - 1].role !== 'user') {
    return respond(400, { error: 'The latest conversation message must be from the user.' });
  }

  // Configure an available Gemini model in Netlify as GEMINI_MODEL if you want to
  // use a different model. The default is a fast text-capable model.
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) {
    return respond(500, { error: 'The configured Gemini model name is invalid.' });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `You are JARVIS, a helpful, concise personal AI assistant. Reply in ${language}. Be clear and friendly. If asked for real-time information you do not have, say so honestly.` }]
        },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
      })
    });

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Gemini request failed with status', upstream.status);
      if (upstream.status === 429) return respond(503, { error: 'The AI service is busy or its quota was reached. Please try again later.' });
      return respond(502, { error: 'The AI service could not answer. Check the Gemini configuration and try again.' });
    }

    const reply = result.candidates?.[0]?.content?.parts
      ?.map(part => typeof part.text === 'string' ? part.text : '')
      .join('')
      .trim();
    if (!reply) return respond(502, { error: 'The AI service returned no text. Please try again.' });
    return respond(200, { reply });
  } catch (error) {
    console.error('Gemini request error:', error.message);
    return respond(502, { error: 'Could not connect to the AI service. Please try again.' });
  }
};
