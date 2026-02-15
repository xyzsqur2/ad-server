/**
 * Serviço de Segurança de Dispositivos
 * Valida dispositivos contra emuladores e root/jailbreak
 * 
 * Fluxo:
 * 1. App cliente detecta se é emulador/rooted usando bibliotecas nativas
 * 2. App envia informações de segurança para o servidor
 * 3. Servidor valida e decide se permite ou bloqueia o dispositivo
 * 4. Servidor registra tentativas suspeitas no Firebase
 */

import admin from 'firebase-admin';

const FIREBASE_PATH = 'device_security';

export class DeviceSecurityService {
  constructor() {
    try {
      // Usar a mesma instância do Firebase Admin ('ad-tracking')
      const app = admin.app('ad-tracking');
      this.database = admin.database(app);
      this._disabled = false;
      console.log('✅ DeviceSecurity: Firebase Admin conectado (app: ad-tracking)');
    } catch (error) {
      console.error('❌ DeviceSecurity: Firebase não disponível:', error.message);
      this._disabled = true;
    }
  }

  /**
   * Valida informações de segurança do dispositivo
   * @param {Object} deviceInfo - Informações do dispositivo
   * @param {boolean} deviceInfo.isEmulator - Se é emulador
   * @param {boolean} deviceInfo.isRooted - Se tem root/jailbreak
   * @param {string} deviceInfo.deviceId - ID único do dispositivo
   * @param {string} deviceInfo.model - Modelo do dispositivo
   * @param {string} deviceInfo.brand - Marca do dispositivo
   * @param {string} deviceInfo.osVersion - Versão do OS
   * @param {string} deviceInfo.appVersion - Versão do app
   * @returns {Object} Resultado da validação
   */
  async validateDevice(deviceInfo) {
    if (this._disabled) {
      // Se Firebase não disponível, permitir (modo degradado)
      console.warn('[DeviceSecurity] Firebase desabilitado - permitindo dispositivo em modo degradado');
      return {
        allowed: true,
        reason: 'firebase_unavailable',
        message: 'Validação em modo degradado'
      };
    }

    try {
      const { isEmulator, isRooted, deviceId } = deviceInfo;

      // Política de segurança: BLOQUEAR emuladores e dispositivos rooted
      if (isEmulator) {
        console.warn(`[DeviceSecurity] ⚠️ BLOQUEADO: Emulador detectado | Device: ${deviceId}`);
        await this._logSecurityEvent({
          ...deviceInfo,
          blocked: true,
          reason: 'emulator_detected',
          timestamp: new Date().toISOString()
        });

        return {
          allowed: false,
          reason: 'emulator_detected',
          message: 'Emuladores não são permitidos. Use um dispositivo real para continuar.'
        };
      }

      if (isRooted) {
        console.warn(`[DeviceSecurity] ⚠️ BLOQUEADO: Root/Jailbreak detectado | Device: ${deviceId}`);
        await this._logSecurityEvent({
          ...deviceInfo,
          blocked: true,
          reason: 'rooted_device',
          timestamp: new Date().toISOString()
        });

        return {
          allowed: false,
          reason: 'rooted_device',
          message: 'Dispositivos com root/jailbreak não são permitidos por razões de segurança.'
        };
      }

      // Dispositivo válido - permitir
      console.log(`[DeviceSecurity] ✅ Dispositivo válido | Device: ${deviceId} | Model: ${deviceInfo.model}`);
      await this._logSecurityEvent({
        ...deviceInfo,
        blocked: false,
        reason: 'valid_device',
        timestamp: new Date().toISOString()
      });

      return {
        allowed: true,
        reason: 'valid_device',
        message: 'Dispositivo válido'
      };

    } catch (error) {
      console.error('[DeviceSecurity] Erro ao validar dispositivo:', error);
      // Em caso de erro, permitir (modo degradado) mas logar
      return {
        allowed: true,
        reason: 'validation_error',
        message: 'Erro na validação - modo degradado',
        error: error.message
      };
    }
  }

