/**
 * Instagram Scraper - Authentication Handler
 * Manages session cookies and login state
 */

const fs = require('fs').promises;
const path = require('path');

class AuthHandler {
    constructor(page, logCallback = () => { }, screenshotCallback = null) {
        this.page = page;
        this.logCallback = logCallback;
        this.screenshotCallback = screenshotCallback;
        this.sessionPath = path.join(__dirname, '..', '..', 'data', 'instagram_session.json');
        this.isLoggedIn = false;
    }

    /**
     * Helper to capture screenshot if callback provided
     */
    async captureShot(action) {
        if (this.screenshotCallback) await this.screenshotCallback(action);
    }

    /**
     * Login with credentials
     * @param {string} username
     * @param {string} password
     * @param {function} challengeCallback - Callback to handle 2FA challenges
     */
    async login(username, password, challengeCallback) {
        try {
            this.logCallback({ message: '🔑 Iniciando login com credenciais...' });

            await this.page.goto('https://www.instagram.com/accounts/login/', {
                waitUntil: 'load',
                timeout: 45000
            });

            await this.delay(2000);

            // Check if already logged in
            if (await this.checkSession()) {
                this.logCallback({ message: '✅ Já autenticado!' });
                return true;
            }

            // Fill credentials
            await this.page.type('input[name="username"]', username, { delay: 50 });
            await this.page.type('input[name="password"]', password, { delay: 50 });
            await this.captureShot('LOGIN');

            // Click login

            // Click login
            const loginBtn = await this.page.$('button[type="submit"]');
            if (loginBtn) {
                await loginBtn.click();
            } else {
                await this.page.keyboard.press('Enter');
            }

            this.logCallback({ message: '⏳ Aguardando autenticação...' });

            // Wait for navigation or error
            try {
                await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
            } catch (e) {
                // Navigation might not happen if 2FA or error appears on same page
            }

            // Handle various intermediate screens
            const afterLoginUrl = this.page.url();
            this.logCallback({ message: `🌐 URL após login: ${afterLoginUrl}` });

            // Check for "Save Info" or "Turn on Notifications"
            try {
                const buttons = await this.page.$$('button');
                for (const btn of buttons) {
                    const text = await this.page.evaluate(el => el.textContent, btn);
                    if (text.includes('Not Now') || text.includes('Agora não') || text.includes('Pular')) {
                        await btn.click();
                        await this.delay(2000);
                    }
                }
            } catch (e) { }

            // Check if account is suspended or has a different block
            const isSuspended = await this.page.evaluate(() =>
                document.body.innerText.includes('Your account has been disabled') ||
                document.body.innerText.includes('Sua conta foi desativada')
            );
            if (isSuspended) {
                this.logCallback({ message: '❌ CONTA DESATIVADA PELO INSTAGRAM' });
                return false;
            }

            // Check login status
            if (await this.isPageLoggedIn()) {
                this.logCallback({ message: '✅ Login efetuado com sucesso!' });
                // Save session cookies
                const cookies = await this.getCurrentCookies();
                await this.saveSession(cookies);
                return true;
            }

            // Check for Errors on page
            const errorMsg = await this.page.evaluate(() => {
                const el = document.getElementById('slfErrorAlert') ||
                    document.querySelector('p[aria-atomic="true"]');
                return el ? el.textContent : null;
            });

            if (errorMsg && errorMsg.length > 5) {
                this.logCallback({ message: `❌ Erro de Login: ${errorMsg}` });
                return false;
            }

            // Check for Challenge/2FA
            const currentUrl = this.page.url();
            const isChallenge = currentUrl.includes('/challenge/') ||
                await this.page.$('input[name="security_code"]') ||
                await this.page.$('input[name="verificationCode"]');

            if (isChallenge) {
                this.logCallback({ message: '⚠️ Detectado desafio de segurança (2FA/SMS)' });
                return await this.handleChallenge(challengeCallback);
            }

            // If we are still on login page but no error, maybe it's thinking
            await this.delay(3000);
            if (await this.isPageLoggedIn()) {
                this.logCallback({ message: '✅ Login efetuado (atrasado)!' });
                const cookies = await this.getCurrentCookies();
                await this.saveSession(cookies);
                return true;
            }

            return false;

        } catch (error) {
            this.logCallback({ message: `❌ Erro inesperado no login: ${error.message}` });
            return false;
        }
    }

