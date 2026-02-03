const BrowserManager = require('../browser');
const SearchHandler = require('./search');
const ProfileExtractor = require('./profile');
const ProxyManager = require('../proxyManager');
const fs = require('fs').promises;
const path = require('path');

class DoctoraliaScraper {
    constructor(id, io) {
        this.id = id;
        this.io = io;
        this.browserManager = null;
        this.searchHandler = null;
        this.profileExtractor = null;
        // Pass log callback to ProxyManager so logs appear in modal
        this.proxyManager = new ProxyManager((msg) => this.emitProgress(msg));
        this.currentProxy = null;
        this.consecutiveErrors = 0;
        this.consecutiveSuccesses = 0;
        this.usingProxy = true; // Track proxy usage
        this.currentDelay = 0; // Adaptive delay in ms
        this.minDelay = 0; // Min delay (no delay)
        this.maxDelay = 72000; // Max delay (60-72s = 1-1.2min)
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
            phonesFound: 0,
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
        this.workerProfileExtractor = null;
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
            // New Format: doctoralia_[id]_live_[source].png
            const filename = `doctoralia_${this.id}_live_${source}.png`;
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
        // Small delay to ensure frontend is connected and listening to logs
        await new Promise(resolve => setTimeout(resolve, 2000));

        this.proxyManager = new ProxyManager((msg) => this.emitProgress(msg));

        // Check if user explicitly disabled proxy
        if (!useProxy) {
            this.emitProgress('🚀 Modo SEM PROXY selecionado. Usando rate limiting.');
            this.currentProxy = null;
            this.usingProxy = false;
            this.currentDelay = 3000; // Start with 3s delay when no proxy
        } else {
            // Try to get proxy, fallback to no proxy if all fail
            this.currentProxy = await this.proxyManager.getNextProxy(true);

            if (this.currentProxy === null) {
                this.emitProgress('⚠️ Nenhum proxy disponível. Usando rate limiting.');
                this.usingProxy = false;
                this.currentDelay = 3000; // Start with 3s delay when no proxy
            } else {
                this.usingProxy = true;
                this.currentDelay = 0; // No delay with proxy
            }
        }

        // Tentar inicializar o browser com o proxy
        // Se for SOCKS e o túnel falhar, tentar próximo proxy
        let initAttempts = 0;
        const maxInitAttempts = 5;
        let initSuccess = false;

        while (initAttempts < maxInitAttempts && !initSuccess) {
            try {
                this.browserManager = new BrowserManager();
                const page = await this.browserManager.initialize(this.currentProxy);

                this.searchHandler = new SearchHandler(page);
                this.profileExtractor = new ProfileExtractor(page);

                // Initialize Worker Page (Page 2)
                try {
                    this.page2 = await this.browserManager.browser.newPage();
                    await this.page2.setViewport({ width: 1366, height: 768 });
                    this.workerProfileExtractor = new ProfileExtractor(this.page2);
                    this.emitProgress('✅ Worker Page inicializada para processamento paralelo');
                } catch (e) {
                    this.emitProgress('⚠️ Falha ao iniciar Worker Page, continuando em modo single-thread: ' + e.message);
                }

                initSuccess = true; // Sucesso, sair do loop

            } catch (error) {
                initAttempts++;

                // Se foi erro de túnel SOCKS, marcar como falho e tentar próximo
                if (error.message && error.message.includes('TUNNEL_FAILED')) {
                    this.emitProgress(`❌ Túnel falhou. Tentando próximo proxy... (${initAttempts}/${maxInitAttempts})`);

                    if (this.currentProxy) {
                        this.proxyManager.markProxyAsFailed(this.currentProxy);
                    }

                    // Fechar browser que falhou
                    await this.browserManager.close().catch(() => { });

                    // Tentar próximo proxy
                    this.currentProxy = await this.proxyManager.getNextProxy(true);

                    if (this.currentProxy === null) {
                        this.emitProgress('⚠️ Sem mais proxies. Tentando modo SEM PROXY...');
                        this.usingProxy = false;
                        this.currentDelay = 3000;
                    }

                    continue; // Tentar novamente com novo proxy (ou sem proxy)
                }

                // Se não foi erro de túnel ou esgotou tentativas, propagar erro
                if (initAttempts >= maxInitAttempts) {
                    throw error;
                }
            }
        }

        // Fallback final: se não conseguiu inicializar, tentar sem proxy
        if (!initSuccess) {
            this.emitProgress('⚠️ Falha em todas as tentativas. Iniciando sem proxy...');
            this.currentProxy = null;
            this.usingProxy = false;
            this.currentDelay = 3000;

            this.browserManager = new BrowserManager();
            const page = await this.browserManager.initialize(null);
            this.searchHandler = new SearchHandler(page);
            this.profileExtractor = new ProfileExtractor(page);
        }

        this.status = 'running';
        this.progress.startTime = Date.now();
        this.startTime = this.progress.startTime;

        const mode = this.usingProxy ? `proxy ${this.currentProxy}` : 'SEM PROXY';
        this.emitProgress(`Scraper inicializado com ${mode}`);
        console.log(`Scraper ${this.id} initialized with ${mode}`);
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

        // Save whatever we have so far
        if (this.results.length > 0) {
            this.emitProgress('Salvando dados parciais...');
            await this.saveResults();
        }

        await this.close();
    }

