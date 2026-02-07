# Diagnóstico e Correção - Sistema de Chaves de Ativação

## Problema Identificado

A API não estava servindo chaves para o app mesmo com chave criada no Firebase.

## Causa Raiz

O `ActivationKeysService` estava tentando obter a instância do Firebase Admin **antes** dela estar completamente inicializada, resultando em serviço desabilitado.

## Análise Comparativa com Sistema de Providers (que funciona)

### Sistema de Providers (✅ Funciona)
```javascript
// provider.service.js (no App - cliente Web)
async _initializeFirebase() {
  // Verifica instância compartilhada
  if (window.firebaseDatabase) {
    this.firebaseDatabase = window.firebaseDatabase;
    return this.firebaseDatabase;
  }
  
  // Importa SDK e inicializa
  const { initializeApp } = await import("firebase-app.js");
  const { getDatabase } = await import("firebase-database.js");
  const app = initializeApp(FIREBASE_CONFIG);
  this.firebaseDatabase = getDatabase(app);
  window.firebaseDatabase = this.firebaseDatabase; // Compartilha
  return this.firebaseDatabase;
}
```

### Sistema de Activation Keys (no ad-server - backend)
```javascript
// firebase-tracking.service.js
function initializeFirebase() {
  if (firebaseApp) {
    return { app: firebaseApp, database };
  }
  
  // Inicializa Firebase Admin uma vez
  firebaseApp = admin.initializeApp({...}, 'ad-tracking');
  database = admin.database(firebaseApp);
  return { app: firebaseApp, database };
}

// FirebaseTrackingService usa esta função no constructor
const { database: db } = initializeFirebase();
this.database = db;

// ActivationKeysService DEVE usar a MESMA app
const app = admin.app('ad-tracking'); // ← Obtém app JÁ inicializada
this.database = admin.database(app);
```

## Correções Implementadas

### 1. **Logs Detalhados no ActivationKeysService**

Adicionados logs em todos os pontos críticos:
- ✅ Conexão com Firebase no constructor
- ✅ Início de criação de chave (`addKey`)
- ✅ Início de reivindicação (`claimKey`)
- ✅ Chaves encontradas no Firebase
- ✅ Chave disponível encontrada
- ✅ Sucesso ao criar/reivindicar
- ❌ Erros em cada operação

### 2. **Mensagens de Erro Melhoradas**

Todos os erros agora retornam `message` além de `error`:
```javascript
return {
  success: false,
  error: 'no_keys_available',
  message: 'Nenhuma chave disponível' // ← Adicional
};
```

### 3. **Diagnóstico no Startup do Server**

```javascript
// server.js
const firebaseTracking = new FirebaseTrackingService(); // PRIMEIRO
const activationKeys = new ActivationKeysService();     // DEPOIS

// Verifica status imediatamente
console.log(`📊 ActivationKeys status: ${activationKeys._disabled ? '❌ DESABILITADO' : '✅ OPERACIONAL'}`);
```

### 4. **Validação na Rota `/api/activation-keys/claim`**

```javascript
if (activationKeys._disabled) {
  console.error('[Activation] ❌ Serviço DESABILITADO');
  return res.status(503).json({
    success: false,
    error: 'service_unavailable',
    message: 'Serviço de ativação indisponível'
  });
}
```

### 5. **Logs no Request do Claim**

```javascript
app.get('/api/activation-keys/claim', async (req, res) => {
  console.log('[Activation] GET /api/activation-keys/claim | Origin:', origin);
  // ... lógica ...
  console.log(`[Activation] ✅ Chave fornecida: ${result.key}`);
});
```

## Como Verificar se Está Funcionando

### 1. **No Log do Render (Startup)**

Você DEVE ver:
```
✅ Firebase Admin inicializado para tracking
✅ ActivationKeys: Firebase Admin conectado (app: ad-tracking)
📊 ActivationKeys status: ✅ OPERACIONAL
🚀 Servidor de anúncios rodando na porta 10000
```

Se aparecer `❌ DESABILITADO`, o problema está na inicialização do Firebase.

### 2. **Ao Criar Chave no Dashboard**

No log do Render:
```
[ActivationKeys] Criando chave: AB12CD34
[ActivationKeys] ✅ Chave criada: AB12CD34
```

### 3. **Quando o App Chamar /claim**

No log do Render:
```
[Activation] GET /api/activation-keys/claim | Origin: https://app.local
[ActivationKeys] Buscando chave disponível...
[ActivationKeys] Chaves encontradas: ['AB12CD34']
[ActivationKeys] Chave disponível encontrada: AB12CD34 { status: 'available', ... }
[ActivationKeys] ✅ Chave reivindicada: AB12CD34
[Activation] ✅ Chave fornecida: AB12CD34
[GET] /api/activation-keys/claim | Origin: https://app.local | Status: 200
```

### 4. **No Console do App (Logcat/WebView)**

```
[DeviceStatusCheck] Solicitando chave de ativação: https://ad-server-taqp.onrender.com/api/activation-keys/claim
[DeviceStatusCheck] Chave de ativação obtida, válida por 24h
[DeviceStatusCheck] ✅ App pode continuar carregando
```

## Estrutura Correta no Firebase

```
Firebase Realtime Database
└── activation_keys/
    └── AB12CD34/               ← Chave como ID do nó (opção A)
        ├── status: "available"  (ou "claimed")
        ├── createdAt: "2026-02-07T..."
        ├── claimedAt: null      (ou timestamp)
        └── deviceId: null       (ou ID do dispositivo)
```

## Se Ainda Não Funcionar

### Checklist de Troubleshooting:

1. ⬜ `firebase-service-account-key.json` existe no diretório do ad-server?
2. ⬜ No log de startup aparece `✅ Firebase Admin inicializado para tracking`?
3. ⬜ No log de startup aparece `✅ ActivationKeys: Firebase Admin conectado`?
4. ⬜ No log de startup aparece `📊 ActivationKeys status: ✅ OPERACIONAL`?
5. ⬜ A chave existe no Firebase com `status: 'available'`?
6. ⬜ O app está fazendo request para a URL correta do ad-server?
7. ⬜ No log do Render aparece `[Activation] GET /api/activation-keys/claim`?

Se todos os checks acima passarem e ainda não funcionar, copie o log completo do Render (desde o startup até o request do claim) para análise.

## Comparação de Arquitetura

| Aspecto | Providers (App) | Activation Keys (ad-server) |
|---------|----------------|----------------------------|
| Firebase SDK | Client SDK (Web) | Admin SDK (Node.js) |
| Inicialização | Lazy (quando necessário) | Eager (no startup) |
| Instância | `window.firebaseDatabase` | `admin.app('ad-tracking')` |
| Persistência | Cache em memória | Direto no Firebase |
| Fallback | DEFAULT_PROVIDERS hardcoded | Sem fallback (bloqueia app) |
| Timeout | 10s com retry | Sem timeout (usa do Firebase Admin) |

## Próximos Passos

1. **Fazer push das alterações** para o repositório do ad-server
2. **Disparar novo deploy** no Render
3. **Verificar log de startup** no Render (deve mostrar ActivationKeys OPERACIONAL)
4. **Criar chave no Dashboard** (usar maiúsculas e números, 8 caracteres)
5. **Testar app** e verificar logs no Render quando fizer claim
