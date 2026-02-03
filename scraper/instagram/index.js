const BaseScraper = require('../baseScraper');
const ProfileSearch = require('./profileSearch');
const HashtagSearch = require('./hashtagSearch');
const FollowerExtractor = require('./followerExtractor');
const ProfileExtractor = require('./profileExtractor');
const AuthHandler = require('./auth');
const fs = require('fs').promises;
const path = require('path');
const config = require('../../config/scraper.config').instagram;

class InstagramScraper extends BaseScraper {
    constructor(id, io) {
        super(id, io, 'instagram', {
            defaultDelay: config.delays.noProxy,
            minDelay: config.delays.min,
            maxDelay: config.delays.max
        });
        
        this.profileSearch = null;
        this.hashtagSearch = null;
        this.followerExtractor = null;
        this.profileExtractor = null;
        this.authHandler = null;
        this.workerProfileExtractor = null;
    }

    async initialize(useProxy = true, cookies = null) {
        // Initialize proxy
        await this.initializeProxy(useProxy);
        
        // Initialize browser
        const page = await this.initializeBrowser(config.retryAttempts.proxyInit);
        
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
        
        // Setup worker page
        await this.setupWorkerPage();
        if (this.page2) {
            this.workerProfileExtractor = new ProfileExtractor(this.page2);
        }
        
        // Restore session if available
        if (cookies) {
            await this.authHandler.applyCookies(cookies);
        } else {
            await this.authHandler.tryRestoreSession();
        }
        
        // Set running state
        this.status = 'running';
        this.progress.startTime = Date.now();
        this.startTime = this.progress.startTime;
        
        const mode = this.usingProxy ? `proxy ${this.currentProxy}` : 'SEM PROXY';
        this.emitProgress(`📸 Instagram Scraper inicializado com ${mode}`);
    }

    async scrape(userConfig) {
        try {
            // Validate config
            this.validateConfig(userConfig);
            
            // Initialize state
            this.results = [];
            this.processedItems.clear();
            this.config = userConfig;
            this.profileQueue = [];
            
            const { searchType, searchTerm, quantity, filterTerm, requiredFields, cookies } = userConfig;
            this.progress.total = quantity || 10;
            this.progress.successCount = 0;
            this.progress.errorCount = 0;
            this.progress.skippedCount = 0;
            
            // Handle authentication
            await this.handleAuthentication(userConfig, cookies);
            
            // Start queue processing
            this.processQueuePromise = this.processQueue(filterTerm, requiredFields);
            
            // Route to appropriate handler
            await this.executeSearch(searchType, searchTerm, quantity, filterTerm);
            
            // Wait for queue to empty
            this.emitProgress('🏁 Coleta finalizada. Aguardando processamento da fila restante...');
            await this.waitForQueueEmpty(quantity);
            
            // Stop queue and finalize
            await this.stopQueue();
            
            // Save results
            await this.checkState();
            this.emitProgress('💾 Salvando resultados...');
            const filePath = await this.saveResultsWithCsv();
            
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
            return { success: false, message: error.message, data: this.results, logs: this.logs };
        }
    }

    validateConfig(userConfig) {
        if (!userConfig || typeof userConfig !== 'object') {
            throw new Error('Configuração inválida');
        }
        
        const { searchType, searchTerm, quantity } = userConfig;
        
        if (!searchType || !config.searchTypes.includes(searchType)) {
            throw new Error(`Tipo de pesquisa inválido. Deve ser um de: ${config.searchTypes.join(', ')}`);
        }
        
        if (!searchTerm || searchTerm.trim().length === 0) {
            throw new Error('Termo de busca ou perfil é obrigatório');
        }
        
        if (quantity !== undefined && (typeof quantity !== 'number' || quantity < 0 || quantity > 5000)) {
            throw new Error('Quantidade deve ser um número entre 0 e 5000');
        }
    }

    async handleAuthentication(userConfig, cookies) {
        const { searchType, username, password } = userConfig;
        
        // Check if authentication is needed
        const needsAuth = config.auth.requiredFor.includes(searchType) || !this.authHandler.isLoggedIn;
        
        if (!needsAuth) return;
        
        // Try cookies first
        if (cookies) {
            const authSuccess = await this.authHandler.applyCookies(cookies);
            if (authSuccess) return;
        }
        
        // Try credentials if provided
        if (username && password) {
            const success = await this.attemptLogin(username, password);
            if (success) return;
        }
        
        // Wait for user authentication
        await this.waitForUserAuth(userConfig);
    }

