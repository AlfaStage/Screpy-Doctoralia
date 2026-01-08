const socket = io();

// State
let activeScrapers = new Map();
let history = [];
let currentModalScraperId = null;
let cachedApiKey = null;

// Fetch API key on load
async function fetchApiKey() {
    try {
        const res = await fetch('/api/v1/key');
        const data = await res.json();
        cachedApiKey = data.apiKey;
    } catch (err) {
        console.warn('Failed to fetch API key:', err);
    }
}
fetchApiKey();

// Helper: Format date for display
function formatDate(dateInput) {
    if (!dateInput) return 'N/A';
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return 'N/A';
    return date.toLocaleDateString('pt-BR') + ' ' + date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// DOM Elements
const form = document.getElementById('scrape-form');
const activeList = document.getElementById('active-scrapers-list');
const historyList = document.getElementById('history-list');
const modal = document.getElementById('scraper-modal');
const closeModalBtn = document.getElementById('close-modal');

// Modal Elements
const modalTitle = document.getElementById('modal-title');
const modalStatus = document.getElementById('modal-status');
const modalProgressText = document.getElementById('modal-progress-text');
const modalSuccessRate = document.getElementById('modal-success-rate');
const modalPhonesFound = document.getElementById('modal-phones-found');
const modalErrors = document.getElementById('modal-errors');
const modalSkipped = document.getElementById('modal-skipped');
const modalSpeed = document.getElementById('modal-speed');
const modalTimeRemaining = document.getElementById('modal-time-remaining');
const modalLogs = document.getElementById('modal-logs');
const modalResultsBody = document.getElementById('modal-results-body');
const btnPause = document.getElementById('btn-pause');
const btnResume = document.getElementById('btn-resume');
const btnCancel = document.getElementById('btn-cancel');
const btnDownload = document.getElementById('btn-download');
const specialtyGrid = document.getElementById('specialty-grid');
const modalTimeLabel = document.getElementById('modal-time-label');

// Specialty selection state
const selectedSpecialties = new Set();

// Common specialties to display
const commonSpecialties = [
    { name: 'Cardiologista', icon: 'fa-heart-pulse' },
    { name: 'Dermatologista', icon: 'fa-hand-dots' },
    { name: 'Pediatra', icon: 'fa-baby-carriage' },
    { name: 'Ortopedista', icon: 'fa-bone' },
    { name: 'Ginecologista', icon: 'fa-venus' },
    { name: 'Neurologista', icon: 'fa-brain' },
    { name: 'Psiquiatra', icon: 'fa-head-side-virus' },
    { name: 'Oftalmologista', icon: 'fa-eye' },
    { name: 'Endocrinologista', icon: 'fa-flask' },
    { name: 'Psicólogo', icon: 'fa-user-nurse' },
    { name: 'Nutricionista', icon: 'fa-apple-whole' },
    { name: 'Fisioterapeuta', icon: 'fa-walking' },
    { name: 'Dentista', icon: 'fa-tooth' },
    { name: 'Urologista', icon: 'fa-mars' },
    { name: 'Otorrinolaringologista', icon: 'fa-ear-listen' },
    { name: 'Pneumologista', icon: 'fa-lungs' },
    { name: 'Gastroenterologista', icon: 'fa-bacteria' },
    { name: 'Reumatologista', icon: 'fa-person-cane' },
    { name: 'Oncologista', icon: 'fa-ribbon' },
    { name: 'Infectologista', icon: 'fa-virus' },
    { name: 'Geriatra', icon: 'fa-blind' },
    { name: 'Nefrologista', icon: 'fa-droplet' },
    { name: 'Anestesiologista', icon: 'fa-syringe' },
    { name: 'Radiologista', icon: 'fa-x-ray' },
    { name: 'Cirurgião Plástico', icon: 'fa-wand-magic-sparkles' },
    { name: 'Cirurgião Geral', icon: 'fa-user-doctor' },
    { name: 'Homeopata', icon: 'fa-leaf' },
    { name: 'Acupunturista', icon: 'fa-arrows-to-circle' },
    { name: 'Alergista', icon: 'fa-virus-covid' },
    { name: 'Hematologista', icon: 'fa-vial' },
    { name: 'Mastologista', icon: 'fa-person-dress' },
    { name: 'Nutrólogo', icon: 'fa-carrot' },
    { name: 'Proctologista', icon: 'fa-notes-medical' },
    { name: 'Angiologista', icon: 'fa-heart-crack' },
    { name: 'Neurocirurgião', icon: 'fa-brain' }
];

// Load specialties into grid
function loadSpecialties() {
    specialtyGrid.innerHTML = '';
    commonSpecialties.forEach(spec => {
        const card = document.createElement('div');
        card.className = 'specialty-card';
        card.dataset.specialty = spec.name;
        card.innerHTML = `
            <i class="fas ${spec.icon}"></i>
            <span>${spec.name}</span>
        `;
        card.addEventListener('click', () => toggleSpecialty(spec.name, card));
        specialtyGrid.appendChild(card);
    });
}

function toggleSpecialty(name, card) {
    if (selectedSpecialties.has(name)) {
        selectedSpecialties.delete(name);
        card.classList.remove('selected');
    } else {
        selectedSpecialties.add(name);
        card.classList.add('selected');
    }
}

// Initialize on load
loadSpecialties();

// Tab Switching Logic
const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;

        // Update active button
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Update active content
        tabContents.forEach(content => {
            if (content.dataset.tab === targetTab) {
                content.classList.add('active');
            } else {
                content.classList.remove('active');
            }
        });
    });
});

