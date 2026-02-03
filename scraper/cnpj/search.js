const { sleep } = require('../../utils/helpers');
const axios = require('axios');

/**
 * CNPJ Scraper - Search Handler for Casa dos Dados
 */

class CnpjSearch {
    constructor(page, config, log, emitUpdate) {
        this.page = page;
        this.config = config;
        this.log = log;
        this.emitUpdate = emitUpdate;
    }

    async search() {
        if (this.config.provider === 'minhareceita') {
            return this.searchMinhaReceita();
        }
        return this.searchCasaDosDados();
    }

    async searchMinhaReceita() {
        this.log('Iniciando busca via API Minha Receita (Alto Volume)...');
        const { razaoSocial, cnae, uf, municipio } = this.config;

        const params = new URLSearchParams();
        if (razaoSocial) params.append('q', razaoSocial);
        if (cnae) params.append('cnae_fiscal', cnae.replace(/\D/g, ''));
        if (uf) params.append('uf', uf.toUpperCase());
        if (municipio) params.append('municipio', municipio.toUpperCase());

        try {
            const url = `https://minhareceita.org/?${params.toString()}`;
            this.log(`Consultando: ${url}`);

            // Note: Since this is an API, we can either fetch directly or use the browser
            // Using the browser might be safer regarding CORS if called from frontend, 
            // but we are in the backend. axios is fine.
            const response = await axios.get(url, { timeout: 30000 });
            const data = response.data;

            if (data && Array.isArray(data)) {
                this.log(`Encontrados ${data.length} resultados via API.`);
                return data.map(item => ({
                    directData: item, // Already has the full data
                    url: null
                }));
            } else if (data && data.results) {
                // Some versions return { results: [], next: ... }
                this.log(`Encontrados ${data.results.length} resultados via API.`);
                return data.results.map(item => ({
                    directData: item,
                    url: null
                }));
            }

            return [];
        } catch (error) {
            this.log(`Erro na API Minha Receita: ${error.message}`);
            throw error;
        }
    }