    async waitForUserAuth(userConfig) {
        while (!this.authHandler.isLoggedIn && !this.isCancelled) {
            this.emitProgress('🔐 Falha na autenticação. Aguardando login do usuário...');
            
            if (this.io) {
                this.io.emit('instagram-auth-required', {
                    id: this.id,
                    message: 'Sessão inválida. Por favor, faça login novamente.'
                });
            }
            
            this.status = 'paused_for_auth';
            
            const newCreds = await this.waitForCredentials();
            
            if (!newCreds) {
                throw new Error('Scraping cancelado durante autenticação');
            }
            
            this.emitProgress('🔄 Retomando com novas credenciais...');
            const success = await this.attemptLogin(newCreds.username, newCreds.password);
            
            if (success) {
                this.status = 'running';
                userConfig.username = newCreds.username;
                userConfig.password = newCreds.password;
                return;
            }
            
            this.emitProgress('❌ Novas credenciais falharam. Tente novamente.');
        }
    }

    async executeSearch(searchType, searchTerm, quantity, filterTerm) {
        const targetQty = quantity === 0 ? config.unlimitedFollowers : quantity;
        const isMultimediaFilter = !!filterTerm;
        
        switch (searchType) {
            case 'profiles':
                this.emitProgress(`🔍 Modo: Pesquisa de Perfis (Paralelo)`);
                await this.searchProfiles(searchTerm, targetQty);
                break;
                
            case 'hashtag':
                this.emitProgress(`#️⃣ Modo: Pesquisa por Hashtag (Paralelo)`);
                await this.searchByHashtag(searchTerm, targetQty);
                break;
                
            case 'followers':
                this.emitProgress(`👥 Modo: Extração de Seguidores (Paralelo)`);
                this.emitProgress(isMultimediaFilter
                    ? `🔎 Filtro "${filterTerm}" ativo. Processando fluxo contínuo...`
                    : `👥 Extraindo seguidores...`
                );
                await this.extractFollowers(searchTerm, targetQty, filterTerm);
                break;
                
            default:
                throw new Error(`Tipo de pesquisa inválido: ${searchType}`);
        }
    }

    async searchProfiles(searchTerm, quantity) {
        // Try Instagram search first
        const profiles = await this.profileSearch.search(
            searchTerm,
            quantity,
            (msg) => this.emitProgress(msg.message),
            (newProfiles) => this.handleNewProfiles(newProfiles)
        );
        
        // If not enough results, try Google search
        if (this.profileQueue.length + this.results.length < quantity) {
            const remaining = quantity - (this.profileQueue.length + this.results.length);
            this.emitProgress('🔄 Expandindo busca via Google...');
            
            const googleProfiles = await this.profileSearch.searchViaGoogle(searchTerm, remaining);
            if (googleProfiles && googleProfiles.length > 0) {
                this.handleNewProfiles(googleProfiles);
            }
        }
        
        return profiles;
    }

    async searchByHashtag(hashtag, quantity) {
        return await this.hashtagSearch.search(
            hashtag,
            quantity,
            (msg) => this.emitProgress(msg.message),
            (newProfiles) => this.handleNewProfiles(newProfiles)
        );
    }

    async extractFollowers(profileInput, quantity, filterTerm) {
        return await this.followerExtractor.extract(
            profileInput,
            quantity,
            filterTerm,
            (msg) => this.emitProgress(msg.message),
            (newProfiles) => this.handleNewProfiles(newProfiles)
        );
    }

    handleNewProfiles(newProfiles) {
        let added = 0;
        
        for (const profile of newProfiles) {
            if (!profile || !profile.username) continue;
            
            const isDuplicate = this.profileQueue.some(p => p.username === profile.username) ||
                this.results.some(r => r.username === profile.username) ||
                this.processedItems.has(profile.username);
            
            if (!isDuplicate) {
                this.processedItems.add(profile.username);
                this.profileQueue.push(profile);
                added++;
            }
        }
        
        if (added > 0) {
            this.emitProgress(`📥 +${added} na fila: Total ${this.profileQueue.length}`);
        }
    }