    getTimestamp() {
        // Always use Brazil timezone (America/Sao_Paulo, UTC-3)
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

        // Store log with Brazil timestamp
        const timestamp = this.getTimestamp();
        const fullMessage = `${timestamp} ${message}`;

        this.logs.push({
            timestamp: new Date().toISOString(),
            message: fullMessage
        });

        // Calculate estimation
        if (this.progress.current === 0) {
            this.progress.estimatedTimeRemaining = this.progress.total * 6;
        } else if (this.progress.total > 0) {
            const elapsed = Date.now() - this.progress.startTime;
            const avgTimePerItem = elapsed / this.progress.current;
            const remainingItems = this.progress.total - this.progress.current;
            const progressRatio = this.progress.current / this.progress.total;
            const weightedAvg = (avgTimePerItem * progressRatio) + (6000 * (1 - progressRatio));
            this.progress.estimatedTimeRemaining = Math.ceil((weightedAvg * remainingItems) / 1000);
        }

        this.io.emit('scraper-progress', {
            id: this.id,
            ...this.progress
        });

        this.io.emit('scraper-log', {
            id: this.id,
            message: fullMessage
        });

        console.log(fullMessage);
    }

    // Public method to add external logs (e.g., from Manager)
    addLog(message) {
        const timestamp = this.getTimestamp();
        const fullMessage = `${timestamp} ${message}`;

        this.logs.push({
            timestamp: new Date().toISOString(),
            message: fullMessage
        });

        console.log(fullMessage);
    }

