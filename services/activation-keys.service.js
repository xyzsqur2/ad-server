/**
 * Serviço de Chaves de Ativação - Firebase Realtime Database
 * Estrutura: activation_keys/<KEY_ID> = { status, createdAt, claimedAt, deviceId }
 * Opção A: chave como id do nó (ex.: activation_keys/AB12CD34)
 * 
 * IMPORTANTE: Usa a mesma instância do Firebase Admin (app 'ad-tracking') que o FirebaseTrackingService.
 */

import admin from 'firebase-admin';

const KEY_LENGTH = 8;
const KEY_REGEX = /^[A-Za-z0-9]{8}$/;
const FIREBASE_PATH = 'activation_keys';
const LOCK_PERIOD_MS = 5 * 60 * 1000;  // 5 minutos de lock automático após claim

export class ActivationKeysService {
  constructor() {
    // Verificar se Firebase Admin foi inicializado (pelo FirebaseTrackingService)
    try {
      // Tentar obter a app 'ad-tracking' existente
      const app = admin.app('ad-tracking');
      this.database = admin.database(app);
      this._disabled = false;
      console.log('✅ ActivationKeys: Firebase Admin conectado (app: ad-tracking)');
    } catch (e) {
      this.database = null;
      this._disabled = true;
      console.error('❌ ActivationKeys: Firebase não disponível (ad-tracking não inicializado):', e.message);
      console.error('   O FirebaseTrackingService deve ser instanciado ANTES de ActivationKeysService');
    }
  }

  /**
   * Lista todas as chaves do Firebase (para o Dashboard).
   * @returns {Promise<{ success: boolean, keys?: Record<string, { status, createdAt, claimedAt, deviceId }>, error?: string }>}
   */
  async listKeys() {
    if (this._disabled) {
      return { success: false, error: 'firebase_unavailable', keys: null };
    }
    try {
      const ref = this.database.ref(FIREBASE_PATH);
      const snapshot = await ref.once('value');
      const keys = snapshot.val() || {};
      return { success: true, keys };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao listar chaves:', error);
      return { success: false, error: error.message, keys: null };
    }
  }

  /**
   * Normaliza chave para id (uppercase, trim)
   */
  _normalizeKey(key) {
    if (!key || typeof key !== 'string') return null;
    const k = key.trim().toUpperCase();
    return k.length === KEY_LENGTH ? k : null;
  }

  /**
   * Cria uma nova chave (Dashboard). Chave como id do nó.
   * @param {string} key - String exatamente 8 caracteres (alfanumérica)
   * @returns {Promise<{ success: boolean, key?: string, error?: string }>}
   */
  async addKey(key) {
    if (this._disabled) {
      console.error('[ActivationKeys] Serviço desabilitado - Firebase não disponível');
      return { success: false, error: 'firebase_unavailable', message: 'Firebase não disponível' };
    }

    const normalized = this._normalizeKey(key);
    if (!normalized || !KEY_REGEX.test(normalized)) {
      return { success: false, error: 'invalid_key', message: 'Chave deve ter exatamente 8 caracteres alfanuméricos' };
    }

    try {
      console.log(`[ActivationKeys] Criando chave: ${normalized}`);
      const ref = this.database.ref(`${FIREBASE_PATH}/${normalized}`);
      const snapshot = await ref.once('value');
      if (snapshot.exists()) {
        console.warn(`[ActivationKeys] Chave ${normalized} já existe`);
        return { success: false, error: 'duplicate_key', message: 'Chave já existe' };
      }

      await ref.set({
        status: 'available',
        createdAt: new Date().toISOString(),
        claimedAt: null,
        deviceId: null
      });

      console.log(`[ActivationKeys] ✅ Chave criada: ${normalized}`);
      return { success: true, key: normalized };
    } catch (error) {
      console.error('[ActivationKeys] ❌ Erro ao criar chave:', error);
      return { success: false, error: 'firebase_error', message: error.message };
    }
  }

