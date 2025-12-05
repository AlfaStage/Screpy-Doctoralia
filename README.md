# Doctoralia Scraper

Um scraper de alta velocidade para extrair dados de médicos do site Doctoralia.com.br. Esta ferramenta permite buscar médicos por especialidade e cidade, extraindo informações detalhadas como nome, especialidades, telefones e endereços.

## 🚀 Características

- **Interface Web Moderna**: Interface intuitiva com tema dark e atualizações em tempo real
- **API REST**: API completa para integração com outros sistemas
- **Filtros Personalizados**: Busca por especialidade e cidade
- **Alta Velocidade**: Extração rápida e eficiente de dados
- **Anti-Detecção**: Utiliza Puppeteer Extra com Stealth Plugin para evitar bloqueios
- **Comportamento Humano**: Simula ações humanas com delays aleatórios e movimentos de mouse
- **Progresso em Tempo Real**: Acompanhe o progresso da extração via Socket.io
- **Webhooks**: Receba notificações automáticas ao finalizar extrações
- **Exportação CSV/JSON**: Resultados exportados em múltiplos formatos

## 📋 Pré-requisitos

- Node.js (versão 14 ou superior)
- npm (geralmente vem com Node.js)
- Windows, macOS ou Linux

## 🔧 Instalação

1. **Clone ou baixe este repositório**

2. **Navegue até o diretório do projeto**
   ```bash
   cd "Screpy Doctoralia"
   ```

3. **Instale as dependências**
   
   No Windows:
   ```bash
   npm.cmd install
   ```
   
   No macOS/Linux:
   ```bash
   npm install
   ```

   Isso instalará todas as dependências necessárias:
   - `express` - Servidor web
   - `socket.io` - Comunicação em tempo real
   - `puppeteer` - Automação do navegador
   - `puppeteer-extra` - Extensões para Puppeteer
   - `puppeteer-extra-plugin-stealth` - Plugin anti-detecção
   - `cors` - Habilitação de CORS

## 🎯 Como Usar

### Iniciando o Servidor

No Windows:
```bash
npm.cmd start
```

No macOS/Linux:
```bash
npm start
```

O servidor será iniciado em `http://localhost:3000`

### Usando a Interface Web

1. **Abra seu navegador** e acesse `http://localhost:3000`

2. **Preencha os campos do formulário**:
   - **Especialidade**: Digite a especialidade médica (ex: Cardiologista, Dermatologista)
   - **Cidade**: Digite a cidade desejada (ex: São Paulo, Rio de Janeiro)
   - **Quantidade**: Defina quantos perfis deseja extrair (máximo: 500)

3. **Clique em "Iniciar Scraping"**

4. **Acompanhe o progresso** em tempo real:
   - Status atual da operação
   - Barra de progresso
   - Log detalhado de atividades

5. **Baixe os resultados**:
   - Após a conclusão, clique em "Baixar CSV"
   - O arquivo será salvo com todas as informações extraídas

### Formato dos Dados Extraídos

O arquivo CSV conterá as seguintes colunas:

| Coluna | Descrição |
|--------|-----------|
| **Nome** | Nome completo do médico |
| **Especialidades** | Lista de especialidades (separadas por ponto e vírgula) |
| **Numero Fixo** | Número de telefone fixo |
| **Numero Movel** | Número de telefone móvel/celular |
| **Enderecos** | Lista de endereços de atendimento (separados por ponto e vírgula) |

## 📁 Estrutura do Projeto

```
Screpy Doctoralia/
├── api/
│   ├── apiMiddleware.js  # Autenticação via API Key
│   ├── apiRoutes.js      # Endpoints REST
│   └── webhookService.js # Serviço de webhooks
├── scraper/
│   ├── browser.js        # Gerenciamento do navegador com Stealth
│   ├── search.js         # Lógica de busca e coleta de URLs
│   ├── profile.js        # Extração de dados dos perfis
│   ├── manager.js        # Gerenciador de múltiplos scrapers
│   ├── utils.js          # Funções utilitárias (delays, comportamento humano)
│   └── index.js          # Controlador principal do scraper
├── public/
│   ├── index.html        # Interface web
│   ├── script.js         # Lógica do cliente (Socket.io)
│   └── style.css         # Estilos da interface
├── docs/
│   ├── API.md            # Documentação da API
│   └── DEPLOY.md         # Guias de deploy
├── results/              # Pasta onde os CSVs são salvos
├── server.js             # Servidor Express + Socket.io
├── Dockerfile            # Configuração Docker
├── package.json          # Configurações e dependências
└── README.md             # Este arquivo
```

## 📡 API REST

O sistema inclui uma API REST completa para integração com outros sistemas.