// Google Maps Form Handler
const mapsForm = document.getElementById('maps-form');
if (mapsForm) {
    mapsForm.addEventListener('submit', (e) => {
        e.preventDefault();

        if (!socket.connected) {
            alert('Erro de conexão com o servidor. Tentando reconectar...');
            socket.connect();
            return;
        }

        const searchTerm = document.getElementById('search-term').value;
        const city = document.getElementById('maps-city').value;
        const quantity = document.getElementById('maps-quantity').value;
        const investigateWebsites = document.getElementById('investigate-websites').checked;
        const proxyMode = document.querySelector('input[name="maps-proxy-mode"]:checked')?.value || 'proxy';
        const useProxy = proxyMode === 'proxy';

        // Collect required fields
        const requiredFields = Array.from(document.querySelectorAll('input[name="maps-required"]:checked'))
            .map(cb => cb.value);

        if (!searchTerm || searchTerm.trim().length === 0) {
            alert('Por favor, informe um termo de busca');
            return;
        }

        // Visual feedback
        const btn = mapsForm.querySelector('button[type="submit"]');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Iniciando...';

        // Timeout to re-enable button if server doesn't respond
        const timeoutId = setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = originalText;
            alert('O servidor demorou para responder. Tente novamente.');
        }, 5000);

        // Listen for confirmation to clear timeout
        const onStarted = (data) => {
            if (data.type === 'googlemaps') {
                clearTimeout(timeoutId);
                socket.off('scrape-started', onStarted);
                socket.off('error', onError);

                // Reset form and button
                mapsForm.reset();
                document.getElementById('investigate-websites').checked = true; // Keep default
                btn.disabled = false;
                btn.innerHTML = originalText;
            }
        };

        const onError = (err) => {
            clearTimeout(timeoutId);
            socket.off('scrape-started', onStarted);
            socket.off('error', onError);

            btn.disabled = false;
            btn.innerHTML = originalText;
            alert(err.message);
        };

        socket.on('scrape-started', onStarted);
        socket.once('error', onError);

        socket.emit('start-maps-scrape', {
            searchTerm,
            city,
            quantity: parseInt(quantity),
            investigateWebsites,
            useProxy,
            requiredFields
        });
    });
}

// Handle Maps scrape-started event
socket.on('scrape-started', ({ id, type }) => {
    if (type === 'googlemaps') {
        const config = {
            searchTerm: document.getElementById('search-term')?.value || '',
            city: document.getElementById('maps-city')?.value || '',
            quantity: parseInt(document.getElementById('maps-quantity')?.value) || 10,
            investigateWebsites: document.getElementById('investigate-websites')?.checked ?? true
        };
        const scraper = {
            id,
            type: 'googlemaps',
            config,
            status: 'running',
            current: 0,
            total: config.quantity,
            logs: [],
            results: [],
            startTime: Date.now(),
            successCount: 0,
            errorCount: 0,
            websitesInvestigated: 0
        };
        activeScrapers.set(id, scraper);
        renderActiveScrapers();

        // Open modal automatically
        currentModalScraperId = id;
        openModal(id, true);
    }
});

// Socket.io Events
socket.on('initial-state', (data) => {
    console.log('Received initial-state:', data);
    activeScrapers = new Map(data.activeScrapers.map(s => [s.id, s]));
    history = data.history || [];
    console.log('Loaded history items:', history.length);
    renderActiveScrapers();
    renderHistory();
});

socket.on('scrape-started', ({ id, type }) => {
    // Only handle Doctoralia type here (googlemaps is handled above)
    if (type === 'googlemaps') return;

    // Criar scraper com dados iniciais
    const config = { city: document.getElementById('city').value || '', specialties: Array.from(selectedSpecialties), quantity: parseInt(document.getElementById('quantity').value) || 10 };
    const scraper = {
        id,
        type: 'doctoralia',
        config,
        status: 'running',
        current: 0,
        total: config.quantity,
        logs: [],
        results: [],
        startTime: Date.now(),
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
        phonesFound: 0
    };
    activeScrapers.set(id, scraper);
    renderActiveScrapers();

    // Abrir modal automaticamente ao iniciar
    currentModalScraperId = id;
    openModal(id, true);
});

socket.on('scraper-progress', (data) => {
    const scraper = activeScrapers.get(data.id);
    if (scraper) {
        scraper.current = data.current;
        scraper.total = data.total;
        scraper.successCount = data.successCount || 0;
        scraper.errorCount = data.errorCount || 0;
        scraper.skippedCount = data.skippedCount || 0;
        scraper.phonesFound = data.phonesFound || 0;
        scraper.progress = data;
        renderActiveScrapers();
        if (currentModalScraperId === data.id) {
            updateModal(scraper);
        }
    }
});