    async processQueue(requiredFields, onlyWithPhone) {
        this.isProcessingQueue = true;
        this.emitProgress(`👷 Worker iniciado: Aguardando perfis na fila...`);

        while (this.isProcessingQueue && !this.isCancelled) {
            if (this.queue.length > 0) {
                const url = this.queue.shift();

                // Dedup check
                if (this.results.some(r => r.url === url)) continue;

                try {
                    // Use workerProfileExtractor if available, else fallback
                    const extractor = this.workerProfileExtractor || this.profileExtractor;
                    await this.captureScreenshot('WORKER_START', 'worker');

                    const profileData = await extractor.extractProfile(url,
                        (msg) => { if (msg.message && msg.message.includes('Acessando')) this.emitProgress(`Worker: ${msg.message}`) }
                    );
                    await this.captureScreenshot('WORKER_EXTRACT', 'worker');

                    // Check required fields logic
                    const missingFields = [];
                    if (requiredFields && requiredFields.length > 0) {
                        for (const field of requiredFields) {
                            if (field === 'phone' && !extractor.hasPhoneNumber(profileData)) missingFields.push('Telefone');
                            if (field === 'address' && !profileData.endereco) missingFields.push('Endereço');
                        }
                        if (onlyWithPhone && !extractor.hasPhoneNumber(profileData) && !missingFields.includes('Telefone')) {
                            missingFields.push('Telefone');
                        }
                    } else if (onlyWithPhone && !extractor.hasPhoneNumber(profileData)) {
                        missingFields.push('Telefone');
                    }

                    if (missingFields.length > 0) {
                        this.progress.skippedCount++;
                        // this.emitProgress(`⏭️ [Worker] Pulado: ${profileData.nome} (Faltando: ${missingFields.join(', ')})`);
                        this.io.emit('scraper-progress', { id: this.id, type: 'doctoralia', ...this.progress });
                    } else {
                        if (extractor.hasPhoneNumber(profileData)) {
                            this.progress.phonesFound++;
                        }
                        this.results.push(profileData);
                        this.progress.successCount++;
                        this.consecutiveErrors = 0;

                        this.io.emit('scraper-result-update', { id: this.id, data: profileData });

                        const percent = this.queue.length > 0 ? `(Fila: ${this.queue.length})` : '';
                        this.emitProgress(`✅ [Worker] Sucesso: ${profileData.nome} ${percent}`);
                    }

                    await this.captureScreenshot('WORKER_COMPLETE', 'worker');

                } catch (error) {
                    this.progress.errorCount++;
                    // Silent consumer error logging to avoid spam
                }

                // Small delay
                await new Promise(r => setTimeout(r, 1000));
            } else {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        this.emitProgress('👷 Worker finalizado.');
    }

    async scrape(specialties, city, quantity, onlyWithPhone = false, requiredFields = []) {
        try {
            this.results = [];
            // Do NOT clear logs here to preserve initialization logs
            this.config = { specialties, city, quantity, onlyWithPhone, requiredFields };
            this.progress.total = quantity;
            this.progress.successCount = 0;
            this.progress.errorCount = 0;
            this.progress.skippedCount = 0;

            if (!specialties || specialties.length === 0) {
                specialties = ['Médico'];
            }

            const quantityPerSpecialty = Math.ceil(quantity / specialties.length);
            const allProfileUrls = new Set();

            // Start Worker
            if (!this.processQueuePromise) {
                this.processQueuePromise = this.processQueue(requiredFields, onlyWithPhone);
            }

            for (let i = 0; i < specialties.length; i++) {
                if (this.progress.successCount >= quantity) break;

                await this.checkState();

                const specialty = specialties[i];
                this.emitProgress(`Buscando ${specialty} (${i + 1}/${specialties.length})...`);

                this.emitProgress(`Acessando Doctoralia...`);
                await this.searchHandler.performSearch(specialty, city, (msg) => this.emitProgress(msg.message));
                await this.captureScreenshot('SEARCH_COMPLETE');

                await this.checkState();

                // Streaming Collection
                const urls = await this.searchHandler.collectProfileUrls(
                    quantityPerSpecialty,
                    (msg) => this.emitProgress(msg.message),
                    (newUrls) => {
                        // Push to queue
                        for (const u of newUrls) {
                            if (!allProfileUrls.has(u)) {
                                allProfileUrls.add(u);
                                this.queue.push(u);
                            }
                        }
                        if (newUrls.length > 0) this.emitProgress(`📥 ${newUrls.length} perfis na fila (Total: ${this.queue.length})`);
                    }
                );

                // Polling wait loop 
                while (this.queue.length > 0 && this.progress.successCount < quantity && !this.isCancelled) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            const profileUrls = Array.from(allProfileUrls);

            if (profileUrls.length === 0 && this.results.length === 0) {
                throw new Error('Nenhum perfil encontrado com os filtros especificados');
            }

            // Clean up queue processing
            while (this.queue.length > 0 && !this.isCancelled) await new Promise(r => setTimeout(r, 1000));
            this.isProcessingQueue = false;

            if (this.processQueuePromise) await this.processQueuePromise;

            // Final summary
            if (this.progress.successCount < quantity) {
                const reason = `Meta atingida parcialmente: Solicitado ${quantity}, extraído ${this.progress.successCount}. Erros: ${this.progress.errorCount}, Pulados: ${this.progress.skippedCount}`;
                this.emitProgress(reason);
            } else {
                this.emitProgress(`🎯 Meta completa: ${this.progress.successCount}/${quantity} médicos extraídos!`);
            }

            await this.checkState();
            this.emitProgress('Salvando resultados...');
            const filePath = await this.saveResults();

            this.status = 'completed';
            const summary = `Scraping concluído! Sucessos: ${this.progress.successCount}, Erros: ${this.progress.errorCount}, Pulados: ${this.progress.skippedCount}`;
            this.emitProgress(summary, { filePath });

            return {
                success: true,
                count: this.results.length,
                successCount: this.progress.successCount,
                errorCount: this.progress.errorCount,
                skippedCount: this.progress.skippedCount,
                phonesFound: this.progress.phonesFound,
                filePath,
                data: this.results,
                logs: this.logs
            };

        } catch (error) {
            if (this.isCancelled) {
                console.log(`Scraper ${this.id} cancelled`);
                return { success: false, message: 'Cancelled', data: this.results, logs: this.logs };
            }

            console.error('Scraping error:', error);
            this.emitProgress(`❌ Erro: ${error.message}`);
            return { success: false, message: error.message, data: this.results, logs: this.logs };
        } finally { }
    }

    async saveResults() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        // New Format: doctoralia_[id]_results_[timestamp].csv
        const fileName = `doctoralia_${this.id}_results_${timestamp}.csv`;
        const filePath = path.join(__dirname, '..', '..', 'results', fileName);

        await fs.mkdir(path.join(__dirname, '..', '..', 'results'), { recursive: true });

        // Save CSV
        const csvLines = ['Nome,Especialidades,Numero Fixo,Numero Movel,Enderecos'];

        this.results.forEach(result => {
            // Fallback for missing data using config
            let specialtiesStr = (result.especialidades || []).join('; ');
            if (!specialtiesStr && this.config.specialties && this.config.specialties.length > 0) {
                specialtiesStr = this.config.specialties.join('; ');
            }

            let addressStr = (result.enderecos || []).join('; ');
            if (!addressStr && this.config.city) {
                addressStr = this.config.city;
            }

            const line = [
                this.escapeCsv(result.nome),
                this.escapeCsv(specialtiesStr),
                this.escapeCsv(result.numeroFixo),
                this.escapeCsv(result.numeroMovel),
                this.escapeCsv(addressStr)
            ].join(',');

            csvLines.push(line);
        });

        await fs.writeFile(filePath, csvLines.join('\n'), 'utf8');
        console.log(`Results saved to: ${filePath}`);

        // Save JSON with complete data
        const jsonPath = filePath.replace('.csv', '.json');

        // Enrich results in JSON as well
        const enrichedResults = this.results.map(r => {
            const enriched = { ...r };
            if (!enriched.especialidades) {
                enriched.especialidades = [];
            }
            if (!enriched.enderecos) {
                enriched.enderecos = [];
            }
            if ((!enriched.especialidades || enriched.especialidades.length === 0) && this.config.specialties) {
                enriched.especialidades = [...this.config.specialties];
            }
            if ((!enriched.enderecos || enriched.enderecos.length === 0) && this.config.city) {
                enriched.enderecos = [this.config.city];
            }
            return enriched;
        });

        const jsonData = {
            config: {
                specialties: this.config.specialties || [],
                city: this.config.city || '',
                quantity: this.config.quantity || 0
            },
            metadata: {
                startTime: this.startTime,
                endTime: new Date().toISOString(),
                totalResults: this.results.length
            },
            logs: this.logs,
            results: enrichedResults
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
        try {
            if (this.browserManager) {
                await this.browserManager.close();
            }
        } catch (error) {
            console.warn(`[DoctoraliaScraper ${this.id}] Erro ao fechar browser:`, error.message);
        }
    }

    getResults() {
        return this.results;
    }
}

module.exports = DoctoraliaScraper;
