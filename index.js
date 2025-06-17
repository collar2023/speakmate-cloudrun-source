const express = require('express');
const { TranslationServiceClient } = require('@google-cloud/translate');
const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { VertexAI } = require('@google-cloud/vertex-ai');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 8080;
const projectId = process.env.GCLOUD_PROJECT;
const region = 'us-central1';

const translationClient = new TranslationServiceClient();
const speechClient = new SpeechClient();
const ttsClient = new TextToSpeechClient();
const vertex_ai = new VertexAI({ project: projectId, location: region });
const geminiModel = vertex_ai.getGenerativeModel({ model: 'gemini-pro' });

app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    next();
});

const apiRouter = express.Router();

apiRouter.post('/translate', async (req, res, next) => {
    try {
        const { text, targetLanguageCode = 'en' } = req.body;
        if (!text) return res.status(400).json({ error: 'Missing text' });
        const [response] = await translationClient.translateText({
            parent: `projects/${projectId}/locations/global`,
            contents: [text],
            targetLanguageCode,
        });
        res.json({ translated: response.translations[0].translatedText });
    } catch (error) {
        next(error);
    }
});

apiRouter.post('/chat', async (req, res, next) => {
    try {
        const { prompt, history = [] } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
        const contents = history.map(item => ({ role: item.role, parts: [{ text: item.text }] }))
            .concat([{ role: 'user', parts: [{ text: prompt }] }]);
        const result = await geminiModel.generateContent({ contents });
        res.json({ reply: result.response.candidates[0].content.parts[0].text });
    } catch (error) {
        next(error);
    }
});

apiRouter.post('/speech', async (req, res, next) => {
    try {
        const { audioContent, config } = req.body;
        if (!audioContent || !config) return res.status(400).json({ error: 'Missing audioContent or config' });
        const [response] = await speechClient.recognize({
            config: config,
            audio: { content: audioContent },
        });
        const transcription = response.results.map(r => r.alternatives[0].transcript).join('\n');
        res.json({ text: transcription });
    } catch (error) {
        next(error);
    }
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
    } catch (error) {
        next(error);
    }
});

app.use('/api', apiRouter);

// ========== Telegram Bot Section ==========

const chatHistories = new Map();

async function apiRequest(botToken, methodName, params = {}) {
    const url = `https://api.telegram.org/bot${botToken}/${methodName}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
    });
    return response.json();
}

app.post('/', async (req, res) => {
    if (!req.body?.message) return res.status(200).send('OK');

    const message = req.body.message;
    const chatId = message.chat.id;
    const text = message.text || '';
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    try {
        if (message.voice) {
            await apiRequest(botToken, 'sendMessage', { chat_id: chatId, text: "正在识别语音..." });
            const fileInfo = await apiRequest(botToken, 'getFile', { file_id: message.voice.file_id });
            const voiceUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
            const voiceRes = await fetch(voiceUrl);
            const voiceBuf = await voiceRes.arrayBuffer();
            const voiceBase64 = Buffer.from(voiceBuf).toString('base64');

            const [sttResponse] = await speechClient.recognize({
                config: { encoding: "OGG_OPUS", sampleRateHertz: 48000, languageCode: "zh-CN" },
                audio: { content: voiceBase64 }
            });
            const transcript = sttResponse.results.map(r => r.alternatives[0].transcript).join('\n') || '（未识别）';
            await apiRequest(botToken, 'sendMessage', { chat_id: chatId, text: `识别结果: ${transcript}` });
        } else if (text) {
            if (text === '/reset') {
                chatHistories.delete(chatId);
                return await apiRequest(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: '对话上下文已清空。'
                });
            }

            if (text.startsWith('/start') || text.startsWith('/help')) {
                return await apiRequest(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: `🤖 欢迎使用 SpeakMate AI 机器人！

我可以执行以下任务：

🧠 多轮 AI 聊天（具备上下文记忆）
🌐 文本翻译：/translate <文本>
🔊 文本转语音：/tts <文本>
🎙️ 语音识别：发送语音消息即可识别为文字
🧹 清除聊天上下文：/reset

直接输入你的问题即可开始聊天！`
                });
            }

            if (text.startsWith('/translate')) {
                const content = text.substring('/translate'.length).trim();
                const [response] = await translationClient.translateText({
                    parent: `projects/${projectId}/locations/global`,
                    contents: [content],
                    targetLanguageCode: "en"
                });
                return await apiRequest(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: `翻译: ${response.translations[0].translatedText}`
                });
            }

            if (text.startsWith('/tts')) {
                const content = text.substring('/tts'.length).trim();
                if (!content) return await apiRequest(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: '用法: /tts <要转为语音的文本>'
                });

                await apiRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'upload_voice' });

                const [response] = await ttsClient.synthesizeSpeech({
                    input: { text: content },
                    voice: { languageCode: 'en-US', name: 'en-US-Standard-C' },
                    audioConfig: { audioEncoding: 'MP3' },
                });

                const audioBuffer = Buffer.from(response.audioContent, 'base64');
                const form = new FormData();
                form.append('chat_id', chatId);
                form.append('voice', audioBuffer, {
                    filename: 'tts.mp3',
                    contentType: 'audio/mpeg'
                });

                const uploadRes = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
                    method: 'POST',
                    headers: form.getHeaders(),
                    body: form
                });

                const result = await uploadRes.json();
                if (!result.ok) {
                    console.error('sendVoice failed:', result);
                    await apiRequest(botToken, 'sendMessage', {
                        chat_id: chatId,
                        text: `语音发送失败：${result.description || '未知错误'}`
                    });
                }
                return;
            }

            await apiRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' });

            const history = chatHistories.get(chatId) || [];
            const contents = history.map(h => ({
                role: h.role,
                parts: [{ text: h.text }]
            })).concat([{ role: 'user', parts: [{ text }] }]);

            const result = await geminiModel.generateContent({ contents });
            const reply = result.response.candidates[0].content.parts[0].text;

            await apiRequest(botToken, 'sendMessage', { chat_id: chatId, text: reply });

            const updatedHistory = [...history, { role: 'user', text }, { role: 'model', text: reply }];
            chatHistories.set(chatId, updatedHistory.slice(-20));
        }
    } catch (error) {
        console.error("Telegram handler error:", error);
        await apiRequest(botToken, 'sendMessage', {
            chat_id: message.chat.id,
            text: '发生错误，稍后再试。'
        });
    }

    res.status(200).send('OK');
});

app.use((err, req, res, next) => {
    console.error("Global Error:", err.stack);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
