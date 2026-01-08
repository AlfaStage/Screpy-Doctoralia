const { randomDelay } = require('../utils');

class WebsiteInvestigator {
    constructor(page, logCallback = null) {
        this.page = page;
        this.logCallback = logCallback;
        this.maxDepth = 5;

        // Regex patterns for extraction
        this.patterns = {
            cnpj: /(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/g,
            email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
            instagram: [
                /@([a-zA-Z0-9_.]{3,30})/g,
                /instagram\.com\/([a-zA-Z0-9_.]{3,30})/gi,
                /instagr\.am\/([a-zA-Z0-9_.]{3,30})/gi
            ],
            phone: /(?:\+55\s?)?(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}/g,
            whatsapp: [
                /wa\.me\/(\d{10,13})/gi,
                /wa\.me\/55(\d{10,11})/gi,
                /api\.whatsapp\.com\/send\/?\?phone=(\d{10,13})/gi,
                /api\.whatsapp\.com\/send\/?\?phone=55(\d{10,11})/gi,
                /whatsapp\.com\/.*phone=(\d{10,13})/gi
            ],
            linktree: [
                /linktr\.ee\/([a-zA-Z0-9_.]+)/gi,
                /lnk\.bio\/([a-zA-Z0-9_.]+)/gi,
                /bio\.link\/([a-zA-Z0-9_.]+)/gi,
                /linkin\.bio\/([a-zA-Z0-9_.]+)/gi
            ]
        };

        // Known bio link services
        this.bioLinkServices = [
            'linktr.ee', 'linktree.com',
            'lnk.bio', 'bio.link', 'linkin.bio',
            'tap.bio', 'campsite.bio',
            'beacons.ai', 'allmylinks.com',
            'carrd.co', 'about.me'
        ];

        // BLOCKED DOMAINS - Pages that are NOT relevant to leads
        // These are generic pages, not lead-specific pages
        this.blockedPaths = [
            // Privacy, Terms, Generic Pages
            '/privacy', '/privacidade', '/terms', '/termos',
            '/policy', '/politica', '/cookies', '/legal',
            '/help', '/ajuda', '/support', '/suporte',
            '/about', '/sobre', '/contact', '/contato', // Only on external sites!
            '/faq', '/blog', '/careers', '/trabalhe-conosco',
            '/login', '/signup', '/register', '/cadastro',

            // WhatsApp generic pages
            '/contact', '/download', '/features', '/security',

            // Linktree generic pages
            '/privacy', '/terms', '/about', '/login', '/register',

            // Instagram generic pages
            '/explore', '/reels', '/stories', '/p/', '/reel/',
            '/accounts/', '/directory/', '/legal/',

            // Facebook generic pages
            '/groups', '/events', '/marketplace', '/watch',

            // Generic patterns
            '/404', '/error', '/not-found', '/maintenance'
        ];

        // BLOCKED DOMAINS - External sites that are NOT relevant
        this.blockedDomains = [
            'whatsapp.com', 'www.whatsapp.com', 'faq.whatsapp.com',
            'facebook.com', 'www.facebook.com', 'm.facebook.com',
            'twitter.com', 'x.com',
            'youtube.com', 'www.youtube.com',
            'google.com', 'www.google.com',
            'apple.com', 'play.google.com',
            'linkedin.com', 'www.linkedin.com',
            'tiktok.com', 'www.tiktok.com',
            'spotify.com', 'open.spotify.com',
            'pinterest.com', 'www.pinterest.com',

            // Generic services
            'wordpress.com', 'wix.com', 'squarespace.com',
            'cloudflare.com', 'jsdelivr.net', 'cdn.', 'fonts.googleapis.com'
        ];

        // ALLOWED BIO LINK DOMAINS - We DO want to access these, but not their generic pages
        this.allowedBioLinkDomains = [
            'linktr.ee', 'lnk.bio', 'bio.link', 'linkin.bio',
            'tap.bio', 'campsite.bio', 'beacons.ai', 'allmylinks.com',
            'carrd.co', 'about.me'
        ];
    }

    log(message) {
        console.log(`[WebsiteInvestigator] ${message}`);
        if (this.logCallback) {
            this.logCallback(message);
        }
    }

    // ============================================
    // SMART LINK FILTERING METHODS
    // ============================================

    // Check if a link should be BLOCKED (not relevant to the lead)
    isBlockedLink(url) {
        if (!url) return true;

        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname.toLowerCase();
            const pathname = urlObj.pathname.toLowerCase();

            // Check if domain is completely blocked
            for (const blockedDomain of this.blockedDomains) {
                if (hostname === blockedDomain || hostname.endsWith('.' + blockedDomain)) {
                    // Exception: wa.me and api.whatsapp.com are OK (they have data in URL)
                    if (hostname === 'wa.me' || hostname === 'api.whatsapp.com') {
                        return false;
                    }
                    this.log(`🚫 Link bloqueado (domínio): ${url}`);
                    return true;
                }
            }

            // Check if path contains blocked patterns
            // But ONLY for external domains, not for the lead's own website
            for (const blockedPath of this.blockedPaths) {
                if (pathname.includes(blockedPath)) {
                    // For bio link services, still allow username pages but block generic ones
                    const isBioLink = this.allowedBioLinkDomains.some(d => hostname.includes(d));
                    if (isBioLink) {
                        // On bio links, block only if pathname is EXACTLY a blocked path
                        if (pathname === blockedPath || pathname === blockedPath + '/') {
                            this.log(`🚫 Link bloqueado (caminho genérico): ${url}`);
                            return true;
                        }
                    } else {
                        this.log(`🚫 Link bloqueado (caminho): ${url}`);
                        return true;
                    }
                }
            }

            return false;
        } catch (e) {
            return true; // Invalid URL
        }
    }

