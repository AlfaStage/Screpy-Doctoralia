const BaseScraper = require('../baseScraper');
const SearchHandler = require('./search');
const ProfileExtractor = require('./profile');
const fs = require('fs').promises;
const path = require('path');
const config = require('../../config/scraper.config').doctoralia;

class DoctoraliaScraper extends BaseScraper {
    constructor(id, io) {
        super(id, io, 'doctoralia', {
            defaultDelay: config.delays.noProxy,
            minDelay: config.delays.min,
            maxDelay: config.delays.max
        });
        
        this.searchHandler = null;
        this.profileExtractor = null;
        this.workerProfileExtractor = null;
    }

    async initialize(useProxy = true) {
        // Initialize proxy
        await this.initializeProxy(useProxy);
        
        // Initialize browser
        const page = await this.initializeBrowser(config.retryAttempts.proxyInit);
        
        // Initialize handlers
        this.searchHandler = new SearchHandler(page);
        this.profileExtractor = new ProfileExtractor(page);
        
        // Setup worker page
        await this.setupWorkerPage();
        if (this.page2) {
            this.workerProfileExtractor = new ProfileExtractor(this.page2);
        }
        
        // Set running state
        this.status = 'running';
        this.progress.startTime = Date.now();
        this.startTime = this.progress.startTime;
        
        const mode = this.usingProxy ? `proxy ${this.currentProxy}` : 'SEM PROXY';
        this.emitProgress(`Scraper inicializado com ${mode}`);
    }

    async scrape(specialties, city, quantity, onlyWithPhone = false, requiredFields = []) {
        try {
            // Validate inputs
            this.validateInputs(specialties, city, quantity);
            
            // Initialize state
            this.results = [];
            this.processedItems.clear();
            this.config = { specialties, city, quantity, onlyWithPhone, requiredFields };
            this.progress.total = quantity;
            this.progress.successCount = 0;
            this.progress.errorCount = 0;
            this.progress.skippedCount = 0;
            
            // Default specialty
            if (!specialties || specialties.length === 0) {
                specialties = ['Médico'];
            }
            
            const quantityPerSpecialty = Math.ceil(quantity / specialties.length);
            
            // Start queue processing
            this.processQueuePromise = this.processQueue(requiredFields, onlyWithPhone);
            
            // Search for each specialty
            for (let i = 0; i < specialties.length; i++) {
                if (this.progress.successCount >= quantity) break;
                
                await this.checkState();
                
                const specialty = specialties[i];
                this.emitProgress(`Buscando ${specialty} (${i + 1}/${specialties.length})...`);
                
                // Perform search
                await this.searchHandler.performSearch(specialty, city, (msg) => 
                    this.emitProgress(msg.message)
                );
                await this.captureScreenshot('SEARCH_COMPLETE');
                
                await this.checkState();
                
                // Collect profile URLs with streaming
                await this.searchHandler.collectProfileUrls(
                    Math.ceil(quantityPerSpecialty * config.margin),
                    (msg) => this.emitProgress(msg.message),
                    (newUrls) => this.handleNewUrls(newUrls)
                );
                
                // Wait for queue to process
                await this.waitForQueueEmpty(quantity);
            }
            
            // Stop queue and finalize
            await this.stopQueue();
            
            // Save results
            await this.checkState();
            this.emitProgress('Salvando resultados...');
            const filePath = await this.saveResultsWithCsv();
            
            this.status = 'completed';
            const summary = `Scraping concluído! Sucessos: ${this.progress.successCount}, Erros: ${this.progress.errorCount}, Pulados: ${this.progress.skippedCount}`;
            this.emitProgress(summary, { filePath });
            
            return {
                success: true,
                count: this.results.length,
                successCount: this.progress.successCount,
                errorCount: this.progress.errorCount,
                skippedCount: this.progress.skippedCount,
                filePath,
                data: this.results,
                logs: this.logs
            };
            
        } catch (error) {
            if (this.isCancelled) {
                return { success: false, message: 'Cancelled', data: this.results, logs: this.logs };
            }
            
            this.emitProgress(`❌ Erro: ${error.message}`);
            return { success: false, message: error.message, data: this.results, logs: this.logs };
        }
    }

    validateInputs(specialties, city, quantity) {
        if (!quantity || quantity < 1) {
            throw new Error('Quantidade deve ser pelo menos 1');
        }
        
        if (quantity > 5000) {
            throw new Error('Quantidade máxima é 5000');
        }
        
        if (specialties && !Array.isArray(specialties)) {
            throw new Error('Especialidades deve ser um array');
        }
    }

