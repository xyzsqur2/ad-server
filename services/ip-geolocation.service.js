import geoip from 'geoip-lite';

/**
 * Serviço de geolocalização por IP
 * Usa geoip-lite (banco local) ou API externa como fallback
 */
export class IPGeolocationService {
  constructor() {
    this.useAPI = process.env.USE_IP_API === 'true';
    this.apiKey = process.env.IP_API_KEY || null;
  }

  /**
   * Obtém geolocalização por IP usando geoip-lite (banco local)
   */
  getLocationByIP(ip) {
    try {
      // Limpar IP (remover porta, etc)
      const cleanIP = this.cleanIP(ip);
      
      if (!cleanIP || cleanIP === 'unknown' || cleanIP === '::1' || cleanIP === '127.0.0.1') {
        return {
          success: false,
          reason: 'invalid_ip'
        };
      }
      
      // Usar geoip-lite (banco local, rápido, sem requisições externas)
      const geo = geoip.lookup(cleanIP);
      
      if (!geo) {
        return {
          success: false,
          reason: 'ip_not_found'
        };
      }

      return {
        success: true,
        ip: cleanIP,
        country_code: geo.country || null,
        country_name: this.getCountryName(geo.country),
        region: geo.region || null,
        city: geo.city || null,
        latitude: geo.ll ? geo.ll[0] : null,
        longitude: geo.ll ? geo.ll[1] : null,
        timezone: geo.timezone || null,
        source: 'geoip-lite'
      };
    } catch (error) {
      console.error('Erro ao obter geolocalização por IP:', error);
      return {
        success: false,
        reason: 'error',
        error: error.message
      };
    }
  }

  /**
   * Obtém geolocalização via API externa (fallback ou quando precisar mais precisão)
   */
  async getLocationByIPAPI(ip) {
    if (!this.useAPI) {
      return this.getLocationByIP(ip); // Fallback para geoip-lite
    }

    try {
      const cleanIP = this.cleanIP(ip);
      
      if (!cleanIP || cleanIP === 'unknown') {
        return this.getLocationByIP(ip);
      }
      
      // Usar ipapi.co (gratuito: 1000 req/dia)
      const url = this.apiKey 
        ? `https://ipapi.co/${cleanIP}/json/?key=${this.apiKey}`
        : `https://ipapi.co/${cleanIP}/json/`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(url, {
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API retornou status ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        // Se API falhar, usar geoip-lite como fallback
        return this.getLocationByIP(ip);
      }

      return {
        success: true,
        ip: cleanIP,
        country_code: data.country_code || null,
        country_name: data.country_name || null,
        region: data.region || null,
        city: data.city || null,
        latitude: data.latitude || null,
        longitude: data.longitude || null,
        timezone: data.timezone || null,
        source: 'ipapi.co'
      };
    } catch (error) {
      console.error('Erro ao obter geolocalização via API:', error);
      // Fallback para geoip-lite
      return this.getLocationByIP(ip);
    }
  }

  /**
   * Limpa e valida IP
   */
  cleanIP(ip) {
    if (!ip) return null;
    
    // Remover porta se houver
    const parts = ip.split(':');
    if (parts.length > 2) {
      // IPv6 com porta
      return ip;
    } else if (parts.length === 2 && parts[1].match(/^\d+$/)) {
      // IPv4 com porta
      return parts[0];
    }
    
    // Remover espaços
    return ip.trim();
  }

  /**
   * Converte código de país para nome (simplificado)
   */
  getCountryName(countryCode) {
    const countries = {
      'BR': 'Brazil',
      'US': 'United States',
      'PT': 'Portugal',
      'ES': 'Spain',
      'FR': 'France',
      'DE': 'Germany',
      'IT': 'Italy',
      'GB': 'United Kingdom',
      'AR': 'Argentina',
      'MX': 'Mexico',
      'CO': 'Colombia',
      'CL': 'Chile',
      'PE': 'Peru',
      'VE': 'Venezuela',
      'EC': 'Ecuador',
      'BO': 'Bolivia',
      'PY': 'Paraguay',
      'UY': 'Uruguay',
      'CA': 'Canada',
      'AU': 'Australia',
      'NZ': 'New Zealand',
      'JP': 'Japan',
      'CN': 'China',
      'IN': 'India',
      'RU': 'Russia',
      'KR': 'South Korea',
      'NL': 'Netherlands',
      'BE': 'Belgium',
      'CH': 'Switzerland',
      'AT': 'Austria',
      'SE': 'Sweden',
      'NO': 'Norway',
      'DK': 'Denmark',
      'FI': 'Finland',
      'PL': 'Poland',
      'CZ': 'Czech Republic',
      'GR': 'Greece',
      'TR': 'Turkey',
      'SA': 'Saudi Arabia',
      'AE': 'United Arab Emirates',
      'ZA': 'South Africa',
      'EG': 'Egypt',
      'NG': 'Nigeria',
      'KE': 'Kenya'
    };
    return countries[countryCode] || countryCode || null;
  }

  /**
   * Converte horário UTC para horário local do usuário
   */
  convertToLocalTime(utcDate, timezone) {
    try {
      if (!timezone) {
        // Se não tiver timezone, retornar UTC
        return {
          localTime: utcDate,
          localTimeString: utcDate.toISOString().replace('T', ' ').substring(0, 19),
          hourLocal: utcDate.getUTCHours(),
          dayOfWeek: utcDate.getUTCDay()
        };
      }

      // Converter para horário local usando timezone
      // Formato: "America/Sao_Paulo", "America/New_York", etc.
      const localDate = new Date(utcDate.toLocaleString('en-US', { timeZone: timezone }));
      
      // Criar string legível
      const year = localDate.getFullYear();
      const month = String(localDate.getMonth() + 1).padStart(2, '0');
      const day = String(localDate.getDate()).padStart(2, '0');
      const hours = String(localDate.getHours()).padStart(2, '0');
      const minutes = String(localDate.getMinutes()).padStart(2, '0');
      const seconds = String(localDate.getSeconds()).padStart(2, '0');
      
      const localTimeString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

      return {
        localTime: localDate,
        localTimeString: localTimeString,
        hourLocal: localDate.getHours(),
        dayOfWeek: localDate.getDay() // 0 = domingo, 6 = sábado
      };
    } catch (error) {
      console.error('Erro ao converter horário local:', error);
      // Fallback para UTC
      return {
        localTime: utcDate,
        localTimeString: utcDate.toISOString().replace('T', ' ').substring(0, 19),
        hourLocal: utcDate.getUTCHours(),
        dayOfWeek: utcDate.getUTCDay()
      };
    }
  }
}
