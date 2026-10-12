# Documentação Técnica: Sistema de Gerenciamento de Proxies

## Objetivo
Este documento detalha o funcionamento interno dos proxies no sistema Screpy, servindo como guia para futuras implementações e manutenções, conforme exigido pelo Protocolo de Memória do usuário.

## 1. Endpoints de Coleta (Sources)

### **ProxyScrape**
- **URL:** `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=br&proxy_format=protocolipport&format=json&timeout=20000&limit=50`
- **Formato:** JSON com objeto raiz `proxies`.
- **Parsing:** Extrai o campo `proxy` (que já vem no formato `protocolo://ip:port`).

### **Litport**
- **URL:** `https://litport.net/api/free-proxy?country=br&uptimeRating=75&limit=50&sortBy=pingAt_asc&page=1&format=json`
- **Formato:** JSON Array direto.
- **Parsing:** Concatena `p.protocol + "://" + p.host + ":" + p.port`.

### **Geonode**
- **URL:** `https://proxylist.geonode.com/api/proxy-list?country=BR&filterUpTime=90&filterLastChecked=30&speed=fast&limit=50&page=1&sort_by=lastChecked&sort_type=desc`
- **Formato:** JSON com objeto raiz `data`.
- **Parsing:** Usa o primeiro elemento de `p.protocols` e concatena com `ip` e `port`.

### **911Proxy**
- **URL:** `https://www.911proxy.com/web_v1/free-proxy/list?page_size=60&page=1&country_code=BR`
- **Formato:** JSON `{ code, data: { list: [] } }`.
- **Parsing:** Filtra por `status === 1`. Mapeia `protocol`:
    - `2` -> `http`
    - `4` -> `socks4`
    - `5` -> `socks5`

### **Bright Data (Contingência)**
- **Serviço:** Proxy residencial pago.
- **Implementação:** Usa variáveis de ambiente (`BRIGHTDATA_HOST`, etc) para construir a URL autenticada.

## 2. Lógica de Operação
1. **Busca Assíncrona:** O `ProxyManager` dispara chamadas para todas as fontes em paralelo.
2. **Priorização:** Proxies HTTP/HTTPS recebem um bônus de pontuação (`score += 40`) para serem tentados primeiro, pois têm melhor compatibilidade nativa com o navegador.
3. **Validação TCP:** Antes de usar qualquer proxy, o sistema tenta abrir um socket TCP no IP:Porta com timeout de 2s. Se falhar, o proxy é marcado como `failed` e ignorado.
4. **Túnel de SOCKS para HTTP:** Quando um proxy SOCKS é selecionado, o `BrowserManager` utiliza o `proxy-chain` para rodar um servidor local que converte o tráfego SOCKS em HTTP, permitindo que o Puppeteer funcione sem erros de protocolo.

## 3. Localização dos Arquivos
- **Lógica Central:** `/scraper/proxyManager.js`
- **Implementação no Browser:** `/scraper/browser.js`
- **Configurações:** `/config/scraper.config.js`
