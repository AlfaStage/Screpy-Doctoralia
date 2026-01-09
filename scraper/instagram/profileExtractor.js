/**
 * Instagram Scraper - Profile Extractor
 * Extracts data from individual Instagram profiles
 */

class ProfileExtractor {
    constructor(page) {
        this.page = page;
    }

    /**
     * Extract data from a profile page
     * @param {string} username - Username or URL to extract
     * @param {Function} logCallback - Callback for logging
     * @returns {Object} Profile data
     */
    async extractProfile(username, logCallback = () => { }) {
        const profileUrl = this.normalizeProfileUrl(username);

        try {
            logCallback({ message: `📄 Acessando perfil: ${profileUrl}` });

            await this.page.goto(profileUrl, {
                waitUntil: 'load',
                timeout: 30000
            });

            // Wait for profile to load or error
            await Promise.race([
                this.page.waitForSelector('header', { timeout: 10000 }),
                this.page.waitForFunction(() =>
                    document.body.innerText.includes("isn't available") ||
                    document.body.innerText.includes("não está disponível"),
                    { timeout: 10000 }
                )
            ]).catch(() => { });

            // Check if profile exists
            const notFound = await this.page.evaluate(() => {
                const text = document.body.innerText;
                return text.includes("Sorry, this page isn't available") ||
                    text.includes("Página não encontrada") ||
                    text.includes("não está disponível");
            });

            if (notFound) {
                throw new Error(`Perfil não encontrado ou indisponível: ${username}`);
            }

            // Check for private account
            const isPrivate = await this.page.$('article h2');
            const privateText = isPrivate ? await this.page.evaluate(el => el.textContent, isPrivate) : '';

            const profileData = await this.page.evaluate(() => {
                const data = {
                    nome: '',
                    username: '',
                    bio: '',
                    website: '',
                    telefone: '',
                    email: '',
                    whatsapp: '',
                    followers: '',
                    following: '',
                    posts: '',
                    categoria: '',
                    isPrivate: false,
                    isVerified: false
                };

                // Extract username from URL
                const pathParts = window.location.pathname.split('/').filter(Boolean);
                data.username = pathParts[0] || '';

                // Try to find the name (usually in header section)
                const headerSection = document.querySelector('header section');
                if (headerSection) {
                    // Name is usually in a span or h1 within header
                    const nameEl = headerSection.querySelector('span[dir="auto"]');
                    if (nameEl) {
                        data.nome = nameEl.textContent.trim();
                    }
                }

                // Get bio
                const bioSection = document.querySelector('header section > div:last-child');
                if (bioSection) {
                    const bioSpans = bioSection.querySelectorAll('span');
                    for (const span of bioSpans) {
                        const text = span.textContent.trim();
                        if (text && text.length > 10 && !text.includes('followers') && !text.includes('following')) {
                            data.bio = text;
                            break;
                        }
                    }
                }

                // Get category (usually in a specific div/span color-coded gray)
                // Selectors for category: div._ap30 or span.x1rg5ohy within header section
                const categoryEl = document.querySelector('header section div span.x1rg5ohy') ||
                    document.querySelector('header section div._ap30') ||
                    Array.from(document.querySelectorAll('header span')).find(el =>
                        el.className.includes('x193iq5w') && // Often gray text class
                        el.textContent.length < 30 &&
                        !el.querySelector('a') // Categories aren't links usually
                    );

                if (categoryEl) {
                    data.categoria = categoryEl.textContent.trim();
                }

                // Alternative bio extraction
                if (!data.bio) {
                    const allSpans = document.querySelectorAll('header span');
                    for (const span of allSpans) {
                        const text = span.textContent.trim();
                        if (text.length > 20 && !text.match(/^\d+$/) && !text.includes('posts') && !text.includes('followers')) {
                            data.bio = text;
                            break;
                        }
                    }
                }

                // Get website link
                const websiteLink = document.querySelector('header a[rel="me nofollow noopener noreferrer"]');
                if (websiteLink) {
                    data.website = websiteLink.href || websiteLink.textContent.trim();
                }

                // Alternative website extraction
                if (!data.website) {
                    const links = document.querySelectorAll('header a');
                    for (const link of links) {
                        const href = link.href || '';
                        if (href && !href.includes('instagram.com') && !href.includes('facebook.com')) {
                            data.website = href;
                            break;
                        }
                    }
                }

                // Get follower/following counts
                const statsList = document.querySelectorAll('header ul li');
                if (statsList.length >= 3) {
                    const getText = (el) => el.textContent.replace(/[^\d]/g, '');
                    data.posts = getText(statsList[0]);
                    data.followers = getText(statsList[1]);
                    data.following = getText(statsList[2]);
                }

                // Check if verified
                const verifiedBadge = document.querySelector('header svg[aria-label="Verified"]');
                data.isVerified = !!verifiedBadge;

                // Check if private
                const privateText = document.body.innerText;
                data.isPrivate = privateText.includes('This Account is Private') ||
                    privateText.includes('Esta conta é privada');

                return data;
            });

            // Extract contact info from bio using regex
            if (profileData.bio) {
                const contacts = this.extractContactsFromBio(profileData.bio);
                if (contacts.email && !profileData.email) profileData.email = contacts.email;
                if (contacts.telefone && !profileData.telefone) profileData.telefone = contacts.telefone;
                if (contacts.whatsapp && !profileData.whatsapp) profileData.whatsapp = contacts.whatsapp;
            }

            // Try to detect WhatsApp link
            const whatsappLink = await this.page.$('a[href*="wa.me"], a[href*="whatsapp"]');
            if (whatsappLink) {
                const href = await this.page.evaluate(el => el.href, whatsappLink);
                const match = href.match(/(\+?\d{10,15})/);
                if (match) {
                    profileData.whatsapp = this.formatPhone(match[1]);
                }
            }

            // If phone found but no whatsapp, check if it's mobile
            if (profileData.telefone && !profileData.whatsapp) {
                if (this.isMobileNumber(profileData.telefone)) {
                    profileData.whatsapp = profileData.telefone;
                }
            }

            logCallback({ message: `✅ Perfil extraído: @${profileData.username}` });
            return profileData;

        } catch (error) {
            logCallback({ message: `❌ Erro ao extrair perfil: ${error.message}` });
            throw error;
        }
    }