socket.on('scraper-log', ({ id, message, timestamp }) => {
    const scraper = activeScrapers.get(id);
    if (scraper) {
        if (!scraper.logs) scraper.logs = [];
        scraper.logs.push({ message, timestamp });
        if (currentModalScraperId === id) {
            appendLogToModal({ message, timestamp });
        }
    }
});

socket.on('scraper-result', (data) => {
    const scraper = activeScrapers.get(data.id);
    if (scraper) {
        if (!scraper.results) scraper.results = [];
        scraper.results.push(data.data);

        if (currentModalScraperId === data.id) {
            // Ensure headers are created if this is the first result
            const thead = document.querySelector('#modal-results-table thead tr');
            if (thead && thead.children.length === 0) {
                const isMaps = scraper.type === 'googlemaps';
                const keys = isMaps
                    ? ['nome', 'categoria', 'telefone', 'whatsapp', 'website', 'email', 'instagram', 'endereco']
                    : ['nome', 'especialidades', 'numeroFixo', 'numeroMovel', 'enderecos'];

                keys.forEach(key => {
                    const th = document.createElement('th');
                    th.textContent = key.charAt(0).toUpperCase() + key.slice(1);
                    thead.appendChild(th);
                });

                // Clear the "no results" message if present
                if (modalResultsBody.querySelector('td[colspan]')) {
                    modalResultsBody.innerHTML = '';
                }
            }

            appendResultToModal(data.data, scraper.type || data.type || 'doctoralia');
        }
    }
});

socket.on('scraper-status-change', ({ id, status }) => {
    const scraper = activeScrapers.get(id);
    if (scraper) {
        scraper.status = status;
        updateScraperCard(id);
        if (currentModalScraperId === id) {
            updateModalControls(scraper);
            modalStatus.textContent = status;
            modalStatus.className = `status-badge ${status}`;
        }
    }
});

socket.on('scraper-completed', ({ id, result }) => {
    const scraper = activeScrapers.get(id);
    if (scraper) {
        activeScrapers.delete(id);
        history.unshift({
            id,
            config: scraper.config,
            result,
            status: 'completed',
            timestamp: Date.now()
        });
        renderActiveScrapers();
        renderHistory();

        if (currentModalScraperId === id) {
            // Keep modal open but update state
            scraper.status = 'completed';
            scraper.result = result; // Store final result

            // If result has logs and metadata, update scraper object
            if (result.data && result.data.length > 0) {
                // Check if result is the full JSON object or just the success wrapper
                // The backend returns { success: true, count: ..., filePath: ..., data: ... }
                // But we also saved a JSON file with { config, metadata, logs, results }
                // We can't easily read the file here, but we can use the in-memory logs

                // Ensure logs are preserved
                if (!scraper.logs || scraper.logs.length === 0) {
                    // If we lost logs (e.g. page refresh), we might not have them
                    // But for a just-finished scrape, they should be in memory
                }

                // Calculate duration if not present
                if (!scraper.duration && scraper.startTime) {
                    scraper.duration = Math.floor((Date.now() - scraper.startTime) / 1000);
                }
            }

            updateModal(scraper);
        }
    }
});

socket.on('scraper-error', ({ id, error }) => {
    const scraper = activeScrapers.get(id);
    if (scraper) {
        activeScrapers.delete(id);
        history.unshift({
            id,
            config: scraper.config,
            error,
            status: 'error',
            timestamp: Date.now()
        });
        renderActiveScrapers();
        renderHistory();

        if (currentModalScraperId === id) {
            alert(`Erro no scraper: ${error}`);
            closeModal();
        }
    }
});

socket.on('error', (data) => {
    alert(data.message);
});

// UI Logic
form.addEventListener('submit', (e) => {
    e.preventDefault();

    if (!socket.connected) {
        alert('Erro de conexão com o servidor. Tentando reconectar...');
        socket.connect();
        return;
    }

    const city = document.getElementById('city').value;
    const quantity = document.getElementById('quantity').value;

    // Get required fields for Doctoralia
    const requiredFields = Array.from(document.querySelectorAll('input[name="doc-required"]:checked'))
        .map(cb => cb.value);

    const proxyMode = document.querySelector('input[name="proxy-mode"]:checked')?.value || 'proxy';
    const useProxy = proxyMode === 'proxy';

    // Get selected specialties from the cards
    const specialties = Array.from(selectedSpecialties);

    // Visual feedback
    const btn = form.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Iniciando...';

    // Timeout to re-enable button if server doesn't respond
    const timeoutId = setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = originalText;
        alert('O servidor demorou para responder. Tente novamente.');
    }, 5000);

    // Listen for confirmation to clear timeout
    const onStarted = () => {
        clearTimeout(timeoutId);
        socket.off('scrape-started', onStarted);
        socket.off('error', onError);

        // Reset form and button
        form.reset();

        // Clearing specialties also might be good, but user might want to reuse them
        // selectedSpecialties.clear();
        // document.querySelectorAll('.specialty-card.selected').forEach(c => c.classList.remove('selected'));

        btn.disabled = false;
        btn.innerHTML = originalText;
    };

    const onError = (err) => {
        clearTimeout(timeoutId);
        socket.off('scrape-started', onStarted);
        socket.off('error', onError);

        btn.disabled = false;
        btn.innerHTML = originalText;
        alert(err.message);
    };

    socket.once('scrape-started', onStarted);
    socket.once('error', onError);

    socket.emit('start-scrape', {
        specialties,
        city,
        quantity,
        requiredFields,
        useProxy
    });
});

