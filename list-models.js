import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

// ---------- Settings ----------
const PORT = process.env.PORT || 3000;           // hosting khud PORT deti hai
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // deploy ke baad apni frontend ka URL daalein
const MAX_HISTORY = 20;                          // har user ke aakhri 20 messages yaad rahenge
const MAX_MESSAGE_LENGTH = 2000;                 // bohat lamba message reject
const SESSION_TTL_MS = 60 * 60 * 1000;           // 1 ghanta idle rehne par history delete
const MAX_SESSIONS = 1000;                       // memory bharne se bachne ke liye

// Models list (list-models.js se verify ki hui). Pehla sab se pehle try hota hai.
const MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite',
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it'
];

// ---------- App setup ----------
const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '10kb' }));

if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY nahi mili. .env file ya hosting ke Environment Variables check karein.');
    process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---------- Har user ki alag history ----------
// sessionId -> { history: [...], lastUsed: timestamp }
const sessions = new Map();

function getSession(sessionId) {
    let session = sessions.get(sessionId);
    if (!session) {
        // Bohat sessions ho jayein to sab se purana hata do
        if (sessions.size >= MAX_SESSIONS) {
            const oldestKey = sessions.keys().next().value;
            sessions.delete(oldestKey);
        }
        session = { history: [], lastUsed: Date.now() };
        sessions.set(sessionId, session);
    }
    session.lastUsed = Date.now();
    return session;
}

// Har 10 minute baad purani (idle) sessions saaf karo
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastUsed > SESSION_TTL_MS) sessions.delete(id);
    }
}, 10 * 60 * 1000);

// ---------- Helpers ----------
function getMsUntilPacificMidnight() {
    const now = new Date();
    const pacificNow = new Date(
        now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
    );
    const nextMidnight = new Date(pacificNow);
    nextMidnight.setHours(24, 0, 0, 0);
    return nextMidnight - pacificNow;
}

function isValidSessionId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
}

// ---------- Routes ----------
app.get('/', (req, res) => {
    res.send('Chatbot server is running.');
});

// Naya chat shuru karne ke liye (history saaf)
app.post('/reset', (req, res) => {
    const { sessionId } = req.body;
    if (isValidSessionId(sessionId)) sessions.delete(sessionId);
    res.json({ ok: true });
});

app.post('/chat', async (req, res) => {
    const { message, sessionId } = req.body;

    if (!isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid session. Please refresh the page.' });
    }
    if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message is required.' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` });
    }

    const session = getSession(sessionId);

    // History ki copy: fail hone par asli history kharab nahi hoti
    const requestHistory = [
        ...session.history,
        { role: 'user', parts: [{ text: message.trim() }] }
    ];

    let sawRateLimit = false;
    let retrySeconds = null;
    let sawDailyLimit = false;
    let sawEmpty = false;
    let hadOtherError = false;

    for (const modelName of MODELS) {
        try {
            console.log(`[${sessionId.slice(0, 8)}] Trying: ${modelName}...`);
            const response = await ai.models.generateContent({
                model: modelName,
                contents: requestHistory
            });

            const replyText = response.text;
            if (!replyText) {
                console.log(`${modelName} ne khaali jawab diya, agla try kar rahe hain...`);
                sawEmpty = true;
                continue;
            }

            // Kamyabi par hi is user ki history save karein
            session.history = [
                ...requestHistory,
                { role: 'model', parts: [{ text: replyText }] }
            ].slice(-MAX_HISTORY);

            return res.json({ reply: replyText });

        } catch (error) {
            const msg = error.message || '';
            console.error(`${modelName} failed:`, error.status, msg.slice(0, 150));

            // Internet/DNS ka masla: baaqi models try karne ka faida nahi
            if (error.cause?.code === 'ENOTFOUND' || /fetch failed/i.test(msg)) {
                return res.status(503).json({
                    error: '⚠️ Cannot reach the AI service. Please try again shortly.'
                });
            }

            if (error.status === 429) {
                sawRateLimit = true;
                if (/PerDay|per day/i.test(msg)) sawDailyLimit = true;
                const match = msg.match(/retry in (\d+(\.\d+)?)s/i);
                if (match) {
                    const s = Math.ceil(parseFloat(match[1]));
                    retrySeconds = retrySeconds === null ? s : Math.min(retrySeconds, s);
                }
                continue;
            }

            if (error.status === 503 || error.status === 404) continue;

            // API key ka masla: agla model try karne ka faida nahi
            if (error.status === 401 || error.status === 403 || /API key/i.test(msg)) {
                return res.status(500).json({
                    error: 'Server configuration problem. Please contact the site owner.'
                });
            }

            // Koi aur error (jaise kisi ek model ka masla): agla model try karo
            hadOtherError = true;
            continue;
        }
    }

    // Koi bhi model kaam nahi kar saka
    if (sawRateLimit) {
        if (retrySeconds !== null && !sawDailyLimit) {
            return res.status(429).json({
                error: `⚠️ Limit full! Please wait ${retrySeconds} seconds before sending the next message.`
            });
        }
        const diffMs = getMsUntilPacificMidnight();
        const hoursLeft = Math.floor(diffMs / (1000 * 60 * 60));
        const minsLeft = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        return res.status(429).json({
            error: `⚠️ Daily limit full! It will reset in ${hoursLeft} hours and ${minsLeft} minutes.`
        });
    }

    if (sawEmpty) {
        return res.status(422).json({
            error: 'The AI could not generate a response for this message. Please try rephrasing it.'
        });
    }

    if (hadOtherError) {
        return res.status(500).json({
            error: 'Something went wrong on the server. Please try again.'
        });
    }

    res.status(503).json({
        error: '⚠️ All AI models are busy right now. Please try again in a minute.'
    });
});

// Kharab JSON ya bohat bari request par bhi JSON error jaye (HTML nahi)
app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request is too large.' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid request format.' });
    }
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
    console.log(`Chatbot is running on port ${PORT}`);
});
