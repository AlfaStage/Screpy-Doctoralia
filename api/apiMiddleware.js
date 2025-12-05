const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Generate a secure API key
function generateApiKey() {
    return 'sk_' + crypto.randomBytes(24).toString('hex');
}

// Get or create API key
function getOrCreateApiKey() {
    let apiKey = process.env.API_KEY;

    if (!apiKey || apiKey.trim() === '') {
        apiKey = generateApiKey();

        // Try to save to .env file
        const envPath = path.join(__dirname, '..', '.env');
        try {
            let envContent = '';
            if (fs.existsSync(envPath)) {
                envContent = fs.readFileSync(envPath, 'utf8');
            }

            // Check if API_KEY line exists
            if (envContent.includes('API_KEY=')) {
                envContent = envContent.replace(/API_KEY=.*/, `API_KEY=${apiKey}`);
            } else {
                envContent += `\n# API Key (auto-generated)\nAPI_KEY=${apiKey}\n`;
            }

            fs.writeFileSync(envPath, envContent);
            console.log('🔑 API Key gerada e salva no .env');
        } catch (err) {
            console.warn('⚠️ Não foi possível salvar API Key no .env:', err.message);
        }

        // Update process.env for current session
        process.env.API_KEY = apiKey;
    }

    return apiKey;
}

// Middleware to validate API key
function validateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    const validKey = process.env.API_KEY;

    if (!apiKey) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'API Key é obrigatória. Use o header X-API-Key ou query param api_key.'
        });
    }

    if (apiKey !== validKey) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'API Key inválida.'
        });
    }

    next();
}

// Get current API key (for display in UI)
function getCurrentApiKey() {
    return process.env.API_KEY;
}

module.exports = {
    generateApiKey,
    getOrCreateApiKey,
    validateApiKey,
    getCurrentApiKey
};
