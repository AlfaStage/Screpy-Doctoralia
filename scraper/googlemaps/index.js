const BrowserManager = require('../browser');
const ProxyManager = require('../proxyManager');
const MapsSearchHandler = require('./search');
const BusinessExtractor = require('./business');
const WebsiteInvestigator = require('./websiteInvestigator');
const fs = require('fs').promises;
const path = require('path');

class GoogleMapsScraper {
    constructor(id, io) {
        this.id = id;
        this.io = io;
        this.browserManager = null;
        this.searchHandler = null;
        this.businessExtractor = null;
        this.websiteInvestigator = null;
        this.proxyManager = new ProxyManager((msg) => this.emitProgress(msg));
        this.currentProxy = null;
        this.consecutiveErrors = 0;
        this.consecutiveSuccesses = 0;
        this.usingProxy = true;
        this.currentDelay = 2000; // Maps requires more careful delays
        this.minDelay = 1000;
        this.maxDelay = 90000;
        this.results = [];
        this.logs = [];
        this.config = {};
        this.status = 'idle';
        this.isPaused = false;
        this.isCancelled = false;
        this.startTime = null;
        this.progress = {
            total: 0,
            current: 0,
            successCount: 0,
            errorCount: 0,
            skippedCount: 0,
            websitesInvestigated: 0,
            message: '',
            startTime: null,
            estimatedTimeRemaining: null
        };
        this.lastScreenshotTime = null;
        this.screenshotPath = null;

        // Parallel processing
        this.page2 = null;
        this.queue = [];
        this.isProcessingQueue = false;
        this.workerBusinessExtractor = null;
        this.workerWebsiteInvestigator = null;
    }

    // Capture screenshot and emit via Socket.io for live view
    // Capture screenshot and emit via Socket.io for live view
    async captureScreenshot(actionName = 'ACTION', source = 'main') {
        let pageToCapture = this.browserManager?.page;

        if (source === 'worker') {
            if (this.page2 && !this.page2.isClosed()) {
                pageToCapture = this.page2;
            } else {
                return;
            }
        }

        if (!pageToCapture || pageToCapture.isClosed()) return;

        try {
            const timestamp = Date.now();
            // New Format: googlemaps_[id]_live_[source].png
            const filename = `googlemaps_${this.id}_live_${source}.png`;
            const filepath = path.join('./results', filename);

            // Take screenshot
            await pageToCapture.screenshot({ path: filepath, type: 'png' });

            // Read as base64 for Socket.io emission
            const imageBuffer = await fs.readFile(filepath);
            const base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;

            // Emit to frontend
            this.io.emit('scraper-screenshot', {
                id: this.id,
                action: actionName,
                timestamp: timestamp,
                image: base64Image,
                source: source,
                url: `/results/${filename}?t=${timestamp}`
            });

            this.lastScreenshotTime = timestamp;
            if (source === 'main') this.screenshotPath = filepath;

        } catch (e) {
            // Silently fail - screenshot is optional
            // console.log(`Screenshot capture failed: ${e.message}`);
        }
    }

