/**
 * Base Scraper Class
 * Abstract base class containing common functionality for all scrapers
 */

const fs = require('fs').promises;
const path = require('path');
const BrowserManager = require('./browser');
const ProxyManager = require('./proxyManager');
const config = require('../config/scraper.config');

class BaseScraper {
    constructor(id, io, type, options = {}) {
        this.id = id;
        this.io = io;
        this.type = type;
        
        // Browser and proxy management
        this.browserManager = null;
        this.proxyManager = null;
        this.currentProxy = null;
        this.usingProxy = true;
        
        // Worker page for parallel processing
        this.page2 = null;
        this.workerExtractor = null;
        
        // State management
        this.status = 'idle';
        this.isPaused = false;
        this.isCancelled = false;
        this.startTime = null;
        
        // Results and logs
        this.results = [];
        this.logs = [];
        this.config = {};
        
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
        
        // Adaptive delays
        this.currentDelay = options.defaultDelay || 3000;
        this.minDelay = options.minDelay || 1000;
        this.maxDelay = options.maxDelay || 72000;
        this.consecutiveErrors = 0;
        
        // Screenshot tracking
        this.lastScreenshotTime = null;
        this.screenshotPath = null;
        
        // Queue processing
        this.queue = [];
        this.isProcessingQueue = false;
        this.processQueuePromise = null;
        this.processedItems = new Set(); // For O(1) deduplication
        
        // Event listeners tracking for cleanup
        this.activeListeners = [];
    }

    /**
     * Get timestamp in Brazil timezone
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
     * Emit progress update to frontend
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

        // Calculate estimated time remaining
        if (this.progress.current > 0 && this.progress.total > 0 && this.progress.startTime) {
            const elapsed = Date.now() - this.progress.startTime;
            const avgTimePerItem = elapsed / this.progress.current;
            const remainingItems = this.progress.total - this.progress.current;
            this.progress.estimatedTimeRemaining = Math.ceil((avgTimePerItem * remainingItems) / 1000);
        }

        // Emit to frontend
        if (this.io) {
            this.io.emit('scraper-progress', {
                id: this.id,
                type: this.type,
                ...this.progress
            });

            this.io.emit('scraper-log', {
                id: this.id,
                message: fullMessage
            });
        }

        console.log(fullMessage);
    }

    /**
     * Add log without emitting
     */
    addLog(message) {
        const timestamp = this.getTimestamp();
        const fullMessage = `${timestamp} ${message}`;

        this.logs.push({
            timestamp: new Date().toISOString(),
            message: fullMessage
        });

        console.log(fullMessage);
    }

