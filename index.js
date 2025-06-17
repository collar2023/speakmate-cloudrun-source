const express = require('express');
const { TranslationServiceClient } = require('@google-cloud/translate');

const app = express();
const port = process.env.PORT || 8080;

// 初始化Google Cloud客户端
// 在Cloud Run中，如果服务被赋予了服务账号，它会自动进行认证！
const translationClient = new TranslationServiceClient();

// 中间件，用于处理CORS
app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }
    next();
});

app.use(express.json());

// 测试端点
app.get('/api/test-auth', async (req, res) => {
    try {
        console.log('Testing Translation API via Cloud Run...');
        const projectId = await translationClient.getProjectId();
        
        const [response] = await translationClient.translateText({
            parent: `projects/${projectId}/locations/global`,
            contents: ["hello"],
            targetLanguageCode: "es",
        });
        
        const translatedText = response.translations[0].translatedText;

        res.status(200).json({ 
            message: "SUCCESS! Cloud Run service is running and successfully called the Translate API.",
            projectId: projectId,
            translationResult: translatedText
        });

    } catch (error) {
        console.error('Test failed:', error);
        res.status(500).json({
            error: "Test failed.",
            details: error.message,
            stack: error.stack
        });
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});