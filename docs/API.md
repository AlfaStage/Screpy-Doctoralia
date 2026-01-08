# API Documentation - Doctoralia Scraper

Esta documentação cobre todos os endpoints da API REST do Doctoralia Scraper.

---

## Autenticação

Todas as requisições (exceto `/api/v1/key`) requerem autenticação via API Key.

### Header de Autenticação
```
X-API-Key: sua-api-key-aqui
```

### Ou via Query Parameter
```
?api_key=sua-api-key-aqui
```

### Obter a API Key
A API Key é gerada automaticamente na primeira execução e exibida:
- No terminal ao iniciar o servidor
- Na interface web (clique no ícone de chave 🔑)

---

## Endpoints

### 1. Iniciar Extração

**POST** `/api/v1/scrape`

Inicia uma nova extração de dados do Doctoralia.

#### Request Body

```json
{
  "specialties": ["Cardiologista", "Dermatologista"],
  "city": "São Paulo",
  "quantity": 10,
  "onlyWithPhone": true,
  "jsonLogs": false,
  "webhook": "https://seu-site.com/webhook"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `specialties` | array | Não | Lista de especialidades. Vazio = "Médico" (todos) |
| `city` | string | Não | Cidade/região para busca |
| `quantity` | number | Sim | Quantidade de médicos (1-5000) |
| `onlyWithPhone` | boolean | Não | Extrair apenas com telefone (default: false) |
| `jsonLogs` | boolean | Não | Incluir logs no webhook (default: false) |
| `webhook` | string | Não | URL para receber resultado via POST |

#### Response

**202 Accepted** - Extração iniciada
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "message": "Extração iniciada com sucesso"
}
```

**400 Bad Request** - Parâmetros inválidos
```json
{
  "error": "Bad Request",
  "message": "Quantidade deve ser entre 1 e 5000"
}
```

#### cURL Exemplo

```bash
curl -X POST http://localhost:3000/api/v1/scrape \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk_abc123..." \
  -d '{
    "specialties": ["Cardiologista"],
    "city": "São Paulo",
    "quantity": 5,
    "onlyWithPhone": true
  }'
```

---

### 2. Iniciar Extração (Google Maps)

**POST** `/api/v1/maps/scrape`

Inicia uma nova extração do Google Maps com suporte a investigação de websites.

#### Request Body

```json
{
  "searchTerm": "Clínica de Estética",
  "city": "São Paulo",
  "quantity": 100,
  "investigateWebsites": true,
  "requiredFields": ["whatsapp", "email"]
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `searchTerm` | string | Sim | O que buscar (ex: "Advogado", "Padaria") |
| `city` | string | Não | Cidade. **Deixe vazio + quantity > 200 para Modo Expansão** |
| `quantity` | number | Sim | Meta de leads (até 5000) |
| `investigateWebsites` | boolean | Não | Se true, acessa o site para coletar contatos (default: true) |
| `requiredFields` | array | Não | Lista de campos obrigatórios: `whatsapp`, `email`, `instagram`, `phone`, `website` |

#### Modo Expansão Global
Para buscar em todo o Brasil (20+ capitais), envie:
- `city`: `""` (string vazia) ou `null`
- `quantity`: `500` ou mais

#### cURL Exemplo

```bash
curl -X POST http://localhost:3000/api/v1/maps/scrape \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk_abc123..." \
  -d '{
    "searchTerm": "Dermatologista",
    "city": "",
    "quantity": 1000,
    "investigateWebsites": true,
    "requiredFields": ["whatsapp"]
  }'
```

---

### 3. Consultar Status/Resultado

**GET** `/api/v1/scrape/:id`

Consulta o status de uma extração. Se finalizada, retorna os resultados.

#### Response (Em processamento)

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",
  "progress": {
    "current": 5,
    "total": 10,
    "successCount": 4,
    "errorCount": 1,
    "skippedCount": 0
  }
}
```

