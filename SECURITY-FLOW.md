# Fluxo de Segurança - Emuladores e Dispositivos Rooted

Este documento descreve o fluxo de segurança implementado para detectar e bloquear emuladores e dispositivos com root/jailbreak.

## 🎯 Objetivo

Garantir que o aplicativo só funcione em dispositivos reais e não modificados, protegendo contra:
- **Emuladores**: Ambientes virtuais que podem ser usados para automação maliciosa
- **Dispositivos Rooted/Jailbroken**: Dispositivos modificados que podem ter medidas de segurança comprometidas

## 🔒 Política de Segurança

### Dispositivos BLOQUEADOS ❌
- Emuladores (Android Emulator, iOS Simulator, etc.)
- Dispositivos com root (Android)
- Dispositivos com jailbreak (iOS)
- Dispositivos na lista de bloqueio manual

### Dispositivos PERMITIDOS ✅
- Dispositivos reais e não modificados
- Dispositivos validados pelo sistema de segurança

## 🔄 Fluxo de Validação

### 1. Detecção no Cliente (App Mobile)

O aplicativo cliente deve detectar o status de segurança do dispositivo usando bibliotecas nativas:

**Android:**
```javascript
// Exemplo com Capacitor e plugins nativos
import { Device } from '@capacitor/device';

async function checkDeviceSecurity() {
  // Detectar emulador
  const isEmulator = await detectEmulator(); // Biblioteca específica
  
  // Detectar root
  const isRooted = await detectRoot(); // Biblioteca específica
  
  // Obter informações do dispositivo
  const info = await Device.getInfo();
  
  return {
    isEmulator,
    isRooted,
    deviceId: await Device.getId(),
    model: info.model,
    brand: info.manufacturer,
    osVersion: info.osVersion,
    appVersion: '1.0.0'
  };
}
```

