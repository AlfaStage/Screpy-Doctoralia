const BaseScraper = require('../baseScraper');
const MapsSearchHandler = require('./search');
const BusinessExtractor = require('./business');
const WebsiteInvestigator = require('./websiteInvestigator');
const fs = require('fs').promises;
const path = require('path');
const config = require('../../config/scraper.config').googlemaps;

class GoogleMapsScraper extends BaseScraper {
    constructor(id, io) {
        super(id, io, 'googlemaps', {
            defaultDelay: config.delays.noProxy,
            minDelay: config.delays.min,
            maxDelay: config.delays.max
        });
        
        this.searchHandler = null;
        this.businessExtractor = null;
        this.websiteInvestigator = null;
        this.workerBusinessExtractor = null;
        this.workerWebsiteInvestigator = null;
    }

    async initialize(useProxy = true) {
        // Initialize proxy
        await this.initializeProxy(useProxy);
        
        // Initialize browser
        const page = await this.initializeBrowser(config.retryAttempts.proxyInit);
        
        // Initialize handlers
        this.searchHandler = new MapsSearchHandler(page);
        this.businessExtractor = new BusinessExtractor(page);
        this.websiteInvestigator = new WebsiteInvestigator(
            page,
            (msg) => this.emitProgress(msg),
            (action) => this.captureScreenshot(action)
        );
        
        // Setup worker page
        await this.setupWorkerPage();
        if (this.page2) {
            this.workerBusinessExtractor = new BusinessExtractor(this.page2);
            this.workerWebsiteInvestigator = new WebsiteInvestigator(
                this.page2,
                (msg) => { if (msg.includes('Worker')) this.emitProgress(msg); },
                (action) => this.captureScreenshot(action, 'worker')
            );
        }
        
        // Set running state
        this.status = 'running';
        this.progress.startTime = Date.now();
        this.startTime = this.progress.startTime;
        
        const mode = this.usingProxy ? `proxy ${this.currentProxy}` : 'SEM PROXY';
        this.emitProgress(`Google Maps Scraper inicializado com ${mode}`);
    }

    async scrape(searchTerm, city, quantity, investigateWebsites = true, requiredFields = []) {
        try {
            // Validate inputs
            this.validateInputs(searchTerm, quantity);
            
            // Initialize state
            this.results = [];
            this.processedItems.clear();
            this.config = { searchTerm, city, quantity, investigateWebsites, requiredFields };
            this.progress.total = quantity;
            this.progress.successCount = 0;
            this.progress.errorCount = 0;
            this.progress.skippedCount = 0;
            this.progress.websitesInvestigated = 0;
            
            // Determine search locations
            const searchLocations = this.getSearchLocations(city, quantity);
            
            // Start queue processing
            this.processQueuePromise = this.processQueue(investigateWebsites, requiredFields);
            
            // Search each location
            for (const currentCity of searchLocations) {
                if (this.progress.successCount >= quantity) break;
                
                const activeQuery = currentCity ? `${searchTerm} em ${currentCity}` : searchTerm;
                
                if (currentCity) {
                    this.emitProgress(`📍 EXPANSÃO: Iniciando nova busca em ${currentCity}`);
                }
                
                // Search with retry
                await this.searchWithRetry(activeQuery);
                await this.captureScreenshot('SEARCH_COMPLETE');
                
                await this.checkState();
                
                // Collect businesses
                await this.collectBusinesses(quantity);
                
                // Wait for queue
                await this.waitForQueueEmpty(quantity);
            }
            
            // Finalize
            await this.stopQueue();
            
            this.emitProgress(`🏁 Busca finalizada. Processando fila restante (${this.queue.length} itens)...`);
            await this.sleep(3000);
            
            // Save results
            await this.checkState();
            this.emitProgress('Salvando resultados...');
            const filePath = await this.saveResultsWithCsv();
            
            this.status = 'completed';
            const summary = `Scraping concluído! Sucessos: ${this.progress.successCount}, Erros: ${this.progress.errorCount}, Websites investigados: ${this.progress.websitesInvestigated}`;
            this.emitProgress(summary, { filePath });
            
            return {
                success: true,
                count: this.results.length,
                successCount: this.progress.successCount,
                errorCount: this.progress.errorCount,
                skippedCount: this.progress.skippedCount,
                websitesInvestigated: this.progress.websitesInvestigated,
                filePath,
                data: this.results,
                logs: this.logs
            };
            
        } catch (error) {
            if (this.isCancelled) {
                return { success: false, message: 'Cancelled', data: this.results, logs: this.logs };
            }
            
            await this.captureScreenshot('ERROR');
            this.emitProgress(`❌ Erro: ${error.message}`);
            return { success: false, message: error.message, data: this.results, logs: this.logs };
        }
    }

