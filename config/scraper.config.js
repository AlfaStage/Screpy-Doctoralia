/**
 * Centralized Scraper Configuration
 * All scraper settings in one place
 */

const config = {
    // Scraper-specific settings
    doctoralia: {
        name: 'Doctoralia',
        delays: {
            min: 0,
            max: 72000,      // 72 seconds max
            noProxy: 3000,   // 3 seconds when no proxy
            betweenRequests: 1000
        },
        timeouts: {
            extraction: 10000,     // 10s for profile extraction
            navigation: 60000,     // 60s for page navigation
            search: 120000       // 120s for search
        },
        retryAttempts: {
            navigation: 3,
            proxyInit: 5,
            extraction: 2
        },
        queue: {
            parallel: true,
            workerDelay: 1000
        },
        margin: 1.20  // 20% extra profiles to account for errors/skips
    },

    googlemaps: {
        name: 'Google Maps',
        delays: {
            min: 1000,
            max: 90000,      // 90 seconds max
            noProxy: 5000,   // 5 seconds when no proxy
            betweenRequests: 2000
        },
        timeouts: {
            extraction: 30000,     // 30s for business extraction
            navigation: 60000,
            search: 120000,
            websiteInvestigation: 15000
        },
        retryAttempts: {
            navigation: 3,
            proxyInit: 5,
            search: 10,
            collection: 5
        },
        queue: {
            parallel: true,
            workerDelay: 1000
        },
        investigation: {
            enabled: true,
            maxDepth: 5,
            linksPerDepth: {
                0: 5,
                1: 3,
                2: 2
            }
        },
        majorCities: [
            'São Paulo', 'Rio de Janeiro', 'Brasília', 'Salvador', 'Fortaleza',
            'Belo Horizonte', 'Manaus', 'Curitiba', 'Recife', 'Goiânia',
            'Belém', 'Porto Alegre', 'Guarulhos', 'Campinas', 'São Luís',
            'São Gonçalo', 'Maceió', 'Duque de Caxias', 'Natal', 'Teresina'
        ],
        expansionThreshold: 200  // Expand to multiple cities if quantity > 200
    },

    instagram: {
        name: 'Instagram',
        delays: {
            min: 3000,
            max: 15000,      // 15 seconds max
            noProxy: 6000,   // 6 seconds when no proxy
            betweenRequests: 2000
        },
        timeouts: {
            extraction: 20000,
            navigation: 45000,
            login: 45000,
            challenge: 300000  // 5 minutes for 2FA
        },
        retryAttempts: {
            navigation: 3,
            proxyInit: 5,
            login: 3
        },
        queue: {
            parallel: true,
            workerDelay: 2000
        },
        auth: {
            sessionDuration: 7,  // days
            requiredFor: ['followers', 'following', 'private_profile']
        },
        searchTypes: ['profiles', 'hashtag', 'followers'],
        unlimitedFollowers: 1000000  // Used when quantity is 0
    },

    cnpj: {
        name: 'CNPJ',
        delays: {
            min: 2000,
            max: 5000,
            noProxy: 2000,
            betweenRequests: 2000
        },
        timeouts: {
            extraction: 15000,
            navigation: 30000
        },
        retryAttempts: {
            navigation: 3
        },
        queue: {
            parallel: false,
            workerDelay: 2000
        }
    },

    // Global browser settings
    browser: {
        headless: 'new',
        protocolTimeout: 120000,
        viewport: {
            width: 1920,
            height: 1080
        },
        workerViewport: {
            width: 1366,
            height: 768
        },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080'
        ],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },

    // Proxy settings
    proxy: {
        testTimeout: 2000,  // TCP test timeout
        maxFailedRetries: 10,
        sources: [
            'proxyscrape',
            'litport',
            'geonode',
            '911proxy',
            'brightdata'
        ]
    },

    // Manager settings
    manager: {
        maxConcurrentScrapes: 3,
        resultsDir: 'results',
        dataDir: 'data'
    },

    // Validation rules
    validation: {
        quantity: {
            min: 1,
            max: 5000
        },
        requiredFields: {
            doctoralia: ['quantity'],
            googlemaps: ['searchTerm', 'quantity'],
            instagram: ['searchType', 'searchTerm', 'quantity'],
            cnpj: ['cnpjList']
        },
        searchTypes: {
            instagram: ['profiles', 'hashtag', 'followers']
        }
    }
};

// Environment variable overrides
if (process.env.SCRAPER_DELAY_MULTIPLIER) {
    const multiplier = parseFloat(process.env.SCRAPER_DELAY_MULTIPLIER);
    ['doctoralia', 'googlemaps', 'instagram', 'cnpj'].forEach(scraper => {
        config[scraper].delays.min *= multiplier;
        config[scraper].delays.max *= multiplier;
        config[scraper].delays.noProxy *= multiplier;
    });
}

if (process.env.SCRAPER_MAX_CONCURRENT) {
    config.manager.maxConcurrentScrapes = parseInt(process.env.SCRAPER_MAX_CONCURRENT);
}

module.exports = config;
