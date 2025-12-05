const express = require('express');
const { validateApiKey, getCurrentApiKey } = require('./apiMiddleware');

function createApiRoutes(scraperManager) {
    const router = express.Router();

    // Get API Key (for UI display) - no auth required for this specific endpoint
    router.get('/key', (req, res) => {
        res.json({ apiKey: getCurrentApiKey() });
    });

    // All other routes require API key
    router.use(validateApiKey);

    // POST /api/v1/scrape - Start a new extraction
    router.post('/scrape', async (req, res) => {
        try {
            const {
                specialties = [],
                city = '',
                quantity = 10,
                onlyWithPhone = false,
                jsonLogs = false,
                webhook = null
            } = req.body;

            // Validate quantity
            const qty = parseInt(quantity);
            if (isNaN(qty) || qty < 1 || qty > 5000) {
                return res.status(400).json({
                    error: 'Bad Request',
                    message: 'Quantidade deve ser entre 1 e 5000'
                });
            }

            // Start the scrape via manager
            const config = {
                specialties: Array.isArray(specialties) ? specialties : [],
                city: String(city),
                quantity: qty,
                onlyWithPhone: Boolean(onlyWithPhone),
                jsonLogs: Boolean(jsonLogs),
                webhook: webhook || null,
                source: 'api'
            };

            const id = await scraperManager.startScrape(config);

            res.status(202).json({
                id,
                status: 'processing',
                message: 'Extração iniciada com sucesso'
            });

        } catch (error) {
            console.error('API Error starting scrape:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: error.message
            });
        }
    });

    // GET /api/v1/scrape/:id - Get extraction status/result
    router.get('/scrape/:id', async (req, res) => {
        try {
            const { id } = req.params;

            // Check if scraper is currently running
            const activeScraper = scraperManager.getScraper(id);
            if (activeScraper) {
                return res.json({
                    id,
                    status: activeScraper.status,
                    progress: {
                        current: activeScraper.progress?.current || 0,
                        total: activeScraper.progress?.total || 0,
                        successCount: activeScraper.progress?.successCount || 0,
                        errorCount: activeScraper.progress?.errorCount || 0,
                        skippedCount: activeScraper.progress?.skippedCount || 0
                    }
                });
            }

            // Check history
            const historyItem = scraperManager.getHistory().find(h => h.id === id);
            if (historyItem) {
                const response = {
                    id: historyItem.id,
                    status: historyItem.status,
                    config: historyItem.config
                };

                if (historyItem.status === 'completed' && historyItem.result) {
                    response.metadata = {
                        startTime: historyItem.result.startTime,
                        endTime: historyItem.result.endTime,
                        totalResults: historyItem.result.count || 0
                    };

                    // Build CSV URL
                    if (historyItem.result.filePath) {
                        const filename = historyItem.result.filePath.split(/[\\/]/).pop();
                        response.csvUrl = `/results/${filename}`;
                    }

                    response.results = historyItem.result.data || [];

                    // Include logs if jsonLogs was true in config
                    if (historyItem.config?.jsonLogs && historyItem.result.logs) {
                        response.logs = historyItem.result.logs;
                    }
                }

                if (historyItem.status === 'failed') {
                    response.error = historyItem.error;
                }

                return res.json(response);
            }

            res.status(404).json({
                error: 'Not Found',
                message: 'Extração não encontrada'
            });

        } catch (error) {
            console.error('API Error getting scrape:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: error.message
            });
        }
    });

    // GET /api/v1/history - List all extractions
    router.get('/history', (req, res) => {
        try {
            const history = scraperManager.getHistory().map(item => ({
                id: item.id,
                config: {
                    specialties: item.config?.specialties || [],
                    city: item.config?.city || '',
                    quantity: item.config?.quantity || 0,
                    onlyWithPhone: item.config?.onlyWithPhone || false
                },
                status: item.status,
                resultCount: item.result?.count || 0,
                timestamp: item.timestamp
            }));

            res.json({ history });

        } catch (error) {
            console.error('API Error getting history:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: error.message
            });
        }
    });

    return router;
}

module.exports = createApiRoutes;
