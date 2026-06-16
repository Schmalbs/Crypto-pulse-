const express = require('express');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// ── CORS: allow any origin ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── DB + Anthropic clients ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Channel definitions ──
const YOUTUBE_CHANNELS = [
  { name: 'Benjamin Cowen',  handle: 'benjaminjcowen',       channelId: 'UCRvqjQPSeaWn-uEx-w0XOIg' },
  { name: 'MMCrypto',        handle: 'MMCryptoTube',          channelId: 'UC_vBKBEDxQVtBpCFiSRyMEg' },
  { name: 'Gareth Soloway',  handle: 'GarethSolowayProTrader',channelId: 'UCOfBDfUBqBTM4pVS6Kc5VoQ' },
  { name: 'Jason Pizzino',   handle: 'JasonPizzinoOfficial',  channelId: 'UC1yMQQ2HvFtHBHkFqnqBJeA' },
];

const WEB_SEARCH_ANALYSTS = [
  { name: 'Kyle Stagoll (Trader Daxx)', searchTerms: ['Kyle Stagoll crypto', 'Trader Daxx crypto sentiment'] }
];

// ── DB init ──
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channel_summaries (
      id SERIAL PRIMARY KEY,
      channel_name TEXT NOT NULL,
      channel_handle TEXT,
      summary TEXT,
      sentiment TEXT CHECK (sentiment IN ('bullish','bearish','neutral')),
      sentiment_score INTEGER CHECK (sentiment_score BETWEEN 1 AND 10),
      key_points JSONB,
      video_title TEXT,
      video_url TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_fetched ON channel_summaries(fetched_at DESC);
  `);
  console.log('DB ready');
}

// ── Fetch latest video ID for a channel via YouTube RSS (no API key needed) ──
async function getLatestVideoId(channelId) {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(rssUrl);
  if (!res.ok) throw new Error(`RSS fetch failed for ${channelId}: ${res.status}`);
  const xml = await res.text();

  // Extract first video ID and title from RSS
  const videoIdMatch = xml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
  const titleMatch = xml.match(/<title>([^<]+)<\/title>/g);

  if (!videoIdMatch) throw new Error('No video ID found in RSS');
  const videoId = videoIdMatch[1];
  // Skip the channel title (first <title>), grab the video title (second)
  const videoTitle = titleMatch && titleMatch[1]
    ? titleMatch[1].replace(/<\/?title>/g, '').trim()
    : 'Unknown title';

  return { videoId, videoTitle };
}

// ── Fetch transcript via Supadata API (works from server IPs) ──
async function getTranscript(videoId) {
  const key = process.env.SUPADATA_API_KEY;
  if (!key) throw new Error('SUPADATA_API_KEY not set');

  const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`;
  const res = await fetch(url, { headers: { 'x-api-key': key } });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supadata ${res.status}: ${body.slice(0, 120)}`);
  }

  const data = await res.json();
  // Supadata returns { content: "..." } when text=true, or segments otherwise
  let text = '';
  if (typeof data.content === 'string') {
    text = data.content;
  } else if (Array.isArray(data.content)) {
    text = data.content.map(s => s.text || '').join(' ');
  } else if (Array.isArray(data.transcript)) {
    text = data.transcript.map(s => s.text || '').join(' ');
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Supadata returned empty transcript');
  return text.slice(0, 12000); // cap to ~3k tokens
}

// ── Web search sentiment via Claude's web_search tool ──
// Works for ALL analysts (YouTube transcripts get blocked from server IPs,
// so we search the web for each analyst's latest views instead).
async function getWebSentiment(analyst, searchHints) {
  const hints = searchHints && searchHints.length
    ? searchHints.join(', ')
    : analyst;

  const prompt = `Search the web for the most recent crypto/Bitcoin market outlook from the analyst "${analyst}". Search terms to try: ${hints}.

Find their latest videos, posts, or interviews (prioritise the last 7 days). Then summarise:
1. A concise 3-5 sentence summary of their current market views, in your own words (paraphrase, never quote).
2. Their overall sentiment: bullish, bearish, or neutral.
3. A sentiment score 1-10 (1=extremely bearish, 5=neutral, 10=extremely bullish).
4. Up to 4 key points. IMPORTANT: if they mention any specific TRADE IDEAS or setups (e.g. entries, targets, levels they're watching, longs/shorts, accumulation zones), call those out explicitly in the key points and in the summary.

Note how fresh the information is (e.g. "from a video 2 days ago" vs "last clear view ~2 weeks ago").

Respond ONLY with valid JSON, no markdown fences:
{"summary":"...","sentiment":"bullish|bearish|neutral","sentiment_score":5,"key_points":["...","..."]}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
  });

  // Concatenate all text blocks (web search responses interleave tool calls + text)
  const raw = (response.content || [])
    .map(b => b.type === 'text' ? b.text : '')
    .join('')
    .trim();

  const clean = raw.replace(/```json|```/g, '').trim();
  // Extract the JSON object even if there's surrounding prose
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in web search response');
  return JSON.parse(jsonMatch[0]);
}

