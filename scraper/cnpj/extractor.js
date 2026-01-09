/**
 * CNPJ Scraper - Data Extractor for Casa dos Dados
 */

class CnpjExtractor {
    constructor(page) {
        this.page = page;
    }

    /**
     * Extract detailed data from a company page
     * @param {string} url - Company detail URL
     * @param {Function} logCallback - Logging callback
     */
    async extract(url, logCallback = () => { }) {
        try {
            await this.page.goto(url, { waitUntil: 'load', timeout: 30000 });

            // Wait for content
            await this.page.waitForSelector('h1', { timeout: 10000 });

            const data = await this.page.evaluate(() => {
                const info = {};

                // Helper to find value by label text
                const findValueByLabel = (labelText) => {
                    const labels = Array.from(document.querySelectorAll('p.has-text-grey'));
                    const label = labels.find(l => l.innerText.includes(labelText));
                    if (label && label.nextElementSibling) {
                        return label.nextElementSibling.innerText.trim();
                    }
                    return '';
                };

                info.cnpj = findValueByLabel('CNPJ');
                info.razao_social = document.querySelector('h1')?.innerText.trim() || '';
                info.nome_fantasia = findValueByLabel('Nome Fantasia');
                info.data_abertura = findValueByLabel('Data de Abertura');
                info.situacao_cadastral = findValueByLabel('Situação Cadastral');
                info.natureza_juridica = findValueByLabel('Natureza Jurídica');

                info.logradouro = findValueByLabel('Logradouro');
                info.numero = findValueByLabel('Número');
                info.complemento = findValueByLabel('Complemento');
                info.bairro = findValueByLabel('Bairro');
                info.cep = findValueByLabel('CEP');
                info.municipio = findValueByLabel('Município');
                info.uf = findValueByLabel('UF');

                info.telefone = findValueByLabel('Telefone');
                info.email = findValueByLabel('E-MAIL');

                info.atividade_principal = findValueByLabel('Atividade Principal');
                info.capital_social = findValueByLabel('Capital Social');

                return info;
            });

            return data;
        } catch (error) {
            logCallback({ message: `⚠️ Erro na extração de ${url}: ${error.message}` });
            return null;
        }
    }
}

module.exports = CnpjExtractor;
