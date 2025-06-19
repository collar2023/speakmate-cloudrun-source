const express = require('express');
const { TranslationServiceClient } = require('@google-cloud/translate');
const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 8080;
const projectId = process.env.GCLOUD_PROJECT;

// 初始化Google Cloud客户端（保持服务账号认证）
const translationClient = new TranslationServiceClient();
const speechClient = new SpeechClient();
const ttsClient = new TextToSpeechClient();

// Google AI Studio API 配置
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = 'gemini-2.0-flash'; // 使用你提到的最新模型

// 中间件设置
app.use(express.json({ limit: '10mb' }));

// 聊天历史存储
const chatHistories = new Map();

// 日志函数
function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    
    if (data) {
        console.log(logEntry, data);
    } else {
        console.log(logEntry);
    }
}

// 环境变量验证函数
function validateEnvironment() {
    const required = ['TELEGRAM_BOT_TOKEN', 'GCLOUD_PROJECT'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        log('error', `Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
    
    if (!GOOGLE_AI_API_KEY) {
        log('warn', 'GOOGLE_AI_API_KEY not set - AI chat functionality will be disabled');
    } else {
        log('info', 'Google AI Studio API Key configured successfully');
        // 验证 API Key 格式（Google AI Studio API Key 通常以 AIza 开头）
        if (!GOOGLE_AI_API_KEY.startsWith('AIza')) {
            log('warn', 'GOOGLE_AI_API_KEY format may be incorrect (should start with "AIza")');
        }
    }
    
    log('info', 'Environment validation completed');
}

// 调用 Gemini API 的函数实现
async function callGeminiAPI(messages) {
    try {
        const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${GOOGLE_AI_API_KEY}`;
        
        // 构建请求体
        const requestBody = {
            contents: messages,
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 2048,
            },
            safetySettings: [
                {
                    category: "HARM_CATEGORY_HARASSMENT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_HATE_SPEECH",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                }
            ]
        };

        log('debug', 'Calling Gemini API', { 
            url: url.replace(GOOGLE_AI_API_KEY, '[REDACTED]'),
            messagesCount: messages.length 
        });

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            log('error', `Gemini API HTTP error: ${response.status}`, { 
                status: response.status,
                statusText: response.statusText,
                errorBody: errorText
            });
            
            // 提供更具体的错误信息
            if (response.status === 403) {
                throw new Error('API_KEY_INVALID: Google AI Studio API Key 无效或无权限');
            } else if (response.status === 429) {
                throw new Error('QUOTA_EXCEEDED: API 配额已用完，请等待重置');
            } else if (response.status === 400) {
                throw new Error('BAD_REQUEST: 请求格式错误或内容被安全过滤器阻止');
            } else {
                throw new Error(`HTTP_ERROR: ${response.status} - ${response.statusText}`);
            }
        }

        const result = await response.json();
        
        // 检查 API 响应是否包含错误
        if (result.error) {
            log('error', 'Gemini API returned error', result.error);
            throw new Error(`GEMINI_API_ERROR: ${result.error.message || 'Unknown API error'}`);
        }

        // 检查是否有有效的回复内容
        if (!result.candidates || result.candidates.length === 0) {
            log('warn', 'Gemini API returned no candidates', result);
            throw new Error('NO_RESPONSE: Gemini API 没有返回有效回复');
        }

        // 检查内容是否被安全过滤器阻止
        const candidate = result.candidates[0];
        if (candidate.finishReason === 'SAFETY') {
            log('warn', 'Content blocked by safety filters', candidate);
            throw new Error('CONTENT_BLOCKED: 内容被安全过滤器阻止，请重新组织您的问题');
        }

        log('debug', 'Gemini API call successful', {
            candidatesCount: result.candidates.length,
            finishReason: candidate.finishReason
        });

        return result;

    } catch (error) {
        // 如果是我们抛出的错误，直接传递
        if (error.message.includes('API_KEY_INVALID') || 
            error.message.includes('QUOTA_EXCEEDED') || 
            error.message.includes('BAD_REQUEST') ||
            error.message.includes('CONTENT_BLOCKED') ||
            error.message.includes('NO_RESPONSE')) {
            throw error;
        }

        // 处理网络错误等其他错误
        log('error', 'Unexpected error calling Gemini API', error);
        
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            throw new Error('NETWORK_ERROR: 网络连接失败，请检查网络设置');
        } else if (error.name === 'AbortError') {
            throw new Error('TIMEOUT_ERROR: 请求超时，请稍后重试');
        } else {
            throw new Error(`UNEXPECTED_ERROR: ${error.message}`);
        }
    }
}

