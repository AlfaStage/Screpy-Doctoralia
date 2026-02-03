/**
 * Instagram Scraper
 * Main orchestrator class for Instagram scraping operations
 */

const BrowserManager = require('../browser');
const ProxyManager = require('../proxyManager');
const ProfileSearch = require('./profileSearch');
const HashtagSearch = require('./hashtagSearch');
const FollowerExtractor = require('./followerExtractor');
const ProfileExtractor = require('./profileExtractor');
const AuthHandler = require('./auth');
const fs = require('fs').promises;
const path = require('path');

class InstagramScraper {
    constructor(id, io) {
        this.id = id;
        this.io = io;
        this.browserManager = null;
        this.proxyManager = new ProxyManager((msg) => this.emitProgress(msg));
        this.currentProxy = null;
        this.usingProxy = true;

        // Handlers
        this.profileSearch = null;
        this.hashtagSearch = null;
        this.followerExtractor = null;
        this.profileExtractor = null;
        this.authHandler = null;

        // State
        this.results = [];
        this.logs = [];
        this.config = {};
        this.status = 'idle';
        this.isPaused = false;
        this.isCancelled = false;
        this.startTime = null;

        // Delay settings (Instagram is strict)
        this.currentDelay = 4000;
        this.minDelay = 3000;
        this.maxDelay = 15000;
        this.consecutiveErrors = 0;

        // Progress tracking
        this.progress = {
            total: 0,
            current: 0,
            successCount: 0,
            errorCount: 0,
            skippedCount: 0,
            message: '',
            startTime: null,
            estimatedTimeRemaining: null
        };

        // Parallel processing support
        this.page2 = null;
        this.profileQueue = [];
        this.isProcessingQueue = false;
        this.workerExtractor = null;

        // Screenshot for live view
        this.lastScreenshotTime = null;
        this.screenshotPath = null;
    }

    /**
     * Initialize the scraper
     */
    async initialize(useProxy = true, cookies = null) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        this.proxyManager = new ProxyManager((msg) => this.emitProgress(msg));

        // Proxy setup
        if (!useProxy) {
            this.emitProgress('🚀 Modo SEM PROXY selecionado');
            this.currentProxy = null;
            this.usingProxy = false;
            this.currentDelay = 6000;
        } else {
            this.currentProxy = await this.proxyManager.getNextProxy(true);
            if (this.currentProxy === null) {
                this.emitProgress('⚠️ Nenhum proxy disponível. Usando rate limiting agressivo.');
                this.usingProxy = false;
                this.currentDelay = 6000;
            } else {
                this.usingProxy = true;
                this.currentDelay = 4000;
            }
        }

        // Initialize browser
        let initSuccess = false;
        let initAttempts = 0;
        const maxInitAttempts = 5;