// Maps Form Logic
mapsForm.addEventListener('submit', (e) => {
    e.preventDefault();

    if (!socket.connected) {
        alert('Erro de conexão com o servidor. Tentando reconectar...');
        socket.connect();
        return;
    }

    const searchTerm = document.getElementById('maps-search-term').value;
    const city = document.getElementById('maps-city').value;
    const quantity = document.getElementById('maps-quantity').value;
    const proxyMode = document.querySelector('input[name="maps-proxy-mode"]:checked')?.value || 'proxy';
    const useProxy = proxyMode === 'proxy';

    // Get required fields for Google Maps
    const requiredFields = Array.from(document.querySelectorAll('input[name="maps-required"]:checked'))
        .map(cb => cb.value);

    // Visual feedback
    const btn = mapsForm.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Iniciando...';

    // Timeout to re-enable button if server doesn't respond
    const timeoutId = setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = originalText;
        alert('O servidor demorou para responder. Tente novamente.');
    }, 5000);

    const onStarted = () => {
        clearTimeout(timeoutId);
        socket.off('scrape-started', onStarted);
        socket.off('error', onError);

        mapsForm.reset();
        btn.disabled = false;
        btn.innerHTML = originalText;
    };

    const onError = (err) => {
        clearTimeout(timeoutId);
        socket.off('scrape-started', onStarted);
        socket.off('error', onError);

        btn.disabled = false;
        btn.innerHTML = originalText;
        alert(err.message);
    };

    socket.once('scrape-started', onStarted);
    socket.once('error', onError);

    socket.emit('start-maps-scrape', {
        searchTerm,
        city,
        quantity,
        requiredFields,
        useProxy
    });
});

// Theme Toggle
const themeToggleBtn = document.getElementById('theme-toggle');
const body = document.body;
const icon = themeToggleBtn.querySelector('i');

// Load saved theme
if (localStorage.getItem('theme') === 'dark') {
    body.classList.add('dark-mode');
    icon.classList.replace('fa-moon', 'fa-sun');
}

themeToggleBtn.addEventListener('click', () => {
    body.classList.toggle('dark-mode');
    const isDark = body.classList.contains('dark-mode');

    // Update icon
    if (isDark) {
        icon.classList.replace('fa-moon', 'fa-sun');
        localStorage.setItem('theme', 'dark');
    } else {
        icon.classList.replace('fa-sun', 'fa-moon');
        localStorage.setItem('theme', 'light');
    }
});

// API Key Modal
const apiKeyToggle = document.getElementById('api-key-toggle');
const apiKeyModal = document.getElementById('api-key-modal');
const closeApiKeyModal = document.getElementById('close-api-key-modal');
const apiKeyValue = document.getElementById('api-key-value');
const copyApiKeyBtn = document.getElementById('copy-api-key');

if (apiKeyToggle && apiKeyModal) {
    apiKeyToggle.addEventListener('click', async () => {
        console.log('API Key button clicked');
        apiKeyModal.classList.remove('hidden');
        try {
            const response = await fetch('/api/v1/key');
            const data = await response.json();
            if (apiKeyValue) {
                apiKeyValue.textContent = data.apiKey || 'Erro ao carregar';
            }
        } catch (error) {
            if (apiKeyValue) {
                apiKeyValue.textContent = 'Erro ao carregar';
            }
            console.error('Error fetching API key:', error);
        }
    });
}

if (closeApiKeyModal && apiKeyModal) {
    closeApiKeyModal.addEventListener('click', () => {
        apiKeyModal.classList.add('hidden');
    });
}

if (apiKeyModal) {
    apiKeyModal.addEventListener('click', (e) => {
        if (e.target === apiKeyModal) {
            apiKeyModal.classList.add('hidden');
        }
    });
}

if (copyApiKeyBtn && apiKeyValue) {
    copyApiKeyBtn.addEventListener('click', async () => {
        const key = apiKeyValue.textContent;
        if (key && key !== 'Carregando...' && key !== 'Erro ao carregar') {
            try {
                await navigator.clipboard.writeText(key);
                copyApiKeyBtn.innerHTML = '<i class="fas fa-check"></i>';
                setTimeout(() => {
                    copyApiKeyBtn.innerHTML = '<i class="fas fa-copy"></i>';
                }, 2000);
            } catch (err) {
                console.error('Failed to copy:', err);
            }
        }
    });
}

function renderActiveScrapers() {
    activeList.innerHTML = '';
    if (activeScrapers.size === 0) {
        activeList.innerHTML = '<div class="empty-state">Nenhum scraper ativo</div>';
        return;
    }

    activeScrapers.forEach(scraper => {
        const card = createScraperCard(scraper, true);
        activeList.appendChild(card);
    });
}

