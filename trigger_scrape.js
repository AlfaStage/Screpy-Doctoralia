const io = require('socket.io-client');

const socket = io('http://localhost:3000');

socket.on('connect', () => {
    console.log('Connected to server');

    const request = {
        specialties: ['Cardiologista'],
        city: 'São Paulo',
        quantity: 10
    };

    console.log('Sending scrape request:', request);
    socket.emit('start-scrape', request);
});

socket.on('log', (data) => {
    // console.log('[LOG]', data.message);
});

socket.on('progress', (data) => {
    console.log('[PROGRESS]', data.message);
    if (data.message.includes('Scraping concluído') || data.message.includes('Erro')) {
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    }
});

socket.on('error', (err) => {
    console.error('Socket error:', err);
    process.exit(1);
});
