const BrowserManager = require('./browser');
const SearchHandler = require('./search');
const ProfileExtractor = require('./profile');
const ProxyManager = require('./proxyManager');
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
    }

    async initialize() {
        // Small delay to ensure frontend is connected and listening to logs
        await new Promise(resolve => setTimeout(resolve, 2000));

        this.proxyManager = new ProxyManager((msg) => this.emitProgress(msg));

        // Try to get proxy, fallback to no proxy if all fail
        // Pass true to allowNoProxy fallback
        this.currentProxy = await this.proxyManager.getNextProxy(true);

        if (this.currentProxy === null) {
            this.emitProgress('⚠️ Modo SEM PROXY ativado. Usando rate limiting.');
            this.usingProxy = false;
            this.currentDelay = 3000; // Start with 3s delay when no proxy
        } else {
            this.usingProxy = true;
            this.currentDelay = 0; // No delay with proxy
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
        // Initial estimate: 6 seconds per item
        if (this.progress.current === 0) {
            this.progress.estimatedTimeRemaining = this.progress.total * 6;
        } else if (this.progress.total > 0) {
            // Adaptive estimation
            const elapsed = Date.now() - this.progress.startTime;
            const avgTimePerItem = elapsed / this.progress.current;
            const remainingItems = this.progress.total - this.progress.current;

            // Weight the initial estimate vs actual average based on progress
            // Early on, trust the 6s estimate more. Later, trust the average.
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

        // Also log to terminal with timestamp
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

    async scrape(specialties, city, quantity, onlyWithPhone = false) {
        try {
            this.results = [];
            // Do NOT clear logs here to preserve initialization logs
            this.config = { specialties, city, quantity, onlyWithPhone };
            this.progress.total = quantity;
            this.progress.successCount = 0;
            this.progress.errorCount = 0;
            this.progress.skippedCount = 0;

            if (!specialties || specialties.length === 0) {
                specialties = ['Médico'];
            }

            const quantityPerSpecialty = Math.ceil(quantity / specialties.length);
            const allProfileUrls = new Set();

            for (let i = 0; i < specialties.length; i++) {
                await this.checkState();

                const specialty = specialties[i];
                this.emitProgress(`Buscando ${specialty} (${i + 1}/${specialties.length})...`);

                this.emitProgress(`Acessando Doctoralia...`);
                await this.searchHandler.performSearch(specialty, city, (msg) => this.emitProgress(msg.message));

                await this.checkState();

                const urls = await this.searchHandler.collectProfileUrls(quantityPerSpecialty, (msg) => {
                    this.emitProgress(msg.message);
                });

                urls.forEach(url => allProfileUrls.add(url));

                if (allProfileUrls.size >= quantity) {
                    break;
                }
            }

            const profileUrls = Array.from(allProfileUrls);

            if (profileUrls.length === 0) {
                throw new Error('Nenhum perfil encontrado com os filtros especificados');
            }

            this.emitProgress(`Iniciando extração de ${profileUrls.length} perfis...`);

            // Extract profiles with phone filter and error handling
            // Keep fetching more URLs until we have enough successes
            let urlIndex = 0;
            let processedUrls = new Set(); // Track which URLs we already tried

            while (this.progress.successCount < quantity) {
                await this.checkState();

                // If we ran out of URLs, fetch more from search
                if (urlIndex >= profileUrls.length) {
                    this.emitProgress(`🔍 Buscando mais perfis para completar a meta...`);

                    // Try to collect more URLs from next pages
                    const additionalUrls = await this.searchHandler.collectProfileUrls(
                        quantity - this.progress.successCount + 10, // Get a bit extra
                        processedUrls, // Pass the Set of already processed URLs to exclude
                        (msg) => this.emitProgress(msg.message)
                    );

                    // Add new URLs (skip duplicates)
                    const newUrls = additionalUrls.filter(url => !processedUrls.has(url));
                    profileUrls.push(...newUrls);

                    if (newUrls.length === 0) {
                        this.emitProgress(`⚠️ Não há mais perfis disponíveis. Encerrando com ${this.progress.successCount} sucessos.`);
                        break;
                    }

                    this.emitProgress(`✅ Encontrados ${newUrls.length} perfis adicionais`);
                }

                const url = profileUrls[urlIndex];
                urlIndex++;
                processedUrls.add(url);

                const totalProcessed = this.progress.successCount + this.progress.errorCount + this.progress.skippedCount;
                this.progress.current = totalProcessed + 1;

                this.emitProgress(`Processando médico ${urlIndex}/${profileUrls.length} (Sucesso: ${this.progress.successCount}/${quantity}, Erros: ${this.progress.errorCount}, Pulados: ${this.progress.skippedCount})`);

                try {
                    const profileData = await this.profileExtractor.extractProfile(url, (msg) => this.emitProgress(msg.message));

                    // Check phone filter
                    if (onlyWithPhone && !this.profileExtractor.hasPhoneNumber(profileData)) {
                        this.progress.skippedCount++;
                        this.emitProgress(`⏭️ Médico pulado (sem telefone): ${profileData.nome}`);
                        console.log(`⏭️ Skipping ${profileData.nome} - no phone number`);
                        continue; // Don't count as success, continue to next
                    }

                    if (this.profileExtractor.hasPhoneNumber(profileData)) {
                        this.progress.phonesFound++;
                    }

                    // Success!
                    this.results.push(profileData);
                    this.progress.successCount++;
                    this.consecutiveErrors = 0; // Reset error counter on success
                    this.consecutiveSuccesses++;

                    // Adaptive delay: decrease on success
                    if (this.consecutiveSuccesses >= 2 && !this.usingProxy) {
                        this.consecutiveSuccesses = 0;
                        this.currentDelay = Math.max(this.currentDelay - 1500, this.minDelay);
                        if (this.currentDelay > 0) {
                            this.emitProgress(`⬇️ Delay reduzido para ${(this.currentDelay / 1000).toFixed(1)}s`);
                        }
                    }

                    this.io.emit('scraper-result-update', {
                        id: this.id,
                        data: profileData
                    });

                    this.emitProgress(`✅ Extraído: ${profileData.nome} (${this.progress.successCount}/${quantity})`);

                } catch (error) {
                    // Error handling
                    this.progress.errorCount++;
                    this.consecutiveErrors++;

                    const errorType = error.type || 'UNKNOWN';
                    const errorMsg = `❌ Erro [${errorType}]: ${error.message}`;

                    this.emitProgress(errorMsg);
                    console.error(errorMsg);

                    // Check for connection errors that require immediate proxy change
                    const isConnectionError = error.message && (
                        error.message.includes('ERR_CONNECTION_CLOSED') ||
                        error.message.includes('ERR_CONNECTION_REFUSED') ||
                        error.message.includes('ERR_PROXY_CONNECTION_FAILED') ||
                        error.message.includes('net::ERR_')
                    );

                    // Force proxy rotation on connection errors or after 2 consecutive errors
                    if (isConnectionError || this.consecutiveErrors >= 2) {
                        if (isConnectionError) {
                            this.emitProgress(`⚠️ Erro de conexão detectado, trocando proxy...`);
                        } else {
                            this.emitProgress(`⚠️ ${this.consecutiveErrors} erros consecutivos, trocando proxy...`);
                        }

                        console.log(`🔄 Rotating proxy after connection error or ${this.consecutiveErrors} consecutive errors`);

                        // Mark current proxy as failed
                        if (this.currentProxy) {
                            this.proxyManager.markProxyAsFailed(this.currentProxy);
                        }

                        // Get new proxy
                        try {
                            const newProxy = await this.proxyManager.getNextProxy();

                            if (newProxy !== this.currentProxy) {
                                // Restart browser with new proxy
                                this.emitProgress('🔄 Reiniciando browser com novo proxy...');
                                await this.browserManager.close();

                                this.currentProxy = newProxy;
                                this.browserManager = new BrowserManager();
                                const page = await this.browserManager.initialize(this.currentProxy);

                                this.searchHandler = new SearchHandler(page);
                                this.profileExtractor = new ProfileExtractor(page);

                                this.consecutiveErrors = 0; // Reset after proxy change
                                this.emitProgress('✅ Proxy trocado com sucesso');
                            }
                        } catch (proxyError) {
                            this.emitProgress(`⚠️ Erro ao trocar proxy: ${proxyError.message}`);
                            console.error('Proxy rotation error:', proxyError);
                            // Continue anyway - will try next profile
                        }
                    }

                    // Continue to next profile
                    continue;
                }
            }

            // Final summary
            if (this.progress.successCount < quantity) {
                const reason = `Meta atingida parcialmente: Solicitado ${quantity}, extraído ${this.progress.successCount}. Erros: ${this.progress.errorCount}, Pulados: ${this.progress.skippedCount}`;
                console.log(reason);
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

            // Check if it's a proxy/connection error that requires immediate proxy change
            const isProxyError = error.message && (
                error.message.includes('TUNNEL_FAILED') ||
                error.message.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
                error.message.includes('ERR_PROXY_CONNECTION_FAILED') ||
                error.message.includes('ERR_CONNECTION_CLOSED') ||
                error.message.includes('ERR_CONNECTION_REFUSED') ||
                error.message.includes('ERR_TIMED_OUT') ||
                error.message.includes('ERR_NAME_NOT_RESOLVED')
            );

            // Limitar tentativas de retry (máximo 3 retries)
            if (!this.retryCount) this.retryCount = 0;
            const maxRetries = 3;

            if (isProxyError && this.retryCount < maxRetries) {
                this.retryCount++;
                this.emitProgress(`⚠️ Erro de proxy detectado. Tentativa ${this.retryCount}/${maxRetries}...`);

                // Mark current proxy as failed
                if (this.currentProxy) {
                    this.proxyManager.markProxyAsFailed(this.currentProxy);
                }

                // Close current browser
                await this.browserManager.close();

                // Try to get a new proxy (pode retornar null para modo sem proxy)
                this.currentProxy = await this.proxyManager.getNextProxy();

                if (this.currentProxy === null) {
                    this.emitProgress('🔄 Reiniciando em modo SEM PROXY...');
                    this.usingProxy = false;
                    this.currentDelay = 3000; // Delay para modo sem proxy
                } else {
                    this.emitProgress(`🔄 Reiniciando com proxy: ${this.currentProxy}`);
                    this.usingProxy = true;
                }

                this.browserManager = new BrowserManager();

                // Wrap initialization in try-catch to handle TUNNEL_FAILED and fallback
                try {
                    const page = await this.browserManager.initialize(this.currentProxy);
                    this.searchHandler = new SearchHandler(page);
                    this.profileExtractor = new ProfileExtractor(page);
                } catch (initError) {
                    // If tunnel failed, try without proxy
                    if (initError.message && initError.message.includes('TUNNEL_FAILED')) {
                        this.emitProgress('⚠️ Túnel falhou novamente. Tentando SEM PROXY...');
                        if (this.currentProxy) {
                            this.proxyManager.markProxyAsFailed(this.currentProxy);
                        }
                        this.currentProxy = null;
                        this.usingProxy = false;
                        this.currentDelay = 3000;

                        await this.browserManager.close().catch(() => { });
                        this.browserManager = new BrowserManager();
                        const page = await this.browserManager.initialize(null);
                        this.searchHandler = new SearchHandler(page);
                        this.profileExtractor = new ProfileExtractor(page);
                    } else {
                        throw initError;
                    }
                }

                // Retry the scrape
                this.emitProgress('🔄 Tentando novamente...');
                return await this.scrape(
                    this.config.specialties,
                    this.config.city,
                    this.config.quantity,
                    this.config.onlyWithPhone
                );
            }

            // Se esgotou os retries COM PROXY, ir para modo sem proxy
            if (isProxyError && this.retryCount >= maxRetries && this.usingProxy) {
                this.emitProgress('⚠️ Esgotadas tentativas com proxy. Iniciando modo SEM PROXY...');

                await this.browserManager.close();

                this.currentProxy = null;
                this.usingProxy = false;
                this.currentDelay = 3000;
                this.retryCount = 0; // Reset contador
                this.noProxyErrors = 0; // Contador de erros no modo sem proxy

                this.browserManager = new BrowserManager();
                const page = await this.browserManager.initialize(null);

                this.searchHandler = new SearchHandler(page);
                this.profileExtractor = new ProfileExtractor(page);

                this.emitProgress('🔄 Tentando em modo SEM PROXY...');
                return await this.scrape(
                    this.config.specialties,
                    this.config.city,
                    this.config.quantity,
                    this.config.onlyWithPhone
                );
            }

            // Se está no modo sem proxy e deu erro, contar erros
            if (isProxyError && !this.usingProxy) {
                if (!this.noProxyErrors) this.noProxyErrors = 0;
                this.noProxyErrors++;

                this.emitProgress(`⚠️ Erro sem proxy ${this.noProxyErrors}/2...`);

                // Após 2 erros no modo sem proxy, voltar a tentar proxies
                if (this.noProxyErrors >= 2) {
                    this.emitProgress('🔄 2 erros sem proxy. Resetando proxies para nova tentativa...');

                    await this.browserManager.close();

                    // Resetar proxies falhos para tentar novamente
                    this.proxyManager.resetFailedProxies();
                    this.noProxyErrors = 0;
                    this.retryCount = 0;

                    // Tentar obter um novo proxy
                    this.currentProxy = await this.proxyManager.getNextProxy();

                    if (this.currentProxy) {
                        this.usingProxy = true;
                        this.currentDelay = 0;
                        this.emitProgress(`🔄 Novo proxy obtido: ${this.currentProxy}`);
                    } else {
                        this.usingProxy = false;
                        this.currentDelay = 3000;
                        this.emitProgress('⚠️ Nenhum proxy disponível, continuando sem proxy...');
                    }

                    this.browserManager = new BrowserManager();
                    const page = await this.browserManager.initialize(this.currentProxy);

                    this.searchHandler = new SearchHandler(page);
                    this.profileExtractor = new ProfileExtractor(page);

                    return await this.scrape(
                        this.config.specialties,
                        this.config.city,
                        this.config.quantity,
                        this.config.onlyWithPhone
                    );
                }

                // Se ainda não chegou a 2 erros, tenta novamente sem proxy
                await this.browserManager.close();

                this.browserManager = new BrowserManager();
                const page = await this.browserManager.initialize(null);

                this.searchHandler = new SearchHandler(page);
                this.profileExtractor = new ProfileExtractor(page);

                this.emitProgress('🔄 Tentando novamente sem proxy...');
                return await this.scrape(
                    this.config.specialties,
                    this.config.city,
                    this.config.quantity,
                    this.config.onlyWithPhone
                );
            }

            throw error;
        } finally { }
    }

    async saveResults() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `doctoralia_results_${timestamp}.csv`;
        const filePath = path.join(__dirname, '..', 'results', fileName);

        await fs.mkdir(path.join(__dirname, '..', 'results'), { recursive: true });

        // Save CSV
        const csvLines = ['Nome,Especialidades,Numero Fixo,Numero Movel,Enderecos'];

        this.results.forEach(result => {
            // Fallback for missing data using config
            let specialtiesStr = result.especialidades.join('; ');
            if (!specialtiesStr && this.config.specialties && this.config.specialties.length > 0) {
                specialtiesStr = this.config.specialties.join('; ');
            }

            let addressStr = result.enderecos.join('; ');
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
        if (this.browserManager) {
            await this.browserManager.close();
        }
    }

    getResults() {
        return this.results;
    }
}

module.exports = DoctoraliaScraper;