        while (initAttempts < maxInitAttempts && !initSuccess) {
            try {
                this.browserManager = new BrowserManager();
                const page = await this.browserManager.initialize(this.currentProxy);

                // Initialize handlers
                this.profileSearch = new ProfileSearch(page);
                this.hashtagSearch = new HashtagSearch(page);
                this.followerExtractor = new FollowerExtractor(page);
                this.profileExtractor = new ProfileExtractor(page);
                this.authHandler = new AuthHandler(
                    page,
                    (msg) => this.emitProgress(msg.message),
                    (action) => this.captureScreenshot(action)
                );

                // Initialize Worker Page (Page 2) for parallel processing
                try {
                    this.page2 = await this.browserManager.browser.newPage();
                    await this.browserManager.setupPage(this.page2);
                    this.workerExtractor = new ProfileExtractor(this.page2);
                    this.emitProgress('✅ Worker Page inicializada para processamento paralelo');
                } catch (e) {
                    this.emitProgress('⚠️ Falha ao iniciar Worker Page: ' + e.message);
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
                        this.emitProgress('⚠️ Sem mais proxies. Tentando sem proxy...');
                        this.usingProxy = false;
                        this.currentDelay = 6000;
                    }
                    continue;
                }

                if (initAttempts >= maxInitAttempts) {
                    throw error;
                }
            }
        }

        // Try to restore saved session
        if (cookies) {
            await this.authHandler.applyCookies(cookies);
        } else {
            await this.authHandler.tryRestoreSession();
        }

        this.status = 'running';
        this.progress.startTime = Date.now();
        this.startTime = this.progress.startTime;

        const mode = this.usingProxy ? `proxy ${this.currentProxy}` : 'SEM PROXY';
        this.emitProgress(`📸 Instagram Scraper inicializado com ${mode}`);
    }

    /**
     * Main scrape method - routes to appropriate handler
     */
    async scrape(config) {
        try {
            this.results = [];
            this.config = config;
            this.progress.total = config.quantity || 10;
            this.progress.successCount = 0;
            this.progress.errorCount = 0;
            this.progress.skippedCount = 0;

            const { searchType, searchTerm, quantity, filterTerm, requiredFields, cookies } = config;

            // Check if authentication is needed
            // Followers always triggers auth check. Others might rely on public view but safer to check.
            if ((searchType === 'followers' || !this.authHandler.isLoggedIn) && !this.authHandler.isLoggedIn) {
                if (cookies) {
                    const authSuccess = await this.authHandler.applyCookies(cookies);
                    if (!authSuccess && (!config.username || !config.password)) {
                        // Skip error if just browsing public profiles? No, Instagram is strict.
                        // throw new Error('Cookies inválidos e sem credenciais de backup.');
                    }
                }

                // If not logged in yet, try credentials if provided
                if (!this.authHandler.isLoggedIn && config.username && config.password) {
                    const success = await this.attemptLogin(config.username, config.password);
                    if (!success) {
                        // Fallthrough to pause logic
                    }
                }

                // If still not logged in, PAUSE AND ASK USER
                while (!this.authHandler.isLoggedIn) {
                    this.emitProgress('🔐 Falha na autenticação. Aguardando login do usuário...');
                    this.io.emit('instagram-auth-required', {
                        id: this.id,
                        message: 'Sessão inválida. Por favor, faça login novamente.'
                    });

                    this.status = 'paused_for_auth';

                    // Wait for credentials update or cancellation
                    const newCreds = await this.waitForCredentials();

                    if (!newCreds) {
                        // Cancelled
                        throw new Error('Scraping cancelado durante autenticação.');
                    }

                    this.emitProgress('🔄 Retomando com novas credenciais...');
                    const success = await this.attemptLogin(newCreds.username, newCreds.password);

                    if (success) {
                        this.status = 'running';
                        // Update config for future use
                        config.username = newCreds.username;
                        config.password = newCreds.password;
                    } else {
                        this.emitProgress('❌ Novas credenciais falharam. Tente novamente.');
                    }
                }
            }

            // Start Queue Processing (Consumer)
            if (!this.processQueuePromise) {
                this.processQueuePromise = this.processQueue(filterTerm, requiredFields);
            }

            // Route to appropriate handler (Producer)
            // Streaming callback
            const onProfilesFoundCallback = (newProfiles) => {
                for (const p of newProfiles) {
                    if (!this.profileQueue.some(existing => existing.username === p.username) &&
                        !this.results.some(r => r.username === p.username)) {
                        this.profileQueue.push(p);
                        this.emitProgress(`📥 +${this.profileQueue.length} na fila: @${p.username}`);
                    }
                }
            };

            switch (searchType) {
                case 'profiles':
                    this.emitProgress(`🔍 Modo: Pesquisa de Perfis (Paralelo)`);
                    await this.searchProfiles(searchTerm, quantity, onProfilesFoundCallback);
                    break;

                case 'hashtag':
                    this.emitProgress(`#️⃣ Modo: Pesquisa por Hashtag (Paralelo)`);
                    await this.searchByHashtag(searchTerm, quantity, onProfilesFoundCallback);
                    break;

                case 'followers':
                    this.emitProgress(`👥 Modo: Extração de Seguidores (Paralelo)`);

                    // Handle "unlimited" or large quantity
                    const targetQty = (quantity === 0 || !quantity) ? 1000000 : quantity;
                    const isMultimediaFilter = filterTerm ? true : false;

                    this.emitProgress(isMultimediaFilter
                        ? `🔎 Filtro "${filterTerm}" ativo. Processando fluxo contínuo até ${targetQty === 1000000 ? 'o fim' : targetQty}...`
                        : `👥 Extraindo até ${targetQty === 1000000 ? 'o fim' : targetQty} seguidores...`
                    );

                    await this.extractFollowers(searchTerm, targetQty, null, onProfilesFoundCallback);
                    break;

                default:
                    throw new Error(`Tipo de pesquisa inválido: ${searchType}`);
            }

            // Wait for queue to empty
            this.emitProgress('🏁 Coleta finalizada. Aguardando processamento da fila restante...');

            // Polling wait loop 
            while (this.profileQueue.length > 0 && this.progress.successCount < quantity && !this.isCancelled) {
                await new Promise(r => setTimeout(r, 2000));
            }

            // Clean up
            this.isProcessingQueue = false;
            if (this.processQueuePromise) await this.processQueuePromise;

            // Save results
            await this.checkState();
            this.emitProgress('💾 Salvando resultados...');
            const filePath = await this.saveResults();

            this.status = 'completed';
            const summary = `Scraping concluído! Sucessos: ${this.progress.successCount}, Erros: ${this.progress.errorCount}, Ignorados: ${this.progress.skippedCount}`;
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

            await this.captureScreenshot('ERROR');
            this.emitProgress(`❌ Erro: ${error.message}`);
            // throw error; // Don't throw to allow safe shutdown return
            return { success: false, message: error.message, data: this.results, logs: this.logs };
        }
    }

    /**
     * Search profiles by term
     */
    async searchProfiles(searchTerm, quantity, onProfilesFound) {
        // Try Instagram search first
        let profiles = await this.profileSearch.search(
            searchTerm,
            quantity,
            (msg) => this.emitProgress(msg.message),
            onProfilesFound
        );

        // If not enough results, try Google search
        // Note: Google search is one-shot, but we can still stream the result
        if (this.profileQueue.length + this.results.length < quantity && profiles.length < quantity) {
            this.emitProgress('🔄 Expandindo busca via Google...');
            const googleProfiles = await this.profileSearch.searchViaGoogle(
                searchTerm,
                quantity - (this.profileQueue.length + this.results.length),
                (msg) => this.emitProgress(msg.message)
            );

            if (googleProfiles && googleProfiles.length > 0 && onProfilesFound) {
                onProfilesFound(googleProfiles);
            }
        }

        return profiles; // Return just for reference, real processing is via queue
    }

    /**
     * Search by hashtag
     */
    async searchByHashtag(hashtag, quantity, onProfilesFound) {
        return await this.hashtagSearch.search(
            hashtag,
            quantity,
            (msg) => this.emitProgress(msg.message),
            onProfilesFound
        );
    }

    /**
     * Extract followers from profile
     */
    async extractFollowers(profileInput, quantity, filterTerm, onProfilesFound) {
        return await this.followerExtractor.extract(
            profileInput,
            quantity,
            filterTerm,
            (msg) => this.emitProgress(msg.message),
            onProfilesFound
        );
    }

    /**
     * Process profiles from the queue using the secondary page
     */
    async processQueue(filterTerm, requiredFields) {
        this.isProcessingQueue = true;
        this.emitProgress(`👷 Worker iniciado: Aguardando perfis...`);

        while (this.isProcessingQueue && !this.isCancelled) {
            // Check if queue has items
            if (this.profileQueue.length > 0) {

                // Pop the next profile
                const profile = this.profileQueue.shift();

                // If it's already in results (race condition), skip
                if (this.results.some(r => r.username === profile.username)) continue;

                try {
                    // Extract detailed profile data using Workder Extractor (Page 2)
                    // If no worker page (e.g. init fail), fallback to main? No, main is busy searching.
                    const extractor = this.workerExtractor || this.profileExtractor;

                    await this.captureScreenshot('WORKER_START', 'worker');
                    const detailedData = await extractor.extractProfile(
                        profile.username,
                        (msg) => this.emitProgress(`Worker: ${msg.message}`)
                    );
                    await this.captureScreenshot('WORKER_EXTRACT', 'worker');

                    // Merge checks
                    const result = { ...profile, ...detailedData };

                    // Deep Filter
                    if (filterTerm) {
                        const matches = this.applyDeepFilter(result, filterTerm);
                        if (!matches) {
                            this.progress.skippedCount++;
                            // Emit to UI so counters update
                            this.io.emit('scraper-progress', { id: this.id, type: 'instagram', ...this.progress });
                            continue;
                        }
                    }

                    // Required Fields
                    if (requiredFields && requiredFields.length > 0) {
                        const missing = this.checkRequiredFields(result, requiredFields);
                        if (missing.length > 0) {
                            this.progress.skippedCount++;
                            this.io.emit('scraper-progress', { id: this.id, type: 'instagram', ...this.progress });
                            continue;
                        }
                    }

                    // Success
                    this.results.push(result);
                    this.progress.successCount++;

                    this.io.emit('scraper-result', {
                        id: this.id,
                        type: 'instagram',
                        data: result
                    });

                    const percent = this.profileQueue.length > 0 ? `(Fila: ${this.profileQueue.length})` : '';
                    this.emitProgress(`✅ [Worker] Sucesso: @${result.username} ${percent}`);
                    await this.captureScreenshot('WORKER_COMPLETE', 'worker');

                } catch (e) {
                    this.progress.errorCount++;
                    // Log but don't stop
                    // await this.captureScreenshot('WORKER_ERROR', 'worker');
                }

                // Small delay for the worker to mimic human behavior
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

            } else {
                // If queue is empty, wait a bit
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        this.emitProgress(`👷 Worker finalizado.`);
    }

    /**
     * Check required fields
     */
    checkRequiredFields(data, requiredFields) {
        const missing = [];

        if (!data || typeof data !== 'object') {
            return ['Data inválida'];
        }

        for (const field of requiredFields) {
            switch (field) {
                case 'phone':
                    if (!data.telefone) missing.push('Telefone');
                    break;
                case 'whatsapp':
                    if (!data.whatsapp) missing.push('WhatsApp');
                    break;
                case 'email':
                    if (!data.email) missing.push('Email');
                    break;
                case 'website':
                    if (!data.website) missing.push('Website');
                    break;
            }
        }

        return missing;
    }

    /**
     * Handle consecutive errors
     */
    async handleConsecutiveErrors() {
        this.emitProgress('⚠️ Múltiplos erros consecutivos. Rotacionando proxy...');
        this.consecutiveErrors = 0;
        this.currentDelay = Math.min(this.currentDelay + 2000, this.maxDelay);

        if (this.usingProxy) {
            await this.rotateProxy();
        } else {
            // Just increase delay
            this.emitProgress(`⏳ Aumentando delay para ${this.currentDelay / 1000}s`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    /**
     * Rotate to new proxy
     */
    async rotateProxy() {
        this.emitProgress('🔄 Rotacionando proxy...');

        if (this.currentProxy) {
            this.proxyManager.markProxyAsFailed(this.currentProxy);
        }

        await this.browserManager.close().catch(() => { });

        this.currentProxy = await this.proxyManager.getNextProxy(true);

        if (this.currentProxy === null) {
            this.emitProgress('⚠️ Sem proxies disponíveis. Continuando sem proxy...');
            this.usingProxy = false;
            this.currentDelay = 6000;
        }

        // Reinitialize browser
        this.browserManager = new BrowserManager();
        const page = await this.browserManager.initialize(this.currentProxy);

        this.profileSearch = new ProfileSearch(page);
        this.hashtagSearch = new HashtagSearch(page);
        this.followerExtractor = new FollowerExtractor(page);
        this.profileExtractor = new ProfileExtractor(page);
        this.authHandler = new AuthHandler(page, (msg) => this.emitProgress(msg.message), (action) => this.captureScreenshot(action));

        // Try to restore session
        await this.authHandler.tryRestoreSession();

        // Also re-init the worker page if we rotated proxy/browser!
        try {
            this.page2 = await this.browserManager.browser.newPage();
            await this.browserManager.setupPage(this.page2);
            this.workerExtractor = new ProfileExtractor(this.page2);
            this.emitProgress('✅ Worker Page reinicializada após rotação de proxy');
        } catch (e) {
            this.emitProgress('⚠️ Falha ao reiniciar Worker Page: ' + e.message);
        }

        this.emitProgress('✅ Proxy rotacionado');
    }

    /**
     * Capture screenshot for live view (multi-window support)
     */
    async captureScreenshot(actionName = 'ACTION', source = 'main') {
        let pageToCapture = this.browserManager?.page;

        // If source is worker, try to get page2
        if (source === 'worker') {
            if (this.page2 && !this.page2.isClosed()) {
                pageToCapture = this.page2;
            } else {
                return; // Worker page not active or closed
            }
        }

        if (!pageToCapture || pageToCapture.isClosed()) return;

        try {
            const timestamp = Date.now();
            // New Format: instagram_[id]_live_[source].png
            const filename = `instagram_${this.id}_live_${source}.png`;
            const filepath = path.join('./results', filename);

            await pageToCapture.screenshot({ path: filepath, type: 'png' });

            const imageBuffer = await fs.readFile(filepath);
            const base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;

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
            // console.log(`Screenshot capture failed: ${e.message}`);
        }
    }

    /**
     * Adaptive delay between requests
     */
    async adaptiveDelay() {
        const delay = this.currentDelay + Math.random() * 2000;
        this.emitProgress(`⏳ Aguardando ${(delay / 1000).toFixed(1)}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    /**
     * Check pause/cancel state
     */
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

    /**
     * Pause scraping
     */
    pause() {
        this.isPaused = true;
        this.status = 'paused';
        this.emitProgress('⏸️ Scraping pausado');
    }

    /**
     * Resume scraping
     */
    resume() {
        this.isPaused = false;
        this.status = 'running';
        this.emitProgress('▶️ Scraping retomado');
    }

    /**
     * Cancel scraping
     */
    async cancel() {
        this.isCancelled = true;
        this.status = 'cancelled';
        this.emitProgress('🛑 Cancelando scraping...');

        if (this.results.length > 0) {
            this.emitProgress('💾 Salvando dados parciais...');
            await this.saveResults();
        }

        await this.close();
    }

    /**
     * Close browser and cleanup
     */
    async close() {
        try {
            if (this.browserManager) {
                await this.browserManager.close();
            }
        } catch (error) {
            console.warn(`[InstagramScraper ${this.id}] Erro ao fechar browser:`, error.message);
        }
    }

    /**
     * Get timestamp for logging
     */
    getTimestamp() {
        const now = new Date();
        const brazilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const hours = String(brazilTime.getHours()).padStart(2, '0');
        const minutes = String(brazilTime.getMinutes()).padStart(2, '0');
        const seconds = String(brazilTime.getSeconds()).padStart(2, '0');
        return `[${hours}:${minutes}:${seconds}]`;
    }

    /**
     * Emit progress to frontend
     */
    emitProgress(message, data = {}) {
        this.progress.message = message;
        Object.assign(this.progress, data);

        const timestamp = this.getTimestamp();
        const fullMessage = `${timestamp} ${message}`;

        this.logs.push({
            timestamp: new Date().toISOString(),
            message: fullMessage
        });

        // Calculate ETA
        if (this.progress.current > 0 && this.progress.total > 0) {
            const elapsed = Date.now() - this.progress.startTime;
            const avgTimePerItem = elapsed / this.progress.current;
            const remainingItems = this.progress.total - this.progress.current;
            this.progress.estimatedTimeRemaining = Math.ceil((avgTimePerItem * remainingItems) / 1000);
        }

        this.io.emit('scraper-progress', {
            id: this.id,
            type: 'instagram',
            ...this.progress
        });

        this.io.emit('scraper-log', {
            id: this.id,
            message: fullMessage
        });

        console.log(fullMessage);
    }

    /**
     * Save results to CSV and JSON
     */
    async saveResults() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        // New Format: instagram_[id]_results_[timestamp].csv
        const fileName = `instagram_${this.id}_results_${timestamp}.csv`;
        const jsonName = `instagram_${this.id}_results_${timestamp}.json`;
        const filePath = path.join(__dirname, '..', '..', 'results', fileName);
        const jsonPath = path.join(__dirname, '..', '..', 'results', jsonName);

        await fs.mkdir(path.join(__dirname, '..', '..', 'results'), { recursive: true });

        // CSV
        const csvHeaders = [
            'Nome',
            'Username',
            'Bio',
            'Telefone',
            'WhatsApp',
            'Email',
            'Website',
            'Seguidores',
            'Seguindo',
            'Posts',
            'Verificado',
            'Privado'
        ];

        const csvLines = [csvHeaders.join(',')];

        this.results.forEach(result => {
            if (!result || typeof result !== 'object') return;
            
            const line = [
                this.escapeCsv(result.nome || ''),
                this.escapeCsv('@' + (result.username || '')),
                this.escapeCsv(result.bio || ''),
                this.escapeCsv(result.telefone || ''),
                this.escapeCsv(result.whatsapp || ''),
                this.escapeCsv(result.email || ''),
                this.escapeCsv(result.website || ''),
                this.escapeCsv(result.followers || ''),
                this.escapeCsv(result.following || ''),
                this.escapeCsv(result.posts || ''),
                result.isVerified ? 'Sim' : 'Não',
                result.isPrivate ? 'Sim' : 'Não'
            ].join(',');
            csvLines.push(line);
        });

        await fs.writeFile(filePath, csvLines.join('\n'), 'utf8');

        // JSON
        const jsonData = {
            config: this.config,
            metadata: {
                startTime: this.startTime,
                endTime: new Date().toISOString(),
                totalResults: this.results.length
            },
            logs: this.logs,
            results: this.results
        };

        await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');

        console.log(`Results saved to: ${filePath}`);
        return filePath;
    }

    /**
     * Helper: Attempt Login with retry/challenge logic
     */
    async attemptLogin(username, password) {
        this.emitProgress('🔐 Tentando login com usuário e senha...');

        const challengeHandler = async (message) => {
            this.emitProgress(`⚠️ ${message}`);
            this.io.emit('instagram-challenge-required', {
                id: this.id,
                type: 'code',
                message: message
            });

            // Wait for code
            return new Promise((resolve) => {
                const onCode = ({ id, code }) => {
                    if (id === this.id) {
                        this.io.off('instagram-challenge-code', onCode);
                        resolve(code);
                    }
                };
                setTimeout(() => { this.io.off('instagram-challenge-code', onCode); resolve(null); }, 300000);
                this.io.on('instagram-challenge-code', onCode);
            });
        };

        return await this.authHandler.login(username, password, challengeHandler);
    }

    /**
     * Helper: Wait for user to provide new credentials via socket
     */
    async waitForCredentials() {
        return new Promise((resolve) => {
            const onCreds = ({ id, username, password }) => {
                if (id === this.id) {
                    this.io.off('update-instagram-credentials', onCreds);
                    resolve({ username, password });
                }
            };

            // Also listen for cancel
            const checkCancel = setInterval(() => {
                if (this.isCancelled) {
                    this.io.off('update-instagram-credentials', onCreds);
                    clearInterval(checkCancel);
                    resolve(null);
                }
            }, 1000);

            this.io.on('update-instagram-credentials', onCreds);
        });
    }

    /**
     * Apply Deep Filter (Name, Username, Bio, Category)
     */
    applyDeepFilter(data, term) {
        if (!term) return true;

        const normalize = (str) => str ? str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";

        const filter = normalize(term);
        const nome = normalize(data.nome);
        const user = normalize(data.username);
        const bio = normalize(data.bio);
        const categoria = normalize(data.categoria);

        return nome.includes(filter) ||
            user.includes(filter) ||
            bio.includes(filter) ||
            categoria.includes(filter);
    }

    /**
     * Escape CSV field
     */
    escapeCsv(field) {
        if (field === null || field === undefined) return '';
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }
}

module.exports = InstagramScraper;
