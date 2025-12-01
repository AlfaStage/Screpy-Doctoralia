const BrowserManager = require('./browser');
const SearchHandler = require('./search');
const ProfileExtractor = require('./profile');
const fs = require('fs').promises;
const path = require('path');

class DoctoraliaScraper {
    constructor(id, io) {
        this.id = id;
        this.io = io;
        this.browserManager = null;
        this.searchHandler = null;
        this.profileExtractor = null;
        this.results = [];
        this.logs = [];
        this.config = {};
        this.status = 'idle';
        this.isPaused = false;
        this.isCancelled = false;
        this.startTime = null;
        this.progress = {
            total: 0,
            current: 0,
            message: '',
            startTime: null,
            estimatedTimeRemaining: null
        };
    }

    async initialize() {
        this.browserManager = new BrowserManager();
        const page = await this.browserManager.initialize();

        this.searchHandler = new SearchHandler(page);
        this.profileExtractor = new ProfileExtractor(page);
        this.status = 'running';
        this.progress.startTime = Date.now();
        this.startTime = new Date().toISOString();

        console.log(`Scraper ${this.id} initialized`);
    }

    async checkState() {
        if (this.isCancelled) {
            throw new Error('Scraping cancelado pelo usuário');
        }

        while (this.isPaused) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (this.isCancelled) {
                throw new Error('Scraping cancelado pelo usuário');
            }
        }
    }

    pause() {
        this.isPaused = true;
        this.status = 'paused';
        this.emitProgress('Scraping pausado');
    }

    resume() {
        this.isPaused = false;
        this.status = 'running';
        this.emitProgress('Scraping retomado');
    }

    async cancel() {
        this.isCancelled = true;
        this.status = 'cancelled';
        this.emitProgress('Cancelando scraping...');

        // Save whatever we have so far
        if (this.results.length > 0) {
            this.emitProgress('Salvando dados parciais...');
            await this.saveResults();
        }

        await this.close();
    }

    emitProgress(message, data = {}) {
        this.progress.message = message;
        Object.assign(this.progress, data);

        // Store log
        this.logs.push({
            timestamp: new Date().toISOString(),
            message: message
        });

        // Calculate estimation
        // Initial estimate: 6 seconds per item
        if (this.progress.current === 0) {
            this.progress.estimatedTimeRemaining = this.progress.total * 6;
        } else if (this.progress.total > 0) {
            // Adaptive estimation
            const elapsed = Date.now() - this.progress.startTime;
            const avgTimePerItem = elapsed / this.progress.current;
            const remainingItems = this.progress.total - this.progress.current;

            // Weight the initial estimate vs actual average based on progress
            // Early on, trust the 6s estimate more. Later, trust the average.
            const progressRatio = this.progress.current / this.progress.total;
            const weightedAvg = (avgTimePerItem * progressRatio) + (6000 * (1 - progressRatio));

            this.progress.estimatedTimeRemaining = Math.ceil((weightedAvg * remainingItems) / 1000);
        }

        this.io.emit('scraper-progress', {
            id: this.id,
            ...this.progress
        });

        this.io.emit('scraper-log', {
            id: this.id,
            message: `[${new Date().toLocaleTimeString()}] ${message}`
        });
    }

    async scrape(specialties, city, quantity) {
        try {
            this.results = [];
            this.logs = [];
            this.config = { specialties, city, quantity };
            this.progress.total = quantity;

            if (!specialties || specialties.length === 0) {
                specialties = ['Médico'];
            }

            const quantityPerSpecialty = Math.ceil(quantity / specialties.length);
            const allProfileUrls = new Set();

            for (let i = 0; i < specialties.length; i++) {
                await this.checkState();

                const specialty = specialties[i];
                this.emitProgress(`Buscando ${specialty} (${i + 1}/${specialties.length})...`);

                await this.searchHandler.performSearch(specialty, city, (msg) => this.emitProgress(msg.message));

                await this.checkState();

                const urls = await this.searchHandler.collectProfileUrls(quantityPerSpecialty, (msg) => {
                    this.emitProgress(msg.message);
                });

                urls.forEach(url => allProfileUrls.add(url));

                if (allProfileUrls.size >= quantity) {
                    break;
                }
            }

            const profileUrls = Array.from(allProfileUrls).slice(0, quantity);
            this.progress.total = profileUrls.length;

            if (profileUrls.length === 0) {
                throw new Error('Nenhum perfil encontrado com os filtros especificados');
            }

            this.emitProgress(`Iniciando extração de ${profileUrls.length} perfis...`);

            for (let i = 0; i < profileUrls.length; i++) {
                await this.checkState();

                const url = profileUrls[i];
                this.progress.current = i + 1;

                this.emitProgress(`Acessando médico ${i + 1}/${profileUrls.length}: ${url}`);

                const profileData = await this.profileExtractor.extractProfile(url, (msg) => this.emitProgress(msg.message));
                this.results.push(profileData);

                this.io.emit('scraper-result-update', {
                    id: this.id,
                    data: profileData
                });
            }

            // Check if we reached the target
            if (this.results.length < quantity) {
                const reason = `Meta não atingida: Solicitado ${quantity}, extraído ${this.results.length}. Motivo: Fim dos resultados disponíveis na busca.`;
                console.log(reason);
                this.emitProgress(reason);
            }

            await this.checkState();
            this.emitProgress('Salvando resultados...');
            const filePath = await this.saveResults();

            this.status = 'completed';
            this.emitProgress('Scraping concluído!', { filePath });

            return {
                success: true,
                count: this.results.length,
                filePath,
                data: this.results,
                logs: this.logs
            };

        } catch (error) {
            if (this.isCancelled) {
                console.log(`Scraper ${this.id} cancelled`);
                return { success: false, message: 'Cancelled', data: this.results, logs: this.logs };
            }

            console.error('Scraping error:', error);
            this.status = 'error';
            this.emitProgress(`Erro: ${error.message}`);
            throw error;
        }
    }

    async saveResults() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `doctoralia_results_${timestamp}.csv`;
        const filePath = path.join(__dirname, '..', 'results', fileName);

        await fs.mkdir(path.join(__dirname, '..', 'results'), { recursive: true });

        // Save CSV
        const csvLines = ['Nome,Especialidades,Numero Fixo,Numero Movel,Enderecos'];

        this.results.forEach(result => {
            // Fallback for missing data using config
            let specialtiesStr = result.especialidades.join('; ');
            if (!specialtiesStr && this.config.specialties && this.config.specialties.length > 0) {
                specialtiesStr = this.config.specialties.join('; ');
            }

            let addressStr = result.enderecos.join('; ');
            if (!addressStr && this.config.city) {
                addressStr = this.config.city;
            }

            const line = [
                this.escapeCsv(result.nome),
                this.escapeCsv(specialtiesStr),
                this.escapeCsv(result.numeroFixo),
                this.escapeCsv(result.numeroMovel),
                this.escapeCsv(addressStr)
            ].join(',');

            csvLines.push(line);
        });

        await fs.writeFile(filePath, csvLines.join('\n'), 'utf8');
        console.log(`Results saved to: ${filePath}`);

        // Save JSON with complete data
        const jsonPath = filePath.replace('.csv', '.json');

        // Enrich results in JSON as well
        const enrichedResults = this.results.map(r => {
            const enriched = { ...r };
            if ((!enriched.especialidades || enriched.especialidades.length === 0) && this.config.specialties) {
                enriched.especialidades = [...this.config.specialties];
            }
            if ((!enriched.enderecos || enriched.enderecos.length === 0) && this.config.city) {
                enriched.enderecos = [this.config.city];
            }
            return enriched;
        });

        const jsonData = {
            config: {
                specialties: this.config.specialties || [],
                city: this.config.city || '',
                quantity: this.config.quantity || 0
            },
            metadata: {
                startTime: this.startTime,
                endTime: new Date().toISOString(),
                totalResults: this.results.length
            },
            logs: this.logs,
            results: enrichedResults
        };

        await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
        console.log(`JSON saved to: ${jsonPath}`);

        return filePath;
    }

    escapeCsv(value) {
        if (!value) return '';
        const stringValue = String(value);
        if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
            return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
    }

    async close() {
        if (this.browserManager) {
            await this.browserManager.close();
        }
    }

    getResults() {
        return this.results;
    }
}

module.exports = DoctoraliaScraper;