    validateInputs(searchTerm, quantity) {
        if (!searchTerm || searchTerm.trim().length === 0) {
            throw new Error('Termo de busca é obrigatório');
        }
        
        if (!quantity || quantity < 1) {
            throw new Error('Quantidade deve ser pelo menos 1');
        }
        
        if (quantity > 5000) {
            throw new Error('Quantidade máxima é 5000');
        }
    }

    getSearchLocations(city, quantity) {
        if (!city && quantity > config.expansionThreshold) {
            this.emitProgress(`🚀 Modo de Expansão Inteligente: Buscando em múltiplas regiões...`);
            return [null, ...config.majorCities];
        }
        return [city];
    }

    async searchWithRetry(searchQuery) {
        let attempts = 0;
        
        while (attempts < config.retryAttempts.search) {
            try {
                attempts++;
                this.emitProgress(`🔍 Buscando: "${searchQuery}"... (tentativa ${attempts})`);
                
                await this.searchHandler.performSearch(searchQuery, (msg) => 
                    this.emitProgress(msg.message)
                );
                return;
                
            } catch (error) {
                if (this.isProxyError(error) && attempts < config.retryAttempts.search) {
                    this.emitProgress(`❌ Erro de conexão: ${error.message.split(' at ')[0]}`);
                    await this.rotateProxy();
                } else {
                    throw error;
                }
            }
        }
        
        throw new Error(`Falha após ${config.retryAttempts.search} tentativas`);
    }

    async collectBusinesses(targetQuantity) {
        const adjustedTarget = targetQuantity * 2;
        let attempts = 0;
        
        while (attempts < config.retryAttempts.collection) {
            try {
                attempts++;
                
                await this.searchHandler.collectBusinesses(
                    adjustedTarget,
                    (msg) => this.emitProgress(msg.message),
                    false,
                    (newBusinesses) => this.handleNewBusinesses(newBusinesses)
                );
                
                await this.captureScreenshot('COLLECT_COMPLETE');
                return;
                
            } catch (error) {
                if (this.isProxyError(error) && attempts < config.retryAttempts.collection) {
                    this.emitProgress(`❌ Erro coleta: ${error.message}`);
                    await this.rotateProxy();
                    const searchQuery = this.config.city ? 
                        `${this.config.searchTerm} em ${this.config.city}` : 
                        this.config.searchTerm;
                    await this.searchHandler.performSearch(searchQuery, () => {});
                } else {
                    throw error;
                }
            }
        }
    }

    handleNewBusinesses(newBusinesses) {
        let added = 0;
        
        for (const business of newBusinesses) {
            const uid = (business.url || '') + (business.nome || '');
            
            if (!this.processedItems.has(uid) && this.queue.length < this.progress.total * 2) {
                this.processedItems.add(uid);
                this.queue.push(business);
                added++;
            }
        }
        
        if (added > 0) {
            this.emitProgress(`📥 ${added} novos itens na fila (Total: ${this.queue.length})`);
        }
    }