    /**
     * Handle Security Challenge
     */
    async handleChallenge(challengeCallback) {
        if (!challengeCallback) {
            this.logCallback({ message: '❌ Callback de desafio não fornecido' });
            return false;
        }

        try {
            // Check if it's asking to send code or enter code
            const sendCodeBtn = await this.page.$x("//button[contains(text(), 'Send Security Code') or contains(text(), 'Enviar código')]");
            if (sendCodeBtn.length > 0) {
                this.logCallback({ message: '📨 Solicitando envio do código...' });
                await sendCodeBtn[0].click();
                await this.page.waitForNavigation({ waitUntil: 'load', timeout: 30000 });
            }

            // Now it should be asking for the code
            this.logCallback({ message: '🔒 Aguardando código de segurança do usuário...' });
            await this.captureShot('LOGIN_CHALLENGE');

            const code = await challengeCallback('Digite o código de segurança enviado por SMS/Email ou App.');



            if (!code) { this.logCallback({ message: '❌ Código não fornecido' }); return false; }

            this.logCallback({ message: '🔑 Recebido código, enviando...' });

            // Enter code
            await this.page.type('input[name="security_code"], input[name="verificationCode"]', code, { delay: 100 });

            const submitBtn = await this.page.$('button[type="button"], button[type="submit"]'); // Usually a generic button inside form
            if (submitBtn) await submitBtn.click();
            else await this.page.keyboard.press('Enter');

            await this.page.waitForNavigation({ waitUntil: 'load', timeout: 45000 });

            if (await this.checkSession()) {
                this.logCallback({ message: '✅ Autenticado após verificação!' });
                const cookies = await this.getCurrentCookies();
                await this.saveSession(cookies);
                return true;
            } else {
                this.logCallback({ message: '❌ Verificação falhou.' });
                return false;
            }

        } catch (error) {
            this.logCallback({ message: `❌ Erro no desafio: ${error.message}` });
            return false;
        }
    }