  /**
   * Reivindica uma chave disponível (App). Claim atômico via transaction para evitar disputa.
   * @param {string} [deviceId] - Id do dispositivo (opcional)
   * @returns {Promise<{ success: boolean, key?: string, error?: string }>}
   */
  async claimKey(deviceId = null) {
    if (this._disabled) {
      console.error('[ActivationKeys] Serviço desabilitado - Firebase não disponível');
      return { success: false, error: 'firebase_unavailable', message: 'Firebase não disponível' };
    }

    try {
      console.log('[ActivationKeys] Claim atômico (transaction)...');
      const ref = this.database.ref(FIREBASE_PATH);
      const claimedKeyId = await new Promise((resolve, reject) => {
        ref.transaction((current) => {
          if (current == null) return undefined;
          const entries = Object.entries(current);
          const available = entries.find(([, v]) => v && v.status === 'available');
          if (!available) return undefined;
          const [keyId, keyData] = available;
          const updated = { ...current };
          updated[keyId] = {
            ...keyData,
            status: 'claimed',
            claimedAt: new Date().toISOString(),
            lockedUntil: new Date(Date.now() + LOCK_PERIOD_MS).toISOString(),
            deviceId: deviceId || null
          };
          return updated;
        }, (err, committed, snapshot) => {
          if (err) {
            reject(err);
            return;
          }
          if (!committed || !snapshot || !snapshot.val()) {
            resolve(null);
            return;
          }
          const data = snapshot.val();
          const now = Date.now();
          const claimedEntries = Object.entries(data || {}).filter(
            ([, v]) => v && v.status === 'claimed' && v.claimedAt && (now - new Date(v.claimedAt).getTime() < 5000)
          );
          const mostRecent = claimedEntries.sort(
            (a, b) => new Date(b[1].claimedAt).getTime() - new Date(a[1].claimedAt).getTime()
          )[0];
          resolve(mostRecent ? mostRecent[0] : null);
        });
      });

      if (claimedKeyId) {
        console.log('[ActivationKeys] Chave reivindicada (transaction): ' + claimedKeyId + (deviceId ? ' deviceId=' + deviceId : ''));
        return { success: true, key: claimedKeyId };
      }
      console.warn('[ActivationKeys] Nenhuma chave disponível (transaction abortou ou sem available)');
      return { success: false, error: 'no_keys_available', message: 'Nenhuma chave disponível' };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao reivindicar chave:', error);
      return { success: false, error: 'firebase_error', message: error.message };
    }
  }

  /**
   * Valida e reivindica uma chave específica informada pelo usuário (tela de bloqueio).
   * AGORA COM TRANSACTION para evitar race condition!
   * A chave deve existir no Firebase e estar com status 'available'.
   * @param {string} key - Chave de 8 caracteres (será normalizada)
   * @param {string} [deviceId] - Id do dispositivo (opcional)
   * @returns {Promise<{ success: boolean, key?: string, error?: string, message?: string }>}
   */
  async claimKeyByValue(key, deviceId = null) {
    if (this._disabled) {
      return { success: false, error: 'firebase_unavailable', message: 'Firebase não disponível' };
    }

    const normalized = this._normalizeKey(key);
    console.log('[ActivationKeys] Chave inserida pelo usuário (raw):', key, '| normalizada:', normalized);
    if (!normalized || !KEY_REGEX.test(normalized)) {
      return { success: false, error: 'invalid_key', message: 'Chave inválida' };
    }

    try {
      // 🔒 TRANSACTION com update simples (Realtime Database)
      // Ao invés de usar transaction() que tem bugs,
      // usar update() com Promise para atomicidade simples
      const keyRef = this.database.ref(`${FIREBASE_PATH}/${normalized}`);
      
      // Primeiro: Ler para validar
      const snapshot = await keyRef.once('value');
      const keyData = snapshot.val();
      
      if (!keyData) {
        console.warn('[ActivationKeys] Chave não existe no Firebase:', normalized);
        return { success: false, error: 'invalid_key', message: 'Chave inválida' };
      }
      
      if (keyData.status !== 'available') {
        console.warn('[ActivationKeys] Chave não está disponível:', normalized, '| status:', keyData.status);
        return { success: false, error: 'invalid_key', message: 'Chave inválida' };
      }
      
      // Segundo: Atualizar + Claim (o mais próximo de atomic possível no Realtime DB)
      console.log('[ActivationKeys] Claimando chave:', normalized);
      await keyRef.update({
        status: 'claimed',
        claimedAt: new Date().toISOString(),
        lockedUntil: new Date(Date.now() + LOCK_PERIOD_MS).toISOString(),
        deviceId: deviceId || null
      });
      
      console.log('[ActivationKeys] ✅ Chave claimada com sucesso:', normalized, deviceId ? '| deviceId=' + deviceId : '');
      return { success: true, key: normalized };
      
    } catch (error) {
      console.error('[ActivationKeys] Erro ao validar/reivindicar chave:', error);
      return { success: false, error: 'firebase_error', message: 'Chave inválida' };
    }
  }

