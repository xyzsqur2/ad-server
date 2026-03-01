import admin from 'firebase-admin';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let firebaseApp = null;
let database = null;

/**
 * Inicializa o Firebase Admin SDK
 */
function initializeFirebase() {
  if (firebaseApp) {
    return { app: firebaseApp, database };
  }

  try {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'firebase-service-account-key.json';
    // Tentar múltiplos caminhos possíveis
    const possiblePaths = [
      join(__dirname, '..', '..', serviceAccountPath), // Raiz do projeto
      join(__dirname, '..', serviceAccountPath), // Dentro de ad-server
      serviceAccountPath // Caminho absoluto ou relativo ao CWD
    ];
    
    let fullPath = null;
    for (const path of possiblePaths) {
      if (existsSync(path)) {
        fullPath = path;
        break;
      }
    }
    
    if (!fullPath) {
      console.log('⚠️  Arquivo Firebase service account não encontrado - tracking será apenas em logs');
      console.log('⚠️  Procurou em:', possiblePaths);
      return { app: null, database: null };
    }

    const serviceAccount = JSON.parse(readFileSync(fullPath, 'utf8'));

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
      databaseURL: "https://sysactivation-507d6-default-rtdb.firebaseio.com"
    });

    database = admin.database(firebaseApp);
    console.log('✅ Firebase Admin inicializado para tracking');
    return { app: firebaseApp, database };
  } catch (error) {
    console.error('❌ Erro ao inicializar Firebase Admin:', error.message);
    return { app: null, database: null };
  }
}

/**
 * Serviço de tracking usando Firebase Realtime Database
 */
export class FirebaseTrackingService {
  constructor() {
    const { database: db } = initializeFirebase();
    this.database = db;
    this._disabled = !db;
    
    if (this._disabled) {
      console.log('ℹ️  Firebase não configurado. Tracking será apenas em logs.');
    }
  }

  /**
   * Gera um ID único
   */
  generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Salva evento de tracking no Firebase
   */
  async saveTracking(trackingData) {
    if (this._disabled) {
      return { success: false, reason: 'firebase_disabled' };
    }

    try {
      const id = this.generateId();
      const ref = this.database.ref(`ad_tracking/${id}`);
      
      await ref.set(trackingData);
      
      return {
        success: true,
        id: id,
        timestamp: trackingData.ts || new Date().toISOString()
      };
    } catch (error) {
      console.error('❌ Erro ao salvar tracking no Firebase:', error);
      return { success: false, reason: 'firebase_error', error: error.message };
    }
  }

  /**
   * Atualiza um registro existente no Firebase
   * @param {string} id - ID do registro
   * @param {Object} updateData - Dados para atualizar
   */
  async updateTracking(id, updateData) {
    if (this._disabled) {
      return { success: false, reason: 'firebase_disabled' };
    }

    try {
      const ref = this.database.ref(`ad_tracking/${id}`);
      await ref.update(updateData);
      
      return {
        success: true,
        id: id
      };
    } catch (error) {
      console.error('❌ Erro ao atualizar tracking no Firebase:', error);
      return { success: false, reason: 'firebase_error', error: error.message };
    }
  }

