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
    }

    // Capture screenshot and emit via Socket.io for live view
    async captureScreenshot(actionName = 'ACTION') {
        if (!this.browserManager || !this.browserManager.page) return;

        try {
            const page = this.browserManager.page;
            const timestamp = Date.now();
            const filename = `live_${this.id}.png`;
            const filepath = path.join('./results', filename);

            // Take screenshot
            await page.screenshot({ path: filepath, type: 'png' });

            // Read as base64 for Socket.io emission
            const imageBuffer = await fs.readFile(filepath);
            const base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;

            // Emit to frontend
            this.io.emit('scraper-screenshot', {
                id: this.id,
                action: actionName,
                timestamp: timestamp,
                image: base64Image,
                url: `/results/${filename}?t=${timestamp}`
            });

            this.lastScreenshotTime = timestamp;
            this.screenshotPath = filepath;

        } catch (e) {
            // Silently fail - screenshot is optional
            console.log(`Screenshot capture failed: ${e.message}`);
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
                const maxSearchAttempts = 10; // Will try up to 10 different proxies

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

                            if (searchAttempts < maxSearchAttempts) {
                                // Rotate to next proxy and retry
                                await this.rotateProxy();
                            } else {
                                throw new Error(`Falha após ${maxSearchAttempts} tentativas de proxy. Verifique sua conexão.`);
                            }
                        } else {
                            // Non-proxy error, rethrow
                            throw searchError;
                        }
                    }
                }

                await this.checkState();

                // COLLECT BUSINESSES WITH RETRY LOGIC
                let collectSuccess = false;
                let collectAttempts = 0;
                const maxCollectAttempts = 5;
                const adjustedTarget = Math.min(quantity * 2, 5000); // Cap at 5000
                let businesses = [];

                while (!collectSuccess && collectAttempts < maxCollectAttempts) {
                    try {
                        collectAttempts++;
                        businesses = await this.searchHandler.collectBusinesses(adjustedTarget, (msg) => {
                            this.emitProgress(msg.message);
                        });
                        collectSuccess = true;
                        await this.captureScreenshot('COLLECT_COMPLETE');

                    } catch (collectError) {
                        if (this.isProxyError(collectError)) {
                            this.emitProgress(`❌ Erro de conexão ao coletar: ${collectError.message.split(' at ')[0]}`);

                            if (collectAttempts < maxCollectAttempts) {
                                await this.rotateProxy();
                                // Re-do search after proxy rotation
                                this.emitProgress(`🔄 Refazendo busca com novo proxy...`);
                                await this.searchHandler.performSearch(searchQuery, (msg) => this.emitProgress(msg.message));
                            } else {
                                throw new Error(`Falha ao coletar estabelecimentos após ${maxCollectAttempts} tentativas.`);
                            }
                        } else {
                            throw collectError;
                        }
                    }
                }

                if (businesses.length === 0) {
                    throw new Error('Nenhum estabelecimento encontrado com os filtros especificados');
                }

                this.emitProgress(`📋 Iniciando extração de ${businesses.length} estabelecimentos...`);

                // Process list loop
                let businessIndex = 0;
                let currentBatchStartIndex = 0;

                // STRICT MODE: Loop until we have enough successes
                while (this.progress.successCount < quantity) {
                    await this.checkState();

                    // If we ran out of businesses in the current list
                    if (businessIndex >= businesses.length) {
                        this.emitProgress(`🔄 Lista atual esgotada (${businessIndex} processados). Buscando mais estabelecimentos...`);

                        // Fetch more with continueCollection=true
                        const newTarget = businesses.length + 10; // Try to get 10 more
                        const oldLength = businesses.length;

                        businesses = await this.searchHandler.collectBusinesses(newTarget, (msg) => {
                            this.emitProgress(msg.message);
                        }, true);

                        if (businesses.length <= oldLength) {
                            this.emitProgress(`⚠️ Não foi possível encontrar mais estabelecimentos. Encerrando com ${this.progress.successCount} sucessos.`);
                            break;
                        }

                        this.emitProgress(`✅ Lista expandida para ${businesses.length} estabelecimentos.`);
                    }

                    const business = businesses[businessIndex];
                    businessIndex++;

                    // Dedup check (Name + Phone is usually unique enough)
                    const uid = (business.nome || '') + (business.telefone || '');
                    if (uid && collectedIds.has(uid)) {
                        continue;
                    }
                    if (uid) collectedIds.add(uid);

                    const totalProcessed = this.progress.successCount + this.progress.errorCount + this.progress.skippedCount;
                    this.progress.current = totalProcessed + 1;

                    this.emitProgress(`Processando ${businessIndex}/${businesses.length} (Sucesso: ${this.progress.successCount}/${quantity})`);

                    try {
                        // Add delay between requests
                        if (businessIndex > 1) {
                            await this.adaptiveDelay();
                        }

                        // Extract business data from Maps
                        const businessData = await this.businessExtractor.extractBusiness(
                            business,
                            (msg) => this.emitProgress(msg.message)
                        );
                        await this.captureScreenshot('EXTRACT_BUSINESS');

                        // If website exists and investigation is enabled
                        if (investigateWebsites && businessData.website) {
                            this.emitProgress(`🔎 Investigando website: ${businessData.website}`);

                            try {
                                // Investigate website with max depth 5 (always, regardless of required fields)
                                const websiteData = await this.websiteInvestigator.investigate(businessData.website);

                                // Screenshot after visiting website
                                await this.captureScreenshot('INVESTIGATE_WEBSITE');

                                // Finalize results (format phones, determine whatsapp)
                                this.websiteInvestigator.finalizeResult(websiteData);

                                this.progress.websitesInvestigated++;

                                // Merge data from website investigation
                                if (websiteData.email && !businessData.email) businessData.email = websiteData.email;
                                if (websiteData.instagram && !businessData.instagram) businessData.instagram = websiteData.instagram;
                                if (websiteData.cnpj && !businessData.cnpj) businessData.cnpj = websiteData.cnpj;

                                // Use formatted phone from website if Maps didn't have one
                                if (websiteData.telefone && !businessData.telefone) {
                                    businessData.telefone = websiteData.telefone;
                                }

                                // Set WhatsApp (from explicit links or mobile number)
                                if (websiteData.whatsapp) {
                                    businessData.whatsapp = websiteData.whatsapp;
                                }

                                // Store additional phones found
                                if (websiteData.telefones && websiteData.telefones.length > 0) {
                                    businessData.telefonesAdicionais = websiteData.telefones;
                                }

                                const foundData = [];
                                if (websiteData.email) foundData.push('Email');
                                if (websiteData.instagram) foundData.push('Instagram');
                                if (websiteData.telefone) foundData.push('Telefone');
                                if (websiteData.whatsapp) foundData.push('WhatsApp');

                                if (foundData.length > 0) {
                                    this.emitProgress(`✅ Website investigado: ${foundData.join(', ')}`);
                                } else {
                                    this.emitProgress(`✅ Website investigado (sem dados adicionais)`);
                                }
                            } catch (webError) {
                                this.emitProgress(`⚠️ Erro ao investigar website: ${webError.message}`);
                            }
                        }

                        // Format Maps phone if present but not already formatted
                        if (businessData.telefone && !businessData.telefone.startsWith('+55')) {
                            const formatted = this.websiteInvestigator.formatPhone(businessData.telefone);
                            if (formatted) businessData.telefone = formatted;
                        }

                        // If no whatsapp yet, check if the main phone is mobile
                        if (!businessData.whatsapp && businessData.telefone) {
                            if (this.websiteInvestigator.isMobileNumber(businessData.telefone)) {
                                businessData.whatsapp = businessData.telefone;
                            }
                        }

                        // Detailed logging of found data
                        const foundData = [];
                        if (businessData.telefone) foundData.push('Telefone');
                        if (businessData.website) foundData.push('Website');
                        if (businessData.email) foundData.push('Email');
                        if (businessData.instagram) foundData.push('Instagram');

                        if (foundData.length > 0) {
                            this.emitProgress(`📊 Dados encontrados: ${foundData.join(', ')}`);
                        }

                        // Check required fields
                        if (requiredFields && requiredFields.length > 0) {
                            const missingFields = [];

                            for (const field of requiredFields) {
                                if (field === 'phone' && !businessData.telefone) missingFields.push('Telefone');
                                if (field === 'whatsapp' && !businessData.whatsapp) missingFields.push('WhatsApp');
                                if (field === 'website' && !businessData.website) missingFields.push('Website');
                                if (field === 'email' && !businessData.email) missingFields.push('Email');
                                if (field === 'instagram' && !businessData.instagram) missingFields.push('Instagram');
                            }

                            if (missingFields.length > 0) {
                                this.progress.skippedCount++;
                                this.emitProgress(`⏭️ Ignorado: ${businessData.nome} (Faltando: ${missingFields.join(', ')})`);

                                // Emit skipped update to UI
                                this.io.emit('scraper-progress', {
                                    id: this.id,
                                    type: 'googlemaps',
                                    ...this.progress
                                });

                                continue;
                            }
                        }

                        // Success!
                        this.results.push(businessData);
                        this.progress.successCount++;
                        this.consecutiveErrors = 0;
                        this.consecutiveSuccesses++;

                        // Adaptive delay: decrease on success
                        if (this.consecutiveSuccesses >= 3 && !this.usingProxy) {
                            this.consecutiveSuccesses = 0;
                            this.currentDelay = Math.max(this.currentDelay - 500, this.minDelay);
                        }

                        this.io.emit('scraper-result', {
                            id: this.id,
                            type: 'googlemaps',
                            data: businessData
                        });

                        this.emitProgress(`✅ Extraído: ${businessData.nome} (${this.progress.successCount}/${quantity})`);

                    } catch (error) {
                        this.progress.errorCount++;
                        this.consecutiveErrors++;

                        const errorType = error.type || 'UNKNOWN';
                        this.emitProgress(`❌ Erro [${errorType}]: ${error.message}`);

                        // Check for connection errors
                        const isConnectionError = error.message && (
                            error.message.includes('ERR_CONNECTION_CLOSED') ||
                            error.message.includes('ERR_CONNECTION_REFUSED') ||
                            error.message.includes('ERR_PROXY_CONNECTION_FAILED') ||
                            error.message.includes('net::ERR_')
                        );

                        // Proxy rotation on connection errors or after 2 consecutive errors
                        if (isConnectionError || this.consecutiveErrors >= 2) {
                            await this.rotateProxy();
                        }

                        // Increase delay on errors
                        this.currentDelay = Math.min(this.currentDelay + 2000, this.maxDelay);
                        this.emitProgress(`⬆️ Delay aumentado para ${(this.currentDelay / 1000).toFixed(1)}s`);

                        continue;
                    }
                }

                // Short delay between cities
                if (!this.usingProxy) await new Promise(r => setTimeout(r, 2000));

            } // End of expansion loop

            // Final summary
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
            throw error;
        }
    }

    async adaptiveDelay() {
        const delay = this.currentDelay + Math.random() * 2000; // Add randomness
        this.emitProgress(`⏳ Aguardando ${(delay / 1000).toFixed(1)}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    async saveResults() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `googlemaps_results_${timestamp}.csv`;
        const filePath = path.join(__dirname, '..', '..', 'results', fileName);

        await fs.mkdir(path.join(__dirname, '..', '..', 'results'), { recursive: true });

        // Save CSV
        const csvHeaders = [
            'Nome',
            'Categoria',
            'Endereco',
            'Telefone',
            'WhatsApp',
            'Website',
            'Email',
            'Instagram',
            'CNPJ',
            'TelefonesAdicionais'
        ];

        const csvLines = [csvHeaders.join(',')];

        this.results.forEach(result => {
            const line = [
                this.escapeCsv(result.nome),
                this.escapeCsv(result.categoria),
                this.escapeCsv(result.endereco),
                this.escapeCsv(result.telefone),
                this.escapeCsv(result.whatsapp),
                this.escapeCsv(result.website),
                this.escapeCsv(result.email),
                this.escapeCsv(result.instagram),
                this.escapeCsv(result.cnpj),
                this.escapeCsv(result.telefonesAdicionais ? result.telefonesAdicionais.join('; ') : '')
            ].join(',');

            csvLines.push(line);
        });

        await fs.writeFile(filePath, csvLines.join('\n'), 'utf8');
        console.log(`Results saved to: ${filePath}`);

        // Save JSON
        const jsonPath = filePath.replace('.csv', '.json');

        const jsonData = {
            config: {
                searchTerm: this.config.searchTerm || '',
                city: this.config.city || '',
                quantity: this.config.quantity || 0,
                investigateWebsites: this.config.investigateWebsites
            },
            metadata: {
                startTime: this.startTime,
                endTime: new Date().toISOString(),
                totalResults: this.results.length,
                websitesInvestigated: this.progress.websitesInvestigated
            },
            logs: this.logs,
            results: this.results
        };

        await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
        console.log(`JSON saved to: ${jsonPath}`);

        return filePath;
    }

    escapeCsv(value) {
        if (!value) return '';
        const stringValue = String(value);
        if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
            return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
    }

    async close() {
        if (this.browserManager) {
            await this.browserManager.close();
        }
    }

    getResults() {
        return this.results;
    }
}

module.exports = GoogleMapsScraper;