**Bibliotecas recomendadas:**
- Android: [cordova-plugin-emulator-detector](https://www.npmjs.com/package/cordova-plugin-emulator-detector)
- Android Root: [cordova-plugin-root-detection](https://www.npmjs.com/package/cordova-plugin-root-detection)
- iOS: [cordova-plugin-jailbreak-detection](https://www.npmjs.com/package/cordova-plugin-jailbreak-detection)

### 2. Validação no Servidor

O app envia as informações de segurança para o servidor:

```javascript
// Cliente - Exemplo de validação
async function validateDeviceSecurity() {
  const deviceInfo = await checkDeviceSecurity();
  
  const response = await fetch('https://ad-server.com/api/device-security/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deviceInfo)
  });
  
  const result = await response.json();
  
  if (!result.allowed) {
    // Dispositivo bloqueado - mostrar mensagem e impedir uso
    showBlockedMessage(result.message);
    return false;
  }
  
  // Dispositivo permitido - continuar
  return true;
}
```

### 3. Resposta do Servidor

O servidor valida e retorna um dos seguintes status:

#### ✅ Dispositivo Válido (200)
```json
{
  "success": true,
  "allowed": true,
  "reason": "valid_device",
  "message": "Dispositivo válido"
}
```

#### ❌ Emulador Detectado (403)
```json
{
  "success": true,
  "allowed": false,
  "reason": "emulator_detected",
  "message": "Emuladores não são permitidos. Use um dispositivo real para continuar."
}
```

#### ❌ Root/Jailbreak Detectado (403)
```json
{
  "success": true,
  "allowed": false,
  "reason": "rooted_device",
  "message": "Dispositivos com root/jailbreak não são permitidos por razões de segurança."
}
```

#### ⛔ Dispositivo Bloqueado Manualmente (403)
```json
{
  "success": true,
  "allowed": false,
  "reason": "device_blocked",
  "message": "Este dispositivo foi bloqueado. Entre em contato com o suporte."
}
```

## 📡 Endpoints da API

### POST `/api/device-security/validate`

Valida a segurança do dispositivo.

**Request Body:**
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

**Response:**
- `200` - Dispositivo válido
- `403` - Dispositivo bloqueado
- `429` - Muitas tentativas (rate limit)
- `500` - Erro no servidor

**Rate Limit:** 10 tentativas por minuto por IP

### GET `/api/device-security/stats`

Obtém estatísticas de segurança (para dashboard de administração).

**Query Parameters:**
- `startDate` (opcional) - Data inicial (ISO 8601)
- `endDate` (opcional) - Data final (ISO 8601)

**Response:**
```json
{
  "success": true,
  "stats": {
    "total": 150,
    "blocked": 25,
    "allowed": 125,
    "emulators": 15,
    "rooted": 10,
    "valid": 125
  },
  "events": [...]
}
```

### POST `/api/device-security/block/:deviceId`

Bloqueia manualmente um dispositivo (requer autenticação).

**Headers:**
- `x-admin-token` ou `x-dashboard-token` - Token de administrador

**Request Body:**
```json
{
  "reason": "Atividade suspeita detectada"
}
```

### POST `/api/device-security/unblock/:deviceId`

Desbloqueia um dispositivo (requer autenticação).

**Headers:**
- `x-admin-token` ou `x-dashboard-token` - Token de administrador

## 🔧 Integração com o App

### Fluxo Recomendado

1. **Ao iniciar o app:**
   ```javascript
   async function initializeApp() {
     // 1. Validar segurança do dispositivo
     const isSecure = await validateDeviceSecurity();
     
     if (!isSecure) {
       // Bloquear app - mostrar tela de erro
       showSecurityBlockScreen();
       return;
     }
     
     // 2. Reivindicar chave de ativação
     const activationKey = await claimActivationKey();
     
     if (!activationKey) {
       showActivationErrorScreen();
       return;
     }
     
     // 3. Iniciar app normalmente
     startApp();
   }
   ```

2. **Durante uso do app:**
   - Validação pode ser feita periodicamente (ex: a cada 24h)
   - Cache o resultado para evitar validações excessivas
   - Re-validar após updates do app ou do sistema operacional

### Exemplo de Tela de Bloqueio

```javascript
function showBlockedMessage(message) {
  // Exemplo usando Ionic/Capacitor
  const alert = await alertController.create({
    header: 'Dispositivo Não Suportado',
    message: message,
    buttons: ['OK'],
    backdropDismiss: false
  });
  
  await alert.present();
}
```

## 📊 Monitoramento e Analytics

### Dados Registrados

Para cada tentativa de validação, o sistema registra:
- Timestamp da validação
- Device ID (identificador único)
- Status de emulador (true/false)
- Status de root (true/false)
- Modelo e marca do dispositivo
- Versão do SO
- Versão do app
- Resultado da validação (bloqueado/permitido)
- Motivo do bloqueio

### Firebase Structure

```
device_security/
├── <timestamp-id>/
│   ├── isEmulator: false
│   ├── isRooted: false
│   ├── deviceId: "xxx"
│   ├── model: "SM-G973F"
│   ├── brand: "Samsung"
│   ├── osVersion: "13"
│   ├── appVersion: "1.0.0"
│   ├── blocked: false
│   ├── reason: "valid_device"
│   ├── timestamp: "2026-02-15T..."
│   └── createdAt: <Firebase ServerTimestamp>

device_security_blocklist/
└── <deviceId>/
    ├── blocked: true
    ├── reason: "manual_block"
    └── blockedAt: <Firebase ServerTimestamp>
```

## 🔐 Segurança Adicional

### Rate Limiting

- **10 tentativas por minuto** por IP
- Proteção contra ataques de força bruta
- Logs de tentativas excessivas

### Modo Degradado

Se o Firebase estiver indisponível:
- O sistema permite o acesso (modo degradado)
- Logs de erro são gerados
- Sistema volta ao normal quando Firebase recuperar

### Bypass para Desenvolvimento

Para ambiente de desenvolvimento, você pode:
1. Desabilitar a validação no cliente
2. Usar variável de ambiente no servidor para modo dev
3. Adicionar dispositivos de teste à allowlist

## 📝 Configuração

### Variáveis de Ambiente

Nenhuma configuração adicional é necessária. O serviço usa a mesma instância do Firebase Admin (`ad-tracking`) que os outros serviços.

### Token de Admin

Para endpoints administrativos, use:
- Header: `x-admin-token` ou `x-dashboard-token`
- Valor: Configure `ADMIN_TOKEN` no arquivo `.env` com um token seguro

**IMPORTANTE**: Nunca use tokens padrão em produção. Sempre configure uma senha forte e única no arquivo `.env`.

## 🧪 Testes

### Testar Dispositivo Válido

```bash
curl -X POST https://ad-server.com/api/device-security/validate \
  -H "Content-Type: application/json" \
  -d '{
    "isEmulator": false,
    "isRooted": false,
    "deviceId": "test-device-123",
    "model": "SM-G973F",
    "brand": "Samsung",
    "osVersion": "13",
    "appVersion": "1.0.0"
  }'
```

### Testar Emulador

```bash
curl -X POST https://ad-server.com/api/device-security/validate \
  -H "Content-Type: application/json" \
  -d '{
    "isEmulator": true,
    "isRooted": false,
    "deviceId": "emulator-device",
    "model": "Android SDK",
    "brand": "Google",
    "osVersion": "13",
    "appVersion": "1.0.0"
  }'
```

### Testar Root

```bash
curl -X POST https://ad-server.com/api/device-security/validate \
  -H "Content-Type: application/json" \
  -d '{
    "isEmulator": false,
    "isRooted": true,
    "deviceId": "rooted-device",
    "model": "SM-G973F",
    "brand": "Samsung",
    "osVersion": "13",
    "appVersion": "1.0.0"
  }'
```

### Obter Estatísticas

```bash
curl https://ad-server.com/api/device-security/stats
```

### Bloquear Dispositivo

```bash
curl -X POST https://ad-server.com/api/device-security/block/test-device-123 \
  -H "x-admin-token: YOUR_ADMIN_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Atividade suspeita"}'
```

## 🚨 Tratamento de Erros

### No Cliente

```javascript
async function validateDeviceSecurity() {
  try {
    const deviceInfo = await checkDeviceSecurity();
    const response = await fetch('https://ad-server.com/api/device-security/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deviceInfo)
    });
    
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Muitas tentativas. Aguarde um momento.');
      }
      throw new Error('Erro ao validar dispositivo');
    }
    
    const result = await response.json();
    return result;
    
  } catch (error) {
    console.error('Erro na validação:', error);
    // Decidir: bloquear ou permitir em caso de erro?
    // Recomendado: permitir (modo degradado) mas logar o erro
    return { allowed: true, reason: 'validation_error' };
  }
}
```

## 📖 Referências

- [Android Emulator Detection](https://developer.android.com/training/articles/security-tips#DetectingEmulators)
- [Android Root Detection](https://developer.android.com/training/safetynet/attestation)
- [iOS Jailbreak Detection](https://developer.apple.com/documentation/security)
- [Capacitor Device API](https://capacitorjs.com/docs/apis/device)

## 🔄 Próximas Melhorias

- [ ] Implementar sistema de reputação de dispositivos
- [ ] Adicionar whitelist para dispositivos de teste
- [ ] Criar dashboard visual para monitoramento
- [ ] Implementar análise de padrões suspeitos
- [ ] Adicionar notificações de segurança em tempo real
