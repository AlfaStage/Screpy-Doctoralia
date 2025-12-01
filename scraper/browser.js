const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

class BrowserManager {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async initialize() {
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    });

    this.page = await this.browser.newPage();
    
    // Set viewport
    await this.page.setViewport({ width: 1920, height: 1080 });
    
    // Set extra headers to appear more human-like
    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });

    return this.page;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  getPage() {
    return this.page;
  }
}

module.exports = BrowserManager;
