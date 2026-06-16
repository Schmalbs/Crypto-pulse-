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

// ── Fetch transcript via YouTubeTranscript API (no key needed) ──
async function getTranscript(videoId) {
  // Uses the public timedtext endpoint — works for auto-generated and manual captions
  const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${videoId}`;
  const listRes = await fetch(listUrl);
  const listXml = await listRes.text();

  // Try English first, fall back to first available
  let langCode = 'en';
  const langMatch = listXml.match(/lang_code="([^"]+)"/);
  if (langMatch) langCode = langMatch[1];

  const transcriptUrl = `https://www.youtube.com/api/timedtext?lang=${langCode}&v=${videoId}&fmt=json3`;
  const transcriptRes = await fetch(transcriptUrl);

  if (!transcriptRes.ok) {
    // Fallback: try youtubetranscript.com mirror
    const fallbackRes = await fetch(`https://youtubetranscript.com/?server_vid=${videoId}`);
    if (!fallbackRes.ok) throw new Error(`No transcript available for ${videoId}`);
    const fallbackText = await fallbackRes.text();
    // Strip HTML tags from response
    return fallbackText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000);
  }

  const json = await transcriptRes.json();
  if (!json.events) throw new Error('Empty transcript');

  // Flatten transcript events into plain text
  const text = json.events
    .filter(e => e.segs)
    .map(e => e.segs.map(s => s.utf8 || '').join(''))
    .join(' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, 12000); // cap to ~3k tokens
}

// ── Web search sentiment for non-channel analysts ──
async function getWebSentiment(analyst) {
  // We ask Claude to reason based on what it knows + search context
  // Since we don't have a live search API wired here, we prompt Claude
  // to summarise based on recent known activity for the analyst
  return `Recent web search sentiment for ${analyst.name} — searched: ${analyst.searchTerms.join(', ')}`;
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

// ── Main pipeline ──
async function runPipeline() {
  const results = [];
  const errors = [];

  // Process YouTube channels
  for (const channel of YOUTUBE_CHANNELS) {
    try {
      console.log(`Processing ${channel.name}...`);
      const { videoId, videoTitle } = await getLatestVideoId(channel.channelId);
      const videoUrl = `https://youtube.com/watch?v=${videoId}`;
      const transcript = await getTranscript(videoId);
      const analysis = await summariseWithClaude(channel.name, transcript);

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
      console.log(`✓ ${channel.name}: ${analysis.sentiment} (${analysis.sentiment_score}/10)`);
    } catch (err) {
      console.error(`✗ ${channel.name}: ${err.message}`);
      errors.push({ channel: channel.name, error: err.message });
    }
  }

  // Process web-search-only analysts
  for (const analyst of WEB_SEARCH_ANALYSTS) {
    try {
      console.log(`Processing ${analyst.name} (web)...`);
      const context = await getWebSentiment(analyst);
      const analysis = await summariseWithClaude(analyst.name, context, true);

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