    async processQueue(filterTerm, requiredFields) {
        this.isProcessingQueue = true;
        this.emitProgress(`👷 Worker iniciado: Aguardando perfis...`);
        
        const extractor = this.workerProfileExtractor || this.profileExtractor;
        
        while (this.isProcessingQueue && !this.isCancelled) {
            if (this.profileQueue.length === 0) {
                await this.sleep(config.queue.workerDelay);
                continue;
            }
            
            const profile = this.profileQueue.shift();
            
            if (!profile || !profile.username) continue;
            if (this.results.some(r => r.username === profile.username)) continue;
            
            try {
                await this.captureScreenshot('WORKER_START', 'worker');
                
                const detailedData = await extractor.extractProfile(
                    profile.username,
                    (msg) => this.emitProgress(`Worker: ${msg.message}`)
                );
                
                await this.captureScreenshot('WORKER_EXTRACT', 'worker');
                
                // Merge data
                const result = { ...profile, ...detailedData };
                
                // Apply deep filter
                if (filterTerm && !this.applyDeepFilter(result, filterTerm)) {
                    this.progress.skippedCount++;
                    continue;
                }
                
                // Check required fields
                const missing = this.checkRequiredFields(result, requiredFields);
                if (missing.length > 0) {
                    this.progress.skippedCount++;
                    continue;
                }
                
                // Success
                this.results.push(result);
                this.progress.successCount++;
                
                if (this.io) {
                    this.io.emit('scraper-result', {
                        id: this.id,
                        type: 'instagram',
                        data: result
                    });
                }
                
                const percent = this.profileQueue.length > 0 ? `(Fila: ${this.profileQueue.length})` : '';
                this.emitProgress(`✅ [Worker] Sucesso: @${result.username} ${percent}`);
                await this.captureScreenshot('WORKER_COMPLETE', 'worker');
                
            } catch (error) {
                this.progress.errorCount++;
            }
            
            await this.sleep(config.queue.workerDelay + Math.random() * 2000);
        }
        
        this.emitProgress(`👷 Worker finalizado.`);
    }

    checkRequiredFields(data, requiredFields) {
        const missing = [];
        
        if (!data || typeof data !== 'object') {
            return ['Data inválida'];
        }
        
        if (!requiredFields || !Array.isArray(requiredFields)) {
            return missing;
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

    async attemptLogin(username, password) {
        this.emitProgress('🔐 Tentando login com usuário e senha...');
        
        const challengeHandler = async (message) => {
            this.emitProgress(`⚠️ ${message}`);
            
            if (this.io) {
                this.io.emit('instagram-challenge-required', {
                    id: this.id,
                    type: 'code',
                    message: message
                });
            }
            
            return new Promise((resolve) => {
                const timeoutId = setTimeout(() => {
                    this.offSocket('instagram-challenge-code', onCode);
                    resolve(null);
                }, config.timeouts.challenge);
                
                const onCode = ({ id, code }) => {
                    if (id === this.id) {
                        clearTimeout(timeoutId);
                        this.offSocket('instagram-challenge-code', onCode);
                        resolve(code);
                    }
                };
                
                this.onSocket('instagram-challenge-code', onCode);
            });
        };
        
        return await this.authHandler.login(username, password, challengeHandler);
    }

    async waitForCredentials() {
        return new Promise((resolve) => {
            let resolved = false;
            
            const onCreds = ({ id, username, password }) => {
                if (id === this.id && !resolved) {
                    resolved = true;
                    cleanup();
                    resolve({ username, password });
                }
            };
            
            const cleanup = () => {
                this.offSocket('update-instagram-credentials', onCreds);
                if (checkCancelInterval) {
                    clearInterval(checkCancelInterval);
                }
            };
            
            const checkCancelInterval = setInterval(() => {
                if (this.isCancelled && !resolved) {
                    resolved = true;
                    cleanup();
                    resolve(null);
                }
            }, 1000);
            
            // Set timeout
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve(null);
                }
            }, config.timeouts.challenge);
            
            this.onSocket('update-instagram-credentials', onCreds);
        });
    }

    applyDeepFilter(data, term) {
        if (!term) return true;
        
        const normalize = (str) => str ? 
            str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';
        
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

    async saveResultsWithCsv() {
        if (this.results.length === 0) {
            return null;
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFilename = `instagram_${this.id}_results_${timestamp}`;
        const resultsDir = path.join(__dirname, '..', '..', 'results');
        
        await fs.mkdir(resultsDir, { recursive: true });
        
        const csvPath = path.join(resultsDir, `${baseFilename}.csv`);
        const headers = [
            'Nome', 'Username', 'Bio', 'Telefone', 'WhatsApp', 'Email',
            'Website', 'Seguidores', 'Seguindo', 'Posts', 'Verificado', 'Privado'
        ];
        
        const csvLines = [headers.join(',')];
        
        for (const result of this.results) {
            if (!result || typeof result !== 'object') continue;
            
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
        }
        
        await fs.writeFile(csvPath, csvLines.join('\n'), 'utf8');
        
        // Save JSON
        const jsonPath = path.join(resultsDir, `${baseFilename}.json`);
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
        
        return csvPath;
    }
}

module.exports = InstagramScraper;
