import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import Archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const APP_KEY = process.env.APP_KEY || ""; // optional API key for GPT Action auth
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };

async function ttsToMp3(text, outPath) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input: text, format: 'mp3', speed: 0.98 })
  });
  if (!r.ok) throw new Error(`TTS failed: ${r.status} ${await r.text()}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// Protect endpoints with optional app key
app.use((req, res, next) => {
  if (!APP_KEY) return next();
  if (req.header('X-APP-KEY') === APP_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

/**
 * POST /generate
 * Body: { specs: { make, model, year?, trim?, engine?, transmission?, mileage?, axle?, sleeper?, tech?, sellingPoints?, useCase?, location?, range?, contact? } }
 * Returns: { batchId, files: [{label,url,script,beats,hashtags}] }
 */
app.post('/generate', async (req, res) => {
  try {
    const { specs } = req.body;
    if (!specs?.make || !specs?.model) {
      return res.status(400).json({ error: 'Missing required specs: make, model.' });
    }

    // Build a single prompt that yields 3 variants in JSON
    const prompt = `
You write TikTok voiceovers for semi-trucks in a natural American blue-collar voice.
- Produce 3 variants: (1) gritty, (2) friendly, (3) high-energy.
- 85–120 words each (20–35s), strong hook in first 3s, specs→benefits→CTA.
- No prices. CTA: DM me for details. Short plain sentences. Contractions OK.
Truck specs: ${JSON.stringify(specs, null, 2)}
Return JSON:
{
  "variants":[
    {"style":"gritty","voiceover":"...","beats":["..."],"hashtags":["#..."]},
    {"style":"friendly","voiceover":"...","beats":["..."],"hashtags":["#..."]},
    {"style":"high-energy","voiceover":"...","beats":["..."],"hashtags":["#..."]}
  ]
}`;

    // Get 3 scripts from OpenAI (chat)
    const cr = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        response_format: { type: 'json_object' }
      })
    });
    if (!cr.ok) throw new Error(`Chat failed: ${cr.status} ${await cr.text()}`);
    const cj = await cr.json();
    const variants = JSON.parse(cj.choices[0].message.content).variants;

    const batchId = uuidv4();
    const dir = path.join(__dirname, 'public', 'voiceovers', batchId);
    ensureDir(dir);

    const results = [];
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const script = v.voiceover.trim();
      const filePath = path.join(dir, `vo_${i + 1}.mp3`);
      await ttsToMp3(script, filePath);
      results.push({
        label: `VoiceOver ${i + 1} — ${v.style}`,
        url: `${BASE_URL}/public/voiceovers/${batchId}/vo_${i + 1}.mp3`,
        script,
        beats: v.beats || [],
        hashtags: (v.hashtags || []).slice(0, 6)
      });
    }

    res.json({ batchId, files: results });
  } catch (e) {
    res.status(500).json({ error: 'Generation failed', detail: String(e?.message || e) });
  }
});

/**
 * POST /zip
 * Body: { files: ["<public URLs returned by /generate>"] }
 * Streams a ZIP with those MP3s.
 */
app.post('/zip', async (req, res) => {
  try {
    const { files } = req.body;
    if (!files?.length) return res.status(400).json({ error: 'No files selected.' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="voiceovers.zip"');

    const archive = Archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    for (const u of files) {
      const p = new URL(u).pathname; // /public/voiceovers/<id>/vo_X.mp3
      const diskPath = path.join(__dirname, p);
      if (fs.existsSync(diskPath)) {
        archive.file(diskPath, { name: path.basename(diskPath) });
      }
    }
    await archive.finalize();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'ZIP failed', detail: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`Server on ${BASE_URL}`));
