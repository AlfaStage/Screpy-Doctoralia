const DoctoraliaScraper = require('./doctoralia');
const GoogleMapsScraper = require('./googlemaps');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const webhookService = require('../api/webhookService');

class ScraperManager {
    constructor(io) {
        this.io = io;
        this.scrapers = new Map(); // Map<id, DoctoraliaScraper | GoogleMapsScraper>
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

                    // Get file stats for timestamp
                    const stats = await fs.stat(filePath);

                    // Determine type based on filename prefix
                    let type = 'doctoralia';
                    let status = 'completed';
                    let id = file.replace('.json', '');

                    if (file.startsWith('googlemaps_')) {
                        type = 'googlemaps';
                        id = file.replace('.json', '').replace('googlemaps_results_', '').replace('googlemaps_error_', '');
                    } else if (file.startsWith('doctoralia_')) {
                        type = 'doctoralia';
                        id = file.replace('.json', '').replace('doctoralia_results_', '').replace('doctoralia_error_', '');
                    }

                    // Check if it's an error file
                    if (file.includes('_error_') || jsonData.status === 'failed' || jsonData.error) {
                        status = 'failed';
                    }

                    // Handle different JSON structures
                    const results = jsonData.results || jsonData.data || [];
                    const logs = jsonData.logs || [];
                    const config = jsonData.config || {};
                    const errorMsg = jsonData.error || null;

                    historyItems.push({
                        id: jsonData.id || id,
                        type: jsonData.type || type,
                        config,
                        error: errorMsg,
                        result: {
                            success: status === 'completed',
                            count: results.length,
                            filePath: filePath.replace('.json', '.csv'),
                            data: results,
                            logs
                        },
                        status,
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

    // Save error results to JSON file so they appear in history
    async saveErrorResults(id, config, type, errorMessage, partialResults = [], logs = []) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const prefix = type === 'googlemaps' ? 'googlemaps_error_' : 'doctoralia_error_';
            const filename = `${prefix}${timestamp}.json`;
            const filePath = path.join(this.resultsDir, filename);

            const errorData = {
                id,
                type,
                config,
                error: errorMessage,
                status: 'failed',
                timestamp: new Date().toISOString(),
                results: partialResults,
                logs,
                partialCount: partialResults.length
            };

            await fs.writeFile(filePath, JSON.stringify(errorData, null, 2), 'utf8');
            console.log(`[Manager] Error results saved to: ${filePath}`);
            return filePath;
        } catch (err) {
            console.error('[Manager] Failed to save error results:', err);
            return null;
        }
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
            type: 'doctoralia',
            status: 'initializing',
            startTime: Date.now()
        });

        // Start scraping asynchronously
        this.runScraper(id, config);

