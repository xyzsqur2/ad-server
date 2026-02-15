# Servidor de Anúncios (Ad Server)

Backend Node.js/Express para servir anúncios (imagens e vídeos MP4) com suporte a streaming HTTP Range.

## 📋 Pré-requisitos

- Node.js 18+ 
- npm ou yarn

## 🚀 Instalação

```bash
cd ad-server
npm install
```

## ▶️ Executar

```bash
npm start
```

O servidor iniciará na porta **3001** (ou na porta definida pela variável de ambiente `PORT`).

## 📡 Endpoints

### `GET /health`
Verifica se o servidor está funcionando.

**Resposta:**
```json
{ "ok": true }
```

### `GET /ad/next`
Retorna o próximo anúncio disponível (round-robin).

**Resposta:**
```json
{
  "id": "ad_001",
  "type": "video",
  "src": "http://localhost:3001/video/ad_001",
  "fallbackSrc": "http://localhost:3001/imagem/ad_001",
  "clickUrl": "https://example.com",
  "minSeconds": 3,
  "maxSeconds": 15,
  "allowSkipAfter": 5,
  "muteByDefault": true
}
```

### `GET /imagem/:id`
Serve a imagem do anúncio.

**Exemplo:** `GET /imagem/ad_001`

**Headers:**
- `Content-Type: image/jpeg`
- `Content-Disposition: inline`
- `Cache-Control: public, max-age=300`

### `GET /video/:id`
Serve o vídeo MP4 com suporte a **HTTP Range** (streaming).

**Exemplo:** `GET /video/ad_001`

**Headers:**
- `Content-Type: video/mp4`
- `Accept-Ranges: bytes`
- `Content-Range: bytes start-end/total` (quando Range é solicitado)
- `206 Partial Content` (quando Range é solicitado)
- `Cache-Control: public, max-age=300`

### `POST /track`
Registra eventos de tracking.

**Body:**
```json
{
  "event": "ad_impression",
  "adId": "ad_001",
  "watchedMs": 5000,
  "ts": "2026-01-27T10:00:00.000Z"
}
```

**Resposta:**
```json
{ "success": true }
```

Os logs são salvos em `logs/tracking.log`.

### `POST /api/device-security/validate`
Valida a segurança do dispositivo (emulador/root detection).

**Body:**
```json
{
  "isEmulator": false,
  "isRooted": false,
  "deviceId": "unique-device-id",
  "model": "SM-G973F",
  "brand": "Samsung",
  "osVersion": "13",
  "appVersion": "1.0.0"
}
```

**Resposta (Dispositivo Válido - 200):**
```json
{
  "success": true,
  "allowed": true,
  "reason": "valid_device",
  "message": "Dispositivo válido"
}
```

**Resposta (Emulador Bloqueado - 403):**
```json
{
  "success": true,
  "allowed": false,
  "reason": "emulator_detected",
  "message": "Emuladores não são permitidos. Use um dispositivo real para continuar."
}
```

**Resposta (Root Detectado - 403):**
```json
{
  "success": true,
  "allowed": false,
  "reason": "rooted_device",
  "message": "Dispositivos com root/jailbreak não são permitidos por razões de segurança."
}
```

**Rate Limit:** 10 tentativas por minuto por IP

Para mais detalhes sobre o fluxo de segurança, consulte [SECURITY-FLOW.md](./SECURITY-FLOW.md).

## ⚙️ Configuração

### Variáveis de Ambiente

- `PORT` - Porta do servidor (padrão: 3001)
- `ALLOWED_ORIGINS` - Lista de origens permitidas para CORS (separadas por vírgula)

**Exemplo:**
```bash
PORT=3001 ALLOWED_ORIGINS=http://localhost:3000,https://app.example.com npm start
```

## 📁 Estrutura de Arquivos

```
ad-server/
├── package.json
├── server.js
├── data/
│   └── ads.json          # Configuração dos anúncios
├── public/
│   └── ads/
│       ├── ad_001/
│       │   ├── image.jpg
│       │   └── video.mp4
│       └── ad_002/
│           ├── image.jpg
│           └── video.mp4
└── logs/
    └── tracking.log      # Logs de tracking (gerado automaticamente)
```

## 📝 Configurar Anúncios

Edite `data/ads.json` para adicionar ou modificar anúncios:

```json
[
  {
    "id": "ad_001",
    "type": "video",
    "imagePath": "public/ads/ad_001/image.jpg",
    "videoPath": "public/ads/ad_001/video.mp4",
    "clickUrl": "https://example.com",
    "minSeconds": 3,
    "maxSeconds": 15,
    "allowSkipAfter": 5,
    "muteByDefault": true
  }
]
```

**Campos:**
- `id` - Identificador único do anúncio
- `type` - `"video"` ou `"image"`
- `imagePath` - Caminho relativo da imagem (não usado diretamente, apenas para referência)
- `videoPath` - Caminho relativo do vídeo (não usado diretamente, apenas para referência)
- `clickUrl` - URL para abrir ao clicar
- `minSeconds` - Tempo mínimo de exibição
- `maxSeconds` - Tempo máximo de exibição (auto-fechar)
- `allowSkipAfter` - Segundos antes de permitir pular
- `muteByDefault` - Vídeo mudo por padrão

### 📦 Assets de Mídia

**IMPORTANTE:** Os arquivos de mídia (imagens e vídeos) precisam estar versionados no repositório ou hospedados em storage externo.

**Estrutura de arquivos:**
- Imagens: devem estar em `public/ads/<adId>/` com extensões `.jpg`, `.jpeg`, `.png` ou `.webp`
- Vídeos: devem estar em `public/ads/<adId>/` com extensão `.mp4`

O servidor procura automaticamente os arquivos por extensão, então os nomes dos arquivos podem variar (ex: `capa.jpg`, `imagem.png`, `video.mp4`, etc.).

**Para deploy no Render:**
- Certifique-se de que os arquivos estão commitados no Git
- Verifique que `.gitignore` não está ignorando `public/ads/**`
- Os arquivos serão incluídos automaticamente no deploy

## 🧪 Testar

```bash
# Health check
curl http://localhost:3001/health

# Próximo anúncio
curl http://localhost:3001/ad/next

# Baixar imagem
curl http://localhost:3001/imagem/ad_001 -o test.jpg

# Baixar vídeo (com Range)
curl -H "Range: bytes=0-1023" http://localhost:3001/video/ad_001 -o test.mp4

# Tracking
curl -X POST http://localhost:3001/track \
  -H "Content-Type: application/json" \
  -d '{"event":"ad_impression","adId":"ad_001"}'
```

## 📊 Logs

Os eventos de tracking são registrados em `logs/tracking.log` no formato:

```
2026-01-27T10:00:00.000Z | {"event":"ad_impression","adId":"ad_001",...}
```
