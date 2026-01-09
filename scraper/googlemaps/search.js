const { randomDelay, scrollPage } = require('../utils'); // Updated: removed typeText since we navigate directly

class MapsSearchHandler {
    constructor(page) {
        this.page = page;
        this.collectedBusinesses = new Set();
    }

    async performSearch(searchQuery, progressCallback) {
        console.log(`Searching Google Maps for: ${searchQuery}`);
        if (progressCallback) progressCallback({ message: `🗺️ Acessando Google Maps...` });

        // Direct Navigation Logic instead of typing
        const encodedQuery = encodeURIComponent(searchQuery);
        const searchUrl = `https://www.google.com/maps/search/${encodedQuery}`;

        console.log(`Direct navigation to: ${searchUrl}`);
        if (progressCallback) progressCallback({ message: `🔍 Pesquisando: "${searchQuery}"` });

        // Navigate directly to search results
        let success = false;
        let attempts = 0;
        const maxAttempts = 3;

        while (!success && attempts < maxAttempts) {
            attempts++;
            try {
                if (attempts > 1) {
                    const delay = 3000 * attempts;
                    if (progressCallback) progressCallback({ message: `⚠️ Tentativa ${attempts}/${maxAttempts}...` });
                    await randomDelay(delay, delay + 2000);
                }

                await this.page.goto(searchUrl, {
                    waitUntil: ['domcontentloaded', 'networkidle2'],
                    timeout: 60000
                });
                success = true;
            } catch (e) {
                console.log(`Maps navigation error (Attempt ${attempts}):`, e.message);
                if (attempts === maxAttempts) {
                    if (progressCallback) progressCallback({ message: `❌ Falha ao acessar Maps após ${maxAttempts} tentativas.` });
                    throw e;
                }
            }
        }

        await randomDelay(2000, 4000);

        // Handle cookie consent if present
        try {
            const consentButton = await this.page.$('button[aria-label*="Aceitar"], button[aria-label*="Accept"]');
            if (consentButton) {
                await consentButton.click();
                await randomDelay(1000, 2000);
            }
        } catch (e) { /* Ignore */ }

        // Confirm search results loaded by checking for result elements OR no results message
        const resultSelectors = [
            'a[href*="/maps/place/"]',
            'div[role="feed"]',
            'div[class*="Nv2PK"]',
            'div[aria-label^="Resultados"]',
            'div[aria-label^="Results"]',
            'div.m6QErb',
            'h1.fontHeadlineLarge' // Sometimes the single result view title
        ];

        try {
            await this.page.waitForFunction((selectors) => {
                // Check if any result selector exists
                const hasResults = selectors.some(s => document.querySelector(s));

                // Check for "No results found" text
                const bodyText = document.body.innerText;
                const noResults = bodyText.includes('Nenhum resultado encontrado') ||
                    bodyText.includes('No results found') ||
                    bodyText.includes('Google Maps não encontrou');

                return hasResults || noResults;
            }, { timeout: 20000 }, resultSelectors);

            console.log('Page load confirmed via waitForFunction.');

            // Check if it was a "No results" case
            const isNoResults = await this.page.evaluate(() => {
                const bodyText = document.body.innerText;
                return bodyText.includes('Nenhum resultado encontrado') ||
                    bodyText.includes('No results found') ||
                    bodyText.includes('Google Maps não encontrou');
            });

            if (isNoResults) {
                console.log('Detected "No results found" state.');
                if (progressCallback) progressCallback({ message: `⚠️ Google Maps: Nenhum resultado encontrado para esta busca.` });
                // We don't throw, just let collection return 0, but user finds out via message
            }

        } catch (e) {
            console.log('Results panel check timed out - proceeding to collection anyway as results might be sparse.');
            // Take debug screenshot just in case
            try {
                const timestamp = Date.now();
                await this.page.screenshot({ path: `./results/debug_maps_nav_${timestamp}.png`, fullPage: true });
            } catch (err) { }
        }
    }

