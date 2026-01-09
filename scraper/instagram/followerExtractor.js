/**
 * Instagram Scraper - Follower Extractor
 * Extracts followers from a specific profile
 */

class FollowerExtractor {
    constructor(page) {
        this.page = page;
    }

    /**
     * Extract followers from a profile
     * @param {string} profileInput - Username or URL of the profile
     * @param {number} quantity - Maximum number of followers to extract
     * @param {string} filterTerm - Optional term to filter followers by bio
     * @param {Function} logCallback - Callback for logging
     * @returns {Array} List of follower profiles
     */
    async extract(profileInput, quantity, filterTerm = '', logCallback = () => { }, onProfilesFound = null) {
        const followers = [];
        const seenUsernames = new Set();

        // Normalize profile URL
        const profileUrl = this.normalizeProfileUrl(profileInput);
        const username = this.extractUsername(profileInput);

        try {
            logCallback({ message: `👥 Extraindo seguidores de @${username}` });

            // Navigate to profile
            await this.page.goto(profileUrl, {
                waitUntil: 'load',
                timeout: 30000
            });

            await this.delay(2000);

            // Check if profile exists
            const notFound = await this.page.$('text/Sorry, this page');
            if (notFound) {
                throw new Error(`Perfil @${username} não encontrado`);
            }

            // Check if profile is private
            const isPrivate = await this.page.evaluate(() => {
                const pageText = document.body.innerText;
                return pageText.includes('This Account is Private') ||
                    pageText.includes('Esta conta é privada');
            });

            if (isPrivate) {
                throw new Error(`Perfil @${username} é privado. Você precisa seguir para ver seguidores.`);
            }

            // Get follower count
            const followerCount = await this.page.evaluate(() => {
                const statsLinks = document.querySelectorAll('a[href*="/followers"]');
                for (const link of statsLinks) {
                    const text = link.textContent || '';
                    // Match number and optional suffix (k, m, mil, mi, b, bi) case insensitive
                    const match = text.match(/([\d,\.]+)\s*([kKmMbB]|mil|mi|bi)?/);

                    if (match) {
                        let numberStr = match[1];
                        const suffix = (match[2] || '').toLowerCase();

                        // normalize: remove thousands separators, keep decimal
                        // If suffix exists, assume dot/comma is decimal if it's not at the end
                        // Actually, simplified approach:
                        // If it has 'k', 'm', etc, assume it's a small number with decimal.
                        // But "1.200" is 1200. "1.2M" is 1200000.

                        let multiplier = 1;
                        if (suffix.includes('k') || suffix === 'mil') multiplier = 1000;
                        if (suffix.includes('m') || suffix === 'mi') multiplier = 1000000;
                        if (suffix.includes('b') || suffix === 'bi') multiplier = 1000000000;

                        if (multiplier > 1) {
                            // If multiplier, treat separators as decimal points if < 1000?
                            // e.g. "1.5M" -> 1.5. "1,5M" -> 1.5.
                            // "800k" -> 800.
                            numberStr = numberStr.replace(',', '.');
                        } else {
                            // No multiplier, assume standard integer with separators
                            // Remove all non-digits
                            numberStr = numberStr.replace(/[^\d]/g, '');
                        }

                        let count = parseFloat(numberStr) * multiplier;
                        return Math.round(count);
                    }
                }

                // Fallback: try title attribute
                const titleEl = document.querySelector('a[href*="/followers"] span[title]');
                if (titleEl) {
                    return parseInt(titleEl.title.replace(/[^\d]/g, ''));
                }

                return 0;
            });

            if (followerCount > 0) {
                logCallback({ message: `📊 @${username} tem ${followerCount.toLocaleString()} seguidores` });
            }

            // Click on followers link to open modal
            const followersLink = await this.page.$('a[href*="/followers"]');
            if (!followersLink) {
                throw new Error('Não foi possível encontrar link de seguidores. Login pode ser necessário.');
            }

            logCallback({ message: `🖱️ Clicando no link de seguidores...` });

            // Try different selectors for followers link if first fails
            const clickSuccess = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/followers/"]'));
                const link = links.find(l => l.textContent.toLowerCase().includes('seguidores') || l.textContent.toLowerCase().includes('followers'));
                if (link) {
                    link.click();
                    return true;
                }
                return false;
            });