        return id;
    }

    async startMapsScrape(config) {
        if (this.scrapers.size >= this.MAX_CONCURRENT_SCRAPES) {
            throw new Error(`Máximo de ${this.MAX_CONCURRENT_SCRAPES} scrapers simultâneos atingido.`);
        }

        const id = uuidv4();
        const scraper = new GoogleMapsScraper(id, this.io);

        this.scrapers.set(id, scraper);

        // Notify client of new scraper
        this.io.emit('scraper-created', {
            id,
            config,
            type: 'googlemaps',
            status: 'initializing',
            startTime: Date.now()
        });

        // Start scraping asynchronously
        this.runMapsScraper(id, config);

        return id;
    }

    async runMapsScraper(id, config) {
        const scraper = this.scrapers.get(id);
        if (!scraper) {
            throw new Error('Scraper not found');
        }

        try {
            console.log(`[Manager] Running Maps scraper ${id} with config:`, config);

            this.io.emit('scraper-progress', {
                id: id,
                type: 'googlemaps',
                message: `[Manager] Iniciando Google Maps scraper para "${config.searchTerm}"...`,
                status: 'initializing'
            });

            await scraper.initialize(config.useProxy !== false);
            console.log(`[Manager] Maps Scraper ${id} initialized`);

            scraper.status = 'running';
            const result = await scraper.scrape(
                config.searchTerm,
                config.city,
                parseInt(config.quantity),
                config.investigateWebsites !== false,
                config.requiredFields || []
            );
            console.log(`[Manager] Maps Scraper ${id} completed. Result:`, result);

            this.io.emit('scraper-progress', {
                id: id,
                type: 'googlemaps',
                message: `[Manager] Google Maps scraper concluído com sucesso`,
                status: 'completed'
            });

            // Add to history
            const historyItem = {
                id,
                config,
                type: 'googlemaps',
                result,
                status: 'completed',
                timestamp: Date.now()
            };

            this.history.unshift(historyItem);
            await this.saveHistory();

            this.io.emit('scraper-completed', { id, type: 'googlemaps', result });

            // Send webhook if configured
            if (config.webhook) {
                const csvFilename = result.filePath ? result.filePath.split(/[\\/]/).pop() : null;
                await webhookService.send(config.webhook, {
                    id,
                    type: 'googlemaps',
                    status: 'completed',
                    config: {
                        searchTerm: config.searchTerm,
                        city: config.city,
                        quantity: config.quantity,
                        investigateWebsites: config.investigateWebsites
                    },
                    metadata: {
                        startTime: scraper.startTime,
                        endTime: new Date().toISOString(),
                        totalResults: result.count || 0,
                        websitesInvestigated: result.websitesInvestigated || 0
                    },
                    csvUrl: csvFilename ? `/results/${csvFilename}` : null,
                    results: result.data || [],
                    logs: result.logs || []
                }, config.jsonLogs || false);
            }

        } catch (error) {
            console.error(`[Manager] Maps Scraper ${id} failed:`, error);

            // Collect partial results and logs from scraper before closing
            const partialResults = scraper.results || [];
            const logs = scraper.logs || [];

            // Save error data to JSON file (so it appears in history with logs)
            const errorFilePath = await this.saveErrorResults(id, config, 'googlemaps', error.message, partialResults, logs);

            const historyItem = {
                id,
                config,
                type: 'googlemaps',
                error: error.message,
                status: 'failed',
                result: {
                    success: false,
                    count: partialResults.length,
                    data: partialResults,
                    logs: logs,
                    filePath: errorFilePath
                },
                timestamp: Date.now()
            };

            this.history.unshift(historyItem);
            await this.saveHistory();

            this.io.emit('scraper-error', { id, type: 'googlemaps', error: error.message, partialResults: partialResults.length, logs: logs.length });

            if (config.webhook) {
                await webhookService.send(config.webhook, {
                    id,
                    type: 'googlemaps',
                    status: 'error',
                    error: error.message,
                    partialResults: partialResults,
                    logs: logs,
                    config
                }, false);
            }
        } finally {
            await scraper.close();
            this.scrapers.delete(id);
            this.io.emit('scraper-removed', { id });
            console.log(`[Manager] Maps Scraper ${id} cleanup done`);
        }
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

            await scraper.initialize(config.useProxy !== false);
            console.log(`[Manager] Scraper ${id} initialized`);

            scraper.status = 'running'; // Update scraper status
            const result = await scraper.scrape(
                config.specialties,
                config.city,
                parseInt(config.quantity),
                config.onlyWithPhone || false,
                config.requiredFields || []
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

    async clearHistory() {
        const fs = require('fs').promises;

        try {
            // Get all files in results directory
            const files = await fs.readdir(this.resultsDir);

            // Delete each file
            for (const file of files) {
                const filePath = path.join(this.resultsDir, file);
                await fs.unlink(filePath);
                console.log(`Deleted: ${filePath}`);
            }

            // Clear in-memory history
            this.history = [];

            console.log('History cleared successfully');
            return true;
        } catch (error) {
            console.error('Error clearing history:', error);
            throw error;
        }
    }
}

module.exports = ScraperManager;
