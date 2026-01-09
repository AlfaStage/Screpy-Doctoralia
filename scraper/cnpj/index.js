/**
 * CNPJ Scraper - Main Handler
 */

const path = require('path');
const fs = require('fs').promises;
const CnpjSearch = require('./search');
const CnpjExtractor = require('./extractor');

class CnpjScraper {
    constructor(id, config, browserManager, logCallback, emitUpdate) {
        this.id = id;
        this.config = config;
        this.browserManager = browserManager;
        this.logCallback = logCallback;
        this.emitUpdate = emitUpdate;

        this.page = null;
        this.page2 = null; // Worker page

        this.searchHandler = null;
        this.extractor = null;

        this.results = [];
        this.queue = [];
        this.isPaused = false;
        this.isStopped = false;

        this.stats = {
            success: 0,
            error: 0,
            skipped: 0
        };
    }

    async initialize() {
        try {
            this.logCallback({ message: '🚀 Inicializando Scraper de CNPJ (Casa dos Dados)...' });

            this.page = await this.browserManager.setupPage();
            this.page2 = await this.browserManager.setupPage();

            this.searchHandler = new CnpjSearch(this.page);
            this.extractor = new CnpjExtractor(this.page2);

            this.logCallback({ message: '✅ Páginas inicializadas.' });
            return true;
        } catch (error) {
            this.logCallback({ message: `❌ Erro na inicialização: ${error.message}` });
            throw error;
        }
    }

    async scrape() {
        try {
            await this.initialize();

            // 1. Perform search
            this.logCallback({ message: '🔍 Iniciando pesquisa avançada...' });
            const companyLinks = await this.searchHandler.search(this.config, this.logCallback);

            if (!companyLinks || companyLinks.length === 0) {
                this.logCallback({ message: '⚠️ Nenhum resultado encontrado para os filtros aplicados.' });
                return this.finalize();
            }

            this.logCallback({ message: `📋 Encontradas ${companyLinks.length} empresas. Iniciando extração detalhada...` });
            this.queue = companyLinks;

            // 2. Process queue
            await this.processQueue();

            return this.finalize();
        } catch (error) {
            this.logCallback({ message: `❌ Erro durante o scraping: ${error.message}` });
            throw error;
        }
    }

    async processQueue() {
        while (this.queue.length > 0 && !this.isStopped) {
            if (this.isPaused) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const companyUrl = this.queue.shift();
            try {
                this.logCallback({ message: `📄 Extraindo dados de: ${companyUrl}` });
                const data = await this.extractor.extract(companyUrl, this.logCallback);

                if (data) {
                    this.results.push(data);
                    this.stats.success++;
                    this.emitUpdate('data', data);
                } else {
                    this.stats.skipped++;
                }

                // Random delay to avoid detection
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));

            } catch (error) {
                this.logCallback({ message: `⚠️ Erro ao processar ${companyUrl}: ${error.message}` });
                this.stats.error++;
            }
        }
    }

    async finalize() {
        this.logCallback({ message: '💾 Salvando resultados...' });
        const filePath = await this.saveResults();

        this.logCallback({ message: `🏁 Scraping concluído! Sucessos: ${this.stats.success}, Erros: ${this.stats.error}` });

        return {
            success: true,
            count: this.results.length,
            successCount: this.stats.success,
            errorCount: this.stats.error,
            skippedCount: this.stats.skipped,
            filePath: filePath,
            data: this.results
        };
    }

    async saveResults() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFileName = `cnpj_${this.id}_results_${timestamp}`;
        const resultsDir = path.join(__dirname, '..', '..', 'results');

        await fs.mkdir(resultsDir, { recursive: true });

        const jsonPath = path.join(resultsDir, `${baseFileName}.json`);
        await fs.writeFile(jsonPath, JSON.stringify(this.results, null, 2));

        // CSV Export (Simplified)
        const csvPath = path.join(resultsDir, `${baseFileName}.csv`);
        if (this.results.length > 0) {
            const headers = Object.keys(this.results[0]).join(',');
            const rows = this.results.map(obj =>
                Object.values(obj).map(val => `"${String(val).replace(/"/g, '""')}"`).join(',')
            ).join('\n');
            await fs.writeFile(csvPath, `${headers}\n${rows}`);
        }

        return csvPath;
    }

    stop() {
        this.isStopped = true;
    }

    pause() {
        this.isPaused = true;
    }

    resume() {
        this.isPaused = false;
    }
}

module.exports = CnpjScraper;
