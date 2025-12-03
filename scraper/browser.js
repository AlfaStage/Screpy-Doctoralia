const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ProxyChain = require('proxy-chain');

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

class BrowserManager {
  constructor() {
    this.browser = null;
    this.page = null;
    this.proxyServer = null; // For SOCKS proxies
  }

  async initialize(proxyUrl = null) {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920x1080',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    let actualProxyUrl = proxyUrl;

    // If proxy is SOCKS, create local HTTP server using proxy-chain
    if (proxyUrl && (proxyUrl.includes('socks4://') || proxyUrl.includes('socks5://'))) {
      console.log(`🔗 Criando servidor local para proxy SOCKS: ${proxyUrl}`);

      // Create anonymous proxy server that forwards to SOCKS proxy
      this.proxyServer = new ProxyChain.Server({
        port: 0, // Use random available port
        prepareRequestFunction: () => {
          return {
            upstreamProxyUrl: proxyUrl
          };
        }
      });

      await this.proxyServer.listen();
      actualProxyUrl = `http://127.0.0.1:${this.proxyServer.port}`;
      console.log(`✅ Servidor proxy local criado em ${actualProxyUrl} -> ${proxyUrl}`);
    }

    // Add proxy if provided
    if (actualProxyUrl) {
      launchArgs.push(`--proxy-server=${actualProxyUrl}`);
      console.log(`🌐 Configurando browser com proxy: ${actualProxyUrl}`);
    }

    const launchOptions = {
      headless: 'new',
      args: launchArgs
    };

    // Only set executablePath if explicitly defined in environment
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.browser = await puppeteer.launch(launchOptions);

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

    // Close proxy server if it was created for SOCKS
    if (this.proxyServer) {
      await this.proxyServer.close();
      console.log('🔌 Servidor proxy local fechado');
      this.proxyServer = null;
    }
  }

  getPage() {
    return this.page;
  }
}

module.exports = BrowserManager;
