// Curated list of medical specialties in Brazil
// This list is predefined to avoid scraping issues with mixed city names

const SPECIALTIES = [
    'Acupunturista',
    'Alergista',
    'Anestesiologista',
    'Angiologista',
    'Cardiologista',
    'Cirurgião Cardíaco',
    'Cirurgião de Cabeça e Pescoço',
    'Cirurgião Geral',
    'Cirurgião Pediátrico',
    'Cirurgião Plástico',
    'Cirurgião Torácico',
    'Cirurgião Vascular',
    'Clínico Geral',
    'Coloproctologista',
    'Dermatologista',
    'Endocrinologista',
    'Endoscopista',
    'Fisiatra',
    'Gastroenterologista',
    'Geriatra',
    'Ginecologista',
    'Hematologista',
    'Hepatologista',
    'Homeopata',
    'Infectologista',
    'Mastologista',
    'Médico do Trabalho',
    'Nefrologista',
    'Neurocirurgião',
    'Neurologista',
    'Nutrólogo',
    'Obstetra',
    'Oftalmologista',
    'Oncologista',
    'Ortopedista',
    'Otorrinolaringologista',
    'Pediatra',
    'Pneumologista',
    'Psiquiatra',
    'Radiologista',
    'Reumatologista',
    'Urologista'
].sort();

class SpecialtyFetcher {
    constructor() {
        // No need for browser anymore, using predefined list
    }

    async fetchSpecialties() {
        try {
            console.log('Returning curated specialty list...');

            // Simulate a small delay to match API behavior
            await new Promise(resolve => setTimeout(resolve, 500));

            console.log(`Returned ${SPECIALTIES.length} specialties`);
            return SPECIALTIES;

        } catch (error) {
            console.error('Error fetching specialties:', error);
            throw error;
        }
    }
}

module.exports = SpecialtyFetcher;