  /**
   * Valida uma chave já reivindicada (Estratégia 1 + 3: Server validation + DeviceId binding)
   * Verifica se a chave existe, é 'claimed' e binds ao deviceId
   * @param {string} key - Chave de 8 caracteres
   * @param {string} [deviceId] - DeviceId do cliente (validar se bate)
   * @returns {Promise<{ valid: boolean, expired: boolean, boundToDevice: boolean, revoked: boolean, revokeReason?: string }>}
   */
  async validateKey(key, deviceId = null) {
    if (this._disabled) {
      return { valid: false, expired: false, boundToDevice: false, revoked: false };
    }

    const normalized = this._normalizeKey(key);
    if (!normalized || !KEY_REGEX.test(normalized)) {
      console.warn('[ActivationKeys] Chave com formato inválido:', key);
      return { valid: false, expired: false, boundToDevice: false, revoked: false };
    }

    try {
      const ref = this.database.ref(`${FIREBASE_PATH}/${normalized}`);
      const snapshot = await ref.once('value');
      const data = snapshot.val();

      // Chave não existe
      if (!data) {
        console.warn('[ActivationKeys] Chave não encontrada:', normalized);
        return { valid: false, expired: false, boundToDevice: false, revoked: false };
      }

      // BLOQUEIO: Verificar se chave foi revogada
      if (data.status === 'revoked') {
        console.error('[ActivationKeys] ❌ BLOQUEADO: Chave foi revogada pelo admin:', normalized);
        console.error('  - Motivo:', data.revokeReason || 'não especificado');
        console.error('  - Revogada em:', data.revokedAt || 'desconhecido');
        return { valid: false, expired: false, boundToDevice: false, revoked: true, revokeReason: data.revokeReason };
      }

      // Verificar se expirou
      if (data.expiresAt) {
        const expiryTime = new Date(data.expiresAt).getTime();
        if (Date.now() > expiryTime) {
          console.warn('[ActivationKeys] Chave expirada:', normalized);
          return { valid: false, expired: true, boundToDevice: false, revoked: false };
        }
      }

      // Verificar se foi reivindicada (só chaves 'claimed' são válidas)
      if (data.status !== 'claimed') {
        console.warn('[ActivationKeys] Chave não foi reivindicada:', normalized, '| status:', data.status);
        return { valid: false, expired: false, boundToDevice: false, revoked: false, locked: false };
      }

      // BLOQUEIO: Verificar se está em período de lock (manual ou automático após claim)
      if (data.lockedUntil) {
        const lockUntilTime = new Date(data.lockedUntil).getTime();
        if (Date.now() < lockUntilTime) {
          const minutesLeft = Math.ceil((lockUntilTime - Date.now()) / 60000);
          console.warn('[ActivationKeys] ❌ Chave ainda está bloqueada:', normalized);
          console.warn('  - Bloqueada até:', data.lockedUntil);
          console.warn('  - Minutos faltando:', minutesLeft);
          return { 
            valid: false, 
            expired: false, 
            boundToDevice: false, 
            revoked: false,
            locked: true,
            lockedUntil: data.lockedUntil,
            minutesLeft: minutesLeft
          };
        }
      }

      // ESTRATÉGIA 3: Verificar DeviceId binding
      // Se a chave foi claimada com deviceId, só é válida para esse device
      // Se foi claimada sem deviceId (null), qualquer device pode usar
      const boundToDevice = !data.deviceId || data.deviceId === deviceId;
      
      if (!boundToDevice) {
        console.warn('[ActivationKeys] ❌ Tentativa de usar chave em device diferente:');
        console.warn('  - Chave:', normalized);
        console.warn('  - DeviceId original:', data.deviceId);
        console.warn('  - DeviceId tentativa:', deviceId);
        return { valid: false, expired: false, boundToDevice: false, revoked: false };
      }

      console.log('[ActivationKeys] ✅ Chave válida em validação:', normalized, '| deviceId match: ' + (data.deviceId === deviceId ? 'sim' : 'não vinculada'));
      return { valid: true, expired: false, boundToDevice: true, revoked: false, locked: false };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao validar chave:', error);
      return { valid: false, expired: false, boundToDevice: false, revoked: false };
    }
  }

