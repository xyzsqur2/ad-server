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
   * Reivindica uma chave disponível (App). Busca uma com status 'available', marca como 'claimed'.
   * @param {string} [deviceId] - Id do dispositivo (opcional)
   * @returns {Promise<{ success: boolean, key?: string, error?: string }>}
   */
  async claimKey(deviceId = null) {
    if (this._disabled) {
      console.error('[ActivationKeys] Serviço desabilitado - Firebase não disponível');
      return { success: false, error: 'firebase_unavailable', message: 'Firebase não disponível' };
    }

    try {
      console.log(`[ActivationKeys] Buscando chave disponível...`);
      const ref = this.database.ref(FIREBASE_PATH);
      const snapshot = await ref.once('value');
      
      if (!snapshot.exists()) {
        console.warn('[ActivationKeys] Nenhuma chave encontrada no Firebase (path vazio)');
        return { success: false, error: 'no_keys_available', message: 'Nenhuma chave disponível' };
      }

      const data = snapshot.val();
      console.log(`[ActivationKeys] Chaves encontradas:`, Object.keys(data || {}));
      
      const entries = Object.entries(data || {});
      const available = entries.find(([_, v]) => v && v.status === 'available');
      
      if (!available) {
        console.warn('[ActivationKeys] Nenhuma chave com status "available"');
        return { success: false, error: 'no_keys_available', message: 'Nenhuma chave disponível' };
      }

      const [keyId, keyData] = available;
      console.log(`[ActivationKeys] Chave disponível encontrada: ${keyId}`, keyData);
      
      const keyRef = this.database.ref(`${FIREBASE_PATH}/${keyId}`);
      await keyRef.update({
        status: 'claimed',
        claimedAt: new Date().toISOString(),
        deviceId: deviceId || null
      });

      console.log(`[ActivationKeys] ✅ Chave reivindicada: ${keyId}${deviceId ? ' deviceId=' + deviceId : ''}`);
      return { success: true, key: keyId };
    } catch (error) {
      console.error('[ActivationKeys] ❌ Erro ao reivindicar chave:', error);
      return { success: false, error: 'firebase_error', message: error.message };
    }
  }
}