// Telegram API请求封装
async function apiRequest(botToken, methodName, params = {}) {
    try {
        const url = `https://api.telegram.org/bot${botToken}/${methodName}`;
        log('debug', `Calling Telegram API: ${methodName}`, { params });
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        
        const result = await response.json();
        
        if (!result.ok) {
            log('error', `Telegram API error for ${methodName}`, result);
            throw new Error(`Telegram API error: ${result.description || 'Unknown error'}`);
        }
        
        log('debug', `Telegram API success: ${methodName}`);
        return result;
    } catch (error) {
        log('error', `Error calling Telegram API ${methodName}`, error);
        throw error;
    }
}

// 安全发送消息（不会抛出异常）
async function safeSendMessage(botToken, chatId, text) {
    try {
        await apiRequest(botToken, 'sendMessage', { chat_id: chatId, text });
        log('info', `Message sent successfully to chat ${chatId}`);
    } catch (error) {
        log('error', `Failed to send message to chat ${chatId}`, error);
    }
}

// 处理语音消息
async function handleVoiceMessage(botToken, message) {
    const chatId = message.chat.id;
    log('info', `Processing voice message from chat ${chatId}`);
    
    try {
        // 发送处理中消息
        await apiRequest(botToken, 'sendMessage', { 
            chat_id: chatId, 
            text: "🎙️ 正在识别语音，请稍候..." 
        });
        
        // 获取语音文件
        log('debug', 'Getting voice file info');
        const fileInfo = await apiRequest(botToken, 'getFile', { file_id: message.voice.file_id });
        
        const voiceUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
        log('debug', `Downloading voice from: ${voiceUrl}`);
        
        const voiceRes = await fetch(voiceUrl);
        if (!voiceRes.ok) {
            throw new Error(`下载语音文件失败: ${voiceRes.statusText}`);
        }
        
        const voiceBuf = await voiceRes.arrayBuffer();
        const voiceBase64 = Buffer.from(voiceBuf).toString('base64');
        log('debug', `Voice file downloaded, size: ${voiceBuf.byteLength} bytes`);

        // 语音识别
        log('debug', 'Starting speech recognition');
        const [sttResponse] = await speechClient.recognize({
            config: { 
                encoding: "OGG_OPUS", 
                sampleRateHertz: 16000,
                languageCode: "zh-CN",
                enableAutomaticPunctuation: true
            },
            audio: { content: voiceBase64 }
        });
        
        const transcript = sttResponse.results
            ?.map(r => r.alternatives?.[0]?.transcript)
            ?.filter(Boolean)
            ?.join('\n') || '（未能识别语音内容）';
        
        log('info', `Speech recognition completed for chat ${chatId}`, { transcript });
        
        await apiRequest(botToken, 'sendMessage', { 
            chat_id: chatId, 
            text: `🎯 识别结果: ${transcript}` 
        });
        
    } catch (error) {
        log('error', `Voice processing error for chat ${chatId}`, error);
        // 异步发送错误消息，不阻塞主流程
        setImmediate(() => {
            safeSendMessage(botToken, chatId, `❌ 语音识别失败：${error.message}`);
        });
    }
}

// 处理翻译功能
async function handleTranslation(botToken, chatId, content) {
    log('info', `Processing translation for chat ${chatId}`, { content });
    
    try {
        await apiRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' });
        
        const [response] = await translationClient.translateText({
            parent: `projects/${projectId}/locations/global`,
            contents: [content],
            targetLanguageCode: "en"
        });
        
        const translatedText = response.translations[0].translatedText;
        log('info', `Translation completed for chat ${chatId}`, { translatedText });
        
        await apiRequest(botToken, 'sendMessage', {
            chat_id: chatId,
            text: `🌐 翻译结果:\n${translatedText}`
        });
        
    } catch (error) {
        log('error', `Translation error for chat ${chatId}`, error);
        setImmediate(() => {
            safeSendMessage(botToken, chatId, `❌ 翻译失败：${error.message}`);
        });
    }
}