#### Response (Concluída)

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "config": {
    "specialties": ["Cardiologista"],
    "city": "São Paulo",
    "quantity": 10,
    "onlyWithPhone": true
  },
  "metadata": {
    "startTime": "2024-01-15T10:00:00.000Z",
    "endTime": "2024-01-15T10:05:30.000Z",
    "totalResults": 10
  },
  "csvUrl": "/results/doctoralia_results_2024-01-15T10-00-00.csv",
  "results": [
    {
      "nome": "Dr. João Silva",
      "especialidades": ["Cardiologista"],
      "numeroFixo": "+55 11 3456-7890",
      "numeroMovel": "+55 11 98765-4321",
      "enderecos": ["Rua Augusta, 123 - São Paulo, SP"]
    }
  ]
}
```

#### cURL Exemplo

```bash
curl http://localhost:3000/api/v1/scrape/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: sk_abc123..."
```

---

### 4. Listar Histórico

**GET** `/api/v1/history`

Lista todas as extrações realizadas.

#### Response

```json
{
  "history": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "config": {
        "specialties": ["Cardiologista"],
        "city": "São Paulo",
        "quantity": 10,
        "onlyWithPhone": true
      },
      "status": "completed",
      "resultCount": 10,
      "timestamp": 1705312530000
    },
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "config": {
        "specialties": ["Dermatologista"],
        "city": "Rio de Janeiro",
        "quantity": 5,
        "onlyWithPhone": false
      },
      "status": "completed",
      "resultCount": 5,
      "timestamp": 1705308900000
    }
  ]
}
```

#### cURL Exemplo

```bash
curl http://localhost:3000/api/v1/history \
  -H "X-API-Key: sk_abc123..."
```

---

### 5. Obter API Key

**GET** `/api/v1/key`

Retorna a API Key atual. Este endpoint **não requer autenticação**.

#### Response

```json
{
  "apiKey": "sk_a1b2c3d4e5f6..."
}
```

#### cURL Exemplo

```bash
curl http://localhost:3000/api/v1/key
```

---

## Webhook

Quando configurado, o sistema envia uma requisição POST para a URL informada ao finalizar a extração.

### Payload do Webhook (Sucesso)

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "config": {
    "specialties": ["Cardiologista"],
    "city": "São Paulo",
    "quantity": 10,
    "onlyWithPhone": true
  },
  "metadata": {
    "startTime": "2024-01-15T10:00:00.000Z",
    "endTime": "2024-01-15T10:05:30.000Z",
    "totalResults": 10
  },
  "csvUrl": "/results/doctoralia_results_2024-01-15T10-00-00.csv",
  "results": [...]
}
```

> **Nota**: Se `jsonLogs: true`, o campo `logs` será incluído no payload.

### Payload do Webhook (Erro)

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "error",
  "error": "Mensagem de erro detalhada",
  "config": {
    "specialties": ["Cardiologista"],
    "city": "São Paulo",
    "quantity": 10,
    "onlyWithPhone": true
  }
}
```

### Comportamento de Retry

O webhook tenta entregar até 3 vezes com exponential backoff:
- 1ª tentativa: imediata
- 2ª tentativa: após 1 segundo
- 3ª tentativa: após 2 segundos

---

## Códigos de Status HTTP

| Código | Significado |
|--------|-------------|
| 200 | Sucesso |
| 202 | Aceito (extração iniciada) |
| 400 | Requisição inválida |
| 401 | Não autorizado (API Key inválida ou ausente) |
| 404 | Extração não encontrada |
| 500 | Erro interno do servidor |

---

## Exemplos Completos

### Fluxo Completo via cURL

```bash
# 1. Iniciar extração
ID=$(curl -s -X POST http://localhost:3000/api/v1/scrape \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk_abc123..." \
  -d '{"city":"São Paulo","quantity":3}' | jq -r '.id')

echo "ID: $ID"

# 2. Aguardar e verificar status
sleep 30
curl http://localhost:3000/api/v1/scrape/$ID \
  -H "X-API-Key: sk_abc123..."

# 3. Baixar CSV
curl -O http://localhost:3000/results/doctoralia_results_xxx.csv
```

### Exemplo com Webhook

```bash
curl -X POST http://localhost:3000/api/v1/scrape \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk_abc123..." \
  -d '{
    "specialties": ["Pediatra"],
    "city": "Curitiba",
    "quantity": 10,
    "onlyWithPhone": true,
    "jsonLogs": false,
    "webhook": "https://webhook.site/seu-id-unico"
  }'
```
