const DoctoraliaScraper = require('./index');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const webhookService = require('../api/webhookService');

class ScraperManager {
    constructor(io) {
        this.io = io;
        this.scrapers = new Map(); // Map<id, DoctoraliaScraper>
        this.history = [];
        this.MAX_CONCURRENT_SCRAPES = 3;
        this.resultsDir = path.join(__dirname, '..', 'results');

        this.loadHistory();
    }

    async loadHistory() {
        try {
            // Ensure results directory exists
            await fs.mkdir(this.resultsDir, { recursive: true });

            // Read all JSON files from results directory
            const files = await fs.readdir(this.resultsDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            const historyItems = [];

            for (const file of jsonFiles) {
                try {
                    const filePath = path.join(this.resultsDir, file);
                    const data = await fs.readFile(filePath, 'utf8');
                    const jsonData = JSON.parse(data);

                    // Extract ID from filename (format: doctoralia_results_TIMESTAMP.json)
                    const id = file.replace('.json', '').replace('doctoralia_results_', '');

                    // Get file stats for timestamp
                    const stats = await fs.stat(filePath);

                    historyItems.push({
                        id,
                        config: jsonData.config || {},
                        result: {
                            success: true,
                            count: jsonData.results ? jsonData.results.length : 0,
                            filePath: filePath.replace('.json', '.csv'),
                            data: jsonData.results || [],
                            logs: jsonData.logs || []
                        },
                        status: 'completed',
                        timestamp: stats.mtimeMs
                    });
                } catch (err) {
                    console.warn(`Erro ao carregar ${file}:`, err.message);
                }
            }

            // Sort by timestamp (newest first)
            historyItems.sort((a, b) => b.timestamp - a.timestamp);

            this.history = historyItems;
            console.log(`📚 Histórico carregado: ${this.history.length} registros de /results`);
        } catch (error) {
            console.warn('Erro ao carregar histórico:', error.message);
            this.history = [];
        }
    }

    async saveHistory() {
        // No longer save to history.json - history is now based on /results files
        // This method is kept for compatibility but does nothing
        return;
    }

    async startScrape(config) {
        if (this.scrapers.size >= this.MAX_CONCURRENT_SCRAPES) {
            throw new Error(`Máximo de ${this.MAX_CONCURRENT_SCRAPES} scrapers simultâneos atingido.`);
        }

        const id = uuidv4();
        const scraper = new DoctoraliaScraper(id, this.io);

        this.scrapers.set(id, scraper);

        // Notify client of new scraper
        this.io.emit('scraper-created', {
            id,
            config,
            status: 'initializing',
            startTime: Date.now()
        });

        // Start scraping asynchronously
        this.runScraper(id, config);

        return id;
    }

    async runScraper(id, config) {
        const scraper = this.scrapers.get(id);
        if (!scraper) {
            throw new Error('Scraper not found');
        }

        try {
            console.log(`[Manager] Running scraper ${id} with config:`, config);

            // Emit manager log to frontend
            this.io.emit('scraper-progress', {
                id: id,
                message: `[Manager] Iniciando scraper com ${config.quantity} médicos...`,
                status: 'initializing'
            });

            await scraper.initialize();
            console.log(`[Manager] Scraper ${id} initialized`);

            scraper.status = 'running'; // Update scraper status
            const result = await scraper.scrape(
                config.specialties,
                config.city,
                parseInt(config.quantity),
                config.onlyWithPhone || false
            );
            console.log(`[Manager] Scraper ${id} completed. Result:`, result);

            // Emit completion log
            this.io.emit('scraper-progress', {
                id: id,
                message: `[Manager] Scraper concluído com sucesso`,
                status: 'completed'
            });

            // Add to history
            const historyItem = {
                id,
                config,
                result,
                status: 'completed',
                timestamp: Date.now()
            };

            this.history.unshift(historyItem);
            await this.saveHistory();
            console.log(`[Manager] History saved for ${id}`);

            this.io.emit('scraper-completed', { id, result });
            console.log(`[Manager] Emitted scraper-completed for ${id}`);

            // Send webhook if configured (from API request)
            if (config.webhook) {
                const csvFilename = result.filePath ? result.filePath.split(/[\\/]/).pop() : null;
                await webhookService.send(config.webhook, {
                    id,
                    status: 'completed',
                    config: {
                        specialties: config.specialties,
                        city: config.city,
                        quantity: config.quantity,
                        onlyWithPhone: config.onlyWithPhone
                    },
                    metadata: {
                        startTime: scraper.startTime,
                        endTime: new Date().toISOString(),
                        totalResults: result.count || 0
                    },
                    csvUrl: csvFilename ? `/results/${csvFilename}` : null,
                    results: result.data || [],
                    logs: result.logs || []
                }, config.jsonLogs || false);
            }

        } catch (error) {
            console.error(`[Manager] Scraper ${id} failed:`, error);

            const historyItem = {
                id,
                config,
                error: error.message,
                status: 'failed',
                timestamp: Date.now()
            };

            this.history.unshift(historyItem);
            await this.saveHistory();

            this.io.emit('scraper-error', { id, error: error.message });

            // Send webhook error notification if configured
            if (config.webhook) {
                await webhookService.send(config.webhook, {
                    id,
                    status: 'error',
                    error: error.message,
                    config: {
                        specialties: config.specialties,
                        city: config.city,
                        quantity: config.quantity,
                        onlyWithPhone: config.onlyWithPhone
                    }
                }, false);
            }
        } finally {
            await scraper.close();
            this.scrapers.delete(id);
            this.io.emit('scraper-removed', { id });
            console.log(`[Manager] Scraper ${id} cleanup done`);
        }
    }

    getScraper(id) {
        return this.scrapers.get(id);
    }

    async pauseScraper(id) {
        const scraper = this.scrapers.get(id);
        if (scraper) {
            scraper.pause();
            this.io.emit('scraper-status-change', { id, status: 'paused' });
            return true;
        }
        return false;
    }

    async resumeScraper(id) {
        const scraper = this.scrapers.get(id);
        if (scraper) {
            scraper.resume();
            this.io.emit('scraper-status-change', { id, status: 'running' });
            return true;
        }
        return false;
    }

    async cancelScraper(id) {
        const scraper = this.scrapers.get(id);
        if (scraper) {
            await scraper.cancel();
            // The runScraper finally block will handle cleanup
            return true;
        }
        return false;
    }

    getActiveScrapers() {
        return Array.from(this.scrapers.values()).map(s => ({
            id: s.id,
            status: s.status,
            progress: s.progress
        }));
    }

    getHistory() {
        return this.history;
    }
}

module.exports = ScraperManager;