    async initialize(useProxy = true) {
        // Small delay to ensure frontend is connected
        await new Promise(resolve => setTimeout(resolve, 2000));

        this.proxyManager = new ProxyManager((msg) => this.emitProgress(msg));

        // Check if user explicitly disabled proxy
        if (!useProxy) {
            this.emitProgress('🚀 Modo SEM PROXY selecionado. Usando rate limiting mais agressivo.');
            this.currentProxy = null;
            this.usingProxy = false;
            this.currentDelay = 5000; // More aggressive delay for Maps without proxy
        } else {
            // Try to get proxy, fallback to no proxy if all fail
            this.currentProxy = await this.proxyManager.getNextProxy(true);

            if (this.currentProxy === null) {
                this.emitProgress('⚠️ Nenhum proxy disponível. Usando rate limiting mais agressivo.');
                this.usingProxy = false;
                this.currentDelay = 5000;
            } else {
                this.usingProxy = true;
                this.currentDelay = 2000;
            }
        }

        // Initialize browser with retry logic
        let initAttempts = 0;
        const maxInitAttempts = 5;
        let initSuccess = false;

        while (initAttempts < maxInitAttempts && !initSuccess) {
            try {
                this.browserManager = new BrowserManager();
                const page = await this.browserManager.initialize(this.currentProxy);

                this.searchHandler = new MapsSearchHandler(page);
                this.businessExtractor = new BusinessExtractor(page);
                this.websiteInvestigator = new WebsiteInvestigator(page, (msg) => this.emitProgress(msg), (action) => this.captureScreenshot(action));

                // Initialize Worker Page (Page 2)
                try {
                    this.page2 = await this.browserManager.browser.newPage();
                    await this.page2.setViewport({ width: 1366, height: 768 });
                    // Share cookies/context with main page automatically since it's same browserContext
                    this.workerBusinessExtractor = new BusinessExtractor(this.page2);
                    this.workerWebsiteInvestigator = new WebsiteInvestigator(this.page2,
                        (msg) => { if (msg.includes('Worker')) this.emitProgress(msg); },
                        (action) => this.captureScreenshot(action, 'worker')
                    );
                    this.emitProgress('✅ Worker Page inicializada para processamento paralelo');
                } catch (e) {
                    this.emitProgress('⚠️ Falha ao iniciar Worker Page, continuando em modo single-thread: ' + e.message);
                }

                initSuccess = true;

            } catch (error) {
                initAttempts++;

                if (error.message && error.message.includes('TUNNEL_FAILED')) {
                    this.emitProgress(`❌ Túnel falhou. Tentando próximo proxy... (${initAttempts}/${maxInitAttempts})`);

                    if (this.currentProxy) {
                        this.proxyManager.markProxyAsFailed(this.currentProxy);
                    }

                    await this.browserManager.close().catch(() => { });
                    this.currentProxy = await this.proxyManager.getNextProxy(true);

                    if (this.currentProxy === null) {
                        this.emitProgress('⚠️ Sem mais proxies. Tentando modo SEM PROXY...');
                        this.usingProxy = false;
                        this.currentDelay = 5000;
                    }

                    continue;
                }

                if (initAttempts >= maxInitAttempts) {
                    throw error;
                }
            }
        }

        // Final fallback
        if (!initSuccess) {
            this.emitProgress('⚠️ Falha em todas as tentativas. Iniciando sem proxy...');
            this.currentProxy = null;
            this.usingProxy = false;
            this.currentDelay = 5000;

            this.browserManager = new BrowserManager();
            const page = await this.browserManager.initialize(null);
            this.searchHandler = new MapsSearchHandler(page);
            this.businessExtractor = new BusinessExtractor(page);
            this.websiteInvestigator = new WebsiteInvestigator(page, (msg) => this.emitProgress(msg), (action) => this.captureScreenshot(action));
        }

        this.status = 'running';
        this.progress.startTime = Date.now();
        this.startTime = this.progress.startTime;

        const mode = this.usingProxy ? `proxy ${this.currentProxy}` : 'SEM PROXY';
        this.emitProgress(`Google Maps Scraper inicializado com ${mode}`);
        console.log(`GoogleMaps Scraper ${this.id} initialized with ${mode}`);
    }