    // Extract data directly from URL without visiting the page
    extractDataFromUrl(url) {
        const extracted = {
            whatsapp: null,
            instagram: null,
            email: null,
            telefone: null,
            shouldVisit: true // Whether we still need to visit this page
        };

        if (!url) return extracted;

        try {
            const urlLower = url.toLowerCase();

            // 1. WHATSAPP - Extract number directly from URL
            if (urlLower.includes('wa.me') || urlLower.includes('whatsapp.com')) {
                const waNum = this.extractWhatsAppFromUrl(url);
                if (waNum) {
                    extracted.whatsapp = waNum;
                    extracted.shouldVisit = false; // No need to visit
                    this.log(`📱 WhatsApp extraído da URL: ${waNum}`);
                }
            }

            // 2. INSTAGRAM - Extract username directly from URL
            const instaMatch = url.match(/instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?(?:\?|$)/i);
            if (instaMatch) {
                const username = instaMatch[1];
                // Skip generic pages
                if (!['p', 'reel', 'reels', 'stories', 'explore', 'direct', 'accounts', 'directory', 'legal'].includes(username.toLowerCase())) {
                    extracted.instagram = username;
                    extracted.shouldVisit = false; // No need to visit
                    this.log(`📸 Instagram extraído da URL: @${username}`);
                }
            }

            // 3. EMAIL - Extract from mailto: links
            if (urlLower.startsWith('mailto:')) {
                const email = url.split('mailto:')[1]?.split('?')[0];
                if (email && email.includes('@')) {
                    extracted.email = email;
                    extracted.shouldVisit = false;
                    this.log(`📧 Email extraído da URL: ${email}`);
                }
            }

            // 4. PHONE - Extract from tel: links
            if (urlLower.startsWith('tel:')) {
                const phone = url.split('tel:')[1]?.split('?')[0];
                if (phone) {
                    const formatted = this.formatPhone(phone);
                    if (formatted) {
                        extracted.telefone = formatted;
                        extracted.shouldVisit = false;
                        this.log(`📞 Telefone extraído da URL: ${formatted}`);
                    }
                }
            }

        } catch (e) {
            // Ignore parsing errors
        }

        return extracted;
    }

    // Check what data is still missing for the lead
    getMissingFields(currentResult) {
        const missing = [];
        if (!currentResult.email) missing.push('email');
        if (!currentResult.instagram) missing.push('instagram');
        if (!currentResult.whatsapp && (!currentResult.telefones || currentResult.telefones.length === 0)) {
            missing.push('telefone');
        }
        if (!currentResult.cnpj) missing.push('cnpj');
        return missing;
    }

