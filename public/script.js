const socket = io();

// State
let activeScrapers = new Map();
let history = [];
let currentModalScraperId = null;

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
    { name: 'Cardiologista', icon: 'fa-heart' },
    { name: 'Dermatologista', icon: 'fa-hand-sparkles' },
    { name: 'Pediatra', icon: 'fa-baby' },
    { name: 'Ortopedista', icon: 'fa-bone' },
    { name: 'Ginecologista', icon: 'fa-venus' },
    { name: 'Neurologista', icon: 'fa-brain' },
    { name: 'Psiquiatra', icon: 'fa-head-side-virus' },
    { name: 'Oftalmologista', icon: 'fa-eye' },
    { name: 'Endocrinologista', icon: 'fa-flask' },
    { name: 'Psicólogo', icon: 'fa-user-md' },
    { name: 'Nutricionista', icon: 'fa-apple-alt' },
    { name: 'Fisioterapeuta', icon: 'fa-running' },
    { name: 'Dentista', icon: 'fa-tooth' },
    { name: 'Urologista', icon: 'fa-mars' },
    { name: 'Otorrinolaringologista', icon: 'fa-ear-listen' },
    { name: 'Pneumologista', icon: 'fa-lungs' },
    { name: 'Gastroenterologista', icon: 'fa-stomach' },
    { name: 'Reumatologista', icon: 'fa-person-cane' },
    { name: 'Oncologista', icon: 'fa-ribbon' },
    { name: 'Infectologista', icon: 'fa-virus' },
    { name: 'Geriatra', icon: 'fa-person-walking-cane' },
    { name: 'Nefrologista', icon: 'fa-droplet' },
    { name: 'Anestesiologista', icon: 'fa-syringe' },
    { name: 'Radiologista', icon: 'fa-x-ray' }
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

// Socket.io Events
socket.on('initial-state', (data) => {
    console.log('Received initial-state:', data);
    activeScrapers = new Map(data.activeScrapers.map(s => [s.id, s]));
    history = data.history || [];
    console.log('Loaded history items:', history.length);
    renderActiveScrapers();
    renderHistory();
});

socket.on('scrape-started', ({ id }) => {
    // Criar scraper com dados iniciais
    const config = { city: document.getElementById('city').value || '', specialties: Array.from(selectedSpecialties), quantity: parseInt(document.getElementById('quantity').value) || 10 };
    const scraper = {
        id,
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
    openModal(scraper);
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
            appendResultToModal(data.data);
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
    const onlyWithPhone = document.getElementById('only-with-phone').checked;

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
        onlyWithPhone
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

apiKeyToggle.addEventListener('click', async () => {
    apiKeyModal.classList.remove('hidden');
    try {
        const response = await fetch('/api/v1/key');
        const data = await response.json();
        apiKeyValue.textContent = data.apiKey || 'Erro ao carregar';
    } catch (error) {
        apiKeyValue.textContent = 'Erro ao carregar';
        console.error('Error fetching API key:', error);
    }
});

closeApiKeyModal.addEventListener('click', () => {
    apiKeyModal.classList.add('hidden');
});

apiKeyModal.addEventListener('click', (e) => {
    if (e.target === apiKeyModal) {
        apiKeyModal.classList.add('hidden');
    }
});

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
    if (history.length === 0) {
        historyList.innerHTML = '<div class="empty-state">Histórico vazio</div>';
        return;
    }

    history.forEach(item => {
        const card = createScraperCard(item, false);
        historyList.appendChild(card);
    });
}

function createScraperCard(item, isActive) {
    const div = document.createElement('div');
    div.className = `scraper-card ${isActive ? 'active' : ''}`;
    div.onclick = () => openModal(item.id, isActive);

    const specialties = item.config?.specialties?.join(', ') || 'Todos';
    const city = item.config?.city || 'Qualquer lugar';
    const progress = isActive ? (item.current || 0) : (item.result?.count || 0);
    const total = isActive ? (item.total || item.config.quantity) : (item.result?.count || item.config.quantity);
    const percent = total > 0 ? (progress / total) * 100 : 0;

    div.innerHTML = `
        <div class="card-header">
            <div class="card-title">${specialties} em ${city}</div>
            <div class="status-dot ${item.status}"></div>
        </div>
        <div class="card-meta">
            <span>${progress}/${total} perfis</span>
            <span>${item.status}</span>
        </div>
        <div class="mini-progress">
            <div class="mini-progress-bar" style="width: ${percent}%"></div>
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

    // Limpar logs anteriores ao abrir modal
    modalLogs.innerHTML = '';

    // Limpar resultados anteriores
    modalResultsBody.innerHTML = '';

    modal.classList.remove('hidden');

    // Carregar logs existentes desta extração (verificar múltiplas fontes)
    const logs = item.logs || (item.result ? item.result.logs : null) || [];
    if (logs && logs.length > 0) {
        logs.forEach(log => appendLogToModal(log));
    } else {
        // Se não há logs, mostrar mensagem
        const noLogsDiv = document.createElement('div');
        noLogsDiv.className = 'log-entry';
        noLogsDiv.style.fontStyle = 'italic';
        noLogsDiv.textContent = 'Nenhum log disponível para esta extração';
        modalLogs.appendChild(noLogsDiv);
    }

    // Carregar resultados existentes desta extração
    const results = item.results || (item.result ? item.result.data : null) || [];
    if (results && results.length > 0) {
        results.forEach(r => appendResultToModal(r));
    }

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
    const specialties = item.config?.specialties?.join(', ') || 'Todos';
    modalTitle.textContent = `${specialties} em ${item.config?.city || 'Qualquer lugar'}`;

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

    // Resultados são adicionados ao vivo via evento scraper-result
    // Só recarregar se for modal de histórico (extração já concluída)
    const isCompletedOrError = item.status === 'completed' || item.status === 'error';
    if (isCompletedOrError && modalResultsBody.children.length === 0) {
        const results = item.results || (item.result ? item.result.data : []);
        if (results && results.length > 0) {
            results.forEach(r => appendResultToModal(r));
        } else {
            modalResultsBody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-tertiary); font-style: italic;">Nenhum resultado disponível</td></tr>';
        }
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

function appendResultToModal(data) {
    const tr = document.createElement('tr');
    const especialidades = data.especialidades && data.especialidades.length > 0
        ? data.especialidades.join(', ')
        : '-';
    tr.innerHTML = `
        <td>${data.nome}</td>
        <td>${especialidades}</td>
        <td>${data.numeroMovel || data.numeroFixo || '-'}</td>
    `;
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


