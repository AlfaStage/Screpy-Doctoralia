const { randomDelay, scrollPage } = require('./utils');

class ProfileExtractor {
    constructor(page) {
        this.page = page;
    }

    async extractProfile(url, progressCallback) {
        const startTime = Date.now();
        console.log(`Extracting profile: ${url}`);
        if (progressCallback) progressCallback({ status: 'extracting', message: `Acessando perfil: ${url}` });

        // Timeout promise
        const timeout = new Promise((_, reject) =>
            setTimeout(() => {
                const error = new Error('Timeout de extração (10s)');
                error.type = 'TIMEOUT';
                reject(error);
            }, 10000)
        );

        try {
            // Race between extraction and timeout
            const profileData = await Promise.race([
                this._performExtraction(url, progressCallback),
                timeout
            ]);

            const duration = (Date.now() - startTime) / 1000;
            console.log(`Extracted: ${profileData.nome} in ${duration}s`);

            if (progressCallback) {
                progressCallback({
                    status: 'extracting',
                    message: `Extraído: ${profileData.nome} (${duration.toFixed(1)}s)`
                });
            }

            return profileData;

        } catch (error) {
            // Detect error type
            let errorType = 'UNKNOWN';
            let errorMessage = error.message;

            if (error.type === 'TIMEOUT' || error.message.includes('Timeout')) {
                errorType = 'TIMEOUT';
                errorMessage = 'Timeout na extração do perfil';
            } else if (error.message.includes('ERR_PROXY') || error.message.includes('ECONNREFUSED')) {
                errorType = 'PROXY_ERROR';
                errorMessage = 'Erro de conexão com proxy';
            } else if (error.message.includes('blocked') || error.message.includes('403') || error.message.includes('429')) {
                errorType = 'BLOCKED';
                errorMessage = 'Página bloqueada ou CAPTCHA detectado';
            } else if (error.message.includes('net::ERR')) {
                errorType = 'NETWORK_ERROR';
                errorMessage = 'Erro de rede';
            }

            console.error(`❌ Erro [${errorType}] ao extrair ${url}: ${errorMessage}`);

            // Throw error with type for upper layer to handle
            const enrichedError = new Error(errorMessage);
            enrichedError.type = errorType;
            enrichedError.url = url;
            throw enrichedError;
        }
    }

    async _performExtraction(url, progressCallback) {
        // Optimized navigation
        await this.page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 10000 // Match the global timeout
        });

        // Minimal delay
        await randomDelay(500, 1500);

        // Fast scroll
        await scrollPage(this.page);

        if (progressCallback) progressCallback({ status: 'extracting', message: `Extraindo dados...` });

        // Try to click "Show phone" buttons (fast attempt)
        try {
            await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const targetButtons = buttons.filter(btn =>
                    btn.textContent.includes('Ver telefone') ||
                    btn.textContent.includes('Mostrar telefone') ||
                    btn.classList.contains('show-phone-button')
                );
                if (targetButtons.length > 0) targetButtons[0].click();
            });
            await new Promise(r => setTimeout(r, 500));
        } catch (e) { /* Ignore click errors */ }

        // Extract data
        const profileData = await this.page.evaluate(() => {
            const data = {
                nome: '',
                especialidades: [],
                numeroFixo: '',
                numeroMovel: '',
                enderecos: []
            };

            const getText = (s) => {
                const el = document.querySelector(s);
                return el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
            };

            const getList = (s) => {
                return Array.from(document.querySelectorAll(s))
                    .map(el => el.textContent.trim())
                    .filter(t => t.length > 0);
            };

            // Name
            data.nome = getText('h1[data-test-id="doctor-name"]') ||
                getText('h1.doctor-name') ||
                getText('[itemprop="name"]') ||
                'Nome não encontrado';

            // Specialties
            const specs = getList('a[href*="/especializacoes-medicas/"]');
            data.especialidades = [...new Set(specs.filter(s => s.length > 3))];

            // Addresses
            const addrs = getList('.address-card span.text-body');
            data.enderecos = [...new Set(addrs)];

            // Phones
            const phones = [];
            document.querySelectorAll('a[href^="tel:"], .phone-number').forEach(el => {
                let p = el.textContent.trim();
                if (el.href && el.href.startsWith('tel:')) p = el.href.replace('tel:', '');
                if (p) phones.push(p);
            });

            phones.forEach(phone => {
                const digits = phone.replace(/\D/g, '');
                if (digits.length >= 10) {
                    if ((digits.charAt(2) === '9' || digits.charAt(3) === '9') && !data.numeroMovel) {
                        data.numeroMovel = phone;
                    } else if (!data.numeroFixo) {
                        data.numeroFixo = phone;
                    }
                }
            });

            return data;
        });

        // Fallback: Parse URL for missing data
        // URL format: https://www.doctoralia.com.br/NAME/SPECIALTY/CITY
        try {
            const urlParts = url.split('/');
            if (urlParts.length >= 6) {
                // urlParts[3] is name, urlParts[4] is specialty, urlParts[5] is city

                if (!profileData.especialidades || profileData.especialidades.length === 0) {
                    const specialtyFromUrl = urlParts[4].replace(/-/g, ' ');
                    // Capitalize words
                    const formattedSpecialty = specialtyFromUrl.replace(/\b\w/g, l => l.toUpperCase());
                    profileData.especialidades = [formattedSpecialty];
                }

                if (!profileData.enderecos || profileData.enderecos.length === 0) {
                    const cityFromUrl = urlParts[5].replace(/-/g, ' ');
                    const formattedCity = cityFromUrl.replace(/\b\w/g, l => l.toUpperCase());
                    profileData.enderecos = [formattedCity];
                }
            }
        } catch (e) {
            console.log('Error parsing URL for fallback data:', e.message);
        }

        return profileData;
    }

    /**
     * Check if profile has phone number
     */
    hasPhoneNumber(profileData) {
        return !!(profileData.numeroFixo || profileData.numeroMovel);
    }
}

module.exports = ProfileExtractor;