    async processQueue(investigateWebsites, requiredFields) {
        this.isProcessingQueue = true;
        this.emitProgress(`👷 Worker iniciado: Aguardando estabelecimentos na fila...`);
        
        const extractor = this.workerBusinessExtractor || this.businessExtractor;
        const investigator = this.workerWebsiteInvestigator || this.websiteInvestigator;
        
        while (this.isProcessingQueue && !this.isCancelled) {
            if (this.queue.length === 0) {
                await this.sleep(config.queue.workerDelay);
                continue;
            }
            
            const business = this.queue.shift();
            const uid = (business.url || '') + (business.nome || '');
            
            // Skip if already processed
            if (this.results.some(r => (r.url === business.url) || r.uid === uid)) continue;
            
            try {
                await this.captureScreenshot('WORKER_EXTRACT_START', 'worker');
                
                // Extract business data
                const businessData = await extractor.extractBusiness(
                    business,
                    (msg) => {
                        if (msg.message && msg.message.includes('Acessando')) {
                            this.emitProgress(`Worker: ${msg.message}`);
                        }
                    }
                );
                
                // Website investigation
                if (investigateWebsites && businessData.website) {
                    await this.investigateWebsite(businessData, investigator);
                }
                
                // Check required fields
                if (!this.hasRequiredFields(businessData, requiredFields)) {
                    this.progress.skippedCount++;
                    continue;
                }
                
                // Success
                businessData.uid = uid;
                this.results.push(businessData);
                this.progress.successCount++;
                
                if (this.io) {
                    this.io.emit('scraper-result', {
                        id: this.id,
                        type: 'googlemaps',
                        data: businessData
                    });
                }
                
                const percent = this.queue.length > 0 ? `(Fila: ${this.queue.length})` : '';
                this.emitProgress(`✅ [Worker] Sucesso: ${businessData.nome} ${percent}`);
                await this.captureScreenshot('WORKER_COMPLETE', 'worker');
                
            } catch (error) {
                this.progress.errorCount++;
                await this.captureScreenshot('WORKER_ERROR', 'worker');
            }
            
            await this.sleep(config.queue.workerDelay);
        }
        
        this.emitProgress(`👷 Worker finalizado.`);
    }

    async investigateWebsite(businessData, investigator) {
        try {
            this.emitProgress(`🔎 Worker investigating: ${businessData.website}`);
            const websiteData = await investigator.investigate(businessData.website);
            await this.captureScreenshot('WORKER_INVESTIGATE', 'worker');
            
            investigator.finalizeResult(websiteData);
            
            // Merge data
            if (websiteData.email && !businessData.email) businessData.email = websiteData.email;
            if (websiteData.instagram && !businessData.instagram) businessData.instagram = websiteData.instagram;
            if (websiteData.cnpj && !businessData.cnpj) businessData.cnpj = websiteData.cnpj;
            if (websiteData.telefone && !businessData.telefone) businessData.telefone = websiteData.telefone;
            if (websiteData.whatsapp) businessData.whatsapp = websiteData.whatsapp;
            
            this.progress.websitesInvestigated++;
            
        } catch (error) {
            // Silent error - continue without investigation data
        }
    }

    hasRequiredFields(businessData, requiredFields) {
        if (!requiredFields || requiredFields.length === 0) return true;
        
        for (const field of requiredFields) {
            if (field === 'phone' && !businessData.telefone) return false;
            if (field === 'email' && !businessData.email) return false;
            if (field === 'website' && !businessData.website) return false;
            if (field === 'whatsapp' && !businessData.whatsapp) return false;
        }
        
        return true;
    }

    async saveResultsWithCsv() {
        if (this.results.length === 0) {
            return null;
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFilename = `googlemaps_${this.id}_results_${timestamp}`;
        const resultsDir = path.join(__dirname, '..', '..', 'results');
        
        await fs.mkdir(resultsDir, { recursive: true });
        
        const jsonPath = path.join(resultsDir, `${baseFilename}.json`);
        await fs.writeFile(jsonPath, JSON.stringify(this.results, null, 2));
        
        // Generate CSV
        const csvPath = path.join(resultsDir, `${baseFilename}.csv`);
        const headers = [
            'nome', 'categoria', 'telefone', 'whatsapp', 'website',
            'link', 'endereco', 'email', 'instagram', 'facebook', 'linkedin'
        ];
        
        let csvContent = '\uFEFF' + headers.join(';') + '\n';
        
        for (const row of this.results) {
            const line = headers.map(header => {
                let val = row[header] || '';
                if (typeof val === 'string') {
                    val = val.replace(/"/g, '""').replace(/;/g, ',');
                    val = `"${val}"`;
                }
                return val;
            }).join(';');
            csvContent += line + '\n';
        }
        
        await fs.writeFile(csvPath, csvContent, 'utf8');
        return csvPath;
    }
}

module.exports = GoogleMapsScraper;