  /**
   * Busca eventos de tracking com filtros
   */
  async getTracking(filters = {}) {
    if (this._disabled) {
      return { data: [] };
    }

    try {
      let ref = this.database.ref('ad_tracking');
      
      // Aplicar filtros
      if (filters.adId) {
        ref = ref.orderByChild('adId').equalTo(filters.adId);
      } else if (filters.countryCode) {
        ref = ref.orderByChild('countryCode').equalTo(filters.countryCode);
      } else if (filters.event) {
        ref = ref.orderByChild('event').equalTo(filters.event);
      } else {
        ref = ref.orderByChild('ts');
      }

      // Limite
      if (filters.limit) {
        ref = ref.limitToLast(filters.limit);
      }

      const snapshot = await ref.once('value');
      const data = snapshot.val() || {};
      
      // Converter objeto para array
      const items = Object.keys(data).map(key => ({
        id: key,
        ...data[key]
      }));

      // Aplicar filtros adicionais em memória (Firebase tem limitações)
      let filtered = items;

      if (filters.startDate) {
        filtered = filtered.filter(item => item.ts >= filters.startDate);
      }

      if (filters.endDate) {
        filtered = filtered.filter(item => item.ts <= filters.endDate);
      }

      if (filters.hourLocal !== undefined) {
        filtered = filtered.filter(item => item.hourLocal === filters.hourLocal);
      }

      if (filters.countryCode && !filters.adId) {
        filtered = filtered.filter(item => item.countryCode === filters.countryCode);
      }

      return { data: filtered };
    } catch (error) {
      console.error('❌ Erro ao buscar tracking:', error);
      return { data: [] };
    }
  }

  /**
   * Estatísticas por país
   */
  async getStatsByCountry(filters = {}) {
    if (this._disabled) {
      return { countries: [] };
    }

    try {
      const { data } = await this.getTracking(filters);
      
      // Agrupar por país
      const grouped = {};
      
      data.forEach(item => {
        const countryCode = item.countryCode || 'unknown';
        const countryName = item.countryName || 'Unknown';
        
        if (!grouped[countryCode]) {
          grouped[countryCode] = {
            countryCode,
            countryName,
            totalImpressions: 0,
            uniqueUsers: new Set(),
            clicks: 0,
            completions: 0
          };
        }
        
        grouped[countryCode].totalImpressions++;
        if (item.ipAddress) {
          grouped[countryCode].uniqueUsers.add(item.ipAddress);
        }
        if (item.event === 'ad_click') {
          grouped[countryCode].clicks++;
        }
        if (item.event === 'ad_complete') {
          grouped[countryCode].completions++;
        }
      });

      // Converter para array e calcular CTR
      const countries = Object.values(grouped).map(country => ({
        countryCode: country.countryCode,
        countryName: country.countryName,
        totalImpressions: country.totalImpressions,
        uniqueUsers: country.uniqueUsers.size,
        clicks: country.clicks,
        ctr: country.totalImpressions > 0 
          ? parseFloat((country.clicks / country.totalImpressions * 100).toFixed(2))
          : 0
      }));

      // Ordenar por impressões
      countries.sort((a, b) => b.totalImpressions - a.totalImpressions);

      return { countries };
    } catch (error) {
      console.error('❌ Erro ao buscar estatísticas por país:', error);
      return { countries: [] };
    }
  }

  /**
   * Estatísticas por horário
   */
  async getStatsByHour(filters = {}) {
    if (this._disabled) {
      return { hours: [] };
    }

    try {
      const { data } = await this.getTracking(filters);
      
      // Agrupar por hora
      const grouped = {};
      
      for (let hour = 0; hour < 24; hour++) {
        grouped[hour] = {
          hour,
          impressions: 0,
          clicks: 0,
          completions: 0
        };
      }
      
      data.forEach(item => {
        const hour = item.hourLocal;
        if (hour !== null && hour !== undefined && hour >= 0 && hour < 24) {
          grouped[hour].impressions++;
          if (item.event === 'ad_click') {
            grouped[hour].clicks++;
          }
          if (item.event === 'ad_complete') {
            grouped[hour].completions++;
          }
        }
      });

      // Converter para array
      const hours = Object.values(grouped)
        .filter(h => h.impressions > 0)
        .map(h => ({
          hour: h.hour,
          hourFormatted: `${String(h.hour).padStart(2, '0')}:00`,
          impressions: h.impressions,
          clicks: h.clicks,
          completions: h.completions
        }))
        .sort((a, b) => a.hour - b.hour);

      return { hours };
    } catch (error) {
      console.error('❌ Erro ao buscar estatísticas por horário:', error);
      return { hours: [] };
    }
  }

