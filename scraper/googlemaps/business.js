const { randomDelay, scrollPage } = require('../utils');

class BusinessExtractor {
    constructor(page) {
        this.page = page;
    }

    async extractBusiness(business, progressCallback) {
        const startTime = Date.now();
        console.log(`Extracting business: ${business.ariaLabel || business.url}`);

        if (progressCallback) {
            progressCallback({
                status: 'extracting',
                message: `📍 Acessando: ${business.ariaLabel || 'estabelecimento'}`
            });
        }

        // Timeout promise
        const timeout = new Promise((_, reject) =>
            setTimeout(() => {
                const error = new Error('Timeout de extração (30s)');
                error.type = 'TIMEOUT';
                reject(error);
            }, 30000)
        );

        try {
            const businessData = await Promise.race([
                this._performExtraction(business, progressCallback),
                timeout
            ]);

            const duration = (Date.now() - startTime) / 1000;
            console.log(`Extracted: ${businessData.nome} in ${duration}s`);

            return businessData;

        } catch (error) {
            let errorType = 'UNKNOWN';
            let errorMessage = error.message;

            if (error.type === 'TIMEOUT' || error.message.includes('Timeout')) {
                errorType = 'TIMEOUT';
            } else if (error.message.includes('ERR_PROXY') || error.message.includes('ECONNREFUSED')) {
                errorType = 'PROXY_ERROR';
            } else if (error.message.includes('net::ERR')) {
                errorType = 'NETWORK_ERROR';
            }

            console.error(`❌ Erro [${errorType}] ao extrair: ${errorMessage}`);

            const enrichedError = new Error(errorMessage);
            enrichedError.type = errorType;
            throw enrichedError;
        }
    }

    async _performExtraction(business, progressCallback) {
        // Navigate to business page
        if (business.url) {
            await this.page.goto(business.url, {
                waitUntil: 'domcontentloaded',
                timeout: 25000
            });
        }

        await randomDelay(2000, 4000);

        // Wait for main content to load
        await this.page.waitForSelector('h1, [role="main"]', { timeout: 15000 }).catch(() => { });

        // Scroll to load more content
        await this.page.evaluate(() => {
            window.scrollBy(0, 300);
        });
        await randomDelay(1000, 2000);

        // Extract all business data
        const businessData = await this.page.evaluate(() => {
            const data = {
                nome: '',
                categoria: '',
                endereco: '',
                telefone: '',
                website: '',
                email: '',
                instagram: '',
                cnpj: ''
            };

            // Helper function to get text
            const getText = (selectors) => {
                if (typeof selectors === 'string') {
                    selectors = [selectors];
                }
                for (const selector of selectors) {
                    const el = document.querySelector(selector);
                    if (el && el.textContent) {
                        return el.textContent.trim();
                    }
                }
                return '';
            };

            // Name - usually in h1 or main header
            data.nome = getText([
                'h1',
                'div[role="main"] h1',
                'div[class*="fontHeadlineLarge"]',
                'span[class*="fontHeadlineLarge"]'
            ]);

            // Category/Type
            data.categoria = getText([
                'button[jsaction*="category"]',
                'span[class*="DkEaL"]',
                'div[class*="skqShb"] span'
            ]);



            // Address - look for address-like elements
            const addressSelectors = [
                'button[data-item-id="address"]',
                'button[aria-label*="Endereço"]',
                'button[aria-label*="Address"]',
                'div[class*="Io6YTe"][class*="fontBodyMedium"]'
            ];

            for (const selector of addressSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    const text = el.textContent || el.getAttribute('aria-label') || '';
                    if (text && text.length > 10) {
                        data.endereco = text.replace(/^Endereço:\s*/i, '').trim();
                        break;
                    }
                }
            }

            // Phone - look for phone elements
            const phoneSelectors = [
                'button[data-item-id^="phone"]',
                'button[aria-label*="Telefone"]',
                'button[aria-label*="Phone"]',
                'a[href^="tel:"]'
            ];

            for (const selector of phoneSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    let phone = el.textContent || '';
                    if (el.href && el.href.startsWith('tel:')) {
                        phone = el.href.replace('tel:', '');
                    }
                    if (el.getAttribute('aria-label')) {
                        const match = el.getAttribute('aria-label').match(/[\d\s()-]+/);
                        if (match) phone = match[0];
                    }
                    const digits = phone.replace(/\D/g, '');
                    if (digits.length >= 10) {
                        data.telefone = phone.trim();
                        break;
                    }
                }
            }

            // Website - look for website link
            const websiteSelectors = [
                'a[data-item-id="authority"]',
                'a[aria-label*="Site"]',
                'a[aria-label*="Website"]',
                'button[data-item-id="authority"]'
            ];

            for (const selector of websiteSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    const href = el.href || el.getAttribute('data-url') || '';
                    const text = el.textContent || el.getAttribute('aria-label') || '';

                    // Try to extract URL from href or text
                    if (href && !href.includes('google.com')) {
                        data.website = href;
                        break;
                    } else if (text) {
                        // Text might be the domain
                        const urlMatch = text.match(/(https?:\/\/)?([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}/);
                        if (urlMatch) {
                            data.website = urlMatch[0].startsWith('http') ? urlMatch[0] : `https://${urlMatch[0]}`;
                            break;
                        }
                    }
                }
            }

            // Also check for website in aria-labels
            const allButtons = document.querySelectorAll('button[aria-label], a[aria-label]');
            for (const btn of allButtons) {
                const label = btn.getAttribute('aria-label') || '';
                if (label.toLowerCase().includes('site') || label.toLowerCase().includes('website')) {
                    const urlMatch = label.match(/(https?:\/\/)?([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}/);
                    if (urlMatch && !data.website) {
                        data.website = urlMatch[0].startsWith('http') ? urlMatch[0] : `https://${urlMatch[0]}`;
                    }
                }
            }



            return data;
        });

        // Try to extract from aria-label if name is empty
        if (!businessData.nome && business.ariaLabel) {
            businessData.nome = business.ariaLabel;
        }

        // Clean up website URL
        if (businessData.website) {
            // Remove any Google redirect URL prefixes
            if (businessData.website.includes('google.com/url')) {
                try {
                    const urlParams = new URL(businessData.website).searchParams;
                    const actualUrl = urlParams.get('url') || urlParams.get('q');
                    if (actualUrl) {
                        businessData.website = actualUrl;
                    }
                } catch (e) { /* Keep original */ }
            }
        }

        return businessData;
    }
}

module.exports = BusinessExtractor;
