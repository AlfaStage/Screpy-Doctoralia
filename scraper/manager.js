const DoctoraliaScraper = require('./index');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class ScraperManager {
    constructor(io) {
        this.io = io;
        this.scrapers = new Map(); // Map<id, DoctoraliaScraper>
        this.history = [];
        this.MAX_CONCURRENT_SCRAPES = 3;
        this.historyFile = path.join(__dirname, '..', 'data', 'history.json');

        this.loadHistory();
    }

    async loadHistory() {
        try {
            await fs.mkdir(path.dirname(this.historyFile), { recursive: true });
            const data = await fs.readFile(this.historyFile, 'utf8');
            this.history = JSON.parse(data);
        } catch (error) {
            this.history = [];
        }
    }

    async saveHistory() {
        try {
            await fs.writeFile(this.historyFile, JSON.stringify(this.history, null, 2));
        } catch (error) {
            console.error('Error saving history:', error);
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
            status: 'initializing',
            startTime: Date.now()
        });

        // Start scraping asynchronously
        this.runScraper(id, scraper, config);

        return id;
    }

    async runScraper(id, scraper, config) {
        console.log(`[Manager] Running scraper ${id} with config:`, config);
        try {
            await scraper.initialize();
            console.log(`[Manager] Scraper ${id} initialized`);

            const result = await scraper.scrape(
                config.specialties,
                config.city,
                parseInt(config.quantity)
            );
            console.log(`[Manager] Scraper ${id} completed. Result:`, result);

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