  /**
   * Estatísticas por dia da semana
   */
  async getStatsByDay(filters = {}) {
    if (this._disabled) {
      return { days: [] };
    }

    try {
      const { data } = await this.getTracking(filters);
      
      const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
      const grouped = {};
      
      for (let day = 0; day < 7; day++) {
        grouped[day] = {
          dayOfWeek: day,
          impressions: 0,
          clicks: 0,
          completions: 0
        };
      }
      
      data.forEach(item => {
        const day = item.dayOfWeek;
        if (day !== null && day !== undefined && day >= 0 && day < 7) {
          grouped[day].impressions++;
          if (item.event === 'ad_click') {
            grouped[day].clicks++;
          }
          if (item.event === 'ad_complete') {
            grouped[day].completions++;
          }
        }
      });

      // Converter para array
      const days = Object.values(grouped)
        .filter(d => d.impressions > 0)
        .map(d => ({
          dayOfWeek: d.dayOfWeek,
          dayName: dayNames[d.dayOfWeek] || 'Desconhecido',
          impressions: d.impressions,
          clicks: d.clicks,
          completions: d.completions
        }))
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek);

      return { days };
    } catch (error) {
      console.error('❌ Erro ao buscar estatísticas por dia:', error);
      return { days: [] };
    }
  }

  /**
   * Geolocalização completa com agregações
   */
  async getGeolocationStats(filters = {}) {
    if (this._disabled) {
      return { data: [], total: 0 };
    }

    try {
      const { data } = await this.getTracking(filters);
      
      // Agrupar por país, região, cidade, timezone e hora
      const grouped = {};
      
      data.forEach(item => {
        const key = `${item.countryCode || 'unknown'}_${item.region || 'unknown'}_${item.city || 'unknown'}_${item.timezone || 'unknown'}_${item.hourLocal !== null ? item.hourLocal : 'unknown'}`;
        
        if (!grouped[key]) {
          grouped[key] = {
            countryCode: item.countryCode,
            countryName: item.countryName,
            region: item.region,
            city: item.city,
            timezone: item.timezone,
            hourLocal: item.hourLocal,
            impressions: 0,
            uniqueIps: new Set(),
            clicks: 0,
            completions: 0,
            firstView: item.localTimeString || item.ts,
            lastView: item.localTimeString || item.ts
          };
        }
        
        grouped[key].impressions++;
        if (item.ipAddress) {
          grouped[key].uniqueIps.add(item.ipAddress);
        }
        if (item.event === 'ad_click') {
          grouped[key].clicks++;
        }
        if (item.event === 'ad_complete') {
          grouped[key].completions++;
        }
        
        // Atualizar primeira e última visualização
        const itemTime = item.localTimeString || item.ts;
        if (itemTime < grouped[key].firstView) {
          grouped[key].firstView = itemTime;
        }
        if (itemTime > grouped[key].lastView) {
          grouped[key].lastView = itemTime;
        }
      });

      // Converter para array
      const result = Object.values(grouped)
        .map(item => ({
          countryCode: item.countryCode,
          countryName: item.countryName,
          region: item.region,
          city: item.city,
          timezone: item.timezone,
          hourLocal: item.hourLocal,
          hourFormatted: item.hourLocal !== null && item.hourLocal !== undefined
            ? `${String(item.hourLocal).padStart(2, '0')}:00`
            : null,
          impressions: item.impressions,
          uniqueIps: item.uniqueIps.size,
          clicks: item.clicks,
          completions: item.completions,
          firstView: item.firstView,
          lastView: item.lastView
        }))
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 100); // Limitar a 100 resultados

      return { data: result, total: result.length };
    } catch (error) {
      console.error('❌ Erro ao buscar estatísticas de geolocalização:', error);
      return { data: [], total: 0 };
    }
  }
}
