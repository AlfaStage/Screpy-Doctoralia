/**
 * Instagram Scraper - Hashtag Search Handler
 * Searches for profiles through hashtag exploration
 */

class HashtagSearch {
    constructor(page) {
        this.page = page;
    }

    /**
     * Search for profiles by hashtag
     * @param {string} hashtag - Hashtag to search (without #)
     * @param {number} quantity - Maximum number of profiles to find
     * @param {Function} logCallback - Callback for logging
     * @returns {Array} List of profile usernames found from hashtag posts
     */
    async search(hashtag, quantity, logCallback = () => { }, onProfilesFound = null) {
        const profiles = [];
        const seenUsernames = new Set();

        // Clean hashtag
        const cleanHashtag = hashtag.replace(/^#/, '').trim().toLowerCase();

        try {
            logCallback({ message: `#️⃣ Pesquisando hashtag: #${cleanHashtag}` });

            // Navigate to hashtag page
            const hashtagUrl = `https://www.instagram.com/explore/tags/${cleanHashtag}/`;
            logCallback({ message: `🌐 Navegando para a hashtag...` });
            await this.page.goto(hashtagUrl, {
                waitUntil: 'load',
                timeout: 45000
            });

            await this.delay(2000);

            // Check if hashtag exists
            const notFound = await this.page.$('text/Sorry, this page');
            if (notFound) {
                throw new Error(`Hashtag #${cleanHashtag} não encontrada`);
            }

            // Get post count if available
            const postCount = await this.page.evaluate(() => {
                const countEl = document.querySelector('span.g47SY, header span');
                if (countEl) {
                    const text = countEl.textContent || '';
                    const match = text.match(/[\d,\.]+/);
                    return match ? match[0].replace(/[,\.]/g, '') : null;
                }
                return null;
            });

            if (postCount) {
                logCallback({ message: `📊 Hashtag tem ${parseInt(postCount).toLocaleString()} posts` });
            }

            // Collect posts and extract profile owners
            logCallback({ message: `📋 Coletando perfis dos posts...` });

            let scrollAttempts = 0;
            const maxScrolls = Math.ceil(quantity / 9) + 5; // ~9 posts per row

            while (profiles.length < quantity && scrollAttempts < maxScrolls) {
                scrollAttempts++;

                // Get post links (href="/p/...") and attempt fast extraction from alt text
                const postData = await this.page.evaluate(() => {
                    const items = [];
                    const postAnchors = document.querySelectorAll('a[href^="/p/"]');

                    for (const anchor of postAnchors) {
                        const img = anchor.querySelector('img');
                        const alt = img ? img.getAttribute('alt') || img.getAttribute('aria-label') || '' : '';

                        // Parse username from alt text if possible
                        // Examples: "Photo by @username on ...", "Photo by username (@username) on ...", "Photo by Name on ..."
                        let username = null;
                        if (alt) {
                            const matchSlash = alt.match(/by ([a-zA-Z0-9_.]+)/);
                            const matchAt = alt.match(/@([a-zA-Z0-9_.]+)/);

                            if (matchAt) username = matchAt[1];
                            else if (matchSlash) username = matchSlash[1];
                        }

                        if (anchor.href) {
                            items.push({
                                url: anchor.href,
                                username: username
                            });
                        }
                    }

                    return items;
                });

                // Add profiles found directly from grid
                const fastProfiles = postData.filter(i => i.username);
                for (const item of fastProfiles) {
                    if (profiles.length < quantity && !seenUsernames.has(item.username.toLowerCase())) {
                        const username = item.username.toLowerCase();
                        seenUsernames.add(username);
                        const newProfile = {
                            username: item.username,
                            name: '',
                            url: `https://www.instagram.com/${item.username}/`,
                            sourcePost: item.url,
                            method: 'fast_extraction'
                        };
                        profiles.push(newProfile);
                        if (onProfilesFound) onProfilesFound([newProfile]);
                        logCallback({ message: `👤 Perfil (rápido): @${item.username}` });
                    }
                }

                if (profiles.length >= quantity) break;

                const postLinks = postData.map(i => i.url);
                logCallback({ message: `📌 Encontrados ${postLinks.length} posts, extraindo autores restantes...` });

                // Visit each post to get the author
                const postsToVisit = postLinks.slice(0, Math.min(postLinks.length, quantity - profiles.length + 5));

                for (const postUrl of postsToVisit) {
                    if (profiles.length >= quantity) break;

                    try {
                        // Navigate to post
                        await this.page.goto(postUrl, {
                            waitUntil: 'load',
                            timeout: 15000
                        });
                        await this.delay(1500);

                        // Extract author username
                        const authorData = await this.page.evaluate(() => {
                            // Look for the author link in the post
                            // Multiple potential selectors for new Instagram layouts
                            const authorLink =
                                document.querySelector('header a[role="link"][href^="/"]') ||
                                document.querySelector('article header a') ||
                                document.querySelector('div[role="button"] a[href^="/"]') ||
                                document.querySelector('article a[href^="/"][role="link"]');

                            if (authorLink) {
                                const href = authorLink.getAttribute('href') || '';
                                const match = href.match(/^\/([^\/\?]+)\/?/);
                                if (match) {
                                    return {
                                        username: match[1],
                                        name: authorLink.textContent?.trim() || ''
                                    };
                                }
                            }

                            // Fallback: try to find any link with a username-like structure in the header area
                            const header = document.querySelector('header');
                            if (header) {
                                const links = header.querySelectorAll('a');
                                for (const link of links) {
                                    const h = link.getAttribute('href') || '';
                                    if (h.length > 2 && h.split('/').filter(Boolean).length === 1) {
                                        const uname = h.replace(/\//g, '');
                                        if (!['explore', 'reels', 'p', 'direct'].includes(uname)) {
                                            return { username: uname, name: link.textContent?.trim() || '' };
                                        }
                                    }
                                }
                            }

                            return null;
                        });

                        if (authorData && !seenUsernames.has(authorData.username.toLowerCase())) {
                            seenUsernames.add(authorData.username.toLowerCase());
                            const newProfile = {
                                username: authorData.username,
                                name: authorData.name,
                                url: `https://www.instagram.com/${authorData.username}/`,
                                sourcePost: postUrl
                            };
                            profiles.push(newProfile);

                            // Streaming callback
                            if (onProfilesFound) {
                                onProfilesFound([newProfile]);
                            }

                            logCallback({ message: `👤 Perfil: @${authorData.username}` });
                        }

                    } catch (postError) {
                        // Skip failed posts
                        continue;
                    }
                }

                if (profiles.length < quantity) {
                    // Go back to hashtag page and scroll for more posts
                    logCallback({ message: `🔄 Voltando para a grade de posts...` });
                    await this.page.goto(hashtagUrl, {
                        waitUntil: 'load',
                        timeout: 30000
                    });

                    await this.delay(1500);

                    // Scroll down to load more posts
                    await this.page.evaluate((scrolls) => {
                        window.scrollBy(0, 800 * scrolls);
                    }, scrollAttempts);

                    await this.delay(2000);
                }
            }

            logCallback({ message: `✅ Encontrados ${profiles.length} perfis em #${cleanHashtag}` });
            return profiles;

        } catch (error) {
            logCallback({ message: `❌ Erro na pesquisa por hashtag: ${error.message}` });
            throw error;
        }
    }

    /**
     * Get recent posts from hashtag without visiting each one
     * Faster but less reliable for extracting usernames
     */
    async getRecentPosts(hashtag, quantity, logCallback = () => { }) {
        const posts = [];
        const cleanHashtag = hashtag.replace(/^#/, '').trim().toLowerCase();

        try {
            const hashtagUrl = `https://www.instagram.com/explore/tags/${cleanHashtag}/`;
            await this.page.goto(hashtagUrl, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            await this.delay(2000);

            // Collect post URLs with scroll
            let lastCount = 0;
            let staleScrolls = 0;

            while (posts.length < quantity && staleScrolls < 3) {
                const newPosts = await this.page.evaluate(() => {
                    const postLinks = [];
                    const anchors = document.querySelectorAll('a[href^="/p/"]');

                    for (const anchor of anchors) {
                        if (anchor.href && !postLinks.includes(anchor.href)) {
                            postLinks.push(anchor.href);
                        }
                    }

                    return postLinks;
                });

                for (const url of newPosts) {
                    if (!posts.includes(url)) {
                        posts.push(url);
                    }
                }

                if (posts.length === lastCount) {
                    staleScrolls++;
                } else {
                    staleScrolls = 0;
                }
                lastCount = posts.length;

                // Scroll for more
                await this.page.evaluate(() => window.scrollBy(0, 800));
                await this.delay(1500);
            }

            return posts.slice(0, quantity);

        } catch (error) {
            logCallback({ message: `⚠️ Erro ao coletar posts: ${error.message}` });
            return posts;
        }
    }

    /**
     * Helper: delay execution
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = HashtagSearch;
