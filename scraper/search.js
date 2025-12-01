const { randomDelay, humanType, scrollPage } = require('./utils');

class SearchHandler {
    constructor(page) {
        this.page = page;
    }

    async performSearch(specialty, city, progressCallback) {
        console.log(`Searching for: ${specialty} in ${city}`);
        if (progressCallback) progressCallback({ status: 'searching', message: `Acessando Doctoralia...` });

        // Navigate to Doctoralia homepage
        await this.page.goto('https://www.doctoralia.com.br/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

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
        if (progressCallback) progressCallback({ status: 'searching', message: `Navegando para resultados: ${searchUrl}` });

        await this.page.goto(searchUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        return true;
    }

    async collectProfileUrls(targetQuantity, progressCallback) {
        const profileUrls = new Set();
        let currentPage = 1;
        let noMoreResults = false;
        let consecutiveEmptyPages = 0;

        console.log(`Collecting up to ${targetQuantity} profile URLs...`);

        while (profileUrls.size < targetQuantity && !noMoreResults) {
            console.log(`Page ${currentPage}: Collected ${profileUrls.size}/${targetQuantity} profiles`);

            if (progressCallback) progressCallback({
                status: 'collecting',
                message: `Página ${currentPage}: Coletados ${profileUrls.size}/${targetQuantity}. Buscando mais...`
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
                console.log(`No profiles found on page ${currentPage} (Attempt ${consecutiveEmptyPages})`);

                if (consecutiveEmptyPages >= 3) {
                    console.log('No more results found after multiple attempts');
                    noMoreResults = true;
                    break;
                }
            } else {
                consecutiveEmptyPages = 0;
                if (progressCallback) progressCallback({ status: 'collecting', message: `Encontrados ${newUrls.length} na página ${currentPage}.` });

                newUrls.forEach(url => {
                    if (profileUrls.size < targetQuantity) {
                        profileUrls.add(url);
                    }
                });
            }

            // Check if we have enough
            if (profileUrls.size >= targetQuantity) {
                break;
            }

            // Try to go to next page
            try {
                const nextButton = await this.page.$('a[data-test-id="pagination-next"]');

                if (nextButton) {
                    if (progressCallback) progressCallback({ status: 'collecting', message: `Indo para página ${currentPage + 1}...` });

                    await Promise.all([
                        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { }),
                        nextButton.click()
                    ]);
                    currentPage++;
                } else {
                    // Fallback: Try to construct URL manually if button not found
                    console.log('Next button not found, trying URL construction...');
                    const currentUrl = this.page.url();
                    let nextUrl;

                    if (currentUrl.includes('page=')) {
                        nextUrl = currentUrl.replace(/page=(\d+)/, (match, p1) => `page=${parseInt(p1) + 1}`);
                    } else {
                        nextUrl = currentUrl.includes('?') ? `${currentUrl}&page=${currentPage + 1}` : `${currentUrl}?page=${currentPage + 1}`;
                    }

                    console.log(`Navigating manually to: ${nextUrl}`);
                    if (progressCallback) progressCallback({ status: 'collecting', message: `Navegação manual para página ${currentPage + 1}...` });

                    await this.page.goto(nextUrl, { waitUntil: 'networkidle2', timeout: 30000 });

                    // Check if we actually got new results or if redirected back/404
                    const checkResults = await this.page.$('a[data-test-id="doctor-name-link"]');
                    if (!checkResults) {
                        console.log('Manual navigation yielded no results.');
                        noMoreResults = true;
                    } else {
                        currentPage++;
                    }
                }
            } catch (error) {
                console.log('Pagination error:', error.message);
                noMoreResults = true;
            }
        }

        const finalUrls = Array.from(profileUrls).slice(0, targetQuantity);
        console.log(`Collected ${finalUrls.length} profile URLs from ${currentPage} pages`);

        return finalUrls;
    }
}

module.exports = SearchHandler;
