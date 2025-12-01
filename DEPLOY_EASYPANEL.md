# Guia de Deploy no EasyPanel

Este guia explica como colocar o **Doctoralia Scraper** em produção usando o EasyPanel.

## Pré-requisitos

1.  Ter um servidor com EasyPanel instalado.
2.  Ter este código em um repositório Git (GitHub, GitLab, etc.).

## Passos para Deploy

### 1. Criar o Projeto no EasyPanel
1.  Acesse seu painel do EasyPanel.
2.  Crie um novo **Project** (ex: `scrapers`).
3.  Dentro do projeto, clique em **+ Service** e escolha **App**.

### 2. Configurar a Fonte (Source)
1.  Em **Source**, conecte seu repositório do GitHub/GitLab.
2.  Selecione o repositório onde este código está.
3.  Branch: `main` (ou a que você estiver usando).

### 3. Configurar o Build
1.  Em **Build**, selecione o método **Dockerfile**.
    *   O EasyPanel vai detectar automaticamente o arquivo `Dockerfile` que criei na raiz do projeto.
    *   Isso é essencial porque o Puppeteer precisa de várias bibliotecas do sistema (Chrome) que já configurei nesse arquivo.

### 4. Configurar a Porta
1.  Vá na aba **Network**.
2.  Certifique-se de que a porta está definida como `3000`.
3.  Habilite o domínio público se quiser acessar externamente (ex: `scraper.seu-dominio.com`).

### 5. Configurar Persistência (Importante!) 💾
Para não perder os arquivos CSV e JSON gerados quando o servidor reiniciar, você precisa criar um volume persistente.

1.  Vá na aba **Storage** (ou Volumes).
2.  Adicione um novo volume:
    *   **Mount Path**: `/usr/src/app/results`
    *   **Name**: `doctoralia-results` (ou qualquer nome)

Isso garante que a pasta `results` dentro do container seja salva no disco do servidor.

### 6. Deploy
1.  Clique em **Deploy** ou **Save & Deploy**.
2.  Aguarde o processo de build (pode demorar uns minutos na primeira vez para baixar o Chrome).

---

## Solução de Problemas Comuns

*   **Erro de Puppeteer/Chrome**: Se der erro ao iniciar dizendo que não achou o Chrome, verifique se o método de build está mesmo como **Dockerfile**.
*   **Memória**: O Puppeteer consome bastante memória. Se o container cair ("OOM Killed"), aumente o limite de memória do serviço (Resources) para pelo menos **1GB** ou **2GB**.