// ── Ask Claude to summarise + classify sentiment ──
async function summariseWithClaude(channelName, transcript, isWebSearch = false) {
  const systemPrompt = `You are a crypto market analyst assistant. Your job is to read YouTube video transcripts or web search summaries from crypto analysts and extract:
1. A concise 3-5 sentence summary of their key market views
2. Their overall market sentiment: bullish, bearish, or neutral
3. A sentiment score from 1 (extremely bearish) to 10 (extremely bullish), where 5 is neutral
4. Up to 4 key bullet points they made

Respond ONLY with valid JSON in this exact format:
{
  "summary": "string",
  "sentiment": "bullish|bearish|neutral",
  "sentiment_score": number,
  "key_points": ["point1", "point2", "point3", "point4"]
}`;

  const userPrompt = isWebSearch
    ? `Analyst: ${channelName}\n\nBased on your knowledge of this analyst's recent public statements and typical market positions, provide a sentiment summary. Note this is based on general knowledge, not a specific video.\n\nContext: ${transcript}`
    : `Analyst: ${channelName}\n\nVideo transcript:\n${transcript}\n\nSummarise their crypto market sentiment from this video.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const raw = response.content[0].text.trim();
  // Strip markdown fences if present
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── Store result in PostgreSQL ──
async function storeResult({ channelName, handle, summary, sentiment, sentimentScore, keyPoints, videoTitle, videoUrl }) {
  await pool.query(
    `INSERT INTO channel_summaries 
      (channel_name, channel_handle, summary, sentiment, sentiment_score, key_points, video_title, video_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [channelName, handle, summary, sentiment, sentimentScore, JSON.stringify(keyPoints), videoTitle, videoUrl]
  );
}

// ── Summarise a real transcript (captures trade ideas) ──
async function summariseTranscript(channelName, transcript) {
  const systemPrompt = `You are a crypto market analyst assistant. Read this YouTube video transcript from a crypto analyst and extract:
1. A concise 3-5 sentence summary of their key market views (paraphrase, never quote).
2. Their overall sentiment: bullish, bearish, or neutral.
3. A sentiment score 1-10 (1=extremely bearish, 5=neutral, 10=extremely bullish).
4. Up to 4 key points. IMPORTANT: if they mention any specific TRADE IDEAS or setups (entries, targets, levels they're watching, longs/shorts, accumulation zones), call those out explicitly.

Respond ONLY with valid JSON, no markdown fences:
{"summary":"...","sentiment":"bullish|bearish|neutral","sentiment_score":5,"key_points":["...","..."]}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Analyst: ${channelName}\n\nVideo transcript:\n${transcript}` }]
  });

  const raw = response.content[0].text.trim();
  const clean = raw.replace(/```json|```/g, '').trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in transcript summary');
  return JSON.parse(jsonMatch[0]);
}