            if (!clickSuccess) {
                await followersLink.click();
            }

            await this.delay(3000);

            // Wait for modal to appear
            logCallback({ message: `⏳ Aguardando lista de seguidores carregar (pode demorar)...` });

            let modalOpened = await this.page.waitForSelector('div[role="dialog"]', { timeout: 15000 }).catch(() => null);

            if (!modalOpened) {
                // Check if it's because it's already there or another structure
                modalOpened = await this.page.$('div[role="dialog"]');
            }

            if (!modalOpened) {
                logCallback({ message: `⚠️ Modal não detectado. Tentando via URL direta...` });
                await this.page.goto(`${profileUrl}followers/`, {
                    waitUntil: 'load',
                    timeout: 20000
                });
                await this.delay(3000);
            } else {
                logCallback({ message: `✅ Lista de seguidores carregada.` });
            }

            // Extract followers from modal/page
            logCallback({ message: `📋 Coletando seguidores...` });

            // Initial scroll to trigger loading
            await this.page.evaluate(() => {
                const dialog = document.querySelector('div[role="dialog"]');
                const scrollable = dialog ? dialog.querySelector('div[style*="overflow"]') : null;
                if (scrollable) scrollable.scrollBy(0, 500);
            });
            await this.delay(1000);

            let scrollAttempts = 0;
            const maxScrollAttempts = Math.ceil(quantity / 5) + 5; // Collect in smaller batches
            let lastCount = 0;
            let staleScrolls = 0;

            // Loop until quantity reached OR stuck scrolling. Support unlimited if quantity is huge.
            while ((followers.length < quantity || quantity > 900000) && staleScrolls < 15 && scrollAttempts < maxScrollAttempts) {
                scrollAttempts++;

                // Get current followers in the list
                const currentFollowers = await this.page.evaluate(() => {
                    const results = [];
                    const seen = new Set();

                    // Target all links within the dialog or main content
                    const dialog = document.querySelector('div[role="dialog"]');
                    const links = dialog ? Array.from(dialog.querySelectorAll('a[href^="/"]')) : [];

                    // If no dialog links, maybe it's not in a dialog
                    const targetLinks = links.length > 0 ? links : Array.from(document.querySelectorAll('main a[href^="/"]'));

                    for (const link of targetLinks) {
                        try {
                            const href = link.getAttribute('href') || '';
                            if (!href || href.length < 2) continue;

                            // Handle both relative and absolute URLs
                            let cleanPath = href;
                            if (href.startsWith('http')) {
                                try {
                                    cleanPath = new URL(href).pathname;
                                } catch (e) {
                                    const match = href.match(/instagram\.com(\/[^?]+)/);
                                    if (match) cleanPath = match[1];
                                }
                            }

                            const parts = cleanPath.split('/').filter(Boolean);

                            // Profile pages have exactly 1 part: /username/
                            if (parts.length !== 1) continue;

                            const username = parts[0].split('?')[0];
                            if (!username || seen.has(username)) continue;

                            const systemPages = ['explore', 'reels', 'direct', 'accounts', 'p', 'reel', 'stories', 'emails', 'about', 'legal', 'directory', 'press', 'api', 'help', 'privacy', 'terms', 'locations'];
                            if (systemPages.includes(username.toLowerCase()) || username.length < 2) continue;

                            seen.add(username);

                            // Find name in the parent structure
                            let name = '';
                            let bio = '';

                            const parent = link.closest('div');
                            if (parent) {
                                const spans = Array.from(parent.querySelectorAll('span'));
                                for (const span of spans) {
                                    const text = span.textContent.trim();
                                    if (text && text !== username && text.length < 50) {
                                        name = text;
                                        break;
                                    }
                                }
                            }

                            results.push({
                                username: username,
                                name: name,
                                bio: bio,
                                url: `https://www.instagram.com/${username}/`
                            });
                        } catch (e) { }
                    }
                    return results;
                });

                if (currentFollowers.length > 0) {
                    const found = currentFollowers.length;
                    logCallback({ message: `🔎 Detectados ${found} perfis na lista...` });
                }

                // Process new followers
                const newBatch = [];
                for (const follower of currentFollowers) {
                    if (!seenUsernames.has(follower.username.toLowerCase())) {

                        // If doing streaming, we skip the filter here and let the consumer do it (deep filter)
                        // If NOT streaming, we apply basic filter here
                        let passesFilter = true;
                        if (filterTerm && !onProfilesFound) {
                            const bio = (follower.bio || '').toLowerCase();
                            const name = (follower.name || '').toLowerCase();
                            const user = (follower.username || '').toLowerCase();
                            const term = filterTerm.toLowerCase();
                            if (!bio.includes(term) && !name.includes(term) && !user.includes(term)) {
                                passesFilter = false;
                            }
                        }

                        if (passesFilter) {
                            seenUsernames.add(follower.username.toLowerCase());
                            followers.push(follower);
                            newBatch.push(follower);
                        }
                    }
                }

                if (newBatch.length > 0) {
                    staleScrolls = 0;
                    if (onProfilesFound) {
                        onProfilesFound(newBatch);
                    } else {
                        logCallback({ message: `🔎 Encontrados +${newBatch.length} perfis... (Total: ${followers.length})` });
                    }
                } else {
                    staleScrolls++;
                    if (!onProfilesFound && staleScrolls % 5 === 0) logCallback({ message: `⏳ Carregando mais...` });
                }

                lastCount = followers.length;

                // Scroll
                await this.page.evaluate(() => {
                    const dialog = document.querySelector('div[role="dialog"]');
                    const scrollable = dialog ? dialog.querySelector('div[style*="overflow"]') : null;

                    if (scrollable) {
                        scrollable.scrollBy(0, 1000);
                    } else if (dialog) {
                        dialog.scrollBy(0, 1000);
                    } else {
                        window.scrollBy(0, 1000);
                    }
                });

                await this.delay(1500 + Math.random() * 1000);

                if (scrollAttempts % 10 === 0) {
                    logCallback({ message: `📊 Progresso: ${followers.length}/${quantity} seguidores coletados` });
                }
            }