    // Prioritize links based on what data is still missing
    prioritizeLinks(links, missingFields, currentResult) {
        const scored = links.map(link => {
            let score = 0;
            const linkLower = link.toLowerCase();

            // High priority: Bio links (contain many social links)
            if (this.isBioLinkService(link)) {
                score += 100;
            }

            // Medium priority: Contact pages (if we need email/phone)
            if (missingFields.includes('email') || missingFields.includes('telefone')) {
                if (linkLower.includes('contato') || linkLower.includes('contact')) {
                    score += 50;
                }
            }

            // Medium priority: Instagram links (if we need instagram)
            if (missingFields.includes('instagram') && linkLower.includes('instagram.com')) {
                score += 40;
            }

            // Lower priority: About pages
            if (linkLower.includes('sobre') || linkLower.includes('about')) {
                score += 20;
            }

            // Lower priority: WhatsApp links
            if (linkLower.includes('wa.me') || linkLower.includes('whatsapp')) {
                score += 30;
            }

            return { link, score };
        });

        // Sort by score descending
        return scored.sort((a, b) => b.score - a.score).map(s => s.link);
    }

    // Format phone number to Brazilian standard: +55 (XX) XXXXX-XXXX or +55 (XX) XXXX-XXXX
    formatPhone(phoneRaw) {
        // Remove all non-digit characters
        let digits = phoneRaw.replace(/\D/g, '');

        // If starts with 55 and has 12-13 digits, it already has country code
        if (digits.startsWith('55') && digits.length >= 12) {
            digits = digits.substring(2);
        }

        // If has 10-11 digits, it's a valid BR number
        if (digits.length === 11) {
            // Mobile with 9 digit: (XX) 9XXXX-XXXX
            const ddd = digits.substring(0, 2);
            const first = digits.substring(2, 7);
            const second = digits.substring(7);
            return `+55 (${ddd}) ${first}-${second}`;
        } else if (digits.length === 10) {
            // Landline: (XX) XXXX-XXXX
            const ddd = digits.substring(0, 2);
            const first = digits.substring(2, 6);
            const second = digits.substring(6);
            return `+55 (${ddd}) ${first}-${second}`;
        }

        // Return cleaned digits if can't format
        return digits.length >= 10 ? `+55 ${digits}` : null;
    }

    // Check if a phone number is mobile (starts with 9 after DDD)
    isMobileNumber(phoneRaw) {
        const digits = phoneRaw.replace(/\D/g, '');
        // Remove country code if present
        let local = digits;
        if (digits.startsWith('55') && digits.length >= 12) {
            local = digits.substring(2);
        }
        // Mobile numbers have 11 digits and 3rd digit (after DDD) is 9
        return local.length === 11 && local.charAt(2) === '9';
    }

