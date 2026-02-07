/**
 * Serviço de Chaves de Ativação - Firebase Realtime Database
 * Estrutura: activation_keys/<KEY_ID> = { status, createdAt, claimedAt, deviceId }
 * Opção A: chave como id do nó (ex.: activation_keys/AB12CD34)
 */

import admin from 'firebase-admin';

const KEY_LENGTH = 8;
const KEY_REGEX = /^[A-Za-z0-9]{8}$/;
const FIREBASE_PATH = 'activation_keys';

export class ActivationKeysService {
  constructor() {
    try {
      const app = admin.app('ad-tracking');
      this.database = admin.database(app);
      this._disabled = false;
    } catch (e) {
      this.database = null;
      this._disabled = true;
      console.log('ℹ️  ActivationKeys: Firebase não disponível (ad-tracking não inicializado).');
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
      return { success: false, error: 'firebase_unavailable' };
    }

    const normalized = this._normalizeKey(key);
    if (!normalized || !KEY_REGEX.test(normalized)) {
      return { success: false, error: 'invalid_key', message: 'Chave deve ter exatamente 8 caracteres alfanuméricos' };
    }

    try {
      const ref = this.database.ref(`${FIREBASE_PATH}/${normalized}`);
      const snapshot = await ref.once('value');
      if (snapshot.exists()) {
        return { success: false, error: 'duplicate_key', message: 'Chave já existe' };
      }

      await ref.set({
        status: 'available',
        createdAt: new Date().toISOString(),
        claimedAt: null,
        deviceId: null
      });

      console.log(`[ActivationKeys] Chave criada: ${normalized}`);
      return { success: true, key: normalized };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao criar chave:', error);
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
      return { success: false, error: 'firebase_unavailable' };
    }

    try {
      const ref = this.database.ref(FIREBASE_PATH);
      const snapshot = await ref.once('value');
      if (!snapshot.exists()) {
        return { success: false, error: 'no_keys_available' };
      }

      const data = snapshot.val();
      const entries = Object.entries(data || {});
      const available = entries.find(([_, v]) => v && v.status === 'available');
      if (!available) {
        return { success: false, error: 'no_keys_available' };
      }

      const [keyId, keyData] = available;
      const keyRef = this.database.ref(`${FIREBASE_PATH}/${keyId}`);
      await keyRef.update({
        status: 'claimed',
        claimedAt: new Date().toISOString(),
        deviceId: deviceId || null
      });

      console.log(`[ActivationKeys] Chave reivindicada: ${keyId}${deviceId ? ' deviceId=' + deviceId : ''}`);
      return { success: true, key: keyId };
    } catch (error) {
      console.error('[ActivationKeys] Erro ao reivindicar chave:', error);
      return { success: false, error: 'firebase_error', message: error.message };
    }
  }
}