    /**
     * Evaluate if the current page indicates a logged-in state
     * DOES NOT NAVIGATE
     */
    async isPageLoggedIn() {
        try {
            return await this.page.evaluate(() => {
                // Look for profile avatar in nav (indicates logged in)
                const profileNav = document.querySelector('a[href*="/accounts/activity/"]') ||
                    document.querySelector('svg[aria-label="Home"]') ||
                    document.querySelector('a[href^="/direct/"]') ||
                    document.querySelector('svg[aria-label="New Post"]') ||
                    document.querySelector('a[href="/reels/"]');

                // Look for login indicators (negative signals)
                const loginInputs = document.querySelector('input[name="username"]') ||
                    document.querySelector('input[name="password"]');

                const loginButtons = Array.from(document.querySelectorAll('button')).find(el =>
                    el.textContent.includes('Log In') ||
                    el.textContent.includes('Entrar')
                );

                // Challenge indicators
                const isChallenge = window.location.href.includes('/challenge/') ||
                    !!document.querySelector('input[name="security_code"]');

                return !!profileNav && !loginInputs && !loginButtons && !isChallenge;
            });
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if current session is valid by navigating to Home
     * @returns {boolean} True if logged in
     */
    async checkSession() {
        try {
            // Only navigate if we aren't already on a helpful page or to be sure
            const currentUrl = this.page.url();
            if (!currentUrl.includes('instagram.com')) {
                await this.page.goto('https://www.instagram.com/', {
                    waitUntil: 'networkidle2',
                    timeout: 30000
                });
            } else if (currentUrl.includes('/accounts/login') || currentUrl.includes('/challenge')) {
                // We are on a login/challenge page, definitely not "session valid" (unless it just finished)
            } else {
                // Already on IG, maybe just check current page first
                if (await this.isPageLoggedIn()) return true;
                // If not sure, go to home
                await this.page.goto('https://www.instagram.com/', {
                    waitUntil: 'load',
                    timeout: 45000
                });
            }

            await this.delay(2000);
            const isLoggedIn = await this.isPageLoggedIn();
            this.isLoggedIn = isLoggedIn;
            return isLoggedIn;

        } catch (error) {
            this.logCallback({ message: `⚠️ Erro ao verificar sessão: ${error.message}` });
            return false;
        }
    }

    /**
     * Apply cookies from user input
     * @param {Object} cookies - Cookie object with sessionid, csrftoken, etc.
     * @returns {boolean} True if cookies were applied successfully
     */
    async applyCookies(cookies) {
        try {
            if (!cookies || !cookies.sessionid) {
                this.logCallback({ message: '❌ Cookie sessionid é obrigatório' });
                return false;
            }

            this.logCallback({ message: '🍪 Aplicando cookies de sessão...' });

            // Format cookies for Puppeteer
            const puppeteerCookies = this.formatCookies(cookies);

            // Set cookies
            await this.page.setCookie(...puppeteerCookies);

            // Verify login
            const isValid = await this.checkSession();

            if (isValid) {
                this.logCallback({ message: '✅ Sessão autenticada com sucesso!' });

                // Save session for reuse
                await this.saveSession(cookies);

                return true;
            } else {
                this.logCallback({ message: '❌ Cookies inválidos ou expirados' });
                return false;
            }

        } catch (error) {
            this.logCallback({ message: `❌ Erro ao aplicar cookies: ${error.message}` });
            return false;
        }
    }

    /**
     * Format cookies for Puppeteer
     */
    formatCookies(cookies) {
        const domain = '.instagram.com';
        const puppeteerCookies = [];

        const cookieNames = ['sessionid', 'csrftoken', 'ds_user_id', 'rur', 'mid', 'ig_did'];

        for (const name of cookieNames) {
            if (cookies[name]) {
                puppeteerCookies.push({
                    name: name,
                    value: cookies[name],
                    domain: domain,
                    path: '/',
                    httpOnly: name === 'sessionid',
                    secure: true,
                    sameSite: 'None'
                });
            }
        }

        return puppeteerCookies;
    }

    /**
     * Save session to file for reuse
     */
    async saveSession(cookies) {
        try {
            await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
            await fs.writeFile(this.sessionPath, JSON.stringify({
                cookies: cookies,
                savedAt: new Date().toISOString()
            }, null, 2));
            this.logCallback({ message: '💾 Sessão salva para reutilização' });
        } catch (error) {
            // Non-critical error
            console.log('Failed to save session:', error.message);
        }
    }

    /**
     * Load previously saved session
     * @returns {Object|null} Saved cookies or null
     */
    async loadSession() {
        try {
            const data = await fs.readFile(this.sessionPath, 'utf8');
            const session = JSON.parse(data);

            // Check if session is not too old (7 days)
            const savedAt = new Date(session.savedAt);
            const now = new Date();
            const daysDiff = (now - savedAt) / (1000 * 60 * 60 * 24);

            if (daysDiff > 7) {
                this.logCallback({ message: '⚠️ Sessão salva expirada (mais de 7 dias)' });
                return null;
            }

            this.logCallback({ message: '📂 Sessão anterior carregada' });
            return session.cookies;

        } catch (error) {
            // No saved session
            return null;
        }
    }

    /**
     * Try to restore previous session
     * @returns {boolean} True if session was restored
     */
    async tryRestoreSession() {
        const savedCookies = await this.loadSession();

        if (savedCookies) {
            const success = await this.applyCookies(savedCookies);
            return success;
        }

        return false;
    }

    /**
     * Clear saved session
     */
    async clearSession() {
        try {
            await fs.unlink(this.sessionPath);
            this.isLoggedIn = false;
            this.logCallback({ message: '🗑️ Sessão removida' });
        } catch (error) {
            // Ignore if file doesn't exist
        }
    }

    /**
     * Extract cookies from browser for user
     * Useful for helping user get their own cookies
     */
    async getCurrentCookies() {
        try {
            const cookies = await this.page.cookies('https://www.instagram.com');
            const relevantCookies = {};

            for (const cookie of cookies) {
                if (['sessionid', 'csrftoken', 'ds_user_id', 'rur', 'mid', 'ig_did'].includes(cookie.name)) {
                    relevantCookies[cookie.name] = cookie.value;
                }
            }

            return relevantCookies;
        } catch (error) {
            return null;
        }
    }

    /**
     * Check if a feature requires authentication
     */
    requiresAuth(feature) {
        const authRequired = ['followers', 'following', 'private_profile', 'dm'];
        return authRequired.includes(feature);
    }

    /**
     * Helper: delay execution
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = AuthHandler;