  /**
   * Registra evento de segurança no Firebase
   * @private
   */
  async _logSecurityEvent(eventData) {
    if (this._disabled) {
      return;
    }

    try {
      const ref = this.database.ref(FIREBASE_PATH).push();
      await ref.set({
        ...eventData,
        createdAt: admin.database.ServerValue.TIMESTAMP
      });
      console.log(`[DeviceSecurity] 📝 Evento registrado: ${eventData.reason}`);
    } catch (error) {
      console.error('[DeviceSecurity] Erro ao registrar evento:', error.message);
      // Não falhar se o log não funcionar
    }
  }

  /**
   * Obtém estatísticas de segurança (para dashboard)
   * @param {Object} filters - Filtros opcionais
   * @returns {Promise<Object>} Estatísticas
   */
  async getSecurityStats(filters = {}) {
    if (this._disabled) {
      return {
        success: false,
        error: 'firebase_unavailable'
      };
    }

    try {
      const ref = this.database.ref(FIREBASE_PATH);
      const snapshot = await ref.once('value');
      const data = snapshot.val() || {};
      
      const events = Object.values(data);
      
      // Filtrar por data se fornecido
      let filtered = events;
      if (filters.startDate) {
        const startDate = new Date(filters.startDate);
        filtered = filtered.filter(e => new Date(e.timestamp) >= startDate);
      }
      if (filters.endDate) {
        const endDate = new Date(filters.endDate);
        filtered = filtered.filter(e => new Date(e.timestamp) <= endDate);
      }

      // Estatísticas
      const stats = {
        total: filtered.length,
        blocked: filtered.filter(e => e.blocked).length,
        allowed: filtered.filter(e => !e.blocked).length,
        emulators: filtered.filter(e => e.reason === 'emulator_detected').length,
        rooted: filtered.filter(e => e.reason === 'rooted_device').length,
        valid: filtered.filter(e => e.reason === 'valid_device').length
      };

      return {
        success: true,
        stats,
        events: filtered.slice(-100) // Últimos 100 eventos
      };

    } catch (error) {
      console.error('[DeviceSecurity] Erro ao obter estatísticas:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Verifica se um dispositivo está na lista de bloqueio
   * @param {string} deviceId - ID do dispositivo
   * @returns {Promise<boolean>} True se bloqueado
   */
  async isDeviceBlocked(deviceId) {
    if (this._disabled) {
      return false;
    }

    try {
      const ref = this.database.ref(`${FIREBASE_PATH}_blocklist/${deviceId}`);
      const snapshot = await ref.once('value');
      const data = snapshot.val();
      
      return data && data.blocked === true;
    } catch (error) {
      console.error('[DeviceSecurity] Erro ao verificar blocklist:', error);
      return false;
    }
  }

  /**
   * Adiciona dispositivo à lista de bloqueio manual
   * @param {string} deviceId - ID do dispositivo
   * @param {string} reason - Motivo do bloqueio
   */
  async blockDevice(deviceId, reason = 'manual_block') {
    if (this._disabled) {
      return { success: false, error: 'firebase_unavailable' };
    }

    try {
      const ref = this.database.ref(`${FIREBASE_PATH}_blocklist/${deviceId}`);
      await ref.set({
        blocked: true,
        reason,
        blockedAt: admin.database.ServerValue.TIMESTAMP
      });

      console.log(`[DeviceSecurity] 🚫 Dispositivo bloqueado: ${deviceId} | Motivo: ${reason}`);
      return { success: true };
    } catch (error) {
      console.error('[DeviceSecurity] Erro ao bloquear dispositivo:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove dispositivo da lista de bloqueio
   * @param {string} deviceId - ID do dispositivo
   */
  async unblockDevice(deviceId) {
    if (this._disabled) {
      return { success: false, error: 'firebase_unavailable' };
    }

    try {
      const ref = this.database.ref(`${FIREBASE_PATH}_blocklist/${deviceId}`);
      await ref.remove();

      console.log(`[DeviceSecurity] ✅ Dispositivo desbloqueado: ${deviceId}`);
      return { success: true };
    } catch (error) {
      console.error('[DeviceSecurity] Erro ao desbloquear dispositivo:', error);
      return { success: false, error: error.message };
    }
  }
}
