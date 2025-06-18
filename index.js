const express = require('express');
const { TranslationServiceClient } = require('@google-cloud/translate');
const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { GoogleGenerativeAI } = require('@google/genai');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 8080;
const projectId = process.env.GCLOUD_PROJECT;

// 初始化Google Cloud客户端
const translationClient = new TranslationServiceClient();
const speechClient = new SpeechClient();
const ttsClient = new TextToSpeechClient();

// 初始化新的GenAI客户端
let genAI;
let geminiModel;

try {
    genAI = new GoogleGenerativeAI({
        projectId: projectId,
        location: 'us-central1', // 或者您偏好的区域
        apiKey: process.env.GOOGLE_API_KEY // 如果使用API密钥
    });
    
    // 使用稳定的Gemini模型
    geminiModel = genAI.getGenerativeModel({ 
        model: 'gemini-1.0-pro' // 使用兼容性更好的模型
    });
    
    log('info', 'Google GenAI client initialized successfully');
} catch (error) {
    log('error', 'Failed to initialize Google GenAI client', error);
    geminiModel = null;
}

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
    
    // 检查模型是否初始化成功
    if (!geminiModel) {
        log('error', `Gemini model not available for chat ${chatId}`);
        setImmediate(() => {
            safeSendMessage(botToken, chatId, '❌ AI聊天功能暂时不可用，模型初始化失败。\n\n请检查环境变量配置和API启用状态。');
        });
        return;
    }
    
    try {
        await apiRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' });

        const history = chatHistories.get(chatId) || [];
        
        // 构建聊天历史（新SDK格式）
        const chatHistory = history.map(h => ({
            role: h.role === 'model' ? 'model' : 'user',
            parts: [{ text: h.text }]
        }));

        log('debug', `AI chat history length: ${history.length}`);
        
        // 使用新的API格式
        const chat = geminiModel.startChat({
            history: chatHistory,
            generationConfig: {
                maxOutputTokens: 1000,
                temperature: 0.7,
            },
        });

        const result = await chat.sendMessage(text);
        const reply = result.response.text() || '抱歉，我无法生成回复。';

        await apiRequest(botToken, 'sendMessage', { chat_id: chatId, text: reply });

        // 更新聊天历史
        const updatedHistory = [...history, { role: 'user', text }, { role: 'model', text: reply }];
        chatHistories.set(chatId, updatedHistory.slice(-20)); // 保持最近20条记录
        
        log('info', `AI chat completed for chat ${chatId}`, { replyLength: reply.length });
        
    } catch (error) {
        log('error', `AI chat error for chat ${chatId}`, error);
        
        // 详细的错误信息
        let errorMessage = '❌ AI聊天暂时不可用';
        
        if (error.message?.includes('403') || error.message?.includes('SERVICE_DISABLED')) {
            errorMessage += '\n\n🔧 **配置检查**：\n' +
                           '• 确保Vertex AI API已启用\n' +
                           '• 检查服务账号权限\n' +
                           '• 验证项目绑定付款方式\n' +
                           '• 新项目可能需要24-48小时激活\n\n' +
                           '💡 **临时解决方案**：\n' +
                           '• 尝试使用其他功能（翻译、语音识别等）';
        } else if (error.message?.includes('quota')) {
            errorMessage += '\n\n📊 配额不足，请稍后重试或检查配额设置。';
        } else if (error.message?.includes('model')) {
            errorMessage += '\n\n🤖 模型不可用，可能是新项目限制或模型版本问题。';
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
或尝试发送语音消息来测试语音识别功能。

🔧 **版本信息**：v1.2.0 - 使用最新Google GenAI SDK`);
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
        version: '1.2.0',
        chatHistories: chatHistories.size,
        environment: {
            nodeVersion: process.version,
            projectId: projectId || 'not-set',
            botTokenConfigured: !!process.env.TELEGRAM_BOT_TOKEN,
            geminiModelAvailable: !!geminiModel
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

// 启动服务器
app.listen(port, () => {
    log('info', `SpeakMate Telegram Bot started successfully`);
    log('info', `Server running on port ${port}`);
    log('info', `Project ID: ${projectId || 'not-set'}`);
    log('info', `Bot Token configured: ${!!process.env.TELEGRAM_BOT_TOKEN}`);
    log('info', `Gemini Model available: ${!!geminiModel}`);
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