function renderHistory() {
    historyList.innerHTML = '';

    // Get filter values
    const statusFilter = document.getElementById('filter-status')?.value || '';
    const typeFilter = document.getElementById('filter-type')?.value || '';

    // Filter history
    let filteredHistory = history.filter(item => {
        // Status filter
        if (statusFilter) {
            if (statusFilter === 'completed' && item.status !== 'completed') return false;
            if (statusFilter === 'error' && item.status !== 'error' && item.status !== 'failed') return false;
        }

        // Type filter
        if (typeFilter) {
            const itemType = item.type || 'doctoralia';
            if (typeFilter !== itemType) return false;
        }

        return true;
    });

    if (filteredHistory.length === 0) {
        historyList.innerHTML = '<div class="empty-state">Nenhum resultado encontrado</div>';
        return;
    }

    filteredHistory.forEach(item => {
        const card = createScraperCard(item, false);
        historyList.appendChild(card);
    });
}

function createScraperCard(item, isActive) {
    const div = document.createElement('div');
    div.className = `scraper-card ${isActive ? 'active' : ''}`;
    div.onclick = () => openModal(item.id, isActive);

    // Determine type and display title
    const scraperType = item.type || 'doctoralia';
    let cardTitle = '';
    let typeBadgeClass = scraperType;
    let typeBadgeText = '';

    if (scraperType === 'googlemaps') {
        cardTitle = item.config?.searchTerm || 'Google Maps';
        typeBadgeText = '<i class="fas fa-map-marker-alt"></i> Maps';
    } else {
        const specialties = item.config?.specialties?.join(', ') || 'Médico';
        cardTitle = specialties;
        typeBadgeText = '<i class="fas fa-user-md"></i> Doctoralia';
    }

    const city = item.config?.city || 'Qualquer lugar';
    const isMaps = item.type === 'googlemaps';
    const title = isMaps ? (item.config?.searchTerm || 'Busca Maps') : (Array.isArray(item.config?.specialties) ? item.config.specialties.join(', ') : 'Especialidade');
    const subtitle = item.config?.city || 'Local não definido';
    const badgeClass = isMaps ? 'badge-maps' : 'badge-doctoralia';
    const badgeText = isMaps ? 'Google Maps' : 'Doctoralia';
    const iconClass = isMaps ? 'fa-map-marker-alt' : 'fa-user-md';

    div.innerHTML = `
        <div class="history-header">
            <span class="history-title"><i class="fas ${iconClass}"></i> ${title}</span>
            <span class="scraper-type-badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="history-details">
            <span><i class="fas fa-map-marker-alt"></i> ${subtitle}</span>
            <span><i class="fas fa-users"></i> ${item.total || item.config?.quantity || 0} leads</span>
        </div>
        <div class="history-meta">
            <span class="status-badge ${item.status}">${item.status}</span>
            <span class="date">${formatDate(item.startTime)}</span>
        </div>
    `;
    return div;
}

function updateScraperCard(id) {
    // Re-render all for simplicity, or optimize to find specific card
    renderActiveScrapers();
}

// Modal Logic
function openModal(id, isActive) {
    currentModalScraperId = id;
    const item = isActive ? activeScrapers.get(id) : history.find(h => h.id === id);
    if (!item) return;

    // Clear previous logs
    modalLogs.innerHTML = '';

    // Clear previous results body
    modalResultsBody.innerHTML = '';

    // Clear previous table headers for fresh start
    const thead = document.querySelector('#modal-results-table thead tr');
    if (thead) thead.innerHTML = '';

    modal.classList.remove('hidden');

    // Load existing logs (check multiple sources)
    const logs = item.logs || (item.result ? item.result.logs : null) || [];
    if (logs && logs.length > 0) {
        logs.forEach(log => appendLogToModal(log));
    } else {
        const noLogsDiv = document.createElement('div');
        noLogsDiv.className = 'log-entry';
        noLogsDiv.style.fontStyle = 'italic';
        noLogsDiv.textContent = 'Nenhum log disponível para esta extração';
        modalLogs.appendChild(noLogsDiv);
    }

    // updateModal will handle loading results
    updateModal(item);
    updateModalControls(item);
}

function closeModal() {
    modal.classList.add('hidden');
    currentModalScraperId = null;
}

closeModalBtn.onclick = closeModal;
modal.onclick = (e) => {
    if (e.target === modal) closeModal();
};