            const filterInfo = filterTerm ? ` (filtro: "${filterTerm}")` : '';
            logCallback({ message: `✅ Extraídos ${followers.length} seguidores de @${username}${filterInfo}` });

            return followers;

        } catch (error) {
            logCallback({ message: `❌ Erro ao extrair seguidores: ${error.message}` });
            throw error;
        }
    }

    /**
     * Extract following (profiles that a user follows)
     */
    async extractFollowing(profileInput, quantity, filterTerm = '', logCallback = () => { }) {
        // Same logic as extract, but for /following/ page
        const profileUrl = this.normalizeProfileUrl(profileInput);
        const username = this.extractUsername(profileInput);

        logCallback({ message: `👥 Extraindo 'seguindo' de @${username}` });

        // Navigate to following
        await this.page.goto(`${profileUrl}following/`, {
            waitUntil: 'load',
            timeout: 30000
        });

        // Rest is similar to extract()... (simplified for now)
        return this.extract(profileInput, quantity, filterTerm, logCallback);
    }

    /**
     * Normalize profile URL
     */
    normalizeProfileUrl(input) {
        if (!input) return '';

        let username = input.trim().replace(/^@/, '');

        if (username.includes('instagram.com')) {
            const match = username.match(/instagram\.com\/([^\/\?]+)/);
            if (match) {
                username = match[1];
            }
        }

        return `https://www.instagram.com/${username}/`;
    }

    /**
     * Extract username from input
     */
    extractUsername(input) {
        if (!input) return '';

        let username = input.trim().replace(/^@/, '');

        if (username.includes('instagram.com')) {
            const match = username.match(/instagram\.com\/([^\/\?]+)/);
            if (match) {
                return match[1];
            }
        }

        return username;
    }

    /**
     * Helper: delay execution
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = FollowerExtractor;
