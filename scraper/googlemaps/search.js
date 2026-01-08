const { randomDelay, scrollPage } = require('../utils');

class MapsSearchHandler {
    constructor(page) {
        this.page = page;
        this.collectedBusinesses = new Set();
    }

    async performSearch(searchQuery, progressCallback) {
        console.log(`Searching Google Maps for: ${searchQuery}`);
        if (progressCallback) progressCallback({ message: `🗺️ Acessando Google Maps...` });

        // Navigate to Google Maps with retry
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

                await this.page.goto('https://www.google.com/maps', {
                    waitUntil: ['domcontentloaded', 'networkidle2'],
                    timeout: 90000
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

        // Wait for and handle cookie consent if present
        try {
            const consentButton = await this.page.$('button[aria-label*="Aceitar"], button[aria-label*="Accept"]');
            if (consentButton) {
                await consentButton.click();
                await randomDelay(1000, 2000);
            }
        } catch (e) { /* Ignore */ }

        // Find and fill search input
        if (progressCallback) progressCallback({ message: `🔍 Pesquisando: "${searchQuery}"` });

        try {
            // Wait for search box with multiple selector strategies
            const searchSelectors = [
                '#searchboxinput',
                'input[name="q"]',
                'input[aria-label*="Pesquisar"]',
                'input[aria-label*="Search"]',
                'input[class*="searchbox"]',
                'input[placeholder*="Pesquisar"]',
                'input[placeholder*="Search"]'
            ];

            let searchInput = null;
            let foundSelector = null;

            for (const selector of searchSelectors) {
                try {
                    await this.page.waitForSelector(selector, { timeout: 5000 });
                    searchInput = await this.page.$(selector);
                    if (searchInput) {
                        foundSelector = selector;
                        console.log(`Found search input with selector: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            if (!searchInput) {
                // Take screenshot for debugging
                console.log('No search input found. Page URL:', await this.page.url());

                // Check if we're on a consent/cookie page
                const pageContent = await this.page.content();
                if (pageContent.includes('consent') || pageContent.includes('cookie') || pageContent.includes('Aceitar')) {
                    if (progressCallback) progressCallback({ message: `⚠️ Detectada página de consentimento. Tentando aceitar...` });

                    // Try to click any accept button
                    const acceptSelectors = [
                        'button[aria-label*="Aceitar"]',
                        'button[aria-label*="Accept"]',
                        'form[action*="consent"] button',
                        'button:has-text("Aceitar")',
                        'button:has-text("Accept")'
                    ];

                    for (const sel of acceptSelectors) {
                        try {
                            await this.page.click(sel);
                            await randomDelay(2000, 3000);
                            break;
                        } catch (e) { /* try next */ }
                    }

                    // Try to find search input again
                    await this.page.waitForSelector('#searchboxinput', { timeout: 10000 });
                    foundSelector = '#searchboxinput';
                } else {
                    throw new Error('Nenhuma caixa de busca encontrada. Google pode estar bloqueando requests.');
                }
            }

            const inputSelector = foundSelector || '#searchboxinput';

            // Type search query with human-like behavior
            await this.page.click(inputSelector);
            await randomDelay(300, 600);

            // Clear any existing text
            await this.page.evaluate((sel) => {
                const input = document.querySelector(sel);
                if (input) input.value = '';
            }, inputSelector);

            // Type character by character
            for (const char of searchQuery) {
                await this.page.type(inputSelector, char, { delay: 50 + Math.random() * 100 });
            }

            await randomDelay(500, 1000);

            // Press Enter or click search button
            await this.page.keyboard.press('Enter');

            // Wait for results to load
            await randomDelay(3000, 5000);

            // Wait for results panel to appear - try multiple selectors
            const resultSelectors = [
                'a[href*="/maps/place/"]',
                'div[role="feed"]',
                'div[class*="Nv2PK"]',
                'a.hfpxzc'
            ];

            let resultsFound = false;
            for (const selector of resultSelectors) {
                try {
                    await this.page.waitForSelector(selector, { timeout: 10000 });
                    console.log(`Results found with selector: ${selector}`);
                    resultsFound = true;
                    break;
                } catch (e) { /* continue */ }
            }

            if (!resultsFound) {
                console.log('Results panel not found after trying all selectors, attempting to continue...');
                // Take debug screenshot
                try {
                    const timestamp = Date.now();
                    await this.page.screenshot({ path: `./results/debug_maps_${timestamp}.png`, fullPage: true });
                    console.log(`Debug screenshot saved: debug_maps_${timestamp}.png`);
                } catch (e) { console.log('Screenshot failed:', e.message); }
            }

            // Extra wait to ensure elements are fully rendered (Google Maps is heavily JS-driven)
            await randomDelay(4000, 6000);

            // Additional check: wait for specific container
            try {
                await this.page.waitForFunction(() => {
                    // Wait for any visible business-related element
                    const feed = document.querySelector('div[role="feed"]');
                    const links = document.querySelectorAll('a[href*="/maps/place/"]');
                    const articles = document.querySelectorAll('[role="article"]');
                    return (feed && feed.children.length > 0) || links.length > 0 || articles.length > 0;
                }, { timeout: 15000 });
                console.log('Business elements detected via waitForFunction');
            } catch (e) {
                console.log('waitForFunction timeout - continuing anyway');
            }

            if (progressCallback) progressCallback({ message: `✅ Resultados carregados` });

        } catch (error) {
            console.error('Search error:', error.message);
            throw new Error(`Erro na busca: ${error.message}`);
        }

        return true;
    }

    async collectBusinesses(targetQuantity, progressCallback, continueCollection = false) {
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

                // Multiple selector strategies for Google Maps - updated for 2024/2025
                const selectors = [
                    // Primary selectors for business cards
                    'a[href*="/maps/place/"]',
                    'div[role="feed"] a[href*="/maps/"]',
                    'div[role="feed"] > div > div[jsaction] a',
                    'a.hfpxzc',
                    // Fallback selectors  
                    'div[class*="Nv2PK"] a',
                    'div[class*="lI9IFe"] a',
                    'div[class*="bfdHYe"] a[href*="maps"]',
                    // Very generic but effective fallback
                    '[jsaction*="mouseover:pane"] a[href*="/maps/place/"]',
                    'div[jscontroller] > a[href*="/maps/place/"]',
                    // Article-based selectors (2025 structure)
                    '[role="article"] a[href*="/maps/place/"]',
                    '[role="article"] a[aria-label]',
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

                // If still no results, try the broadest approach - find all place links
                if (elements.length === 0) {
                    const allLinks = document.querySelectorAll('a[href*="google.com/maps/place"]');
                    elements = Array.from(allLinks);
                }

                // Deduplicate by href to avoid counting same place multiple times
                const seenUrls = new Set();

                elements.forEach((element, index) => {
                    try {
                        const href = element.href || element.getAttribute('href');

                        // Must be a valid Google Maps place URL
                        if (!href || !href.includes('/maps/place/')) return;

                        // Skip if we already have this URL
                        if (seenUrls.has(href)) return;
                        seenUrls.add(href);

                        // Try to get name from aria-label or nearby text
                        const ariaLabel = element.getAttribute('aria-label') ||
                            element.closest('[role="article"]')?.querySelector('[class*="fontHeadlineSmall"], [class*="qBF1Pd"]')?.textContent ||
                            element.querySelector('[class*="fontHeadlineSmall"]')?.textContent ||
                            element.closest('div[jsaction]')?.querySelector('[class*="fontHeadlineSmall"]')?.textContent ||
                            element.textContent?.substring(0, 100) ||
                            '';

                        results.push({
                            index: results.length,
                            url: href,
                            ariaLabel: ariaLabel.trim(),
                            element: null
                        });
                    } catch (e) { /* Skip problematic elements */ }
                });

                // Debug: log what we found
                console.log(`[Maps Scraper] Found ${elements.length} raw elements, ${results.length} unique places`);

                return results;
            });

            // Filter duplicates
            let addedCount = 0;
            for (const business of newBusinesses) {
                const key = business.url || business.ariaLabel;
                if (!this.collectedBusinesses.has(key)) {
                    this.collectedBusinesses.add(key);
                    businesses.push(business);
                    addedCount++;

                    if (businesses.length >= targetQuantity) {
                        break;
                    }
                }
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
                            console.log(`Scrolled using: ${selector}`);
                            return;
                        }
                    } catch (e) { /* continue */ }
                }

                // Final fallback: scroll within any scrollable element in the left panel
                const leftPanel = document.querySelector('[class*="section-layout"]') ||
                    document.querySelector('[class*="layout"]');
                if (leftPanel) {
                    leftPanel.scrollTop += 800;
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
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                await randomDelay(2000, 4000);
                return true;
            }

            // Alternative: try to click by index
            const clicked = await this.page.evaluate((index) => {
                const elements = document.querySelectorAll('a[class*="hfpxzc"]');
                if (elements[index]) {
                    elements[index].click();
                    return true;
                }
                return false;
            }, business.index);

            if (clicked) {
                await randomDelay(2000, 4000);
            }

            return clicked;
        } catch (error) {
            console.error('Click error:', error.message);
            return false;
        }
    }
}

module.exports = MapsSearchHandler;
