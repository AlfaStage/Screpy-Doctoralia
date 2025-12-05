const https = require('https');
const http = require('http');
const { URL } = require('url');

class WebhookService {
    constructor() {
        this.maxRetries = 3;
        this.retryDelayMs = 1000;
    }

    /**
     * Send webhook notification
     * @param {string} webhookUrl - URL to send the webhook to
     * @param {object} data - Data to send
     * @param {boolean} includeLogs - Whether to include logs in the payload
     * @returns {Promise<boolean>} - True if successful
     */
    async send(webhookUrl, data, includeLogs = false) {
        if (!webhookUrl) {
            return false;
        }

        const payload = this.buildPayload(data, includeLogs);

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                await this.sendRequest(webhookUrl, payload);
                console.log(`✅ Webhook enviado com sucesso para ${webhookUrl}`);
                return true;
            } catch (error) {
                console.warn(`⚠️ Webhook falhou (tentativa ${attempt}/${this.maxRetries}):`, error.message);

                if (attempt < this.maxRetries) {
                    const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
                    await this.sleep(delay);
                }
            }
        }

        console.error(`❌ Webhook falhou após ${this.maxRetries} tentativas`);
        return false;
    }

    buildPayload(data, includeLogs) {
        const payload = {
            id: data.id,
            status: data.status,
            config: data.config || {},
            metadata: data.metadata || {
                startTime: data.startTime,
                endTime: new Date().toISOString(),
                totalResults: data.results?.length || 0
            },
            csvUrl: data.csvUrl || null,
            results: data.results || []
        };

        if (includeLogs && data.logs) {
            payload.logs = data.logs;
        }

        return payload;
    }

    sendRequest(webhookUrl, payload) {
        return new Promise((resolve, reject) => {
            try {
                const url = new URL(webhookUrl);
                const isHttps = url.protocol === 'https:';
                const lib = isHttps ? https : http;

                const postData = JSON.stringify(payload);

                const options = {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                        'User-Agent': 'DoctoraliaScraper/1.0'
                    },
                    timeout: 30000
                };

                const req = lib.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(data);
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                        }
                    });
                });

                req.on('error', reject);
                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                });

                req.write(postData);
                req.end();
            } catch (error) {
                reject(error);
            }
        });
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new WebhookService();