    /**
     * Normalize username or URL to profile URL
     */
    normalizeProfileUrl(input) {
        if (!input) return '';

        // Remove @ if present
        let username = input.trim().replace(/^@/, '');

        // If it's already a URL, extract username
        if (username.includes('instagram.com')) {
            const match = username.match(/instagram\.com\/([^\/\?]+)/);
            if (match) {
                username = match[1];
            }
        }

        return `https://www.instagram.com/${username}/`;
    }

    /**
     * Extract contact information from bio text using regex
     */
    extractContactsFromBio(bio) {
        const result = {
            email: null,
            telefone: null,
            whatsapp: null
        };

        if (!bio) return result;

        // Email patterns
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
        const emails = bio.match(emailRegex);
        if (emails && emails.length > 0) {
            result.email = emails[0].toLowerCase();
        }

        // Phone patterns (Brazilian format)
        const phonePatterns = [
            /(?:whatsapp|wpp|whats|zap|contato|tel|fone|📞|📱|☎️)?[:\s]*(?:\+?55)?[\s.-]?\(?(\d{2})\)?[\s.-]?(\d{4,5})[\s.-]?(\d{4})/gi,
            /(?:\+55)?[\s]?\(?\d{2}\)?[\s]?\d{4,5}[-\s]?\d{4}/g,
            /\d{2}[\s.-]?\d{4,5}[\s.-]?\d{4}/g
        ];

        for (const pattern of phonePatterns) {
            const matches = bio.match(pattern);
            if (matches && matches.length > 0) {
                const phone = this.formatPhone(matches[0]);
                if (phone) {
                    result.telefone = phone;

                    // Check if explicitly mentioned as WhatsApp
                    const beforeMatch = bio.toLowerCase().substring(0, bio.toLowerCase().indexOf(matches[0]));
                    if (beforeMatch.includes('whatsapp') || beforeMatch.includes('wpp') ||
                        beforeMatch.includes('whats') || beforeMatch.includes('zap')) {
                        result.whatsapp = phone;
                    }
                    break;
                }
            }
        }

        // WhatsApp link patterns
        const waLinkRegex = /wa\.me\/(\+?\d+)/gi;
        const waLinks = bio.match(waLinkRegex);
        if (waLinks && waLinks.length > 0) {
            const match = waLinks[0].match(/(\d+)/);
            if (match) {
                result.whatsapp = this.formatPhone(match[1]);
            }
        }

        return result;
    }

    /**
     * Format phone number to standard format
     */
    formatPhone(phone) {
        if (!phone) return null;

        // Remove all non-digits
        const digits = phone.replace(/\D/g, '');

        if (digits.length < 10) return null;

        // Brazilian format
        if (digits.length === 11) {
            // Mobile with 9th digit
            return `+55 (${digits.substring(0, 2)}) ${digits.substring(2, 7)}-${digits.substring(7)}`;
        } else if (digits.length === 10) {
            // Landline
            return `+55 (${digits.substring(0, 2)}) ${digits.substring(2, 6)}-${digits.substring(6)}`;
        } else if (digits.length === 13 && digits.startsWith('55')) {
            // Already has country code
            const ddd = digits.substring(2, 4);
            const rest = digits.substring(4);
            if (rest.length === 9) {
                return `+55 (${ddd}) ${rest.substring(0, 5)}-${rest.substring(5)}`;
            } else {
                return `+55 (${ddd}) ${rest.substring(0, 4)}-${rest.substring(4)}`;
            }
        }

        return `+${digits}`;
    }

    /**
     * Check if phone number is mobile (Brazilian)
     */
    isMobileNumber(phone) {
        if (!phone) return false;
        const digits = phone.replace(/\D/g, '');

        // Brazilian mobile starts with 9 after DDD
        if (digits.length >= 11) {
            const afterDDD = digits.length === 13 ? digits.substring(4, 5) : digits.substring(2, 3);
            return afterDDD === '9';
        }
        return false;
    }
}

module.exports = ProfileExtractor;