    /**
     * Check scraper state (pause/cancel)
     */
    async checkState() {
        if (this.isCancelled) {
            throw new Error('Scraping cancelado pelo usuário');
        }

        while (this.isPaused) {
            await this.sleep(1000);
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
        this.emitProgress('Scraping pausado');
    }

    /**
     * Resume scraping
     */
    resume() {
        this.isPaused = false;
        this.status = 'running';
        this.emitProgress('Scraping retomado');
    }

    /**
     * Cancel scraping
     */
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

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Adaptive delay between requests
     */
    async adaptiveDelay() {
        const jitter = Math.random() * 1000;
        await this.sleep(this.currentDelay + jitter);
    }

    /**
     * Capture screenshot and emit via Socket.io
     */
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
            const filename = `${this.type}_${this.id}_live_${source}.png`;

            // Capture as base64 buffer directly (no disk I/O)
            const screenshotBuffer = await pageToCapture.screenshot({ 
                type: 'png', 
                encoding: 'base64' 
            });
            
            const base64Image = `data:image/png;base64,${screenshotBuffer}`;

            // Emit to frontend
            if (this.io) {
                this.io.emit('scraper-screenshot', {
                    id: this.id,
                    action: actionName,
                    timestamp: timestamp,
                    image: base64Image,
                    source: source,
                    url: `/results/${filename}?t=${timestamp}`
                });
            }

            this.lastScreenshotTime = timestamp;
            if (source === 'main') {
                this.screenshotPath = filename;
            }

        } catch (e) {
            // Silently fail - screenshot is optional
        }
    }

    /**
     * Initialize proxy manager
     */
    async initializeProxy(useProxy = true) {
        this.proxyManager = new ProxyManager((msg) => this.emitProgress(msg));

        if (!useProxy) {
            this.emitProgress(`🚀 Modo SEM PROXY selecionado. Usando rate limiting.`);
            this.currentProxy = null;
            this.usingProxy = false;
            this.currentDelay = this.maxDelay === 72000 ? 3000 : (this.maxDelay === 90000 ? 5000 : 6000);
        } else {
            this.currentProxy = await this.proxyManager.getNextProxy(true);

            if (this.currentProxy === null) {
                this.emitProgress('⚠️ Nenhum proxy disponível. Usando rate limiting.');
                this.usingProxy = false;
                this.currentDelay = this.maxDelay === 72000 ? 3000 : (this.maxDelay === 90000 ? 5000 : 6000);
            } else {
                this.usingProxy = true;
                this.currentDelay = this.minDelay;
            }
        }
    }

    /**
     * Initialize browser with retry logic
     */
    async initializeBrowser(maxAttempts = 5) {
        let initAttempts = 0;
        let initSuccess = false;

        while (initAttempts < maxAttempts && !initSuccess) {
            try {
                this.browserManager = new BrowserManager();
                const page = await this.browserManager.initialize(this.currentProxy);
                initSuccess = true;
                return page;

            } catch (error) {
                initAttempts++;

                if (error.message && error.message.includes('TUNNEL_FAILED')) {
                    this.emitProgress(`❌ Túnel falhou. Tentando próximo proxy... (${initAttempts}/${maxAttempts})`);

                    if (this.currentProxy) {
                        this.proxyManager.markProxyAsFailed(this.currentProxy);
                    }

                    await this.browserManager?.close?.().catch(() => {});

                    this.currentProxy = await this.proxyManager.getNextProxy(true);

                    if (this.currentProxy === null) {
                        this.emitProgress('⚠️ Sem mais proxies. Tentando modo SEM PROXY...');
                        this.usingProxy = false;
                        this.currentDelay = this.maxDelay === 72000 ? 3000 : (this.maxDelay === 90000 ? 5000 : 6000);
                    }

                    continue;
                }

                if (initAttempts >= maxAttempts) {
                    throw error;
                }
            }
        }

        // Fallback to no proxy
        if (!initSuccess) {
            this.emitProgress('⚠️ Falha em todas as tentativas. Iniciando sem proxy...');
            this.currentProxy = null;
            this.usingProxy = false;
            this.currentDelay = this.maxDelay === 72000 ? 3000 : (this.maxDelay === 90000 ? 5000 : 6000);

            this.browserManager = new BrowserManager();
            return await this.browserManager.initialize(null);
        }
    }

    /**
     * Setup worker page for parallel processing
     */
    async setupWorkerPage() {
        try {
            this.page2 = await this.browserManager.browser.newPage();
            await this.page2.setViewport({ width: 1366, height: 768 });
            this.emitProgress('✅ Worker Page inicializada para processamento paralelo');
            return true;
        } catch (e) {
            this.emitProgress('⚠️ Falha ao iniciar Worker Page, continuando em modo single-thread: ' + e.message);
            return false;
        }
    }

    /**
     * Rotate to next available proxy
     */
    async rotateProxy() {
        this.emitProgress('🔄 Rotacionando proxy...');

        if (this.currentProxy) {
            this.proxyManager.markProxyAsFailed(this.currentProxy);
        }

        await this.browserManager?.close?.().catch(() => {});

        const maxRetries = 10;
        let retryCount = 0;
        let success = false;

        while (!success && retryCount < maxRetries) {
            retryCount++;

            this.currentProxy = await this.proxyManager.getNextProxy(true);

            if (this.currentProxy === null) {
                this.emitProgress('⚠️ Sem mais proxies disponíveis. Tentando modo SEM PROXY...');
                this.usingProxy = false;
                this.currentDelay = this.maxDelay === 72000 ? 3000 : (this.maxDelay === 90000 ? 5000 : 6000);
            } else {
                this.usingProxy = true;
                this.currentDelay = this.minDelay;
            }

            try {
                this.browserManager = new BrowserManager();
                const page = await this.browserManager.initialize(this.currentProxy);
                
                this.consecutiveErrors = 0;
                this.emitProgress('✅ Proxy trocado com sucesso');
                success = true;
                return page;

            } catch (initError) {
                const errorMsg = initError.message || '';
                this.emitProgress(`⚠️ Erro ao trocar proxy: ${errorMsg.split('\n')[0]}`);

                if (this.currentProxy) {
                    this.proxyManager.markProxyAsFailed(this.currentProxy);
                }

                await this.browserManager?.close?.().catch(() => {});

                if (!this.usingProxy) {
                    throw new Error('Falha ao inicializar browser mesmo sem proxy');
                }
            }
        }

        if (!success) {
            throw new Error('Falha ao trocar proxy após múltiplas tentativas');
        }
    }

    /**
     * Check if error is a connection/proxy error
     */
    isProxyError(error) {
        const errorMessage = error.message || '';
        const proxyErrors = [
            'ERR_TUNNEL_CONNECTION_FAILED',
            'TUNNEL_FAILED',
            'ERR_PROXY_CONNECTION_FAILED',
            'ERR_CONNECTION_CLOSED',
            'ERR_CONNECTION_REFUSED',
            'ERR_CONNECTION_RESET',
            'ERR_TIMED_OUT',
            'ERR_NAME_NOT_RESOLVED',
            'net::ERR_',
            'Requesting main frame too early',
            'Target closed',
            'Session closed',
            'Protocol error'
        ];
        
        return proxyErrors.some(err => errorMessage.includes(err));
    }

    /**
     * Wait for queue to empty
     */
    async waitForQueueEmpty(targetCount = null) {
        const target = targetCount || this.progress.total;
        
        while (this.queue.length > 0 && this.progress.successCount < target && !this.isCancelled) {
            await this.sleep(2000);
        }
    }

    /**
     * Stop queue processing
     */
    async stopQueue() {
        this.isProcessingQueue = false;
        if (this.processQueuePromise) {
            await this.processQueuePromise;
        }
    }

    /**
     * Safe socket event listener with auto-cleanup
     */
    onSocket(event, handler, timeout = null) {
        // Remove existing listener for this event on this scraper
        this.io.off(event, handler);
        
        // Add new listener
        this.io.on(event, handler);
        
        // Track for cleanup
        this.activeListeners.push({ event, handler });
        
        // Auto-cleanup after timeout if provided
        if (timeout) {
            setTimeout(() => {
                this.offSocket(event, handler);
            }, timeout);
        }
        
        return handler;
    }

    /**
     * Remove socket listener
     */
    offSocket(event, handler) {
        this.io.off(event, handler);
        this.activeListeners = this.activeListeners.filter(
            l => l.event !== event || l.handler !== handler
        );
    }

    /**
     * Cleanup all socket listeners
     */
    cleanupListeners() {
        for (const { event, handler } of this.activeListeners) {
            this.io.off(event, handler);
        }
        this.activeListeners = [];
    }

    /**
     * Escape CSV value
     */
    escapeCsv(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes(';') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    /**
     * Save results to CSV and JSON
     */
    async saveResults(filename = null) {
        if (this.results.length === 0) {
            return null;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFilename = filename || `${this.type}_${this.id}_results_${timestamp}`;
        const resultsDir = path.join(__dirname, '..', '..', 'results');

        await fs.mkdir(resultsDir, { recursive: true });

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
        await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2));

        return jsonPath;
    }

    /**
     * Close browser and cleanup
     */
    async close() {
        try {
            // Stop queue processing
            this.isProcessingQueue = false;
            
            // Close worker page first
            if (this.page2 && !this.page2.isClosed()) {
                await this.page2.close().catch(() => {});
            }
            
            // Close browser
            if (this.browserManager) {
                await this.browserManager.close();
            }
            
            // Cleanup socket listeners
            this.cleanupListeners();
            
        } catch (error) {
            console.warn(`[${this.type}Scraper ${this.id}] Erro ao fechar browser:`, error.message);
        } finally {
            this.page2 = null;
            this.browserManager = null;
            this.status = 'closed';
        }
    }

    /**
     * Abstract method - must be implemented by subclasses
     */
    async initialize(useProxy = true) {
        throw new Error('initialize() must be implemented by subclass');
    }

    /**
     * Abstract method - must be implemented by subclasses
     */
    async scrape(...args) {
        throw new Error('scrape() must be implemented by subclass');
    }
}

module.exports = BaseScraper;