    async collectBusinesses(targetQuantity, progressCallback, continueCollection = false, onBusinessFound = null) {
        const businesses = [];
        let noNewResultsCount = 0;
        const maxNoNewResults = 8; // Increased patience for incremental search

        if (!continueCollection) {
            this.collectedBusinesses.clear();
        }

        console.log(`Collecting up to ${targetQuantity} businesses (Continue: ${continueCollection})...`);
        if (progressCallback) progressCallback({ message: `📋 Coletando até ${targetQuantity} estabelecimentos...` });

        // Initial debug: check what we can find on the page before scrolling
        const debugInfo = await this.page.evaluate(() => {
            const info = {
                url: window.location.href,
                bodyLength: document.body.innerHTML.length,
                feedElements: document.querySelectorAll('div[role="feed"]').length,
                placeLinks: document.querySelectorAll('a[href*="/maps/place/"]').length,
                allLinks: document.querySelectorAll('a[href*="google.com/maps"]').length,
                hfpxzcLinks: document.querySelectorAll('a.hfpxzc').length,
                Nv2PK: document.querySelectorAll('div[class*="Nv2PK"]').length
            };
            return info;
        });
        console.log('[DEBUG] Page state before collection:', JSON.stringify(debugInfo));

        while (businesses.length < targetQuantity && noNewResultsCount < maxNoNewResults) {
            // Scroll the results panel
            await this.scrollResultsPanel();
            await randomDelay(2000, 3000);

            // Extract business entries with improved selectors
            const newBusinesses = await this.page.evaluate(() => {
                const results = [];

                // Multiple selector strategies for business cards
                const selectors = [
                    // Primary selectors
                    'a[href*="/maps/place/"]',
                    'div[role="feed"] a[href*="/maps/"]',
                    'div[role="feed"] > div > div[jsaction] a',
                    'a.hfpxzc',
                    // Fallback selectors  
                    'div[class*="Nv2PK"] a',
                    'div[class*="lI9IFe"] a',
                    'div[class*="bfdHYe"] a[href*="maps"]',
                    // Generic fallback
                    '[jsaction*="mouseover:pane"] a[href*="/maps/place/"]',
                    '[role="article"] a[href*="/maps/place/"]',
                    // Direct search for any links with place in href
                    'a[href*="google.com/maps/place/"]'
                ];

                let elements = [];

                // Try each selector and keep the one with most results
                for (const selector of selectors) {
                    try {
                        const found = document.querySelectorAll(selector);
                        if (found.length > elements.length) {
                            elements = Array.from(found);
                        }
                    } catch (e) { /* continue */ }
                }

                if (elements.length === 0) {
                    // Last resort
                    const allLinks = document.querySelectorAll('a[href*="google.com/maps/place"]');
                    elements = Array.from(allLinks);
                }

                // Deduplicate
                const seenUrls = new Set();

                elements.forEach((element, index) => {
                    try {
                        const href = element.href || element.getAttribute('href');

                        if (!href || !href.includes('/maps/place/')) return;
                        if (seenUrls.has(href)) return;
                        seenUrls.add(href);

                        // Try to get name
                        const ariaLabel = element.getAttribute('aria-label') ||
                            element.closest('[role="article"]')?.querySelector('[class*="fontHeadlineSmall"], [class*="qBF1Pd"]')?.textContent ||
                            element.querySelector('[class*="fontHeadlineSmall"]')?.textContent ||
                            element.textContent?.substring(0, 50) ||
                            '';

                        results.push({
                            index: results.length,
                            url: href,
                            ariaLabel: ariaLabel.trim(),
                            element: null
                        });
                    } catch (e) { /* Skip problematic elements */ }
                });

                return results;
            });

            // Filter duplicates
            let addedCount = 0;
            const newItems = [];
            for (const business of newBusinesses) {
                const key = business.url || business.ariaLabel;
                if (!this.collectedBusinesses.has(key)) {
                    this.collectedBusinesses.add(key);
                    businesses.push(business);
                    newItems.push(business);
                    addedCount++;
                }
            }

            // Streaming callback
            if (newItems.length > 0 && onBusinessFound) {
                onBusinessFound(newItems);
            }

            // Check exit condition AFTER streaming
            if (businesses.length >= targetQuantity) {
                break;
            }

            if (addedCount === 0) {
                noNewResultsCount++;
                if (progressCallback) progressCallback({
                    message: `⏳ Scrollando para mais resultados... (${businesses.length}/${targetQuantity})`
                });
            } else {
                noNewResultsCount = 0;
                if (progressCallback) progressCallback({
                    message: `📋 Coletados ${businesses.length}/${targetQuantity} estabelecimentos (+${addedCount} novos)`
                });
            }
        }

        console.log(`Collected ${businesses.length} businesses`);
        return businesses;
    }

    async scrollResultsPanel() {
        try {
            await this.page.evaluate(() => {
                // Multiple attempts to find the scrollable results container
                const scrollSelectors = [
                    'div[role="feed"]',
                    'div[class*="m6QErb"][class*="DxyBCb"]',
                    'div[class*="m6QErb"][class*="WNBkOb"]',
                    'div[aria-label*="Resultados"]',
                    'div[aria-label*="Results"]',
                    'div[class*="ecceSd"]',
                    'div[class*="Hzlp"]'
                ];

                for (const selector of scrollSelectors) {
                    try {
                        const container = document.querySelector(selector);
                        if (container && container.scrollHeight > container.clientHeight) {
                            container.scrollTop += 800;
                            return;
                        }
                    } catch (e) { /* continue */ }
                }

                // Final fallback: any large scrollable element
                const scrollables = Array.from(document.querySelectorAll('*')).filter(e => e.scrollHeight > e.clientHeight && e.clientHeight > 200);
                if (scrollables.length) {
                    scrollables[0].scrollTop += 800;
                }
            });
        } catch (e) {
            console.log('Scroll error:', e.message);
        }
    }

    async clickOnBusiness(business) {
        try {
            if (business.url) {
                // Navigate directly to business URL
                await this.page.goto(business.url, {
                    waitUntil: 'load',
                    timeout: 30000
                });
                await randomDelay(2000, 4000);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Click error:', error.message);
            return false;
        }
    }
}

module.exports = MapsSearchHandler;
