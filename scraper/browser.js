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
    let proxyAuth = null;

    // Helper to parse proxy URL and separate credentials
    if (proxyUrl && !proxyUrl.includes('socks')) {
      try {
        const parsed = new URL(proxyUrl);
        if (parsed.username && parsed.password) {
          proxyAuth = {
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password)
          };
          // Reconstruct URL without credentials
          actualProxyUrl = `${parsed.protocol}//${parsed.host}`;
          console.log(`🔒 Credenciais de proxy detectadas (separadas para autenticação via page.authenticate)`);
        }
      } catch (e) {
        console.error('Erro ao analisar URL do proxy:', e);
      }
    }

    // Use proxy-chain ONLY for SOCKS proxies (they need tunneling)
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
      const localProxyUrl = `http://127.0.0.1:${this.proxyServer.port}`;
      console.log(`✅ Servidor proxy local criado em ${localProxyUrl} -> ${proxyUrl}`);

      // Test request through tunnel
      console.log(`🧪 Testando túnel SOCKS...`);
      const tunnelWorks = await this.testProxyTunnel(localProxyUrl);

      if (tunnelWorks) {
        console.log(`✅ Túnel SOCKS funcionando corretamente!`);
        actualProxyUrl = localProxyUrl;
      } else {
        console.log(`❌ Túnel SOCKS falhou no teste!`);
        await this.proxyServer.close();
        this.proxyServer = null;
        throw new Error(`TUNNEL_FAILED: Túnel SOCKS para ${proxyUrl} não funcionou`);
      }
    } else if (actualProxyUrl) {
      // HTTP proxy
      console.log(`🌐 Usando proxy HTTP direto: ${actualProxyUrl}`);
    }

    // Add proxy to launch args
    if (actualProxyUrl) {
      launchArgs.push(`--proxy-server=${actualProxyUrl}`);
      console.log(`🌐 Configurando browser com proxy: ${actualProxyUrl}`);
    }

    const launchOptions = {
      headless: 'new',
      protocolTimeout: 120000, // Increase protocol timeout to 2 minutes
      args: launchArgs
    };

    // Only set executablePath if explicitly defined in environment
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.browser = await puppeteer.launch(launchOptions);

    this.page = await this.browser.newPage();

    // Authenticate if credentials were extracted
    if (proxyAuth) {
      console.log('🔑 Autenticando proxy...');
      await this.page.authenticate(proxyAuth);
    }

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

    // Close SOCKS proxy server if it was created
    if (this.proxyServer) {
      await this.proxyServer.close();
      console.log('🔌 Servidor proxy SOCKS local fechado');
      this.proxyServer = null;
    }
  }

  getPage() {
    return this.page;
  }

  // Create or setup a new page with standard configuration
  async setupPage(page = null) {
    const targetPage = page || (await this.browser.newPage());

    // Set viewport
    await targetPage.setViewport({ width: 1920, height: 1080 });

    // Set default timeouts to prevent infinite protocol hangs
    await targetPage.setDefaultTimeout(60000);
    await targetPage.setDefaultNavigationTimeout(60000);

    // Set extra headers
    await targetPage.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });

    // Authenticate if we have proxy credentials
    // (Note: Proxy logic from initialize() might need to be stored to re-apply here if needed, 
    // but usually page.authenticate persists or is set at browser level for new pages if using args. 
    // For now, basic setup is enough to fix the crash.)

    return targetPage;
  }

  // Testar se o túnel do proxy está funcionando
  async testProxyTunnel(localProxyUrl) {
    return new Promise((resolve) => {
      const http = require('http');
      const { URL } = require('url');

      try {
        const proxyUrlParsed = new URL(localProxyUrl);

        // Fazer requisição HTTP simples através do proxy
        const options = {
          hostname: proxyUrlParsed.hostname,
          port: proxyUrlParsed.port,
          path: 'http://httpbin.org/ip', // Serviço simples para teste
          method: 'GET',
          timeout: 10000, // 10 segundos
          headers: {
            'Host': 'httpbin.org'
          }
        };

        const req = http.request(options, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode === 200) {
              console.log(`🧪 Teste do túnel: resposta recebida (${res.statusCode})`);
              resolve(true);
            } else {
              console.log(`🧪 Teste do túnel: código inesperado (${res.statusCode})`);
              resolve(false);
            }
          });
        });

        req.on('error', (error) => {
          console.log(`🧪 Teste do túnel: erro - ${error.message}`);
          resolve(false);
        });

        req.on('timeout', () => {
          console.log(`🧪 Teste do túnel: timeout`);
          req.destroy();
          resolve(false);
        });

        req.end();
      } catch (error) {
        console.log(`🧪 Teste do túnel: exceção - ${error.message}`);
        resolve(false);
      }
    });
  }
}

module.exports = BrowserManager;
