const express = require('express');
const { TranslationServiceClient } = require('@google-cloud/translate');

const app = express();
const port = process.env.PORT || 8080;

// 初始化Google Cloud客户端
const translationClient = new TranslationServiceClient();

// 中间件：这个必须放在最前面，用于解析所有进来的JSON请求
app.use(express.json());

// --- Telegram API 辅助函数 ---
async function sendMessage(botToken, chatId, text) {
    // 您需要从环境变量中获取Bot Token
    // 但为了快速测试，我们暂时硬编码一个占位符
    // 稍后我们会改成从环境变量读取
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        console.error("TELEGRAM_BOT_TOKEN environment variable not set!");
        // 在实际生产中，这里应该抛出错误或有更好的处理
        return; 
    }
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text }),
        });
    } catch (error) {
        console.error("Failed to send message to Telegram:", error);
    }
}


// --- Telegram Webhook 处理器 ---
// Telegram 会向这个根路径'/'发送POST请求
app.post('/', async (req, res) => {
    const update = req.body;

    // 验证这是一个有效的Telegram消息更新
    if (!update || !update.message || !update.message.text) {
        return res.status(200).send('OK'); // 告诉Telegram我们收到了，但这不是我们关心的消息
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text;

    try {
        // 简单的命令路由
        if (text.startsWith('/translate')) {
            const textToTranslate = text.substring('/translate'.length).trim();

            if (!textToTranslate) {
                await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, '请输入要翻译的内容。用法: /translate hello world');
            } else {
                await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, `正在翻译 "${textToTranslate}"...`);
                
                const projectId = await translationClient.getProjectId();
                const [response] = await translationClient.translateText({
                    parent: `projects/${projectId}/locations/global`,
                    contents: [textToTranslate],
                    targetLanguageCode: "zh-CN", // 我们将它翻译成中文
                });

                const translatedText = response.translations[0].translatedText;
                await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, `翻译结果: ${translatedText}`);
            }
        } else {
             await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, '你好！我暂时只懂 /translate 命令。');
        }
    } catch (error) {
        console.error("Error processing Telegram update:", error);
        await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, `处理您的请求时发生错误: ${error.message}`);
    }

    // 务必返回一个200 OK，否则Telegram会不停地重试发送这个Webhook
    res.status(200).send('OK');
});


// --- 保留我们的诊断端点 ---
app.get('/api/test-auth', async (req, res) => {
    try {
        const projectId = await translationClient.getProjectId();
        const [response] = await translationClient.translateText({
            parent: `projects/${projectId}/locations/global`, contents: ["hello"], targetLanguageCode: "es",
        });
        const translatedText = response.translations[0].translatedText;
        res.status(200).json({ 
            message: "SUCCESS! Cloud Run service is running and successfully called the Translate API.",
            translationResult: translatedText
        });
    } catch (error) {
        res.status(500).json({ error: "Test failed.", details: error.message });
    }
});


app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});