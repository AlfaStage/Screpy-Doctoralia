/**
 * CNPJ Scraper - Search Handler for Casa dos Dados
 */

class CnpjSearch {
    constructor(page) {
        this.page = page;
    }

    /**
     * Perform advanced search on Casa dos Dados
     * @param {Object} filters - Search filters
     * @param {Function} logCallback - Logging callback
     */
    async search(filters, logCallback = () => { }) {
        const searchUrl = 'https://casadosdados.com.br/solucao/cnpj/pesquisa-avancada';

        try {
            logCallback({ message: `🌐 Acessando Pesquisa Avançada...` });
            await this.page.goto(searchUrl, { waitUntil: 'load', timeout: 60000 });

            // Wait for form to load
            await this.page.waitForSelector('input[placeholder="Razão Social ou Fantasia"]', { timeout: 15000 });

            // Fill filters
            if (filters.razaoSocial) {
                await this.page.type('input[placeholder="Razão Social ou Fantasia"]', filters.razaoSocial, { delay: 50 });
            }

            if (filters.cnae) {
                // Handling CNAE might require selecting from a dropdown that appears
                await this.page.type('input[placeholder="Código ou nome da atividade"]', filters.cnae, { delay: 50 });
                await new Promise(r => setTimeout(r, 1000));
                await this.page.keyboard.press('Enter');
            }

            if (filters.uf) {
                await this.page.type('input[placeholder="Selecione o estado"]', filters.uf, { delay: 50 });
                await new Promise(r => setTimeout(r, 1000));
                await this.page.keyboard.press('Enter');
            }

            if (filters.municipio) {
                await this.page.type('input[placeholder="Selecione um município"]', filters.municipio, { delay: 50 });
                await new Promise(r => setTimeout(r, 1000));
                await this.page.keyboard.press('Enter');
            }

            // Capital Social
            if (filters.capitalSocialMin) {
                // Use the selector for the first "A partir de" placeholder that is likely for Capital Social
                // Actually the subagent found: input[placeholder="A partir de"].is-info
                const capitalMin = await this.page.$$('input[placeholder="A partir de"]');
                if (capitalMin.length > 1) {
                    await capitalMin[1].type(filters.capitalSocialMin.toString(), { delay: 50 });
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

            if (filters.somenteMei !== undefined) await setToggle('Somente MEI', filters.somenteMei);
            if (filters.excluirMei !== undefined) await setToggle('Excluir MEI', filters.excluirMei);
            if (filters.comTelefone !== undefined) await setToggle('Com contato de telefone', filters.comTelefone);
            if (filters.comEmail !== undefined) await setToggle('Com e-mail', filters.comEmail);

            // Click Search
            logCallback({ message: '🖱️ Clicando em Pesquisar...' });
            await this.page.click('a.button.is-success');

            // Wait for results
            await this.page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => { });
            await new Promise(r => setTimeout(r, 3000));

            // Collect links
            const links = await this.page.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll('a[href^="/solucao/cnpj/"]'));
                // Filter out links that are not company details (e.g., search links themselves if any)
                return anchors
                    .map(a => a.href)
                    .filter(href => href.includes('/solucao/cnpj/') && !href.includes('/pesquisa-avancada'));
            });

            // Unique links only
            return [...new Set(links)];

        } catch (error) {
            logCallback({ message: `❌ Erro na pesquisa: ${error.message}` });
            throw error;
        }
    }
}

module.exports = CnpjSearch;