// 处理文本转语音功能
async function handleTextToSpeech(botToken, chatId, content) {
    log('info', `Processing TTS for chat ${chatId}`, { content });
    
    try {
        await apiRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'upload_voice' });

        const [response] = await ttsClient.synthesizeSpeech({
            input: { text: content },
            voice: { languageCode: 'en-US', name: 'en-US-Standard-C' },
            audioConfig: { audioEncoding: 'MP3' },
        });

        const audioBuffer = Buffer.from(response.audioContent, 'base64');
        log('debug', `TTS audio generated, size: ${audioBuffer.length} bytes`);
        
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
            throw new Error(`语音发送失败：${result.description || '未知错误'}`);
        }
        
        log('info', `TTS voice sent successfully to chat ${chatId}`);
        
    } catch (error) {
        log('error', `TTS error for chat ${chatId}`, error);
        setImmediate(() => {
            safeSendMessage(botToken, chatId, `❌ 语音合成失败：${error.message}`);
        });
    }
}

// 处理AI聊天功能
async function handleAIChat(botToken, chatId, text) {
    log('info', `Processing AI chat for chat ${chatId}`, { text });
    
    // 检查 API Key 是否配置
    if (!GOOGLE_AI_API_KEY) {
        log('error', `Google AI API Key not configured for chat ${chatId}`);
        setImmediate(() => {
            safeSendMessage(botToken, chatId, '❌ AI聊天功能暂时不可用。\n\n请检查 GOOGLE_AI_API_KEY 环境变量是否正确配置。');
        });
        return;
    }
    
    try {
        await apiRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' });

        // 获取聊天历史
        const history = chatHistories.get(chatId) || [];
        
        // 构建消息数组，按照 Google AI Studio API 格式
        const messages = [];
        
        // 添加历史对话
        for (const msg of history) {
            messages.push({
                role: msg.role,
                parts: [{ text: msg.text }]
            });
        }
        
        // 添加当前用户消息
        messages.push({
            role: 'user',
            parts: [{ text: text }]
        });
        
        log('debug', `AI chat history length: ${history.length}`);
        
        // 调用 Gemini API
        const result = await callGeminiAPI(messages);
        
        // 提取回复内容
        const reply = result.candidates?.[0]?.content?.parts?.[0]?.text || '抱歉，我无法生成回复。';

        await apiRequest(botToken, 'sendMessage', { chat_id: chatId, text: reply });

        // 更新聊天历史
        const updatedHistory = [...history, { role: 'user', text }, { role: 'model', text: reply }];
        chatHistories.set(chatId, updatedHistory.slice(-20)); // 保持最近20条记录
        
        log('info', `AI chat completed for chat ${chatId}`, { replyLength: reply.length });
        
    } catch (error) {
        log('error', `AI chat error for chat ${chatId}`, error);
        
        // 详细的错误信息
        let errorMessage = '❌ AI聊天暂时不可用';
        
        if (error.message?.includes('403') || error.message?.includes('API_KEY')) {
            errorMessage += '\n\n🔑 API Key 问题：\n' +
                           '• 请检查 GOOGLE_AI_API_KEY 是否正确\n' +
                           '• 确保 API Key 有效且未过期';
        } else if (error.message?.includes('429') || error.message?.includes('QUOTA')) {
            errorMessage += '\n\n📊 配额超限：\n' +
                           '• Google AI Studio 配额已用完\n' +
                           '• 请等待配额重置或升级计划';
        } else if (error.message?.includes('400')) {
            errorMessage += '\n\n🚫 请求格式错误：\n' +
                           '• 您的消息可能包含不支持的内容\n' +
                           '• 请重新组织您的问题';
        } else {
            errorMessage += `\n\n🔍 错误详情：${error.message}`;
        }
        
        setImmediate(() => {
            safeSendMessage(botToken, chatId, errorMessage);
        });
    }
}

