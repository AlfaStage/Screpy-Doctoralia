# Guia de Deploy - Doctoralia Scraper

Este guia explica como fazer deploy do Doctoralia Scraper em diferentes ambientes.

---

## Sumário
1. [Deploy Local (Terminal)](#deploy-local-terminal)
2. [Deploy com Docker](#deploy-com-docker)
3. [Deploy no EasyPanel](#deploy-no-easypanel)
4. [Deploy no Railway](#deploy-no-railway)
5. [Deploy no Render](#deploy-no-render)

---

## Deploy Local (Terminal)

### Pré-requisitos
- Node.js 18+ instalado
- npm ou pnpm

### Passos

1. **Clone o repositório**
   ```bash
   git clone https://github.com/seu-usuario/doctoralia-scraper.git
   cd doctoralia-scraper
   ```

2. **Instale as dependências**
   ```bash
   npm install
   ```

3. **Configure as variáveis de ambiente**
   ```bash
   cp .env.example .env
   # Edite o .env se necessário (PORT, proxies, etc.)
   ```

4. **Inicie o servidor**
   ```bash
   npm start
   ```

5. **Acesse o sistema**
   - Interface Web: `http://localhost:3000`
   - API: `http://localhost:3000/api/v1`
   - A API Key será exibida no terminal ao iniciar

---

## Deploy com Docker

### Usando Docker diretamente

1. **Build da imagem**
   ```bash
   docker build -t doctoralia-scraper .
   ```

2. **Execute o container**
   ```bash
   docker run -d \
     --name scraper \
     -p 3000:3000 \
     -v doctoralia-results:/usr/src/app/results \
     doctoralia-scraper
   ```

3. **Veja os logs (API Key)**
   ```bash
   docker logs scraper
   ```

### Usando Docker Compose

Crie um arquivo `docker-compose.yml`:

```yaml
version: '3.8'
services:
  scraper:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - results:/usr/src/app/results
    environment:
      - PORT=3000
      # - API_KEY=sua-chave-aqui (opcional)
    restart: unless-stopped

volumes:
  results:
```

Execute:
```bash
docker-compose up -d
```

---

## Deploy no EasyPanel

### 1. Criar o Projeto
1. Acesse seu painel do EasyPanel
2. Crie um novo **Project** (ex: `scrapers`)
3. Dentro do projeto, clique em **+ Service** → **App**

### 2. Configurar a Fonte (Source)
1. Em **Source**, conecte seu repositório GitHub/GitLab
2. Selecione o repositório e a branch (`main`)

### 3. Configurar o Build
1. Em **Build**, selecione o método **Dockerfile**
2. O EasyPanel detectará automaticamente o `Dockerfile`

### 4. Configurar a Rede
1. Vá na aba **Network**
2. Defina a porta como `3000`
3. Habilite o domínio público (ex: `scraper.seu-dominio.com`)

### 5. Configurar Persistência (Importante!)
1. Vá na aba **Storage** (ou Volumes)
2. Adicione um novo volume:
   - **Mount Path**: `/usr/src/app/results`
   - **Name**: `doctoralia-results`

### 6. Variáveis de Ambiente (Opcional)
1. Em **Environment Variables**, adicione:
   - `PORT=3000`
   - `API_KEY=sua-chave-personalizada` (opcional)

### 7. Deploy
1. Clique em **Deploy** ou **Save & Deploy**
2. Aguarde o build (pode demorar alguns minutos na primeira vez)

### Solução de Problemas
- **Erro de memória (OOM)**: Aumente o limite para 1-2GB em Resources
- **Erro de Chrome/Puppeteer**: Verifique se o método de build está como Dockerfile

---

## Deploy no Railway

1. **Conecte o repositório ao Railway**
   - Acesse [railway.app](https://railway.app)
   - New Project → Deploy from GitHub Repo
   - Selecione o repositório

2. **Configure as variáveis**
   - Adicione `PORT=3000` (Railway usa porta automática via `$PORT`)
   - Adicione outras variáveis conforme necessário

3. **Configure o volume**
   - Vá em Settings → Volumes
   - Adicione um volume montado em `/usr/src/app/results`

4. **Deploy automático**
   - Railway detectará o Dockerfile automaticamente
   - Cada push na branch main fará redeploy

---

## Deploy no Render

1. **Crie um Web Service**
   - Acesse [render.com](https://render.com)
   - New → Web Service → Connect GitHub

2. **Configurações**
   - **Build Command**: (deixe vazio, usa Dockerfile)
   - **Environment**: Docker
   - Adicione variáveis de ambiente conforme necessário

3. **Disco Persistente**
   - Vá em Settings → Disks
   - Adicione disco montado em `/usr/src/app/results`

---

## Notas sobre Recursos

O Puppeteer/Chrome consome bastante recursos. Recomendações:
- **Memória mínima**: 1GB
- **Memória recomendada**: 2GB
- **CPU**: 1 vCPU mínimo

## Segurança

> **Importante**: A API Key é gerada automaticamente e salva no `.env`. Em produção, considere:
> - Definir uma API Key forte manualmente
> - Usar HTTPS para todas as requisições
> - Configurar rate limiting se exposto publicamente
