/**
 * CNPJ Scraper - Main Handler
 */

const BaseScraper = require('../baseScraper');
const CnpjSearch = require('./search');
const CnpjExtractor = require('./extractor');
const fs = require('fs').promises;
const path = require('path');
const config = require('../../config/scraper.config').cnpj;

class CnpjScraper extends BaseScraper {
    constructor(id, userConfig, browserManagerWrapper, logCallback, emitUpdate) {
        super(id, null, 'cnpj', {
            defaultDelay: config.delays.noProxy,
            minDelay: config.delays.min,
            maxDelay: config.delays.max
        });
        
        // CNPJ specific initialization
        this.userConfig = userConfig;
        this.browserManagerWrapper = browserManagerWrapper;
        this.externalLogCallback = logCallback;
        this.externalEmitUpdate = emitUpdate;
        
        // Override io to use external callback
        this.io = {
            emit: (event, data) => {
                if (this.externalEmitUpdate) {
                    this.externalEmitUpdate(event, data);
                }
            }
        };
        
        this.searchHandler = null;
        this.extractor = null;
        this.stats = {
            success: 0,
            error: 0,
            skipped: 0
        };
    }

    // Override emitProgress to use external callback
    emitProgress(message, data = {}) {
        super.emitProgress(message, data);
        
        if (this.externalLogCallback) {
            this.externalLogCallback({ message });
        }
    }

    async initialize() {
        try {
            this.emitProgress('🚀 Inicializando Scraper de CNPJ (Casa dos Dados)...');
            
            // Validate config
            this.validateConfig();
            
            // Get pages from browser manager
            this.page = await this.browserManagerWrapper.setupPage();
            this.page2 = await this.browserManagerWrapper.setupPage();
            
            // Initialize handlers
            const emitUpdate = (type, data) => {
                if (this.externalEmitUpdate) {
                    this.externalEmitUpdate(type, data);
                }
            };
            
            this.searchHandler = new CnpjSearch(
                this.page, 
                this.userConfig, 
                (msg) => this.emitProgress(msg), 
                emitUpdate
            );
            this.extractor = new CnpjExtractor(this.page2);
            
            this.emitProgress('✅ Páginas inicializadas.');
            return true;
            
        } catch (error) {
            this.emitProgress(`❌ Erro na inicialização: ${error.message}`);
            throw error;
        }
    }

    validateConfig() {
        if (!this.userConfig || typeof this.userConfig !== 'object') {
            throw new Error('Configuração inválida');
        }
        
        // CNPJ scraper can work with various config types
        // (cnpjList, search terms, etc.)
        if (!this.userConfig.cnpjList && !this.userConfig.searchTerm) {
            // Allow empty config - might be filled later
            console.log('[CnpjScraper] No specific search criteria provided');
        }
    }

    async scrape() {
        try {
            await this.initialize();
            
            // Perform search
            const provider = this.userConfig.provider === 'minhareceita' ? 'API Minha Receita' : 'Casa dos Dados';
            this.emitProgress(`🔍 Iniciando pesquisa via ${provider}...`);
            
            const companyLinks = await this.searchHandler.search();
            
            if (!companyLinks || companyLinks.length === 0) {
                this.emitProgress('⚠️ Nenhum resultado encontrado para os filtros aplicados.');
                return this.finalize();
            }
            
            this.emitProgress(`📋 Encontradas ${companyLinks.length} empresas. Iniciando extração detalhada...`);
            this.queue = companyLinks;
            
            // Process queue
            await this.processQueue();
            
            return this.finalize();
            
        } catch (error) {
            this.emitProgress(`❌ Erro durante o scraping: ${error.message}`);
            throw error;
        }
    }

    async processQueue() {
        while (this.queue.length > 0 && !this.isCancelled) {
            if (this.isPaused) {
                await this.sleep(1000);
                continue;
            }
            
            const item = this.queue.shift();
            const companyUrl = item.url;
            const directData = item.directData;
            
            try {
                if (directData) {
                    // Data already provided by the API (Minha Receita)
                    const companyName = directData.razao_social || directData.nome_fantasia || 'Empresa';
                    this.emitProgress(`✅ Processando dados diretos: ${companyName}`);
                    this.results.push(directData);
                    this.stats.success++;
                    
                    if (this.externalEmitUpdate) {
                        this.externalEmitUpdate('data', { id: this.id, data: directData, type: 'cnpj' });
                    }
                    
                } else if (companyUrl) {
                    // Need to extract from profile page (Casa dos Dados)
                    this.emitProgress(`📄 Extraindo dados de: ${companyUrl}`);
                    const data = await this.extractor.extract(companyUrl, this.externalLogCallback);
                    
                    if (data) {
                        this.results.push(data);
                        this.stats.success++;
                        
                        if (this.externalEmitUpdate) {
                            this.externalEmitUpdate('data', { id: this.id, data, type: 'cnpj' });
                        }
                    } else {
                        this.stats.skipped++;
                    }
                    
                    // Random delay to avoid detection
                    await this.sleep(config.delays.betweenRequests + Math.random() * 3000);
                }
                
            } catch (error) {
                this.emitProgress(`⚠️ Erro ao processar: ${error.message}`);
                this.stats.error++;
            }
        }
    }

    async finalize() {
        this.emitProgress('💾 Salvando resultados...');
        const filePath = await this.saveResultsWithCsv();
        
        this.emitProgress(`🏁 Scraping concluído! Sucessos: ${this.stats.success}, Erros: ${this.stats.error}`);
        
        return {
            success: true,
            count: this.results.length,
            successCount: this.stats.success,
            errorCount: this.stats.error,
            skippedCount: this.stats.skipped,
            filePath,
            data: this.results
        };
    }

    async saveResultsWithCsv() {
        if (this.results.length === 0) {
            return null;
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFileName = `cnpj_${this.id}_results_${timestamp}`;
        const resultsDir = path.join(__dirname, '..', '..', 'results');
        
        await fs.mkdir(resultsDir, { recursive: true });
        
        // Save JSON
        const jsonPath = path.join(resultsDir, `${baseFileName}.json`);
        await fs.writeFile(jsonPath, JSON.stringify(this.results, null, 2));
        
        // Save CSV
        const csvPath = path.join(resultsDir, `${baseFileName}.csv`);
        const validResults = this.results.filter(r => r && typeof r === 'object');
        
        if (validResults.length > 0) {
            const headers = Object.keys(validResults[0]).join(',');
            const rows = validResults.map(obj =>
                Object.values(obj)
                    .map(val => `"${String(val || '').replace(/"/g, '""')}"`)
                    .join(',')
            ).join('\n');
            
            await fs.writeFile(csvPath, `${headers}\n${rows}`);
        }
        
        return csvPath;
    }

    // Maintain compatibility with old interface
    stop() {
        this.isCancelled = true;
    }
}

module.exports = CnpjScraper;