### Autenticação

Todas as requisições requerem uma API Key no header:
```
X-API-Key: sua-api-key-aqui
```

A API Key é gerada automaticamente na primeira execução e exibida:
- No terminal ao iniciar o servidor
- Na interface web (clique no ícone 🔑)

### Endpoints Principais

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/v1/scrape` | Iniciar extração |
| GET | `/api/v1/scrape/:id` | Consultar status/resultado |
| GET | `/api/v1/history` | Listar histórico |

### Exemplo de Uso

```bash
# Iniciar extração
curl -X POST http://localhost:3000/api/v1/scrape \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sua-api-key" \
  -d '{"city":"São Paulo","quantity":10,"onlyWithPhone":true}'

# Consultar resultado
curl http://localhost:3000/api/v1/scrape/ID_DA_EXTRACAO \
  -H "X-API-Key: sua-api-key"
```

📚 **Documentação completa**: [docs/API.md](docs/API.md)

## ⚙️ Configurações Avançadas

### Alterando a Porta do Servidor

Por padrão, o servidor roda na porta 3000. Para alterar:

1. Abra o arquivo `server.js`
2. Modifique a linha:
   ```javascript
   const PORT = process.env.PORT || 3000;
   ```
3. Ou defina a variável de ambiente `PORT`:
   ```bash
   PORT=8080 npm start
   ```

### Modo Headless

O navegador roda em modo headless (invisível) por padrão. Para visualizar o navegador durante a execução:

1. Abra `scraper/browser.js`
2. Altere a linha:
   ```javascript
   headless: 'new',
   ```
   Para:
   ```javascript
   headless: false,
   ```

### Ajustando Delays

Para tornar o scraper mais rápido ou mais lento:

1. Abra `scraper/utils.js`
2. Modifique a função `randomDelay`:
   ```javascript
   function randomDelay(min = 1000, max = 3000) {
     // Reduza os valores para mais velocidade
     // Aumente para ser mais cauteloso
   }
   ```

## 🛡️ Recursos Anti-Bloqueio

O scraper implementa várias técnicas para evitar detecção:

- **Stealth Plugin**: Mascara características do Puppeteer
- **User-Agent Real**: Simula um navegador Chrome real
- **Delays Aleatórios**: Tempo variável entre ações
- **Movimentos de Mouse**: Simula comportamento humano
- **Digitação Natural**: Digita caractere por caractere com delays
- **Headers Customizados**: Headers HTTP realistas

## ⚠️ Avisos Importantes

1. **Uso Responsável**: Use esta ferramenta de forma ética e responsável
2. **Rate Limiting**: Evite fazer muitas requisições em curto período
3. **Termos de Serviço**: Verifique os termos de serviço do Doctoralia
4. **Bloqueios**: Mesmo com anti-detecção, bloqueios podem ocorrer com uso excessivo
5. **Dados Pessoais**: Os dados extraídos podem conter informações pessoais - trate-os com cuidado

## 🐛 Solução de Problemas

### O scraper não encontra perfis

- Verifique se a especialidade e cidade estão escritas corretamente
- Tente termos mais genéricos (ex: "Médico" ao invés de especialidade específica)
- Verifique sua conexão com a internet

### Erro de instalação do Puppeteer

No Windows, pode ser necessário instalar ferramentas de build:
```bash
npm install --global windows-build-tools
```

### O navegador não abre

- Verifique se o Chrome/Chromium está instalado
- Tente executar com `headless: false` para ver erros visuais

### Socket.io não conecta

- Verifique se a porta 3000 não está em uso
- Desabilite firewalls/antivírus temporariamente para testar

## 📊 Desempenho

- **Velocidade**: ~5-10 perfis por minuto (dependendo da complexidade)
- **Memória**: ~200-500 MB durante execução
- **CPU**: Uso moderado (Puppeteer é intensivo)

## 🔄 Atualizações Futuras

Possíveis melhorias:

- [ ] Suporte a múltiplos navegadores simultâneos
- [x] ~~Proxy rotation para evitar bloqueios~~
- [x] ~~Exportação em JSON~~
- [ ] Filtros adicionais (avaliações, preço, etc.)
- [ ] Agendamento de scraping automático
- [ ] Dashboard com estatísticas
- [x] ~~API REST para integração~~

## 📝 Licença

Este projeto é fornecido "como está" para fins educacionais.

## 🤝 Contribuições

Contribuições são bem-vindas! Sinta-se à vontade para abrir issues ou pull requests.

## 📧 Suporte

Para problemas ou dúvidas, abra uma issue no repositório.

---

**Desenvolvido com ❤️ para extração eficiente de dados do Doctoralia**