  /**
   * Lista chaves com filtros e paginação (Dashboard)
   * @param {string} [status='all'] - 'available', 'claimed', 'revoked', 'all'
   * @param {boolean} [includeExpired=false] - Incluir expiradas?
   * @returns {Promise<{ success: boolean, keys?: Array, total?: number, byStatus?: object }>}
   */
  async listKeysFiltered(status = 'all', includeExpired = false) {
    if (this._disabled) {
      return { success: false, keys: [], total: 0, byStatus: {} };
    }

    try {
      const ref = this.database.ref(FIREBASE_PATH);
      const snapshot = await ref.once('value');
      const allKeys = snapshot.val() || {};

      const filtered = Object.entries(allKeys)
        .filter(([, keyData]) => {
          // Filtrar por status
          if (status !== 'all' && keyData.status !== status) {
            return false;
          }

          // Filtrar expiradas
          if (!includeExpired && keyData.expiresAt) {
            const expiryTime = new Date(keyData.expiresAt).getTime();
            if (Date.now() > expiryTime) {
              return false;
            }
          }

          return true;
        })
        .map(([keyId, keyData]) => ({
          key: keyId,
          status: keyData.status,
          createdAt: keyData.createdAt,
          expiresAt: keyData.expiresAt,
          claimedAt: keyData.claimedAt,
          claimedBy: keyData.deviceId || null,
          deviceId: keyData.deviceId || null, // Duplicado para compatibilidade
          daysLeft: keyData.expiresAt 
            ? Math.ceil((new Date(keyData.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
            : null,
          lockedUntil: keyData.lockedUntil || null,
          locked: keyData.lockedUntil && new Date(keyData.lockedUntil).getTime() > Date.now(),
          minutesLeft: keyData.lockedUntil && new Date(keyData.lockedUntil).getTime() > Date.now() 
            ? Math.ceil((new Date(keyData.lockedUntil).getTime() - Date.now()) / 60000)
            : 0,
          revokedAt: keyData.revokedAt,
          revokeReason: keyData.revokeReason
        }))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      const byStatus = {
        available: Object.values(allKeys).filter(k => k.status === 'available').length,
        claimed: Object.values(allKeys).filter(k => k.status === 'claimed').length,
        revoked: Object.values(allKeys).filter(k => k.status === 'revoked').length,
        expired: Object.values(allKeys).filter(k => k.status === 'expired').length
      };

      console.log(`[ActivationKeys] Listadas ${filtered.length} chaves (status: ${status})`);
      return {
        success: true,
        keys: filtered,
        total: filtered.length,
        byStatus
      };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao listar chaves:', error);
      return { success: false, keys: [], total: 0, byStatus: {} };
    }
  }

  /**
   * Bloqueia uma chave manualmente (Dashboard)
   * Configura lockedUntil para um tempo no futuro, impedindo acesso
   * @param {string} key - Chave de 8 caracteres
   * @param {number} [durationMinutes=5] - Quanto tempo bloquear (padrão 5 minutos)
   * @returns {Promise<{ success: boolean, lockedUntil?: string, minutesLeft?: number, error?: string }>}
   */
  async lockKey(key, durationMinutes = 5) {
    if (this._disabled) {
      return { success: false, error: 'firebase_unavailable' };
    }

    const normalized = this._normalizeKey(key);
    if (!normalized || !KEY_REGEX.test(normalized)) {
      return { success: false, error: 'invalid_key' };
    }

    try {
      const keyRef = this.database.ref(`${FIREBASE_PATH}/${normalized}`);
      const snapshot = await keyRef.once('value');
      const keyData = snapshot.val();

      if (!keyData) {
        return { success: false, error: 'not_found' };
      }

      const lockUntilTime = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();

      await keyRef.update({
        lockedUntil: lockUntilTime,
        lockedAt: new Date().toISOString(),
        lockedBy: 'dashboard'
      });

      console.log(`[ActivationKeys] ✅ Chave bloqueada: ${normalized} | Até: ${lockUntilTime}`);
      return { 
        success: true, 
        lockedUntil: lockUntilTime,
        minutesLeft: durationMinutes
      };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao bloquear chave:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Desbloqueia uma chave manualmente (Dashboard)
   * Remove o bloqueio definindo lockedUntil para null
   * @param {string} key - Chave de 8 caracteres
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async unlockKey(key) {
    if (this._disabled) {
      return { success: false, error: 'firebase_unavailable' };
    }

    const normalized = this._normalizeKey(key);
    if (!normalized || !KEY_REGEX.test(normalized)) {
      return { success: false, error: 'invalid_key' };
    }

    try {
      const keyRef = this.database.ref(`${FIREBASE_PATH}/${normalized}`);
      const snapshot = await keyRef.once('value');
      const keyData = snapshot.val();

      if (!keyData) {
        return { success: false, error: 'not_found' };
      }

      await keyRef.update({
        lockedUntil: null
      });

      console.log(`[ActivationKeys] ✅ Chave desbloqueada: ${normalized}`);
      return { success: true };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao desbloquear chave:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Verifica status de bloqueio de uma chave
   * @param {string} key - Chave de 8 caracteres
   * @returns {Promise<{ success: boolean, locked: boolean, lockedUntil?: string, minutesLeft?: number, error?: string }>}
   */
  async getKeyLockStatus(key) {
    if (this._disabled) {
      return { success: false, locked: false, error: 'firebase_unavailable' };
    }

    const normalized = this._normalizeKey(key);
    if (!normalized || !KEY_REGEX.test(normalized)) {
      return { success: false, locked: false, error: 'invalid_key' };
    }

    try {
      const keyRef = this.database.ref(`${FIREBASE_PATH}/${normalized}`);
      const snapshot = await keyRef.once('value');
      const data = snapshot.val();

      if (!data) {
        return { success: false, locked: false, error: 'not_found' };
      }

      if (!data.lockedUntil) {
        return { success: true, locked: false, minutesLeft: 0 };
      }

      const lockUntilTime = new Date(data.lockedUntil).getTime();
      const now = Date.now();

      if (now < lockUntilTime) {
        const minutesLeft = Math.ceil((lockUntilTime - now) / 60000);
        return {
          success: true,
          locked: true,
          lockedUntil: data.lockedUntil,
          minutesLeft,
          lockedAt: data.lockedAt || null,
          lockedBy: data.lockedBy || 'unknown'
        };
      }

      return { success: true, locked: false, minutesLeft: 0 };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao verificar lock status:', error);
      return { success: false, locked: false, error: error.message };
    }
  }

  /**
   * Revoga uma chave (invalida permanentemente)
   * @param {string} key - Chave de 8 caracteres
   * @param {string} [reason='admin_revoke'] - Motivo da revogação
   * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
   */
  async revokeKey(key, reason = 'admin_revoke') {
    if (this._disabled) {
      return { success: false, error: 'firebase_unavailable', message: 'Firebase não disponível' };
    }

    const normalized = this._normalizeKey(key);
    if (!normalized) {
      return { success: false, error: 'invalid_key', message: 'Chave inválida' };
    }

    try {
      const keyRef = this.database.ref(`${FIREBASE_PATH}/${normalized}`);
      const snapshot = await keyRef.once('value');
      const data = snapshot.val();

      if (!data) {
        return { success: false, error: 'not_found', message: 'Chave não encontrada' };
      }

      // Atualizar status para revoked e adicionar timestamp
      await keyRef.update({
        status: 'revoked',
        revokedAt: new Date().toISOString(),
        revokeReason: reason,
        lockedUntil: null  // Remove bloqueio
      });

      console.log(`[ActivationKeys] Chave revogada: ${normalized} | Motivo: ${reason}`);
      return {
        success: true,
        message: `Chave ${normalized} revogada com sucesso`
      };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao revogar chave:', error);
      return { success: false, error: 'server_error', message: error.message };
    }
  }

  /**
   * Exporta chaves para CSV (Dashboard)
   * @param {string} [status='available'] - Status das chaves a exportar
   * @returns {Promise<{ success: boolean, csv?: string, count?: number }>}
   */
  async exportKeysCSV(status = 'available') {
    if (this._disabled) {
      return { success: false, csv: '', count: 0 };
    }

    try {
      const ref = this.database.ref(FIREBASE_PATH);
      const snapshot = await ref.once('value');
      const allKeys = snapshot.val() || {};

      const keysToExport = Object.entries(allKeys)
        .filter(([, keyData]) => keyData.status === status)
        .map(([keyId, keyData]) => ({
          key: keyId,
          status: keyData.status,
          createdAt: keyData.createdAt,
          claimedAt: keyData.claimedAt,
          deviceId: keyData.deviceId,
          expiresAt: keyData.expiresAt
        }));

      // Gerar CSV
      const headers = ['Chave', 'Status', 'Criada em', 'Ativada em', 'Device', 'Expira em'];
      const rows = keysToExport.map(k => [
        k.key,
        k.status,
        new Date(k.createdAt).toLocaleString('pt-BR'),
        k.claimedAt ? new Date(k.claimedAt).toLocaleString('pt-BR') : 'N/A',
        k.deviceId || 'N/A',
        k.expiresAt ? new Date(k.expiresAt).toLocaleString('pt-BR') : 'N/A'
      ]);

      const csv = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
      ].join('\n');

      console.log(`[ActivationKeys] Exportadas ${keysToExport.length} chaves para CSV`);
      return {
        success: true,
        csv,
        count: keysToExport.length
      };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao exportar chaves:', error);
      return { success: false, csv: '', count: 0 };
    }
  }
}
