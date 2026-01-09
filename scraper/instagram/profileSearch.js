/**
 * Instagram Scraper - Profile Search Handler
 * Searches for profiles based on a search term
 */

class ProfileSearch {
    constructor(page) {
        this.page = page;
    }

    /**
     * Search for profiles by term
     * @param {string} searchTerm - Term to search for
     * @param {number} quantity - Maximum number of profiles to find
     * @param {Function} logCallback - Callback for logging
     * @returns {Array} List of profile usernames found
     */
    async search(searchTerm, quantity, logCallback = () => { }, onProfilesFound = null) {
        const profiles = [];

        try {
            logCallback({ message: `🔍 Pesquisando perfis: "${searchTerm}"` });

            // First check if we are already on a search-capable page
            const currentUrl = this.page.url();
            if (!currentUrl.includes('instagram.com')) {
                logCallback({ message: `🌐 Navegando para Instagram...` });
                await this.page.goto('https://www.instagram.com/', {
                    waitUntil: 'load',
                    timeout: 45000
                });
            }

            // Click on search icon/button (only if search input isn't visible)
            logCallback({ message: `🖱️ Verificando interface de busca...` });
            let searchInput = await this.page.$('input[placeholder="Search"]') ||
                await this.page.$('input[aria-label="Search input"]');

            if (!searchInput) {
                const searchButton = await this.page.$('svg[aria-label="Search"]') ||
                    await this.page.$('[aria-label="Search"]') ||
                    await this.page.$('a[href="/explore/"]');

                if (searchButton) {
                    logCallback({ message: `🖱️ Clicando no botão de busca...` });
                    await searchButton.click();
                    await this.delay(2000);
                }
            }

            // Re-check for search input after potential click
            searchInput = await this.page.$('input[placeholder="Search"]') ||
                await this.page.$('input[aria-label="Search input"]') ||
                await this.page.$('input[type="text"]');

            if (!searchInput) {
                logCallback({ message: `🌐 Campo não encontrado. Navegando via URL direta...` });
                // Navigate directly to explore/search
                await this.page.goto(`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(searchTerm)}`, {
                    waitUntil: 'load',
                    timeout: 45000
                });
                await this.delay(2000);
            } else {
                logCallback({ message: `⌨️ Digitando termo: "${searchTerm}"` });
                // Clear and type
                await searchInput.click({ clickCount: 3 });
                await this.page.keyboard.press('Backspace');
                await searchInput.type(searchTerm, { delay: 150 });
                await this.page.keyboard.press('Enter');
                await this.delay(3000);
            }

            // Collect profiles from search results
            logCallback({ message: `📋 Coletando perfis dos resultados...` });

            let attempts = 0;
            const maxAttempts = 10;

            while (profiles.length < quantity && attempts < maxAttempts) {
                attempts++;

                // Get profile links from results
                const newProfiles = await this.page.evaluate(() => {
                    const results = [];
                    const links = document.querySelectorAll('a[href^="/"]');

                    for (const link of links) {
                        const href = link.href || '';
                        const match = href.match(/instagram\.com\/([^\/\?]+)\/?$/);

                        if (match && match[1]) {
                            const username = match[1];
                            // Filter out Instagram system pages
                            const systemPages = ['explore', 'reels', 'direct', 'accounts', 'p', 'reel', 'stories'];
                            if (!systemPages.includes(username) && !username.startsWith('_')) {
                                // Try to get the name from the link context
                                const parent = link.closest('div');
                                let name = '';
                                if (parent) {
                                    const spans = parent.querySelectorAll('span');
                                    for (const span of spans) {
                                        const text = span.textContent.trim();
                                        if (text && text !== username && text.length > 0 && text.length < 50) {
                                            name = text;
                                            break;
                                        }
                                    }
                                }

                                results.push({
                                    username: username,
                                    name: name,
                                    url: `https://www.instagram.com/${username}/`
                                });
                            }
                        }
                    }

                    return results;
                });

                // Add unique profiles
                const batchNew = [];
                for (const profile of newProfiles) {
                    if (!profiles.some(p => p.username === profile.username)) {
                        profiles.push(profile);
                        batchNew.push(profile);
                        logCallback({ message: `📌 Encontrado: @${profile.username}${profile.name ? ` (${profile.name})` : ''}` });

                        if (profiles.length >= quantity) break;
                    }
                }

                if (batchNew.length > 0 && onProfilesFound) {
                    onProfilesFound(batchNew);
                }

                if (profiles.length < quantity) {
                    // Scroll to load more results
                    await this.page.evaluate(() => {
                        window.scrollBy(0, 500);
                    });
                    await this.delay(1500);
                }
            }

            logCallback({ message: `✅ Encontrados ${profiles.length} perfis para "${searchTerm}"` });
            return profiles;

        } catch (error) {
            logCallback({ message: `❌ Erro na pesquisa: ${error.message}` });
            throw error;
        }
    }

    /**
     * Alternative search using Google for Instagram profiles
     * More reliable for finding profiles by keyword
     */
    async searchViaGoogle(searchTerm, quantity, logCallback = () => { }) {
        const profiles = [];

        try {
            logCallback({ message: `🔍 Pesquisando via Google: "${searchTerm}" site:instagram.com` });

            const searchQuery = `site:instagram.com "${searchTerm}"`;
            await this.page.goto(`https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&num=50`, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            await this.delay(2000);

            // Handle consent page if present
            const consentButton = await this.page.$('button[id*="agree"], button:has-text("I agree")');
            if (consentButton) {
                await consentButton.click();
                await this.delay(1500);
            }

            // Collect Instagram profile links from Google results
            const googleResults = await this.page.evaluate(() => {
                const results = [];
                const links = document.querySelectorAll('a[href*="instagram.com"]');

                for (const link of links) {
                    const href = link.href || '';
                    const match = href.match(/instagram\.com\/([a-zA-Z0-9_.]+)\/?(?:\?|$)/);

                    if (match && match[1]) {
                        const username = match[1];
                        const systemPages = ['explore', 'reels', 'direct', 'accounts', 'p', 'reel', 'stories', 'about', 'legal'];

                        if (!systemPages.includes(username.toLowerCase())) {
                            results.push({
                                username: username,
                                name: '',
                                url: `https://www.instagram.com/${username}/`
                            });
                        }
                    }
                }

                return results;
            });

            // Deduplicate
            for (const profile of googleResults) {
                if (!profiles.some(p => p.username.toLowerCase() === profile.username.toLowerCase())) {
                    profiles.push(profile);
                    if (profiles.length >= quantity) break;
                }
            }

            logCallback({ message: `✅ Google encontrou ${profiles.length} perfis` });
            return profiles;

        } catch (error) {
            logCallback({ message: `⚠️ Erro na busca Google: ${error.message}` });
            return profiles;
        }
    }

    /**
     * Helper: delay execution
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ProfileSearch;
