const https = require('https');
const http = require('http');

class ProxyManager {
    constructor(logCallback = null) {
        this.proxies = [];
        this.currentIndex = 0;
        this.failedProxies = new Set();
        this.isRefreshing = false;
        this.logCallback = logCallback;
    }

    log(message) {
        console.log(message);
        if (this.logCallback) {
            this.logCallback(message);
        }
    }

    async fetchProxyScrape() {
        this.log('📡 Buscando proxies do ProxyScrape...');

        return new Promise((resolve) => {
            const url = 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=br&proxy_format=protocolipport&format=json&timeout=20000&limit=50';

            const req = https.get(url, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const lines = data.trim().split('\n');
                        const proxies = lines
                            .map(line => line.trim())
                            .filter(line => line.length > 0 && line.startsWith('http://'))
                            .map(proxy => ({
                                url: proxy,
                                source: 'proxyscrape',
                                score: 80, // HTTP proxies get higher base score
                                upTime: 50,
                                speed: 2
                            }));

                        this.log(`✅ ProxyScrape: ${proxies.length} proxies HTTP encontrados`);
                        resolve(proxies);
                    } catch (error) {
                        this.log(`❌ Erro ao processar ProxyScrape: ${error.message}`);
                        resolve([]);
                    }
                });
            });

            req.on('error', (error) => {
                this.log(`❌ Erro ao buscar ProxyScrape: ${error.message || 'Erro de rede'}`);
                resolve([]);
            });

            req.on('timeout', () => {
                req.destroy();
                this.log(`❌ ProxyScrape timeout`);
                resolve([]);
            });

            req.setTimeout(5000); // 5 second timeout
        });
    }

    async fetchLitport() {
        this.log('📡 Buscando proxies do Litport...');

        return new Promise((resolve) => {
            const url = 'https://litport.net/api/free-proxy?country=br&uptimeRating=75&limit=50&sortBy=pingAt_asc&page=1&format=json';

            const req = https.get(url, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);

                        if (Array.isArray(response) && response.length > 0) {
                            const proxies = response.map(p => {
                                const protocol = p.protocol || 'http';

                                // Calculate score based on quality metrics
                                let score = 0;
                                score += (p.uptimeRating || 50);
                                score += (100 - (p.responseTimeRating || 50)); // Lower response time is better

                                // BIG bonus for HTTP proxies (much more stable)
                                if (protocol === 'http' || protocol === 'https') {
                                    score += 40;
                                }

                                return {
                                    url: `${protocol}://${p.host}:${p.port}`,
                                    source: 'litport',
                                    score: Math.max(0, score),
                                    upTime: p.uptimeRating || 0,
                                    responseTime: p.responseTimeMs || 999,
                                    anonymity: p.anonymityLevel || 'unknown'
                                };
                            });

                            const httpCount = proxies.filter(p => p.url.startsWith('http')).length;
                            const socksCount = proxies.length - httpCount;

                            this.log(`✅ Litport: ${proxies.length} proxies (${httpCount} HTTP, ${socksCount} SOCKS)`);
                            resolve(proxies);
                        } else {
                            this.log('⚠️ Litport: nenhum proxy retornado');
                            resolve([]);
                        }
                    } catch (error) {
                        this.log(`⚠️ Erro ao parsear Litport: ${error.message}`);
                        resolve([]);
                    }
                });
            });

            req.on('error', (error) => {
                this.log(`⚠️ Erro ao buscar Litport: ${error.message}`);
                resolve([]);
            });

            req.on('timeout', () => {
                req.destroy();
                this.log(`❌ Litport timeout`);
                resolve([]);
            });

            req.setTimeout(5000);
        });
    }

    async fetchGeonode() {
        this.log('📡 Buscando proxies do Geonode...');

        return new Promise((resolve) => {
            const url = 'https://proxylist.geonode.com/api/proxy-list?country=BR&filterUpTime=90&filterLastChecked=30&speed=fast&limit=50&page=1&sort_by=lastChecked&sort_type=desc';

            const req = https.get(url, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);

                        if (response.data && Array.isArray(response.data)) {
                            const proxies = response.data.map(p => {
                                const protocol = p.protocols && p.protocols.length > 0 ? p.protocols[0] : 'http';

                                let score = 0;
                                score += (p.upTime || 50);
                                score += (p.speed || 1) * 10;
                                score -= (p.latency || 1000) / 10;

                                // BIG bonus for HTTP (more stable than SOCKS)
                                if (protocol === 'http' || protocol === 'https') {
                                    score += 40;
                                }

                                return {
                                    url: `${protocol}://${p.ip}:${p.port}`,
                                    source: 'geonode',
                                    score: Math.max(0, score),
                                    upTime: p.upTime || 0,
                                    speed: p.speed || 1,
                                    latency: p.latency || 999
                                };
                            });

                            this.log(`✅ Geonode: ${proxies.length} proxies encontrados (HTTP/SOCKS)`);
                            resolve(proxies);
                        } else {
                            this.log('⚠️ Geonode: nenhum proxy retornado');
                            resolve([]);
                        }
                    } catch (error) {
                        this.log(`⚠️ Erro ao parsear Geonode: ${error.message}`);
                        resolve([]);
                    }
                });
            });

            req.on('error', (error) => {
                this.log(`⚠️ Erro ao buscar Geonode: ${error.message}`);
                resolve([]);
            });

            req.setTimeout(5000);
        });
    }

    async fetchProxies() {
        this.log('🔍 Iniciando busca de proxies...');

        try {
            const [proxyscrape, litport, geonode] = await Promise.all([
                this.fetchProxyScrape().catch(() => []),
                this.fetchLitport().catch(() => []),
                this.fetchGeonode().catch(() => [])
            ]);

            const allProxies = [...proxyscrape, ...litport, ...geonode];

            if (allProxies.length === 0) {
                this.log('⚠️ Nenhum provedor retornou proxies.');
                return [];
            }

            // Sort by score (higher = better, HTTP will be first)
            allProxies.sort((a, b) => b.score - a.score);

            this.proxies = allProxies.map(p => p.url);

            // FIX: Use allProxies instead of this.proxies to access .url
            const httpCount = allProxies.filter(p => p.url.startsWith('http')).length;
            const socksCount = allProxies.length - httpCount;

            this.log(`✅ Total: ${allProxies.length} proxies (${httpCount} HTTP, ${socksCount} SOCKS)`);
            this.log(`🏆 Top 3: ${this.proxies.slice(0, 3).join(', ')}`);

            this.currentIndex = 0;
            this.failedProxies.clear();
            return this.proxies;
        } catch (error) {
            this.log(`❌ Erro crítico: ${error.message}`);
            return [];
        }
    }

    async testProxy(proxyUrl) {
        return new Promise((resolve) => {
            const proxyMatch = proxyUrl.match(/(https?|socks[45]):\/\/([^:]+):(\d+)/);
            if (!proxyMatch) {
                resolve(false);
                return;
            }

            const protocol = proxyMatch[1];
            const proxyHost = proxyMatch[2];
            const proxyPort = parseInt(proxyMatch[3]);

            // Test SOCKS proxies via TCP socket
            if (protocol === 'socks4' || protocol === 'socks5') {
                const net = require('net');
                const socket = new net.Socket();

                socket.setTimeout(3000);

                socket.on('connect', () => {
                    socket.destroy();
                    resolve(true);
                });

                socket.on('timeout', () => {
                    socket.destroy();
                    resolve(false);
                });

                socket.on('error', () => {
                    socket.destroy();
                    resolve(false);
                });

                socket.connect(proxyPort, proxyHost);
                return;
            }

            // Test HTTP proxies via CONNECT
            const options = {
                host: proxyHost,
                port: proxyPort,
                method: 'CONNECT',
                path: 'www.doctoralia.com.br:443',
                timeout: 3000
            };

            const req = http.request(options);

            req.on('connect', (res, socket) => {
                socket.end();
                resolve(true);
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.on('error', () => {
                resolve(false);
            });

            req.end();
        });
    }

    async getNextProxy(allowNoProxy = false) {
        if (this.proxies.length === 0) {
            await this.refreshProxies().catch(err => {
                this.log(`⚠️ Erro ao buscar proxies: ${err.message}`);
            });
        }

        // If still no proxies and allowNoProxy is true, return null (no proxy mode)
        if (this.proxies.length === 0 && allowNoProxy) {
            this.log('⚠️ Nenhum proxy disponível. Modo SEM PROXY ativado.');
            return null;
        }

        let attempts = 0;
        const maxAttempts = Math.min(15, this.proxies.length);

        while (attempts < maxAttempts) {
            const proxy = this.proxies[this.currentIndex];

            if (!this.failedProxies.has(proxy)) {
                this.log(`🔍 Testando proxy ${attempts + 1}/${maxAttempts}: ${proxy}`);

                const isWorking = await this.testProxy(proxy);

                if (isWorking) {
                    const ipMatch = proxy.match(/\/\/([^:]+):/);
                    const proxyIP = ipMatch ? ipMatch[1] : proxy;

                    this.log(`✅ Proxy conectado com sucesso! IP: ${proxyIP}`);
                    this.log(`🌐 Usando proxy: ${proxy}`);
                    return proxy;
                } else {
                    this.log(`❌ Proxy falhou no teste: ${proxy}`);
                    this.markProxyAsFailed(proxy);
                }
            }

            this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
            attempts++;
        }

        // All proxies failed
        if (allowNoProxy) {
            this.log('⚠️ Todos os proxies falharam. Modo SEM PROXY ativado.');
            return null;
        }

        const error = new Error('❌ Nenhum proxy funcional.');
        this.log(error.message);
        throw error;
    }

    markProxyAsFailed(proxyUrl) {
        this.failedProxies.add(proxyUrl);
        this.log(`⛔ Proxy marcado como falho: ${proxyUrl} (${this.failedProxies.size}/${this.proxies.length})`);
    }

    async refreshProxies() {
        if (this.isRefreshing) {
            this.log('⏳ Aguardando refresh...');
            while (this.isRefreshing) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            return;
        }

        this.isRefreshing = true;

        try {
            await this.fetchProxies();
        } catch (error) {
            this.log(`❌ Erro ao atualizar proxies: ${error.message}`);
        } finally {
            this.isRefreshing = false;
        }
    }

    getProxyCount() {
        return {
            total: this.proxies.length,
            failed: this.failedProxies.size,
            available: this.proxies.length - this.failedProxies.size
        };
    }
}

module.exports = ProxyManager;
