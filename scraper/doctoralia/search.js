const { randomDelay, humanType, scrollPage } = require('../utils');

class SearchHandler {
    constructor(page) {
        this.page = page;
        this.currentPage = 1;
        this.baseSearchUrl = '';
    }

    async performSearch(specialty, city, progressCallback) {
        console.log(`Searching for: ${specialty} in ${city}`);

        // Navigate to Doctoralia homepage with retry
        let homeSuccess = false;
        let homeAttempts = 0;
        const maxAttempts = 3;

        while (!homeSuccess && homeAttempts < maxAttempts) {
            homeAttempts++;
            try {
                if (homeAttempts > 1) {
                    const delay = 3000 * homeAttempts;
                    if (progressCallback) progressCallback({ message: `⚠️ Tentativa de conexão ${homeAttempts}/${maxAttempts} em ${delay / 1000}s...` });
                    await randomDelay(delay, delay + 2000);
                }

                await this.page.goto('https://www.doctoralia.com.br/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 90000
                });
                homeSuccess = true;
            } catch (e) {
                console.log(`Homepage navigation error (Attempt ${homeAttempts}):`, e.message);
                if (homeAttempts === maxAttempts) {
                    if (progressCallback) progressCallback({ message: `❌ Falha ao acessar home após ${maxAttempts} tentativas.` });
                    throw e;
                }
            }
        }

        await randomDelay(1000, 2000);

        // Construct direct URL based on filters
        let searchUrl = 'https://www.doctoralia.com.br/pesquisa';
        const params = [];

        if (specialty && specialty !== 'Médico') {
            params.push(`q=${encodeURIComponent(specialty)}`);
        }

        if (city) {
            params.push(`loc=${encodeURIComponent(city)}`);
        }

        if (params.length > 0) {
            searchUrl += `?${params.join('&')}`;
        } else {
            searchUrl += `?q=Médico`;
        }

        console.log('Navigating to search URL:', searchUrl);
        this.baseSearchUrl = searchUrl;
        if (progressCallback) progressCallback({ status: 'searching', message: `Navegando para resultados: ${searchUrl}` });

        // Retry loop for search URL navigation
        let searchSuccess = false;
        let searchAttempts = 0;

