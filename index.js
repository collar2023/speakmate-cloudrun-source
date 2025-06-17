// index.js - Final version supporting both Web UI and Telegram Bot

const express = require('express');
const { TranslationServiceClient } = require('@google-cloud/translate');
const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { VertexAI } = require('@google-cloud/vertex-ai');

// --- Initialization ---
const app = express();
const port = process.env.PORT || 8080;
const projectId = process.env.GCLOUD_PROJECT;
const region = 'us-central1';

// Initialize Google Cloud clients
const translationClient = new TranslationServiceClient();
const speechClient = new SpeechClient();
const ttsClient = new TextToSpeechClient();
const vertex_ai = new VertexAI({ project: projectId, location: region });
const geminiModel = vertex_ai.getGenerativeModel({ model: 'gemini-pro' });

// --- Middlewares ---
app.use(express.json({ limit: '10mb' })); // Increase limit for Base64 audio

// CORS Middleware for Web UI
app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*'); // For development. In production, change to your Web UI's domain.
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }
    next();
});

// --- API Router for Web UI ---
const apiRouter = express.Router();

apiRouter.post('/translate', async (req, res, next) => {
    try {
        const { text, targetLanguageCode = 'en' } = req.body;
        if (!text) return res.status(400).json({ error: 'Missing text' });
        const [response] = await translationClient.translateText({
            parent: `projects/${projectId}/locations/global`,
            contents: [text], targetLanguageCode,
        });
        res.json({ translated: response.translations[0].translatedText });
    } catch (error) { next(error); }
});

apiRouter.post('/chat', async (req, res, next) => {
    try {
        const { prompt, history = [] } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
        const contents = history.map(item => ({ role: item.role, parts: [{ text: item.text }] })).concat([{ role: 'user', parts: [{ text: prompt }] }]);
        const result = await geminiModel.generateContent({ contents });
        res.json({ reply: result.response.candidates[0].content.parts[0].text });
    } catch (error) { next(error); }
});

apiRouter.post('/speech', async (req, res, next) => {
    try {
        const { audioContent, config } = req.body;
        if (!audioContent || !config) return res.status(400).json({ error: 'Missing audioContent or config' });
        const [response] = await speechClient.recognize({
            config: config,
            audio: { content: audioContent },
        });
        const transcription = response.results.map(result => result.alternatives[0].transcript).join('\n');
        res.json({ text: transcription });
    } catch (error) { next(error); }
});

apiRouter.post('/tts', async (req, res, next) => {
    try {
        const { text, languageCode = 'en-US', voiceName = 'en-US-Standard-C' } = req.body;
        if (!text) return res.status(400).json({ error: 'Missing text' });
        const [response] = await ttsClient.synthesizeSpeech({
            input: { text },
            voice: { languageCode, name: voiceName },
            audioConfig: { audioEncoding: 'MP3' },
        });
        res.json({ audioContent: response.audioContent.toString('base64') });
    } catch (error) { next(error); }
});

app.use('/api', apiRouter);

// --- Telegram Webhook Handler ---
async function sendMessage(botToken, chatId, text) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) });
}

app.post('/', async (req, res) => { // Telegram webhook at root path
    if (!req.body || !req.body.message) return res.status(200).send('OK');
    
    const { message } = req.body;
    const chatId = message.chat.id;
    const text = message.text || '';

    try {
        if (text.startsWith('/translate')) {
            const content = text.substring('/translate'.length).trim();
            if (!content) return await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, 'Usage: /translate <text to translate>');
            
            const [response] = await translationClient.translateText({
                parent: `projects/${projectId}/locations/global`, contents: [content], targetLanguageCode: "en",
            });
            await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, `Translation: ${response.translations[0].translatedText}`);
        }
        // Add other Telegram commands (/chat, /tts, voice handling) here...
        else {
            await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, 'Command not recognized. Try /translate <text>.');
        }
    } catch (error) {
        console.error("Telegram handler error:", error);
        await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, 'Sorry, an error occurred.');
    }
    
    res.status(200).send('OK');
});

// --- Final Error Handler ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!', details: err.message });
});

// --- Server Start ---
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});