    handleNewUrls(newUrls) {
        let added = 0;
        for (const url of newUrls) {
            if (!this.processedItems.has(url) && this.queue.length < this.progress.total * 2) {
                this.processedItems.add(url);
                this.queue.push(url);
                added++;
            }
        }
        
        if (added > 0) {
            this.emitProgress(`📥 ${added} perfis na fila (Total: ${this.queue.length})`);
        }
    }

    async processQueue(requiredFields, onlyWithPhone) {
        this.isProcessingQueue = true;
        this.emitProgress(`👷 Worker iniciado: Aguardando perfis na fila...`);
        
        const extractor = this.workerProfileExtractor || this.profileExtractor;
        
        while (this.isProcessingQueue && !this.isCancelled) {
            if (this.queue.length === 0) {
                await this.sleep(config.queue.workerDelay);
                continue;
            }
            
            const url = this.queue.shift();
            
            // Skip if already in results
            if (this.results.some(r => r.url === url)) continue;
            
            try {
                await this.captureScreenshot('WORKER_START', 'worker');
                
                const profileData = await extractor.extractProfile(url, (msg) => {
                    if (msg.message && msg.message.includes('Acessando')) {
                        this.emitProgress(`Worker: ${msg.message}`);
                    }
                });
                
                await this.captureScreenshot('WORKER_EXTRACT', 'worker');
                
                // Check required fields
                if (this.shouldSkipProfile(profileData, requiredFields, onlyWithPhone)) {
                    this.progress.skippedCount++;
                    continue;
                }
                
                // Success
                this.results.push(profileData);
                this.progress.successCount++;
                this.consecutiveErrors = 0;
                
                if (this.io) {
                    this.io.emit('scraper-result-update', { id: this.id, data: profileData });
                }
                
                const percent = this.queue.length > 0 ? `(Fila: ${this.queue.length})` : '';
                this.emitProgress(`✅ [Worker] Sucesso: ${profileData.nome} ${percent}`);
                await this.captureScreenshot('WORKER_COMPLETE', 'worker');
                
            } catch (error) {
                this.progress.errorCount++;
                // Silent error - continue processing
            }
            
            await this.sleep(config.queue.workerDelay);
        }
        
        this.emitProgress('👷 Worker finalizado.');
    }

    shouldSkipProfile(profileData, requiredFields, onlyWithPhone) {
        const missingFields = [];
        
        if (requiredFields && requiredFields.length > 0) {
            for (const field of requiredFields) {
                if (field === 'phone' && !this.profileExtractor.hasPhoneNumber(profileData)) {
                    missingFields.push('Telefone');
                }
                if (field === 'address' && (!profileData.enderecos || profileData.enderecos.length === 0)) {
                    missingFields.push('Endereço');
                }
            }
        }
        
        if (onlyWithPhone && !this.profileExtractor.hasPhoneNumber(profileData)) {
            missingFields.push('Telefone');
        }
        
        return missingFields.length > 0;
    }

    async saveResultsWithCsv() {
        if (this.results.length === 0) {
            return null;
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFilename = `doctoralia_${this.id}_results_${timestamp}`;
        const resultsDir = path.join(__dirname, '..', '..', 'results');
        
        await fs.mkdir(resultsDir, { recursive: true });
        
        // Save CSV
        const csvPath = path.join(resultsDir, `${baseFilename}.csv`);
        const csvLines = ['Nome,Especialidades,Numero Fixo,Numero Movel,Enderecos'];
        
        for (const result of this.results) {
            const specialtiesStr = (result.especialidades || []).join('; ') || 
                (this.config.specialties || []).join('; ');
            const addressStr = (result.enderecos || []).join('; ') || this.config.city || '';
            
            const line = [
                this.escapeCsv(result.nome),
                this.escapeCsv(specialtiesStr),
                this.escapeCsv(result.numeroFixo),
                this.escapeCsv(result.numeroMovel),
                this.escapeCsv(addressStr)
            ].join(',');
            
            csvLines.push(line);
        }
        
        await fs.writeFile(csvPath, csvLines.join('\n'), 'utf8');
        
        // Save JSON
        const jsonPath = path.join(resultsDir, `${baseFilename}.json`);
        const enrichedResults = this.results.map(r => ({
            ...r,
            especialidades: r.especialidades?.length ? r.especialidades : (this.config.specialties || []),
            enderecos: r.enderecos?.length ? r.enderecos : (this.config.city ? [this.config.city] : [])
        }));
        
        const jsonData = {
            config: this.config,
            metadata: {
                startTime: this.startTime,
                endTime: new Date().toISOString(),
                totalResults: this.results.length
            },
            logs: this.logs,
            results: enrichedResults
        };
        
        await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
        
        console.log(`Results saved to: ${csvPath}`);
        return csvPath;
    }
}

module.exports = DoctoraliaScraper;