function updateModal(item) {
    const isMaps = item.type === 'googlemaps';
    const typeLabel = isMaps ? 'Google Maps' : 'Doctoralia';
    const term = isMaps ? (item.config?.searchTerm || 'Busca') : (item.config?.specialties?.join(', ') || 'Todas');
    const city = item.config?.city || 'Qualquer lugar';
    const quantityLabel = item.config?.quantity || item.total || 0;

    modalTitle.textContent = `${typeLabel} | ${term} | ${city} | ${quantityLabel}`;

    modalStatus.textContent = item.status;
    modalStatus.className = `status-badge ${item.status}`;

    const quantityRequested = item.config?.quantity || item.total || 0;
    const successCount = item.successCount || item.progress?.successCount || (item.result ? item.result.count : 0) || 0;
    const errorCount = item.errorCount || item.progress?.errorCount || (item.result ? item.result.errorCount : 0) || 0;
    const skippedCount = item.skippedCount || item.progress?.skippedCount || (item.result ? item.result.skippedCount : 0) || 0;
    const phonesFound = item.phonesFound || item.progress?.phonesFound || (item.result ? item.result.phonesFound : 0) || 0;
    const totalExtracted = successCount + errorCount + skippedCount;

    // Progresso: sucesso comparado com quantidade pedida
    const progressPercent = quantityRequested > 0 ? Math.round((successCount / quantityRequested) * 100) : 0;

    // Sucesso Text (New)
    const modalSuccessText = document.getElementById('modal-success-text'); // Dynamically get it safely
    if (modalSuccessText) modalSuccessText.textContent = successCount;

    // Totais (Progresso)
    modalProgressText.textContent = `${successCount}/${quantityRequested} (${progressPercent}%)`;

    // Erros: quantidade de erros / total extraído
    const errorPercent = totalExtracted > 0 ? Math.round((errorCount / totalExtracted) * 100) : 0;
    modalErrors.textContent = `${errorCount} (${errorPercent}%)`;

    // Pulados: pulados / total extraído
    const skippedPercent = totalExtracted > 0 ? Math.round((skippedCount / totalExtracted) * 100) : 0;
    modalSkipped.textContent = `${skippedCount} (${skippedPercent}%)`;

    // Taxa de sucesso: médicos que deram certo / total extraídos
    const successRate = totalExtracted > 0 ? Math.round((successCount / totalExtracted) * 100) : 0;
    modalSuccessRate.textContent = `${successRate}%`;

    // Color coding for success rate
    modalSuccessRate.className = 'stat-value';
    if (totalExtracted > 0) {
        if (successRate >= 90) modalSuccessRate.classList.add('text-success');
        else if (successRate >= 70) modalSuccessRate.classList.add('text-warning');
        else modalSuccessRate.classList.add('text-danger');
    }

    // Telefones: médicos com telefone
    modalPhonesFound.textContent = phonesFound;

    // Time and speed calculations
    const isCompleted = item.status === 'completed' || item.status === 'error';

    if (isCompleted) {
        // Tempo de duração: tempo total que levou
        if (modalTimeLabel) modalTimeLabel.textContent = 'Tempo de Duração';

        let durationSecs = item.duration;
        if (!durationSecs && item.metadata?.startTime && item.metadata?.endTime) {
            const start = new Date(item.metadata.startTime).getTime();
            const end = new Date(item.metadata.endTime).getTime();
            durationSecs = Math.floor((end - start) / 1000);
        } else if (!durationSecs && item.startTime && item.timestamp) {
            durationSecs = Math.floor((item.timestamp - item.startTime) / 1000);
        } else if (!durationSecs && item.startTime) {
            durationSecs = Math.floor((Date.now() - item.startTime) / 1000);
        }

        if (durationSecs) {
            const mins = Math.floor(durationSecs / 60);
            const secs = durationSecs % 60;
            modalTimeRemaining.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

            // Velocidade média: extrações por minuto
            const avgSpeed = durationSecs > 0 ? ((successCount / durationSecs) * 60).toFixed(1) : 0;
            modalSpeed.textContent = `${avgSpeed}/min`;
        } else {
            modalTimeRemaining.textContent = 'N/A';
            modalSpeed.textContent = '0/min';
        }
    } else {
        // Tempo restante: estimativa baseada na velocidade atual (sem contar erros/pulados)
        if (modalTimeLabel) modalTimeLabel.textContent = 'Tempo Restante';

        if (item.startTime && successCount > 0) {
            const elapsedSecs = (Date.now() - item.startTime) / 1000;
            const currentSpeed = successCount / elapsedSecs; // extrações por segundo
            const remaining = quantityRequested - successCount;
            const estimatedSecs = currentSpeed > 0 ? Math.ceil(remaining / currentSpeed) : 0;

            if (estimatedSecs > 0) {
                const mins = Math.floor(estimatedSecs / 60);
                const secs = estimatedSecs % 60;
                modalTimeRemaining.textContent = `~${mins}:${secs.toString().padStart(2, '0')}`;
            } else {
                modalTimeRemaining.textContent = '--:--';
            }

            // Velocidade atual: extrações por minuto
            const speed = (currentSpeed * 60).toFixed(1);
            modalSpeed.textContent = `${speed}/min`;
        } else {
            modalTimeRemaining.textContent = '--:--';
            modalSpeed.textContent = '--/min';
        }
    }

    // Results Table Handling
    const isCompletedOrError = item.status === 'completed' || item.status === 'error' || item.status === 'failed';
    const isRunning = item.status === 'running' || item.status === 'paused';

    // Get results from various possible sources
    const results = item.results || (item.result ? (item.result.data || item.result.results) : []) || [];

    // Clear table body first
    modalResultsBody.innerHTML = '';

    // Setup headers if not already present
    const thead = document.querySelector('#modal-results-table thead tr');
    if (thead && thead.children.length === 0) {
        const keys = isMaps
            ? ['nome', 'categoria', 'telefone', 'whatsapp', 'website', 'email', 'instagram', 'endereco']
            : ['nome', 'especialidades', 'numeroFixo', 'numeroMovel', 'enderecos'];

        keys.forEach(key => {
            const th = document.createElement('th');
            th.textContent = key.charAt(0).toUpperCase() + key.slice(1);
            thead.appendChild(th);
        });
    }

    // Load results
    if (results.length > 0) {
        results.forEach(r => appendResultToModal(r, item.type));
    } else if (isRunning) {
        // For running scrapers, show waiting message
        modalResultsBody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-tertiary); font-style: italic; padding: 24px;">⏳ Aguardando resultados...</td></tr>';
    } else {
        // For completed with no results
        modalResultsBody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-tertiary); font-style: italic; padding: 24px;">Nenhum resultado encontrado</td></tr>';
    }
}

