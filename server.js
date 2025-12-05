require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ScraperManager = require('./scraper/manager');
const SpecialtyFetcher = require('./scraper/specialties');
const { getOrCreateApiKey } = require('./api/apiMiddleware');
const createApiRoutes = require('./api/apiRoutes');

// Initialize API Key (auto-generate if not set)
const apiKey = getOrCreateApiKey();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/results', express.static('results'));

// Initialize Scraper Manager
const scraperManager = new ScraperManager(io);

// API v1 routes
app.use('/api/v1', createApiRoutes(scraperManager));

// Socket.io connection
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Send initial state
    socket.emit('initial-state', {
        activeScrapers: scraperManager.getActiveScrapers(),
        history: scraperManager.getHistory()
    });

    socket.on('start-scrape', async (data) => {
        try {
            const { specialties, city, quantity, onlyWithPhone } = data;
            console.log('Starting scrape:', { specialties, city, quantity, onlyWithPhone });

            // Validate input (specialties can be empty array, will default to "Médico")
            if (!quantity || quantity < 1) {
                socket.emit('error', { message: 'Quantidade inválida' });
                return;
            }

            const id = await scraperManager.startScrape(data);
            socket.emit('scrape-started', { id });

        } catch (error) {
            console.error('Error starting scrape:', error);
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('pause-scrape', async ({ id }) => {
        await scraperManager.pauseScraper(id);
    });

    socket.on('resume-scrape', async ({ id }) => {
        await scraperManager.resumeScraper(id);
    });

    socket.on('cancel-scrape', async ({ id }) => {
        await scraperManager.cancelScraper(id);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// REST API endpoints (legacy)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/specialties', async (req, res) => {
    try {
        const fetcher = new SpecialtyFetcher();
        const specialties = await fetcher.fetchSpecialties();
        res.json({ success: true, specialties });
    } catch (error) {
        console.error('Error fetching specialties:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/history', (req, res) => {
    res.json(scraperManager.getHistory());
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        activeScrapers: scraperManager.getActiveScrapers().length
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📖 Open your browser and navigate to http://localhost:${PORT}`);
    console.log(`\n🔑 API Key: ${apiKey}`);
    console.log(`📡 API Base URL: http://localhost:${PORT}/api/v1\n`);
});

