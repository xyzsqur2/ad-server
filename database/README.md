# 📊 Sistema de Tracking com Geolocalização

Este sistema permite rastrear visualizações de anúncios com geolocalização (país, região, cidade) e horário local do usuário usando **Firebase Realtime Database**.

## 🚀 Configuração Inicial

### 1. Instalar Dependências

As dependências já foram instaladas automaticamente:
- `geoip-lite`: Geolocalização por IP (banco local)
- `firebase-admin`: Cliente Firebase Admin SDK (para salvar no Firebase)

### 2. Configurar Firebase Realtime Database

1. **Estrutura de dados no Firebase:**

O Firebase Realtime Database usa uma estrutura JSON. Os dados serão salvos em:
```
ad_tracking/
  {trackingId}/
    event: "ad_impression"
    adId: "ad_001"
    ts: "2026-01-30T18:30:00.000Z"
    localTime: "2026-01-30T15:30:00.000Z"
    localTimeString: "2026-01-30 15:30:00"
    hourLocal: 15
    dayOfWeek: 1
    ipAddress: "177.123.45.67"
    countryCode: "BR"
    countryName: "Brazil"
    region: "São Paulo"
    city: "São Paulo"
    latitude: -23.5505
    longitude: -46.6333
    timezone: "America/Sao_Paulo"
    deviceInfo: "..."
    userAgent: "..."
    eventData: {...}
    createdAt: "2026-01-30T18:30:00.000Z"
```

2. **Configurar Firebase Admin SDK:**

Certifique-se de que o arquivo `firebase-service-account-key.json` está no diretório raiz do projeto (mesmo nível que `ad-server/`).

Ou configure no arquivo `.env`:
```bash
# Caminho para o arquivo de credenciais do Firebase
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account-key.json
```

**O arquivo `firebase-service-account-key.json` deve conter:**
- `project_id`: ID do projeto Firebase
- `private_key`: Chave privada
- `client_email`: Email da conta de serviço
- `databaseURL`: URL do Realtime Database (opcional, será detectado automaticamente)

3. **Configurar Regras de Segurança no Firebase:**

Acesse o Firebase Console: https://console.firebase.google.com
- Vá em **Realtime Database** → **Rules**
- Configure as regras para permitir leitura/escrita do backend:

```json
{
  "rules": {
    "ad_tracking": {
      ".read": "auth != null || request.auth != null",
      ".write": "auth != null || request.auth != null"
    }
  }
}
```

**Nota:** Como o backend usa Firebase Admin SDK, ele não precisa de autenticação. As regras acima são para acesso direto via client SDK. O Admin SDK ignora as regras de segurança.

### 3. Iniciar o Servidor

```bash
cd ad-server
npm install  # Instalar dependências (se ainda não instalou)
npm start
```

## 📡 Endpoints Disponíveis

### Tracking de Eventos

**POST `/track`**
- Captura automaticamente geolocalização e horário
- Salva no Firebase Realtime Database
- Retorna informações de geolocalização na resposta

**Exemplo de requisição:**
```json
{
  "event": "ad_impression",
  "adId": "ad_001",
  "watchedMs": 5000
}
```

**Resposta:**
```json
{
  "success": true,
  "geo": {
    "country": "Brazil",
    "region": "São Paulo",
    "city": "São Paulo",
    "timezone": "America/Sao_Paulo",
    "localTime": "2026-01-30 15:30:00",
    "hour": 15
  }
}
```

### Analytics

#### 1. Estatísticas por País
**GET `/api/analytics/countries?adId=ad_001`**

Retorna:
- Total de impressões por país
- Usuários únicos por país
- Cliques e CTR (Click-Through Rate)

**Exemplo de resposta:**
```json
{
  "success": true,
  "countries": [
    {
      "countryCode": "BR",
      "countryName": "Brazil",
      "totalImpressions": 1500,
      "uniqueUsers": 850,
      "clicks": 120,
      "ctr": 8.0
    }
  ]
}
```

#### 2. Estatísticas por Horário
**GET `/api/analytics/hours?adId=ad_001&country=BR`**

Retorna:
- Impressões por hora do dia (0-23)
- Cliques e completions por horário

**Exemplo de resposta:**
```json
{
  "success": true,
  "hours": [
    {
      "hour": 15,
      "hourFormatted": "15:00",
      "impressions": 250,
      "clicks": 20,
      "completions": 180
    }
  ]
}
```