function updateModalControls(item) {
    const isRunning = item.status === 'running';
    const isPaused = item.status === 'paused';
    const isCompleted = item.status === 'completed' || item.status === 'error';

    // Show/hide controls based on status
    btnPause.classList.toggle('hidden', !isRunning);
    btnResume.classList.toggle('hidden', !isPaused);
    btnCancel.classList.toggle('hidden', isCompleted);

    // Download button - show for completed scrapers with results
    if (isCompleted && item.result && item.result.filePath) {
        btnDownload.classList.remove('hidden');
        const path = item.result.filePath;
        const filename = path.split(/[\\/]/).pop();
        btnDownload.href = `/results/${filename}`;
        btnDownload.setAttribute('download', filename);
    } else {
        btnDownload.classList.add('hidden');
    }
}


function appendLogToModal(log) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.textContent = log.message || log;
    modalLogs.appendChild(div);
    modalLogs.scrollTop = modalLogs.scrollHeight;
}

function appendResultToModal(data, type) {
    const tr = document.createElement('tr');

    // Determine columns based on type (must match header definition in updateModal)
    const isMaps = type === 'googlemaps';
    const keys = isMaps
        ? ['nome', 'categoria', 'telefone', 'whatsapp', 'website', 'email', 'instagram', 'endereco']
        : ['nome', 'especialidades', 'numeroFixo', 'numeroMovel', 'enderecos'];

    let html = '';
    keys.forEach(key => {
        let value = data[key];

        // Format arrays or special fields
        if (Array.isArray(value)) value = value.join(', ');
        if (key === 'website' && value) value = `<a href="${value}" target="_blank" style="color: var(--accent-color); text-decoration: none;">🔗 Link</a>`;
        if (key === 'instagram' && value && !value.startsWith('http')) value = `<a href="https://instagram.com/${value.replace('@', '')}" target="_blank" style="color: var(--accent-color); text-decoration: none;">@${value.replace('@', '')}</a>`;
        if (key === 'whatsapp' && value) value = `<a href="https://wa.me/${value.replace(/\D/g, '')}" target="_blank" style="color: #25D366;">📱 ${value}</a>`;
        if (!value) value = '<span style="color: var(--text-tertiary);">-</span>';

        html += `<td>${value}</td>`;
    });

    tr.innerHTML = html;
    modalResultsBody.appendChild(tr);
}

// Controls Events
btnPause.onclick = () => {
    if (currentModalScraperId) socket.emit('pause-scrape', { id: currentModalScraperId });
};

btnResume.onclick = () => {
    if (currentModalScraperId) socket.emit('resume-scrape', { id: currentModalScraperId });
};

btnCancel.onclick = () => {
    if (currentModalScraperId && confirm('Tem certeza que deseja cancelar?')) {
        socket.emit('cancel-scrape', { id: currentModalScraperId });
    }
};

// History Filter Events
const filterStatus = document.getElementById('filter-status');
const filterType = document.getElementById('filter-type');

if (filterStatus) {
    filterStatus.addEventListener('change', renderHistory);
}

if (filterType) {
    filterType.addEventListener('change', renderHistory);
}

// Clear History Modal
const clearHistoryBtn = document.getElementById('clear-history-btn');
const clearHistoryModal = document.getElementById('clear-history-modal');
const cancelClearHistory = document.getElementById('cancel-clear-history');
const confirmClearHistory = document.getElementById('confirm-clear-history');

if (clearHistoryBtn && clearHistoryModal) {
    clearHistoryBtn.addEventListener('click', () => {
        clearHistoryModal.classList.remove('hidden');
    });

    clearHistoryModal.addEventListener('click', (e) => {
        if (e.target === clearHistoryModal) {
            clearHistoryModal.classList.add('hidden');
        }
    });
}

if (cancelClearHistory) {
    cancelClearHistory.addEventListener('click', () => {
        clearHistoryModal.classList.add('hidden');
    });
}

if (confirmClearHistory) {
    confirmClearHistory.addEventListener('click', async () => {
        try {
            const response = await fetch('/api/v1/clear-history', {
                method: 'DELETE',
                headers: {
                    'X-API-Key': cachedApiKey || ''
                }
            });

            if (response.ok) {
                history = [];
                renderHistory();
                clearHistoryModal.classList.add('hidden');
                alert('Histórico limpo com sucesso!');
            } else {
                alert('Erro ao limpar histórico');
            }
        } catch (error) {
            console.error('Error clearing history:', error);
            alert('Erro ao limpar histórico');
        }
    });
}