    // Extract WhatsApp number from URL
    extractWhatsAppFromUrl(url) {
        const patterns = [
            /wa\.me\/(\d{10,13})/i,
            /wa\.me\/55(\d{10,11})/i,
            /api\.whatsapp\.com\/send\/?\?phone=(\d{10,13})/i,
            /api\.whatsapp\.com\/send\/?\?phone=55(\d{10,11})/i,
            /whatsapp\.com\/.*phone=(\d{10,13})/i
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                let digits = match[1];
                // Ensure it has country code
                if (!digits.startsWith('55') && digits.length <= 11) {
                    digits = '55' + digits;
                }
                return this.formatPhone(digits);
            }
        }
        return null;
    }

    async investigate(websiteUrl, depth = 0, visitedUrls = new Set()) {
        const result = {
            email: '',
            instagram: '',
            cnpj: '',
            telefone: '',
            whatsapp: '',
            telefones: [],
            whatsappsFound: [],
            linksEncontrados: []
        };

        // Normalize initial URL
        let url = websiteUrl;
        if (!url.startsWith('http')) {
            url = `https://${url}`;
        }

        // Use a set to track visited URLs globally for this investigation tree
        // The visitedUrls set is passed by reference across recursive calls
        if (depth >= this.maxDepth) {
            return result;
        }

        // Remove trailing slash for consistency check
        const normalizedUrl = url.replace(/\/$/, '');
        if (visitedUrls.has(normalizedUrl)) {
            return result;
        }
        visitedUrls.add(normalizedUrl);

        // Also add the original url just in case
        visitedUrls.add(url);

        try {
            this.log(`🔎 Investigando: ${url} (profundidade ${depth}/${this.maxDepth})`);

            // FIRST: Try to extract data directly from the URL before navigating
            // This catches Instagram usernames, WhatsApp numbers, emails, etc. from the URL itself
            const urlExtracted = this.extractDataFromUrl(url);

            if (urlExtracted.instagram) {
                result.instagram = urlExtracted.instagram;
            }
            if (urlExtracted.whatsapp) {
                result.whatsapp = urlExtracted.whatsapp;
                result.whatsappsFound.push(urlExtracted.whatsapp);
            }
            if (urlExtracted.email) {
                result.email = urlExtracted.email;
            }
            if (urlExtracted.telefone) {
                result.telefones.push(urlExtracted.telefone);
            }

            // If we extracted everything we need from the URL, skip navigation
            if (!urlExtracted.shouldVisit) {
                this.log(`✅ Dados extraídos da URL, não precisa visitar a página`);
                return result;
            }

            // Check if this is a blocked link (generic pages like privacy, terms, etc.)
            if (this.isBlockedLink(url)) {
                this.log(`🚫 URL bloqueada, pulando navegação`);
                return result;
            }

            // Navigate to website
            await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });

            await randomDelay(1000, 2000);

            // Check redirects
            const currentUrl = this.page.url();
            const normalizedCurrent = currentUrl.replace(/\/$/, '');

            if (this.isNewDomain(url, currentUrl)) {
                if (visitedUrls.has(normalizedCurrent)) return result;
                visitedUrls.add(normalizedCurrent);
                this.log(`➡️ Redirecionado para: ${currentUrl}`);

                if (currentUrl.includes('instagram.com')) {
                    const instagramData = await this.extractInstagramProfile(currentUrl);
                    this.mergeResults(result, instagramData);
                    return result;
                }
                if (this.isBioLinkService(currentUrl)) {
                    const bioData = await this.extractFromBioLink(currentUrl);
                    this.mergeResults(result, bioData);
                    return result;
                }
            }

            // Extract data from current page
            const pageData = await this.extractFromPage();
            this.mergeResults(result, pageData);

            // SMART RECURSION LOGIC
            if (depth < this.maxDepth) {
                // First, extract data directly from URLs without visiting
                const linksToProcess = [];

                for (const link of pageData.linksEncontrados) {
                    const cleanLink = link.replace(/\/$/, '');
                    if (visitedUrls.has(cleanLink)) continue;

                    // Check if link is blocked (not relevant to lead)
                    if (this.isBlockedLink(link)) {
                        continue;
                    }

                    // Try to extract data directly from URL
                    const urlData = this.extractDataFromUrl(link);

                    if (urlData.whatsapp && !result.whatsapp) {
                        result.whatsapp = urlData.whatsapp;
                        if (!result.whatsappsFound) result.whatsappsFound = [];
                        result.whatsappsFound.push(urlData.whatsapp);
                    }
                    if (urlData.instagram && !result.instagram) {
                        result.instagram = urlData.instagram;
                    }
                    if (urlData.email && !result.email) {
                        result.email = urlData.email;
                    }
                    if (urlData.telefone) {
                        if (!result.telefones) result.telefones = [];
                        if (!result.telefones.includes(urlData.telefone)) {
                            result.telefones.push(urlData.telefone);
                        }
                    }

                    // If URL extraction was sufficient, skip visiting this link
                    if (!urlData.shouldVisit) {
                        visitedUrls.add(cleanLink); // Mark as processed
                        continue;
                    }

                    // Otherwise, add to links to visit
                    linksToProcess.push(link);
                }

                // Check what data is still missing
                const missingFields = this.getMissingFields(result);

                // If we have all data, no need to go deeper
                if (missingFields.length === 0) {
                    this.log(`✅ Todos os dados encontrados! Parando investigação.`);
                    return result;
                }

                // Prioritize links based on what's missing
                const prioritizedLinks = this.prioritizeLinks(linksToProcess, missingFields, result);

                // Smart limit based on depth
                // Depth 0: follow up to 5 links
                // Depth 1: follow up to 3 links  
                // Depth 2+: follow up to 2 links
                const limit = depth === 0 ? 5 : (depth === 1 ? 3 : 2);
                const linksToFollow = prioritizedLinks.slice(0, limit);

                this.log(`📋 ${linksToFollow.length} links para investigar (faltando: ${missingFields.join(', ')})`);

                for (const link of linksToFollow) {
                    try {
                        const subData = await this.investigate(link, depth + 1, visitedUrls);
                        this.mergeResults(result, subData);

                        // Check if we now have all data - early exit
                        const stillMissing = this.getMissingFields(result);
                        if (stillMissing.length === 0) {
                            this.log(`✅ Dados completos! Encerrando branch.`);
                            break;
                        }
                    } catch (e) { /* Ignore nav errors */ }
                }
            }

            return result;

        } catch (error) {
            this.log(`❌ Erro ao investigar ${websiteUrl}: ${error.message}`);
            return result;
        }
    }

    async extractFromPage() {
        const pageResult = await this.page.evaluate((patterns) => {
            const result = {
                email: '',
                instagram: '',
                cnpj: '',
                telefones: [],
                whatsappLinks: [],
                linksEncontrados: []
            };

            // Get page text content
            const bodyText = document.body?.innerText || '';
            const html = document.documentElement?.outerHTML || '';

            // Extract emails
            const emailPattern = new RegExp(patterns.email.source, patterns.email.flags);
            const emails = bodyText.match(emailPattern) || [];
            // Filter out common non-email patterns
            const validEmails = emails.filter(e =>
                !e.includes('example.com') &&
                !e.includes('youremail') &&
                !e.includes('email@')
            );
            if (validEmails.length > 0) {
                result.email = validEmails[0];
            }

            // Extract CNPJ
            const cnpjPattern = new RegExp(patterns.cnpj.source, patterns.cnpj.flags);
            const cnpjs = bodyText.match(cnpjPattern) || [];
            if (cnpjs.length > 0) {
                result.cnpj = cnpjs[0];
            }

            // Extract phones
            const phonePattern = new RegExp(patterns.phone.source, patterns.phone.flags);
            const phones = bodyText.match(phonePattern) || [];
            // Clean and validate phones
            const validPhones = phones
                .map(p => p.trim())
                .filter(p => {
                    const digits = p.replace(/\D/g, '');
                    return digits.length >= 10 && digits.length <= 13;
                });
            result.telefones = [...new Set(validPhones)].slice(0, 5);

            // Extract WhatsApp links
            const whatsappLinks = document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp.com"], a[href*="api.whatsapp"]');
            for (const link of whatsappLinks) {
                const href = link.href || '';
                if (href && !result.whatsappLinks.includes(href)) {
                    result.whatsappLinks.push(href);
                }
            }

            // Extract Instagram - from links first
            const instagramLinks = document.querySelectorAll('a[href*="instagram.com"]');
            for (const link of instagramLinks) {
                const match = link.href.match(/instagram\.com\/([a-zA-Z0-9_.]{3,30})/i);
                if (match && !['p', 'reel', 'stories', 'explore'].includes(match[1])) {
                    result.instagram = match[1];
                    break;
                }
            }

            // If no Instagram from links, try text patterns
            if (!result.instagram) {
                // Look for @username patterns
                const atMatches = bodyText.match(/@([a-zA-Z0-9_.]{3,30})/g) || [];
                for (const match of atMatches) {
                    const username = match.substring(1);
                    // Skip if looks like an email
                    if (!username.includes('.') || username.match(/^[a-zA-Z0-9_]+$/)) {
                        result.instagram = username;
                        break;
                    }
                }
            }

            // Collect interesting links for deeper investigation
            const links = document.querySelectorAll('a[href]');
            const contactKeywords = ['contato', 'contact', 'sobre', 'about', 'fale-conosco', 'fale conosco'];

            for (const link of links) {
                const href = link.href || '';
                const text = (link.textContent || '').toLowerCase();

                // Contact page links
                if (contactKeywords.some(k => href.toLowerCase().includes(k) || text.includes(k))) {
                    if (!result.linksEncontrados.includes(href)) {
                        result.linksEncontrados.push(href);
                    }
                }

                // Bio link services
                const bioServices = ['linktr.ee', 'lnk.bio', 'bio.link', 'linkin.bio', 'beacons.ai'];
                for (const service of bioServices) {
                    if (href.includes(service) && !result.linksEncontrados.includes(href)) {
                        result.linksEncontrados.unshift(href); // Priority
                    }
                }
            }

            return result;
        }, {
            email: this.patterns.email,
            cnpj: this.patterns.cnpj,
            phone: this.patterns.phone
        });

        // Process WhatsApp links to extract numbers (back in Node context)
        for (const waLink of pageResult.whatsappLinks || []) {
            const waNum = this.extractWhatsAppFromUrl(waLink);
            if (waNum) {
                if (!pageResult.whatsappsFound) pageResult.whatsappsFound = [];
                pageResult.whatsappsFound.push(waNum);
            }
        }

        return pageResult;
    }

    async extractFromBioLink(url) {
        this.log(`📋 Extraindo de bio link: ${url}`);

        try {
            await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });

            await randomDelay(2000, 3000);

            const data = await this.page.evaluate(() => {
                const result = {
                    email: '',
                    instagram: '',
                    telefones: [],
                    linksEncontrados: []
                };

                // Get all links
                const links = document.querySelectorAll('a[href]');

                for (const link of links) {
                    const href = link.href || '';

                    // Instagram
                    if (href.includes('instagram.com')) {
                        const match = href.match(/instagram\.com\/([a-zA-Z0-9_.]{3,30})/i);
                        if (match && !['p', 'reel', 'stories'].includes(match[1])) {
                            result.instagram = match[1];
                        }
                    }

                    // Email
                    if (href.startsWith('mailto:')) {
                        result.email = href.replace('mailto:', '').split('?')[0];
                    }

                    // WhatsApp (contains phone)
                    if (href.includes('wa.me') || href.includes('whatsapp')) {
                        const phoneMatch = href.match(/\d{10,13}/);
                        if (phoneMatch) {
                            result.telefones.push(phoneMatch[0]);
                        }
                    }

                    // Phone
                    if (href.startsWith('tel:')) {
                        result.telefones.push(href.replace('tel:', ''));
                    }

                    // Other links for further investigation
                    if (!href.includes('instagram.com') &&
                        !href.includes('facebook.com') &&
                        !href.includes('twitter.com') &&
                        !href.includes('tiktok.com') &&
                        !href.includes('youtube.com') &&
                        !href.startsWith('mailto:') &&
                        !href.startsWith('tel:') &&
                        !href.includes(window.location.hostname)) {
                        result.linksEncontrados.push(href);
                    }
                }

                // Also check page text for email
                const pageText = document.body?.innerText || '';
                const emailMatch = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emailMatch && !result.email) {
                    result.email = emailMatch[0];
                }

                return result;
            });

            return data;

        } catch (error) {
            this.log(`❌ Erro ao extrair bio link: ${error.message}`);
            return { email: '', instagram: '', telefones: [], linksEncontrados: [] };
        }
    }

    async extractInstagramProfile(url) {
        this.log(`📸 Acessando perfil Instagram: ${url}`);

        try {
            await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });

            await randomDelay(2000, 4000);

            const data = await this.page.evaluate(() => {
                const result = {
                    email: '',
                    instagram: '',
                    telefones: [],
                    linksEncontrados: []
                };

                // Try to get bio text
                const bioSelectors = [
                    'div.-vDIg span',
                    'div._aa_c span',
                    'section main header section span',
                    'meta[property="og:description"]'
                ];

                let bioText = '';
                for (const selector of bioSelectors) {
                    const el = document.querySelector(selector);
                    if (el) {
                        bioText = el.textContent || el.getAttribute('content') || '';
                        if (bioText) break;
                    }
                }

                // Extract email from bio
                const emailMatch = bioText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emailMatch) {
                    result.email = emailMatch[0];
                }

                // Extract phone from bio
                const phoneMatch = bioText.match(/(?:\+55\s?)?(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}/);
                if (phoneMatch) {
                    result.telefones.push(phoneMatch[0]);
                }

                // Look for link in bio
                const linkInBio = document.querySelector('a[href*="linktr.ee"], a[href*="lnk.bio"], a[href*="bio.link"]');
                if (linkInBio) {
                    result.linksEncontrados.push(linkInBio.href);
                }

                // Also check external link button
                const externalLinks = document.querySelectorAll('a[href]:not([href*="instagram.com"])');
                for (const link of externalLinks) {
                    const href = link.href || '';
                    if (href && !href.includes('facebook.com') && !href.includes('l.instagram.com')) {
                        result.linksEncontrados.push(href);
                    }
                }

                return result;
            });

            // If found a linktree link, follow it
            if (data.linksEncontrados.length > 0 && !data.email) {
                for (const link of data.linksEncontrados.slice(0, 2)) {
                    if (this.isBioLinkServiceUrl(link)) {
                        const bioData = await this.extractFromBioLink(link);
                        this.mergeResults(data, bioData);
                        break;
                    }
                }
            }

            return data;

        } catch (error) {
            this.log(`❌ Erro ao acessar Instagram: ${error.message}`);
            return { email: '', instagram: '', telefones: [], linksEncontrados: [] };
        }
    }

    isBioLinkServiceUrl(url) {
        return this.bioLinkServices.some(service => url.includes(service));
    }

    async findContactLinks() {
        return await this.page.evaluate(() => {
            const links = [];
            const keywords = ['contato', 'contact', 'sobre', 'about', 'fale'];

            document.querySelectorAll('a[href]').forEach(link => {
                const href = link.href || '';
                const text = (link.textContent || '').toLowerCase();

                if (keywords.some(k => href.toLowerCase().includes(k) || text.includes(k))) {
                    if (!links.includes(href)) {
                        links.push(href);
                    }
                }
            });

            return links.slice(0, 5);
        });
    }

    isNewDomain(originalUrl, currentUrl) {
        try {
            const original = new URL(originalUrl);
            const current = new URL(currentUrl);
            return original.hostname !== current.hostname;
        } catch (e) {
            return false;
        }
    }

    isBioLinkService(url) {
        return this.bioLinkServices.some(service => url.includes(service));
    }

    mergeResults(target, source) {
        if (source.email && !target.email) {
            target.email = source.email;
        }
        if (source.instagram && !target.instagram) {
            target.instagram = source.instagram;
        }
        if (source.cnpj && !target.cnpj) {
            target.cnpj = source.cnpj;
        }
        if (source.telefones && source.telefones.length > 0) {
            target.telefones = [...new Set([...target.telefones, ...source.telefones])];
        }
        if (source.whatsappsFound && source.whatsappsFound.length > 0) {
            target.whatsappsFound = [...new Set([...(target.whatsappsFound || []), ...source.whatsappsFound])];
        }
        if (source.linksEncontrados && source.linksEncontrados.length > 0) {
            target.linksEncontrados = [...new Set([...target.linksEncontrados, ...source.linksEncontrados])];
        }
    }

    // Finalize the result: format phones, determine main telefone and whatsapp
    finalizeResult(result) {
        // Format all telefones
        const formattedPhones = result.telefones
            .map(p => this.formatPhone(p))
            .filter(p => p !== null);

        // Remove duplicates based on digits only
        const uniquePhones = [];
        const seenDigits = new Set();
        for (const phone of formattedPhones) {
            const digits = phone.replace(/\D/g, '');
            if (!seenDigits.has(digits)) {
                seenDigits.add(digits);
                uniquePhones.push(phone);
            }
        }

        result.telefones = uniquePhones;

        // Set main telefone (first one found)
        if (!result.telefone && uniquePhones.length > 0) {
            result.telefone = uniquePhones[0];
        }

        // Set whatsapp: prefer explicit whatsapp links, then mobile numbers
        if (!result.whatsapp) {
            if (result.whatsappsFound && result.whatsappsFound.length > 0) {
                result.whatsapp = result.whatsappsFound[0];
            } else {
                // Find first mobile number
                for (const phone of uniquePhones) {
                    if (this.isMobileNumber(phone)) {
                        result.whatsapp = phone;
                        break;
                    }
                }
            }
        }

        // Clean up internal arrays
        delete result.whatsappLinks;

        return result;
    }
}

module.exports = WebsiteInvestigator;