// 主要的Telegram Webhook处理器
app.post('/', async (req, res) => {
    // 立即返回200状态码，防止Telegram重复发送
    res.status(200).send('OK');
    
    if (!req.body?.message) {
        log('debug', 'Received request without message');
        return;
    }

    const message = req.body.message;
    const chatId = message.chat.id;
    const text = message.text || '';
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    log('info', `Received message from chat ${chatId}`, { 
        messageType: message.voice ? 'voice' : 'text',
        textLength: text.length,
        userId: message.from?.id
    });

    if (!botToken) {
        log('error', 'TELEGRAM_BOT_TOKEN is not set');
        return;
    }

    // 异步处理消息，不阻塞响应
    setImmediate(async () => {
        try {
            // 处理语音消息
            if (message.voice) {
                await handleVoiceMessage(botToken, message);
                return;
            }
            
            // 处理文本消息
            if (text) {
                // 重置对话
                if (text === '/reset') {
                    chatHistories.delete(chatId);
                    log('info', `Chat history cleared for chat ${chatId}`);
                    await safeSendMessage(botToken, chatId, '🧹 对话上下文已清空。');
                    return;
                }

                // 帮助信息
                if (text.startsWith('/start') || text.startsWith('/help')) {
                    log('info', `Sending help message to chat ${chatId}`);
                    await safeSendMessage(botToken, chatId, 
                        `🤖 欢迎使用 SpeakMate AI 机器人！

我可以执行以下任务：

🧠 **多轮 AI 聊天**：直接输入问题即可对话
🌐 **文本翻译**：/translate <文本>
🔊 **文本转语音**：/tts <文本>
🎙️ **语音识别**：发送语音消息即可识别为文字
🧹 **清除聊天记录**：/reset

直接输入你的问题即可开始聊天！
或尝试发送语音消息来测试语音识别功能。`);
                    return;
                }

                // 翻译功能
                if (text.startsWith('/translate')) {
                    const content = text.substring('/translate'.length).trim();
                    if (!content) {
                        await safeSendMessage(botToken, chatId, '❓ 用法: /translate <要翻译的文本>');
                        return;
                    }
                    await handleTranslation(botToken, chatId, content);
                    return;
                }

                // 文本转语音功能
                if (text.startsWith('/tts')) {
                    const content = text.substring('/tts'.length).trim();
                    if (!content) {
                        await safeSendMessage(botToken, chatId, '❓ 用法: /tts <要转为语音的文本>');
                        return;
                    }
                    await handleTextToSpeech(botToken, chatId, content);
                    return;
                }

                // AI 聊天功能
                await handleAIChat(botToken, chatId, text);
            }
        } catch (error) {
            log('error', `Unexpected error in message handler for chat ${chatId}`, error);
            await safeSendMessage(botToken, chatId, '❌ 服务暂时不可用，请稍后再试。');
        }
    });
});

// 健康检查端点
app.get('/health', (req, res) => {
    const healthStatus = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        version: process.env.npm_package_version || '1.2.0',
        chatHistories: chatHistories.size,
        environment: {
            nodeVersion: process.version,
            projectId: projectId || 'not-set',
            botTokenConfigured: !!process.env.TELEGRAM_BOT_TOKEN,
            googleAiApiKeyConfigured: !!GOOGLE_AI_API_KEY,
            geminiModel: GEMINI_MODEL
        }
    };
    
    log('info', 'Health check requested', healthStatus);
    res.json(healthStatus);
});

// 全局错误处理中间件
app.use((err, req, res, next) => {
    log('error', 'Global error handler triggered', err);
    
    // 如果响应已经发送，则不能再发送
    if (res.headersSent) {
        return next(err);
    }
    
    res.status(500).json({ 
        error: 'Internal Server Error', 
        timestamp: new Date().toISOString()
    });
});

// 验证环境变量
validateEnvironment();

// 启动服务器
app.listen(port, () => {
    log('info', `SpeakMate Telegram Bot started successfully`);
    log('info', `Server running on port ${port}`);
    log('info', `Project ID: ${projectId || 'not-set'}`);
    log('info', `Bot Token configured: ${!!process.env.TELEGRAM_BOT_TOKEN}`);
    log('info', `Google AI API Key configured: ${!!GOOGLE_AI_API_KEY}`);
    log('info', `Gemini Model: ${GEMINI_MODEL}`);
    log('info', `Node.js version: ${process.version}`);
    log('info', `Memory usage:`, process.memoryUsage());
});

// 优雅关闭处理
process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    log('info', 'SIGINT received, shutting down gracefully');
    process.exit(0);
});

// 未捕获异常处理
process.on('uncaughtException', (error) => {
    log('error', 'Uncaught Exception', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log('error', 'Unhandled Rejection', { reason, promise });
});