    /**
     * Perform advanced search on Casa dos Dados
     */
    async searchCasaDosDados(isPartitioned = false) {
        if (!isPartitioned && !this.config.bairro && this.config.municipio) {
            this.log('🧐 Verificando se é necessário particionamento por bairro...');
        }

        this.log(`Iniciando busca no Casa dos Dados${isPartitioned ? ' (Sub-busca)' : ''}...`);
        const searchUrl = 'https://casadosdados.com.br/solucao/cnpj/pesquisa-avancada';

        try {
            this.log('🌐 Acessando Pesquisa Avançada...');
            await this.page.goto(searchUrl, { waitUntil: 'load', timeout: 60000 });

            // Wait for form to load
            await this.page.waitForSelector('input[placeholder="Razão Social ou Fantasia"]', { timeout: 15000 });

            if (this.config.razaoSocial) {
                await this.page.type('input[placeholder="Razão Social ou Fantasia"]', this.config.razaoSocial, { delay: 50 });
            }

            if (this.config.cnae) {
                await this.page.type('input[placeholder="Código ou nome da atividade"]', this.config.cnae, { delay: 50 });
                await new Promise(r => setTimeout(r, 1000));
                await this.page.keyboard.press('Enter');
            }

            if (this.config.uf) {
                await this.page.type('input[placeholder="Selecione o estado"]', this.config.uf, { delay: 50 });
                await new Promise(r => setTimeout(r, 1000));
                await this.page.keyboard.press('Enter');
            }

            if (this.config.municipio) {
                await this.page.type('input[placeholder="Selecione um município"]', this.config.municipio, { delay: 50 });
                await new Promise(r => setTimeout(r, 1000));
                await this.page.keyboard.press('Enter');
            }

            // Capital Social
            if (this.config.capitalSocialMin) {
                const capitalMin = await this.page.$$('input[placeholder="A partir de"]');
                if (capitalMin.length > 1) {
                    await capitalMin[1].type(this.config.capitalSocialMin.toString(), { delay: 50 });
                }
            }

            // Checkboxes / Toggles
            const setToggle = async (labelPart, state) => {
                const toggles = await this.page.$$('label.switch');
                for (const toggle of toggles) {
                    const text = await this.page.evaluate(el => el.innerText, toggle);
                    if (text.includes(labelPart)) {
                        const isChecked = await this.page.evaluate(el => el.querySelector('input').checked, toggle);
                        if (isChecked !== state) {
                            await toggle.click();
                        }
                        break;
                    }
                }
            };

            if (this.config.somenteMei !== undefined) await setToggle('Somente MEI', this.config.somenteMei);
            if (this.config.excluirMei !== undefined) await setToggle('Excluir MEI', this.config.excluirMei);
            if (this.config.comTelefone !== undefined) await setToggle('Com contato de telefone', this.config.comTelefone);
            if (this.config.comEmail !== undefined) await setToggle('Com e-mail', this.config.comEmail);

            // Click Search
            this.log('🖱️ Clicando em Pesquisar...');
            await this.page.click('a.button.is-success');

            // Check for total results count
            const totalText = await this.page.evaluate(() => {
                const el = document.querySelector('.title.is-4'); // Common pattern for total results
                return el ? el.innerText : '';
            });

            const totalMatch = totalText.match(/(\d+)/);
            const totalCount = totalMatch ? parseInt(totalMatch[1]) : 0;

            if (!isPartitioned && totalCount > 20 && !this.config.bairro && this.config.municipio) {
                this.log(`⚠️ Total de ${totalCount} resultados excede o limite de 20. Iniciando particionamento por bairro...`);

                const neighborhoods = await this.getNeighborhoods();
                if (neighborhoods && neighborhoods.length > 0) {
                    this.log(`🏘️ Encontrados ${neighborhoods.length} bairros. Iniciando sub-buscas...`);

                    let allLinks = [];
                    // Initial page links
                    const initialLinks = await this.extractLinks();
                    allLinks.push(...initialLinks);

                    // To avoid being too slow, we can limit neighborhoods or just loop
                    for (const bairro of neighborhoods) {
                        this.log(`📍 Buscando no bairro: ${bairro}...`);
                        // Create a temporary config for the sub-search
                        const subConfig = { ...this.config, bairro };
                        const subSearch = new CnpjSearch(this.page, subConfig, this.log, this.emitUpdate);
                        const subResults = await subSearch.searchCasaDosDados(true);
                        allLinks.push(...subResults);

                        // Small delay between neighborhoods
                        await sleep(1000);
                    }

                    this.log(`✅ Particionamento concluído. Total consolidado: ${[...new Set(allLinks.map(l => l.url))].length} links.`);
                    return [...new Map(allLinks.map(item => [item.url, item])).values()];
                } else {
                    this.log('⚠️ Não foi possível listar bairros. Retornando apenas a primeira página.');
                }
            }

            // Collect links
            const uniqueLinks = await this.extractLinks();
            return uniqueLinks.map(url => ({
                url,
                directData: null
            }));

        } catch (error) {
            this.log(`❌ Erros na pesquisa Casa dos Dados: ${error.message}`);
            throw error;
        }
    }

    async extractLinks() {
        const links = await this.page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href^="/solucao/cnpj/"]'));
            return anchors
                .map(a => a.href)
                .filter(href => href.includes('/solucao/cnpj/') && !href.includes('/pesquisa-avancada'));
        });
        return [...new Set(links)];
    }

    async getNeighborhoods() {
        this.log('🏘️ Tentando descobrir bairros para particionamento...');
        try {
            // Click on the neighborhood input to trigger the dropdown/list
            const inputSelector = 'input[placeholder="Nome do bairro"]';
            await this.page.click(inputSelector);
            await new Promise(r => setTimeout(r, 1000));

            // Usually, these sites use a list that appears. Let's look for common patterns.
            // On Casa dos Dados, it might be a div with class 'dropdown-content' or similar.
            // Simplified: If we can't easily scrape the list, we'll inform the user or use a common list.
            // But let's try to get what's visible.
            const neighborhoods = await this.page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('.dropdown-item, .autocomplete-item'));
                return items.map(i => i.innerText.trim()).filter(t => t.length > 0);
            });

            return neighborhoods;
        } catch (error) {
            this.log(`⚠️ Erro ao descobrir bairros: ${error.message}`);
            return [];
        }
    }
}

module.exports = CnpjSearch;