#### 3. Estatísticas por Dia da Semana
**GET `/api/analytics/days?adId=ad_001`**

Retorna:
- Impressões por dia da semana
- Cliques e completions

**Exemplo de resposta:**
```json
{
  "success": true,
  "days": [
    {
      "dayOfWeek": 1,
      "dayName": "Segunda",
      "impressions": 300,
      "clicks": 25,
      "completions": 220
    }
  ]
}
```

#### 4. Geolocalização Completa
**GET `/api/analytics/geolocation?adId=ad_001&startDate=2026-01-01&country=BR&hour=15`**

Retorna:
- Dados completos de geolocalização
- Filtros por país, horário, data
- Primeira e última visualização

**Exemplo de resposta:**
```json
{
  "success": true,
  "data": [
    {
      "countryCode": "BR",
      "countryName": "Brazil",
      "region": "São Paulo",
      "city": "São Paulo",
      "timezone": "America/Sao_Paulo",
      "hourLocal": 15,
      "hourFormatted": "15:00",
      "impressions": 150,
      "uniqueIps": 120,
      "clicks": 12,
      "completions": 100,
      "firstView": "2026-01-30 15:00:00",
      "lastView": "2026-01-30 15:59:00"
    }
  ],
  "total": 1
}
```

## 📊 Dados Salvos

Para cada evento de tracking, o sistema salva:

- **Evento:** Tipo (ad_impression, ad_click, etc.)
- **Anúncio:** ID do anúncio
- **Horário UTC:** Timestamp do servidor
- **Horário Local:** Convertido para timezone do usuário
- **Hora Local:** 0-23
- **Dia da Semana:** 0 (domingo) a 6 (sábado)
- **IP:** Endereço IP do usuário
- **País:** Código e nome (ex: BR, Brazil)
- **Região:** Estado/Província
- **Cidade:** Cidade do usuário
- **Coordenadas:** Latitude e longitude (aproximadas)
- **Timezone:** Fuso horário (ex: America/Sao_Paulo)

## 🔍 Consultas no Firebase

### Ver dados no Firebase Console

1. Acesse: https://console.firebase.google.com
2. Selecione o projeto: **notification-sistem**
3. Vá em **Realtime Database** → **Data**
4. Navegue até `ad_tracking/` para ver todos os eventos

### Estrutura de Dados

Os dados são salvos em formato JSON aninhado:
```
ad_tracking/
  ├── 1706630400000-abc123/
  │   ├── event: "ad_impression"
  │   ├── adId: "ad_001"
  │   ├── countryCode: "BR"
  │   ├── countryName: "Brazil"
  │   └── ...
  ├── 1706630401000-def456/
  │   └── ...
```

## ⚙️ Configurações Opcionais

### Usar API Externa para Geolocalização

Se quiser usar uma API externa (mais precisa, mas requer requisições HTTP):

1. Configure no `.env`:
```bash
USE_IP_API=true
IP_API_KEY=sua_chave_aqui  # Opcional
```

2. O sistema usará `ipapi.co` como fallback se `geoip-lite` não encontrar o IP.

## 🛡️ Privacidade

- O sistema usa apenas geolocalização por IP (não GPS)
- Não requer permissão do usuário
- Dados são agregados para analytics
- IPs podem ser anonimizados se necessário

## 📝 Notas

- O sistema funciona mesmo sem Firebase (apenas logs em arquivo)
- Geolocalização por IP tem precisão limitada (cidade/região, não endereço exato)
- Timezone é detectado automaticamente baseado na localização
- Horário local é calculado no servidor baseado no timezone
- Firebase Realtime Database é NoSQL, então não há tabelas - apenas estrutura JSON aninhada
- As consultas são feitas em memória após buscar os dados do Firebase (devido às limitações de queries do Realtime Database)

## 🔧 Troubleshooting

### Firebase não inicializa

1. Verifique se o arquivo `firebase-service-account-key.json` existe
2. Verifique se o caminho está correto no `.env`
3. Verifique se as credenciais estão válidas
4. O sistema continuará funcionando (apenas logs) se Firebase não estiver configurado

### Dados não aparecem no Firebase

1. Verifique as regras de segurança do Firebase
2. Verifique os logs do servidor para erros
3. Verifique se o `databaseURL` está correto no arquivo de credenciais

### Performance

- Firebase Realtime Database tem limites de leitura/escrita
- Para grandes volumes, considere usar Firestore ou implementar cache
- As consultas de analytics processam dados em memória (pode ser lento com muitos registros)