        while (!searchSuccess && searchAttempts < maxAttempts) {
            searchAttempts++;
            try {
                if (searchAttempts > 1) {
                    const delay = 3000 * searchAttempts;
                    if (progressCallback) progressCallback({ message: `⚠️ Tentativa de busca ${searchAttempts}/${maxAttempts} em ${delay / 1000}s...` });
                    await randomDelay(delay, delay + 2000);
                }

                await this.page.goto(searchUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 120000
                });
                searchSuccess = true;
            } catch (error) {
                console.log(`Search navigation error (Attempt ${searchAttempts}):`, error.message);
                if (searchAttempts === maxAttempts) throw error;
            }
        }

        return true;
    }

    async collectProfileUrls(targetQuantity, progressCallback) {
        // Buscar 20% a mais para ter margem de erros e pulados
        const adjustedTarget = Math.ceil(targetQuantity * 1.20);

        // Restore search context if we are not on a search page
        if (!this.page.url().includes('/pesquisa') && this.baseSearchUrl) {
            console.log('Restoring search context...');
            if (progressCallback) progressCallback({ message: `🔄 Restaurando busca na página ${this.currentPage}...` });

            let targetUrl = this.baseSearchUrl;
            if (this.currentPage > 1) {
                targetUrl += (targetUrl.includes('?') ? '&' : '?') + `page=${this.currentPage}`;
            }

            try {
                await this.page.goto(targetUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });
            } catch (e) {
                console.log('Error restoring search context:', e.message);
                if (progressCallback) progressCallback({ message: '⚠️ Erro ao restaurar busca, tentando continuar...' });
            }
        }

        const profileUrls = new Set();
        let noMoreResults = false;
        let consecutiveEmptyPages = 0;

        // Detectar total de páginas disponíveis
        const totalPages = await this.page.evaluate(() => {
            const paginationLinks = document.querySelectorAll('a[data-test-id^="pagination-page-"]');
            let maxPage = 1;
            paginationLinks.forEach(link => {
                const pageNum = parseInt(link.textContent);
                if (!isNaN(pageNum) && pageNum > maxPage) {
                    maxPage = pageNum;
                }
            });
            // Também verificar se há indicador de "..." e última página
            const lastPageLink = document.querySelector('a[data-test-id="pagination-page-last"]');
            if (lastPageLink) {
                const lastNum = parseInt(lastPageLink.textContent);
                if (!isNaN(lastNum) && lastNum > maxPage) {
                    maxPage = lastNum;
                }
            }
            return maxPage;
        });

        console.log(`Collecting up to ${adjustedTarget} profile URLs (${targetQuantity} + 20% margem)...`);
        if (progressCallback) progressCallback({ message: `📋 Buscando ${adjustedTarget} perfis (${targetQuantity} + 20% margem). Páginas disponíveis: ${totalPages}` });

        while (profileUrls.size < adjustedTarget && !noMoreResults) {
            console.log(`Page ${this.currentPage}: Collected ${profileUrls.size}/${targetQuantity} profiles`);

            if (progressCallback) progressCallback({
                status: 'collecting',
                message: `Página ${this.currentPage}: Coletados ${profileUrls.size}/${targetQuantity}. Buscando mais...`
            });

            await randomDelay(1500, 3000);
            await scrollPage(this.page);

            // Extract profile links from current page
            const newUrls = await this.page.evaluate(() => {
                const links = [];
                // Broader selector strategy
                const selectors = [
                    'a[data-test-id="doctor-name-link"]',
                    '.card-body h3 a',
                    '.media-body h3 a',
                    'a[href*="/medico/"]',
                    'a[href*="/profissional/"]',
                    'a[href*="/clinica/"]'
                ];

                const profileLinks = document.querySelectorAll(selectors.join(', '));

                profileLinks.forEach(link => {
                    const href = link.href;
                    // Filter out non-profile links
                    if (href &&
                        !href.includes('/opiniao') &&
                        !href.includes('/agenda') &&
                        !href.includes('/perguntas') &&
                        !href.includes('google.com/maps') &&
                        href.startsWith('https://www.doctoralia.com.br/')) {

                        // Clean URL (remove query params and hash)
                        const cleanUrl = href.split('?')[0].split('#')[0];
                        links.push(cleanUrl);
                    }
                });

                return [...new Set(links)]; // Remove duplicates
            });

            if (newUrls.length === 0) {
                consecutiveEmptyPages++;
                console.log(`No profiles found on page ${this.currentPage} (Attempt ${consecutiveEmptyPages})`);

                if (consecutiveEmptyPages >= 3) {
                    console.log('No more results found after multiple attempts');
                    noMoreResults = true;
                    break;
                }
            } else {
                consecutiveEmptyPages = 0;

                // Contar quantos são novos (não duplicados)
                const sizeBefore = profileUrls.size;
                newUrls.forEach(url => {
                    if (profileUrls.size < adjustedTarget) {
                        profileUrls.add(url);
                    }
                });
                const addedCount = profileUrls.size - sizeBefore;

                if (progressCallback) progressCallback({
                    status: 'collecting',
                    message: `Página ${this.currentPage}: +${addedCount} novos (${newUrls.length - addedCount} duplicados). Total: ${profileUrls.size}/${adjustedTarget}`
                });
            }

            // Check if we have enough (with margin)
            if (profileUrls.size >= adjustedTarget) {
                break;
            }

            // Try to go to next page
            try {
                const nextButton = await this.page.$('a[data-test-id="pagination-next"]');

                if (nextButton) {
                    if (progressCallback) progressCallback({ status: 'collecting', message: `Indo para página ${this.currentPage + 1}...` });

                    const previousUrl = this.page.url();

                    await Promise.all([
                        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { }),
                        nextButton.click()
                    ]);

                    // Esperar a URL mudar para garantir que navegou
                    await randomDelay(2000, 3000);

                    // Verificar se a URL realmente mudou
                    const newUrl = this.page.url();
                    if (newUrl === previousUrl) {
                        console.log('URL não mudou após navegação, tentando novamente...');
                        // Tentar novamente com goto direto
                        const nextPageUrl = previousUrl.includes('page=')
                            ? previousUrl.replace(/page=(\d+)/, (m, p) => `page=${parseInt(p) + 1}`)
                            : previousUrl + (previousUrl.includes('?') ? '&' : '?') + `page=${this.currentPage + 1}`;

                        await this.page.goto(nextPageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                        await randomDelay(1000, 2000);
                    }

                    this.currentPage++;
                } else {
                    // Fallback: Try to construct URL manually if button not found
                    console.log('Next button not found, trying URL construction...');
                    const currentUrl = this.page.url();
                    let nextUrl;

                    if (currentUrl.includes('page=')) {
                        nextUrl = currentUrl.replace(/page=(\d+)/, (match, p1) => `page=${parseInt(p1) + 1}`);
                    } else {
                        nextUrl = currentUrl.includes('?') ? `${currentUrl}&page=${this.currentPage + 1}` : `${currentUrl}?page=${this.currentPage + 1}`;
                    }

                    console.log(`Navigating manually to: ${nextUrl}`);
                    if (progressCallback) progressCallback({ status: 'collecting', message: `Navegação manual para página ${this.currentPage + 1}...` });

                    await this.page.goto(nextUrl, { waitUntil: 'networkidle2', timeout: 30000 });

                    // Check if we actually got new results or if redirected back/404
                    const checkResults = await this.page.$('a[data-test-id="doctor-name-link"]');
                    if (!checkResults) {
                        console.log('Manual navigation yielded no results.');
                        noMoreResults = true;
                    } else {
                        this.currentPage++;
                    }
                }
            } catch (error) {
                console.log('Pagination error:', error.message);
                noMoreResults = true;
            }
        }

        const finalUrls = Array.from(profileUrls).slice(0, targetQuantity);
        console.log(`Collected ${finalUrls.length} profile URLs from ${this.currentPage} pages`);

        return finalUrls;
    }
}

module.exports = SearchHandler;