// ========== Live View Modal ==========
const liveViewModal = document.getElementById('live-view-modal');
const closeLiveViewBtn = document.getElementById('close-live-view');
const btnLiveView = document.getElementById('btn-live-view');
const liveScreenshot = document.getElementById('live-screenshot');
const screenshotPlaceholder = document.getElementById('screenshot-placeholder');
const liveActionBadge = document.getElementById('live-action-badge');
const liveLogs = document.getElementById('live-logs');

// Per-scraper screenshot storage: Map<scraperId, { image, timestamp, expiryTimer }>
const scraperScreenshots = new Map();
let liveViewActive = false;

// Enable/disable Ao Vivo button based on available screenshot
function updateLiveViewButtonState() {
    if (!btnLiveView || !currentModalScraperId) return;

    const screenshotData = scraperScreenshots.get(currentModalScraperId);
    if (screenshotData && screenshotData.image) {
        btnLiveView.disabled = false;
        btnLiveView.title = 'Visualizar ao vivo';
    } else {
        btnLiveView.disabled = true;
        btnLiveView.title = 'Aguardando screenshot...';
    }
}

// Open live view modal
function openLiveView() {
    if (!currentModalScraperId) return;

    const screenshotData = scraperScreenshots.get(currentModalScraperId);
    if (!screenshotData || !screenshotData.image) return;

    liveViewModal.classList.remove('hidden');
    liveViewActive = true;

    // Load existing screenshot for this scraper
    liveScreenshot.src = screenshotData.image;
    liveScreenshot.style.display = 'block';
    screenshotPlaceholder.style.display = 'none';

    // Copy existing logs from main modal
    const mainLogs = document.getElementById('modal-logs');
    if (mainLogs && liveLogs) {
        liveLogs.innerHTML = mainLogs.innerHTML;
        liveLogs.scrollTop = liveLogs.scrollHeight;
    }
}

// Close live view modal
function closeLiveView() {
    liveViewModal.classList.add('hidden');
    liveViewActive = false;
}

// Handle Ao Vivo button click
if (btnLiveView) {
    btnLiveView.addEventListener('click', openLiveView);
}

// Handle close button
if (closeLiveViewBtn) {
    closeLiveViewBtn.addEventListener('click', closeLiveView);
}

// Close on overlay click
if (liveViewModal) {
    liveViewModal.addEventListener('click', (e) => {
        if (e.target === liveViewModal) {
            closeLiveView();
        }
    });
}

// Socket listener for screenshots - stores per scraper
socket.on('scraper-screenshot', (data) => {
    const { id, image, action, timestamp } = data;

    // Get or create screenshot data for this scraper
    let screenshotData = scraperScreenshots.get(id);

    // Clear any existing expiry timer for this scraper
    if (screenshotData && screenshotData.expiryTimer) {
        clearTimeout(screenshotData.expiryTimer);
    }

    // Store new screenshot
    scraperScreenshots.set(id, {
        image: image,
        action: action,
        timestamp: timestamp,
        expiryTimer: null
    });

    // Update button state if viewing this scraper
    if (id === currentModalScraperId) {
        updateLiveViewButtonState();
    }

    // If live view is open for this scraper, update it
    if (liveViewActive && id === currentModalScraperId && image) {
        liveScreenshot.src = image;
        liveScreenshot.style.display = 'block';
        screenshotPlaceholder.style.display = 'none';

        // Update action badge
        if (liveActionBadge) {
            const actionLabels = {
                'SEARCH_COMPLETE': 'Busca OK',
                'COLLECT_COMPLETE': 'Coletando...',
                'EXTRACT_BUSINESS': 'Extraindo',
                'EXTRACT_PROFILE': 'Extraindo Perfil',
                'INVESTIGATE_WEBSITE': 'Investigando',
                'NAVIGATE_PAGE': 'Navegando...',
                'ERROR': 'ERRO'
            };
            liveActionBadge.textContent = actionLabels[action] || action;
            liveActionBadge.className = 'status-badge ' + (action === 'ERROR' ? 'status-error' : 'status-running');
        }
    }
});

// Start 10-minute expiry timer when scraper completes
socket.on('scraper-complete', (data) => {
    const screenshotData = scraperScreenshots.get(data.id);
    if (screenshotData) {
        // Set 10 minute expiry timer
        screenshotData.expiryTimer = setTimeout(() => {
            scraperScreenshots.delete(data.id);
            // Update button if currently viewing this scraper
            if (data.id === currentModalScraperId) {
                updateLiveViewButtonState();
                if (liveViewActive) {
                    closeLiveView();
                }
            }
        }, 10 * 60 * 1000); // 10 minutes
    }
});

// Sync logs to live view when log is appended
const originalAppendLogToModal = appendLogToModal;
appendLogToModal = function (log) {
    originalAppendLogToModal(log);

    // Also append to live logs if active
    if (liveViewActive && liveLogs) {
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.textContent = log.message;
        liveLogs.appendChild(logEntry);
        liveLogs.scrollTop = liveLogs.scrollHeight;
    }
};

// Update button state when modal opens for a scraper
const originalOpenModal = openModal;
openModal = function (id, isActive) {
    originalOpenModal(id, isActive);
    setTimeout(updateLiveViewButtonState, 100);
};
