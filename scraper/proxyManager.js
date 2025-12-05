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
                        const response = JSON.parse(data);

                        // ProxyScrape v4 API returns {proxies: [{proxy: "protocol://ip:port", ...}, ...]}
                        if (!response.proxies || !Array.isArray(response.proxies)) {
                            this.log('⚠️ ProxyScrape: formato de resposta inválido');
                            resolve([]);
                            return;
                        }

                        const proxies = response.proxies
                            .filter(p => p.proxy && (p.proxy.startsWith('http://') || p.proxy.startsWith('https://')))
                            .map(p => ({
                                url: p.proxy,
                                source: 'proxyscrape',
                                score: 80, // HTTP proxies get higher base score
                                upTime: p.uptime || 50,
                                speed: p.speed || 2
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

            req.setTimeout(5000);
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

                                let score = 0;
                                score += (p.uptimeRating || 50);
                                score += (100 - (p.responseTimeRating || 50));

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

    async fetch911Proxy() {
        this.log('📡 Buscando proxies do 911Proxy...');

        return new Promise((resolve) => {
            const url = 'https://www.911proxy.com/web_v1/free-proxy/list?page_size=60&page=1&country_code=BR';

            const req = https.get(url, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);

                        if (response.code === 200 && response.data && Array.isArray(response.data.list)) {
                            const proxies = response.data.list
                                .filter(p => p.status === 1) // Apenas proxies ativos
                                .map(p => {
                                    // protocol: 2 = HTTP, 4 = SOCKS4, 5 = SOCKS5
                                    let protocol = 'http';
                                    if (p.protocol === 4) protocol = 'socks4';
                                    else if (p.protocol === 5) protocol = 'socks5';

                                    let score = 0;
                                    score += (p.uptime || 50);
                                    score += (100 - (p.latency || 50));
                                    if (protocol === 'http') score += 40;

                                    return {
                                        url: `${protocol}://${p.ip}:${p.port}`,
                                        source: '911proxy',
                                        score: Math.max(0, score),
                                        upTime: p.uptime || 0,
                                        latency: p.latency || 999
                                    };
                                });

                            this.log(`✅ 911Proxy: ${proxies.length} proxies encontrados`);
                            resolve(proxies);
                        } else {
                            this.log('⚠️ 911Proxy: nenhum proxy retornado');
                            resolve([]);
                        }
                    } catch (error) {
                        this.log(`⚠️ Erro ao parsear 911Proxy: ${error.message}`);
                        resolve([]);
                    }
                });
            });

            req.on('error', (error) => {
                this.log(`⚠️ Erro ao buscar 911Proxy: ${error.message}`);
                resolve([]);
            });

            req.setTimeout(5000);
        });
    }

    async fetchBrightData() {
        // Verificar se credenciais do BrightData estão configuradas
        const host = process.env.BRIGHTDATA_HOST;
        const port = process.env.BRIGHTDATA_PORT;
        const username = process.env.BRIGHTDATA_USERNAME;
        const password = process.env.BRIGHTDATA_PASSWORD;

        if (!host || !port || !username || !password) {
            // BrightData não configurado, pular silenciosamente
            return [];
        }

        this.log('📡 Testando proxy BrightData...');

        return new Promise((resolve) => {
            const { exec } = require('child_process');
            const proxyUrl = `http://${username}-country-br:${password}@${host}:${port}`;

            // Testar se o proxy funciona
            const testCmd = `curl --proxy ${host}:${port} --proxy-user ${username}-country-br:${password} "https://geo.brdtest.com/mygeo.json" --max-time 10`;

            exec(testCmd, (error, stdout, stderr) => {
                if (error) {
                    this.log(`⚠️ BrightData: falha no teste - ${error.message}`);
                    resolve([]);
                    return;
                }

                try {
                    const geoData = JSON.parse(stdout);
                    if (geoData.country === 'BR') {
                        this.log(`✅ BrightData: proxy BR funcionando! IP: ${geoData.ip} (${geoData.country})`);
                        resolve([{
                            url: proxyUrl,
                            source: 'brightdata',
                            score: -10, // Última prioridade - usar apenas se todos gratuitos falharem
                            upTime: 99,
                            latency: 50
                        }]);
                    } else {
                        this.log(`⚠️ BrightData: resposta inválida`);
                        resolve([]);
                    }
                } catch (e) {
                    this.log(`⚠️ BrightData: erro ao parsear resposta - ${e.message}`);
                    resolve([]);
                }
            });
        });
    }

    async fetchProxies() {
        this.log('🔍 Iniciando busca de proxies...');

        try {
            const [brightdata, proxyscrape, litport, geonode, proxy911] = await Promise.all([
                this.fetchBrightData().catch(() => []),
                this.fetchProxyScrape().catch(() => []),
                this.fetchLitport().catch(() => []),
                this.fetchGeonode().catch(() => []),
                this.fetch911Proxy().catch(() => [])
            ]);

            const allProxies = [...brightdata, ...proxyscrape, ...litport, ...geonode, ...proxy911];

            if (allProxies.length === 0) {
                this.log('⚠️ Nenhum provedor retornou proxies.');
                return [];
            }

            // Sort by score (higher = better, HTTP will be first)
            allProxies.sort((a, b) => b.score - a.score);

            // Guardar objetos com url e source
            this.proxyData = allProxies;
            this.proxies = allProxies.map(p => p.url);

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
        // Simple fast TCP test - just check if proxy is reachable
        // We test quickly and fall back to no-proxy mode if it fails in browser
        return new Promise((resolve) => {
            const proxyMatch = proxyUrl.match(/(https?|socks[45]):\/\/([^:]+):(\d+)/);
            if (!proxyMatch) {
                resolve(false);
                return;
            }

            const proxyHost = proxyMatch[2];
            const proxyPort = parseInt(proxyMatch[3]);

            const net = require('net');
            const socket = new net.Socket();

            // Fast timeout - if proxy doesn't respond in 2s, skip it
            socket.setTimeout(2000);

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
        });
    }

    async getNextProxy(allowNoProxy = false) {
        if (this.proxies.length === 0) {
            await this.refreshProxies().catch(err => {
                this.log(`⚠️ Erro ao buscar proxies: ${err.message}`);
            });
        }

        // If still no proxies, return null (no proxy mode)
        if (this.proxies.length === 0) {
            this.log('⚠️ Nenhum proxy disponível. Modo SEM PROXY ativado.');
            return null;
        }

        // Contar proxies gratuitos não testados/falhos
        const freeProxies = this.proxyData ? this.proxyData.filter(p => p.source !== 'brightdata') : [];
        const untested = freeProxies.filter(p => !this.failedProxies.has(p.url));

        this.log(`📊 Proxies: ${untested.length} gratuitos disponíveis de ${freeProxies.length} total`);

        // Testar TODOS os proxies gratuitos disponíveis
        let attempts = 0;
        const totalFreeProxies = freeProxies.length;

        while (attempts < totalFreeProxies) {
            const proxy = this.proxies[this.currentIndex];
            const proxyInfo = this.proxyData ? this.proxyData.find(p => p.url === proxy) : null;
            const source = proxyInfo ? proxyInfo.source : 'unknown';

            // Pular BrightData nesta fase (será testado depois)
            if (source === 'brightdata') {
                this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
                continue;
            }

            if (!this.failedProxies.has(proxy)) {
                this.log(`🔍 Testando proxy gratuito ${attempts + 1}/${totalFreeProxies}: ${proxy} (${source})`);

                const isWorking = await this.testProxy(proxy);

                if (isWorking) {
                    const ipMatch = proxy.match(/\/\/([^:]+):/);
                    const proxyIP = ipMatch ? ipMatch[1] : proxy;

                    this.log(`✅ Proxy conectado! IP: ${proxyIP} (${source})`);
                    this.log(`🌐 Usando proxy: ${proxy} (${source})`);
                    return proxy;
                } else {
                    this.log(`❌ Proxy falhou: ${proxy} (${source})`);
                    this.markProxyAsFailed(proxy);
                }
            }

            this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
            attempts++;
        }

        // Todos os proxies gratuitos falharam - tentar BrightData se configurado
        const brightdataProxy = this.proxyData ? this.proxyData.find(p => p.source === 'brightdata') : null;
        if (brightdataProxy && !this.failedProxies.has(brightdataProxy.url)) {
            this.log('💰 Todos proxies gratuitos falharam. Tentando BrightData (pago)...');
            return brightdataProxy.url;
        }

        // Fallback para modo sem proxy
        this.log('⚠️ Todos os proxies falharam. Modo SEM PROXY ativado.');
        return null;
    }

    // Método para resetar proxies falhos (para tentar novamente após erros no modo sem proxy)
    resetFailedProxies() {
        const count = this.failedProxies.size;
        this.failedProxies.clear();
        this.currentIndex = 0;
        this.log(`🔄 ${count} proxies resetados para nova tentativa`);
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