// ── Main pipeline ──
async function runPipeline() {
  const results = [];
  const errors = [];

  // YouTube analysts: real transcript first, web search as fallback.
  for (const channel of YOUTUBE_CHANNELS) {
    try {
      console.log(`Processing ${channel.name}...`);
      let analysis, videoTitle, videoUrl, source;

      try {
        // 1. Get latest video, 2. fetch real transcript, 3. summarise
        const latest = await getLatestVideoId(channel.channelId);
        const transcript = await getTranscript(latest.videoId);
        analysis = await summariseTranscript(channel.name, transcript);
        videoTitle = latest.videoTitle;
        videoUrl = `https://youtube.com/watch?v=${latest.videoId}`;
        source = 'transcript';
      } catch (transcriptErr) {
        // Fallback: web search (so the analyst never comes back empty)
        console.warn(`  ↳ transcript failed (${transcriptErr.message}), falling back to web search`);
        const searchHints = [
          `${channel.name} crypto latest video`,
          `${channel.name} Bitcoin outlook`,
          `${channel.name} ${channel.handle}`
        ];
        analysis = await getWebSentiment(channel.name, searchHints);
        videoTitle = 'Latest views (web fallback)';
        videoUrl = `https://youtube.com/@${channel.handle}`;
        source = 'web';
      }

      await storeResult({
        channelName: channel.name,
        handle: channel.handle,
        summary: analysis.summary,
        sentiment: analysis.sentiment,
        sentimentScore: analysis.sentiment_score,
        keyPoints: analysis.key_points,
        videoTitle,
        videoUrl
      });

      results.push({ channel: channel.name, sentiment: analysis.sentiment, score: analysis.sentiment_score });
      console.log(`✓ ${channel.name}: ${analysis.sentiment} (${analysis.sentiment_score}/10) [${source}]`);
    } catch (err) {
      console.error(`✗ ${channel.name}: ${err.message}`);
      errors.push({ channel: channel.name, error: err.message });
    }
  }

  // Web-search-only analysts (e.g. Kyle Stagoll / Trader Daxx)
  for (const analyst of WEB_SEARCH_ANALYSTS) {
    try {
      console.log(`Processing ${analyst.name} (web)...`);
      const analysis = await getWebSentiment(analyst.name, analyst.searchTerms);

      await storeResult({
        channelName: analyst.name,
        handle: null,
        summary: analysis.summary,
        sentiment: analysis.sentiment,
        sentimentScore: analysis.sentiment_score,
        keyPoints: analysis.key_points,
        videoTitle: 'Web search summary',
        videoUrl: null
      });

      results.push({ channel: analyst.name, sentiment: analysis.sentiment, score: analysis.sentiment_score });
      console.log(`✓ ${analyst.name}: ${analysis.sentiment} (${analysis.sentiment_score}/10)`);
    } catch (err) {
      console.error(`✗ ${analyst.name}: ${err.message}`);
      errors.push({ channel: analyst.name, error: err.message });
    }
  }

  return { results, errors };
}

// ═══════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════

// POST /api/trigger — fires the pipeline, waits, returns results
app.post('/api/trigger', async (req, res) => {
  console.log(`Pipeline triggered at ${new Date().toISOString()}`);
  try {
    const { results, errors } = await runPipeline();
    res.json({
      success: true,
      triggered_at: new Date().toISOString(),
      processed: results.length,
      errors: errors.length,
      results,
      errors
    });
  } catch (err) {
    console.error('Pipeline failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/summaries — latest summary per channel
app.get('/api/summaries', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (channel_name)
        id, channel_name, channel_handle, summary, sentiment,
        sentiment_score, key_points, video_title, video_url, fetched_at
      FROM channel_summaries
      ORDER BY channel_name, fetched_at DESC
    `);
    res.json({ success: true, summaries: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/summaries/history — last 7 days per channel
app.get('/api/summaries/history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT channel_name, sentiment, sentiment_score, fetched_at
      FROM channel_summaries
      WHERE fetched_at > NOW() - INTERVAL '7 days'
      ORDER BY fetched_at DESC
    `);
    res.json({ success: true, history: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Start ──
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Crypto sentiment server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