    async checkState() {
        if (this.isCancelled) {
            throw new Error('Scraping cancelado pelo usuário');
        }

        while (this.isPaused) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (this.isCancelled) {
                throw new Error('Scraping cancelado pelo usuário');
            }
        }
    }

    pause() {
        this.isPaused = true;
        this.status = 'paused';
        this.emitProgress('Scraping pausado');
    }

    resume() {
        this.isPaused = false;
        this.status = 'running';
        this.emitProgress('Scraping retomado');
    }

    async cancel() {
        this.isCancelled = true;
        this.status = 'cancelled';
        this.emitProgress('Cancelando scraping...');

        if (this.results.length > 0) {
            this.emitProgress('Salvando dados parciais...');
            await this.saveResults();
        }

        await this.close();
    }

    // Rotate to next available proxy or fallback to no-proxy mode
    async rotateProxy() {
        this.emitProgress('🔄 Rotacionando proxy...');

        // Mark current proxy as failed
        if (this.currentProxy) {
            this.proxyManager.markProxyAsFailed(this.currentProxy);
        }

        // Close current browser
        await this.browserManager.close().catch(() => { });

        // Retry loop - try multiple proxies until one works
        const maxRetries = 10;
        let retryCount = 0;
        let success = false;

        while (!success && retryCount < maxRetries) {
            retryCount++;

            // Try to get a new proxy
            this.currentProxy = await this.proxyManager.getNextProxy(true);

            if (this.currentProxy === null) {
                // No more proxies available, fallback to no-proxy mode
                this.emitProgress('⚠️ Sem mais proxies disponíveis. Tentando modo SEM PROXY...');
                this.usingProxy = false;
                this.currentDelay = 5000;
            } else {
                this.usingProxy = true;
                this.currentDelay = 2000;
                this.emitProgress(`🔄 Reiniciando browser com novo proxy...`);
            }

            try {
                // Reinitialize browser with new proxy (or no proxy)
                this.browserManager = new BrowserManager();
                const page = await this.browserManager.initialize(this.currentProxy);

                this.searchHandler = new MapsSearchHandler(page);
                this.businessExtractor = new BusinessExtractor(page);
                this.websiteInvestigator = new WebsiteInvestigator(page, (msg) => this.emitProgress(msg), (action) => this.captureScreenshot(action));

                this.consecutiveErrors = 0;
                this.emitProgress('✅ Proxy trocado com sucesso');
                success = true;

            } catch (initError) {
                const errorMsg = initError.message || '';
                this.emitProgress(`⚠️ Erro ao trocar proxy: ${errorMsg.split('\n')[0]}`);

                // Mark this proxy as failed too
                if (this.currentProxy) {
                    this.proxyManager.markProxyAsFailed(this.currentProxy);
                }

                // Close browser if partially initialized
                await this.browserManager.close().catch(() => { });

                // If we're already in no-proxy mode and still failing, throw
                if (!this.usingProxy) {
                    throw new Error('Falha ao inicializar browser mesmo sem proxy');
                }

                // Continue to next proxy
            }
        }

        if (!success) {
            throw new Error('Falha ao trocar proxy após múltiplas tentativas');
        }

        return true;
    }

    // Check if error is a connection/proxy error that requires rotation
    isProxyError(error) {
        const errorMessage = error.message || '';
        return (
            errorMessage.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
            errorMessage.includes('TUNNEL_FAILED') ||
            errorMessage.includes('ERR_PROXY_CONNECTION_FAILED') ||
            errorMessage.includes('ERR_CONNECTION_CLOSED') ||
            errorMessage.includes('ERR_CONNECTION_REFUSED') ||
            errorMessage.includes('ERR_CONNECTION_RESET') ||
            errorMessage.includes('ERR_TIMED_OUT') ||
            errorMessage.includes('ERR_NAME_NOT_RESOLVED') ||
            errorMessage.includes('net::ERR_') ||
            errorMessage.includes('Requesting main frame too early') ||
            errorMessage.includes('Target closed') ||
            errorMessage.includes('Session closed') ||
            errorMessage.includes('Protocol error')
        );
    }

    getTimestamp() {
        const now = new Date();
        const brazilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));

        const hours = String(brazilTime.getHours()).padStart(2, '0');
        const minutes = String(brazilTime.getMinutes()).padStart(2, '0');
        const seconds = String(brazilTime.getSeconds()).padStart(2, '0');
        return `[${hours}:${minutes}:${seconds}]`;
    }

    emitProgress(message, data = {}) {
        this.progress.message = message;
        Object.assign(this.progress, data);

        const timestamp = this.getTimestamp();
        const fullMessage = `${timestamp} ${message}`;

        this.logs.push({
            timestamp: new Date().toISOString(),
            message: fullMessage
        });

        // Calculate estimation (average 15s per item for Maps with investigation)
        if (this.progress.current === 0) {
            this.progress.estimatedTimeRemaining = this.progress.total * 15;
        } else if (this.progress.total > 0) {
            const elapsed = Date.now() - this.progress.startTime;
            const avgTimePerItem = elapsed / this.progress.current;
            const remainingItems = this.progress.total - this.progress.current;

            const progressRatio = this.progress.current / this.progress.total;
            const weightedAvg = (avgTimePerItem * progressRatio) + (15000 * (1 - progressRatio));

            this.progress.estimatedTimeRemaining = Math.ceil((weightedAvg * remainingItems) / 1000);
        }

        this.io.emit('scraper-progress', {
            id: this.id,
            type: 'googlemaps',
            ...this.progress
        });

        this.io.emit('scraper-log', {
            id: this.id,
            message: fullMessage
        });

        console.log(fullMessage);
    }

    addLog(message) {
        const timestamp = this.getTimestamp();
        const fullMessage = `${timestamp} ${message}`;

        this.logs.push({
            timestamp: new Date().toISOString(),
            message: fullMessage
        });

        console.log(fullMessage);
    }

    async processQueue(investigateWebsites, requiredFields) {
        this.isProcessingQueue = true;
        this.emitProgress(`👷 Worker iniciado: Aguardando estabelecimentos na fila...`);

        while (this.isProcessingQueue && !this.isCancelled) {
            if (this.queue.length > 0) {
                const business = this.queue.shift();

                // Dedup check (if not already done)
                const uid = (business.url || '') + (business.nome || '');
                if (this.results.some(r => (r.url === business.url) || (uid && r.uid === uid))) continue;

                try {
                    // Extract business data using WORKER extractors
                    await this.captureScreenshot('WORKER_EXTRACT_START', 'worker');

                    // Use workerBusinessExtractor if available, else fallback to main (but main is busy scrolling...)
                    // Ideally we only run this if page2 exists. If not, we should have a fallback.
                    const extractor = this.workerBusinessExtractor || this.businessExtractor;
                    const investigator = this.workerWebsiteInvestigator || this.websiteInvestigator;

                    const businessData = await extractor.extractBusiness(
                        business,
                        (msg) => { if (msg.message && msg.message.includes('Acessando')) this.emitProgress(`Worker: ${msg.message}`) }
                    );

                    // Website Investigation
                    if (investigateWebsites && businessData.website) {
                        this.emitProgress(`🔎 Worker investigating: ${businessData.website}`);
                        try {
                            const websiteData = await investigator.investigate(businessData.website);
                            await this.captureScreenshot('WORKER_INVESTIGATE', 'worker');

                            investigator.finalizeResult(websiteData);

                            // Merge data
                            if (websiteData.email && !businessData.email) businessData.email = websiteData.email;
                            if (websiteData.instagram && !businessData.instagram) businessData.instagram = websiteData.instagram;
                            if (websiteData.cnpj && !businessData.cnpj) businessData.cnpj = websiteData.cnpj;
                            if (websiteData.telefone && !businessData.telefone) businessData.telefone = websiteData.telefone;
                            if (websiteData.whatsapp) businessData.whatsapp = websiteData.whatsapp;

                        } catch (invErr) {
                            // console.log('Worker invest error', invErr);
                        }
                    }

                    // Check required fields
                    let isValid = true;
                    if (requiredFields && requiredFields.length > 0) {
                        for (const field of requiredFields) {
                            if (field === 'phone' && !businessData.telefone) isValid = false;
                            if (field === 'email' && !businessData.email) isValid = false;
                            if (field === 'website' && !businessData.website) isValid = false;
                            if (field === 'whatsapp' && !businessData.whatsapp) isValid = false;
                        }
                    }

                    if (isValid) {
                        this.results.push(businessData);
                        this.progress.successCount++;

                        this.io.emit('scraper-result', {
                            id: this.id,
                            type: 'googlemaps',
                            data: businessData
                        });

                        const percent = this.queue.length > 0 ? `(Fila: ${this.queue.length})` : '';
                        this.emitProgress(`✅ [Worker] Sucesso: ${businessData.nome} ${percent}`);
                    } else {
                        this.progress.skippedCount++;
                    }

                    await this.captureScreenshot('WORKER_COMPLETE', 'worker');

                } catch (e) {
                    this.progress.errorCount++;
                    await this.captureScreenshot('WORKER_ERROR', 'worker');
                }

                // Small delay
                await new Promise(r => setTimeout(r, 1000));

            } else {
                // Wait for more items
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        this.emitProgress(`👷 Worker finalizado.`);
    }

    async scrape(searchTerm, city, quantity, investigateWebsites = true, requiredFields = []) {
        try {
            this.results = [];
            this.config = { searchTerm, city, quantity, investigateWebsites, requiredFields };
            this.progress.total = quantity;
            this.progress.successCount = 0;
            this.progress.errorCount = 0;
            this.progress.skippedCount = 0;
            this.progress.websitesInvestigated = 0;

            const collectedIds = new Set();
            const majorCities = [
                'São Paulo', 'Rio de Janeiro', 'Brasília', 'Salvador', 'Fortaleza',
                'Belo Horizonte', 'Manaus', 'Curitiba', 'Recife', 'Goiânia',
                'Belém', 'Porto Alegre', 'Guarulhos', 'Campinas', 'São Luís',
                'São Gonçalo', 'Maceió', 'Duque de Caxias', 'Natal', 'Teresina'
            ];

            let searchLocations = [];
            // If no city defined and asking for many leads (> 200), expand search
            if (!city && quantity > 200) {
                this.emitProgress(`🚀 Modo de Expansão Inteligente: Buscando em múltiplas regiões...`);
                searchLocations = [null, ...majorCities];
            } else {
                searchLocations = [city];
            }

            // Start Worker Process (Consumer)
            if (!this.processQueuePromise) {
                this.processQueuePromise = this.processQueue(investigateWebsites, requiredFields);
            }

            for (const currentCity of searchLocations) {
                if (this.progress.successCount >= quantity) {
                    break;
                }

                // Build active query
                const activeQuery = currentCity ? `${searchTerm} em ${currentCity}` : (city ? `${searchTerm} em ${city}` : searchTerm);
                if (currentCity) {
                    this.emitProgress(`📍 EXPANSÃO: Iniciando nova busca em ${currentCity}`);
                }

                const searchQuery = activeQuery;

                // SEARCH PHASE WITH RETRY LOGIC
                let searchSuccess = false;
                let searchAttempts = 0;
                const maxSearchAttempts = 10;

                while (!searchSuccess && searchAttempts < maxSearchAttempts) {
                    try {
                        searchAttempts++;
                        this.emitProgress(`🔍 Buscando: "${searchQuery}"... (tentativa ${searchAttempts})`);

                        await this.searchHandler.performSearch(searchQuery, (msg) => this.emitProgress(msg.message));
                        await this.captureScreenshot('SEARCH_COMPLETE');
                        searchSuccess = true;

                    } catch (searchError) {
                        if (this.isProxyError(searchError)) {
                            this.emitProgress(`❌ Erro de conexão na busca: ${searchError.message.split(' at ')[0]}`);
                            if (searchAttempts < maxSearchAttempts) await this.rotateProxy();
                            else throw new Error(`Falha após ${maxSearchAttempts} tentativas de proxy.`);
                        } else {
                            throw searchError;
                        }
                    }
                }

                await this.checkState();

                // COLLECT BUSINESSES (Producer)
                const adjustedTarget = quantity * 2;
                let collectSuccess = false;
                let collectAttempts = 0;

                while (!collectSuccess && collectAttempts < 5) {
                    try {
                        collectAttempts++;
                        await this.searchHandler.collectBusinesses(
                            adjustedTarget,
                            (msg) => this.emitProgress(msg.message),
                            false,
                            (newBusinesses) => {
                                for (const b of newBusinesses) {
                                    this.queue.push(b);
                                }
                                if (newBusinesses.length > 0) {
                                    this.emitProgress(`📥 ${newBusinesses.length} novos itens na fila (Total: ${this.queue.length})`);
                                }
                            }
                        );
                        collectSuccess = true;
                        await this.captureScreenshot('COLLECT_COMPLETE');

                    } catch (collectError) {
                        if (this.isProxyError(collectError)) {
                            this.emitProgress(`❌ Erro coleta: ${collectError.message}`);
                            if (collectAttempts < 5) {
                                await this.rotateProxy();
                                await this.searchHandler.performSearch(searchQuery, () => { });
                            }
                        }
                    }
                }

                // Polling for completion check
                while (this.queue.length > 0 && this.progress.successCount < quantity && !this.isCancelled) {
                    await new Promise(r => setTimeout(r, 2000));
                }

            } // End city loop

            // Final wait
            this.emitProgress(`🏁 Busca finalizada. Aguardando processamento da fila restante (${this.queue.length} itens)...`);
            while (this.queue.length > 0 && !this.isCancelled) {
                await new Promise(r => setTimeout(r, 1000));
            }

            // Stop worker
            this.isProcessingQueue = false;
            if (this.processQueuePromise) {
                await this.processQueuePromise;
            }

            // Verify count
            if (this.progress.successCount < quantity) {
                this.emitProgress(`Meta atingida parcialmente: ${this.progress.successCount}/${quantity} estabelecimentos extraídos.`);
            } else {
                this.emitProgress(`🎯 Meta completa: ${this.progress.successCount}/${quantity} estabelecimentos extraídos!`);
            }

            await this.checkState();
            this.emitProgress('Salvando resultados...');
            const filePath = await this.saveResults();

            this.status = 'completed';
            const summary = `Scraping concluído! Sucessos: ${this.progress.successCount}, Erros: ${this.progress.errorCount}, Websites investigados: ${this.progress.websitesInvestigated}`;
            this.emitProgress(summary, { filePath });

            return {
                success: true,
                count: this.results.length,
                successCount: this.progress.successCount,
                errorCount: this.progress.errorCount,
                websitesInvestigated: this.progress.websitesInvestigated,
                filePath,
                data: this.results,
                logs: this.logs
            };

        } catch (error) {
            if (this.isCancelled) {
                console.log(`Scraper ${this.id} cancelled`);
                return { success: false, message: 'Cancelled', data: this.results, logs: this.logs };
            }

            // Capture error screenshot for debugging
            await this.captureScreenshot('ERROR');

            console.error('Scraping error:', error);
            this.emitProgress(`❌ Erro: ${error.message}`);
            return { success: false, message: error.message, data: this.results, logs: this.logs };
        }
    }

    async adaptiveDelay() {
        const jitter = Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, this.currentDelay + jitter));
    }

    async saveResults() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFilename = `googlemaps_${this.id}_results_${timestamp}`;
        const jsonPath = path.join('./results', `${baseFilename}.json`);
        const csvPath = path.join('./results', `${baseFilename}.csv`);

        // Ensure results dir
        try {
            await fs.mkdir('./results', { recursive: true });

            // 1. Save JSON (Source of Truth for History)
            await fs.writeFile(jsonPath, JSON.stringify(this.results, null, 2));

            // 2. Generate and Save CSV (For User Download)
            if (this.results.length > 0) {
                // Determine headers from all keys in the first result, or a fixed set
                const headers = [
                    'nome', 'categoria', 'telefone', 'whatsapp', 'website',
                    'link', 'endereco', 'email', 'instagram', 'facebook', 'linkedin'
                ];

                // BOM for Excel
                let csvContent = '\uFEFF';

                // Add Headers
                csvContent += headers.join(';') + '\n';

                // Add Rows
                for (const row of this.results) {
                    const line = headers.map(header => {
                        let val = row[header] || '';
                        // Clean for CSV
                        if (typeof val === 'string') {
                            val = val.replace(/"/g, '""').replace(/;/g, ',');
                            val = `"${val}"`;
                        }
                        return val;
                    }).join(';');
                    csvContent += line + '\n';
                }

                await fs.writeFile(csvPath, csvContent, 'utf8');
                return csvPath; // Return CSV path for the frontend download button
            }

            return jsonPath; // Fallback if no results to make CSV
        } catch (e) {
            console.error('Save error:', e);
            return null;
        }
    }

    async close() {
        try {
            if (this.browserManager) {
                await this.browserManager.close();
            }
        } catch (error) {
            console.warn(`[GoogleMapsScraper ${this.id}] Erro ao fechar browser:`, error.message);
        }
        this.status = 'closed';
    }
}

module.exports = GoogleMapsScraper;
