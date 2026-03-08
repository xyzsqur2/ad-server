import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';
import { IPGeolocationService } from './services/ip-geolocation.service.js';
import { FirebaseTrackingService } from './services/firebase-tracking.service.js';
import { ActivationKeysService } from './services/activation-keys.service.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;

// Trust proxy para produção (Render, etc)
app.set('trust proxy', 1);

// CORS configurável via variável de ambiente
// Incluir origens padrão do Capacitor/Android
const defaultOrigins = [
  'capacitor://localhost',
  'http://localhost',
  'https://localhost'
];

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? [...defaultOrigins, ...process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())]
  : defaultOrigins;

// Função para verificar se origin é permitida
function isAllowedOrigin(origin) {
  // Se origin for undefined/null (curl, server-to-server, file://), permitir
  if (!origin || origin === 'null' || origin === 'file://') {
    return true;
  }
  
  // Se ALLOWED_ORIGINS não estiver configurado, permitir tudo (modo dev/produção flexível)
  if (!process.env.ALLOWED_ORIGINS) {
    return true;
  }
  
  // Se ALLOWED_ORIGINS estiver configurado, verificar se está na lista
  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin);
  }
  
  // Fallback: permitir tudo
  return true;
}

// Configuração CORS
const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      // Log para debug
      console.warn(`⚠️ CORS bloqueado para origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'x-admin-token', 'x-dashboard-token', 'x-firebase-appcheck'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
  credentials: false,
  maxAge: 86400
};

// Aplicar CORS globalmente (sempre habilitado)
app.use(cors(corsOptions));

// Servir arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// Garantir preflight OPTIONS para todas as rotas
app.options('*', cors(corsOptions));

// Middleware de logging de requisições
app.use((req, res, next) => {
  const origin = req.get('origin') || 'no-origin';
  const method = req.method;
  const path = req.path;
  
  // Log após resposta
  res.on('finish', () => {
    console.log(`[${method}] ${path} | Origin: ${origin} | Status: ${res.statusCode}`);
  });
  
  next();
});

app.use(express.json());

// ========== RATE LIMITING ==========

/**
 * Limiter específico para endpoints de ativação
 * - Máximo 5 tentativas por IP a cada 1 minuto
 * - Protege contra brute force de chaves
 */
const activationLimiter = rateLimit({
  windowMs: 60 * 1000,                              // 1 minuto
  max: 5,                                           // 5 requisições por IP
  message: 'Muitas tentativas de ativação. Tente novamente em 1 minuto.',
  standardHeaders: true,                            // Retorna `RateLimit-*` headers
  legacyHeaders: false,                             // Desabilita `X-RateLimit-*` headers
  keyGenerator: (req) => getClientIP(req),          // Usar IP real (com proxy support)
  skip: (req) => false,                             // Nunca pular (aplicar sempre)
  handler: (req, res) => {
    console.warn(`⚠️ [RateLimit] Muitas tentativas de ativação do IP: ${getClientIP(req)}`);
    res.status(429).json({ 
      success: false, 
      error: 'too_many_requests',
      message: 'Muitas tentativas. Aguarde 1 minuto antes de tentar novamente.' 
    });
  }
});

/**
 * Limiter global para todas as requisições
 * - Máximo 100 requisições por IP a cada 5 minutos
 * - Proteção geral contra DOS/abuso
 */
const globalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,                          // 5 minutos
  max: 100,                                         // 100 requisições por IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req),
  skip: (req) => false,
  handler: (req, res) => {
    console.warn(`⚠️ [RateLimit] Limite global excedido do IP: ${getClientIP(req)}`);
    res.status(429).json({ 
      success: false, 
      error: 'too_many_requests',
      message: 'Limite de requisições excedido. Tente novamente mais tarde.' 
    });
  }
});

// Aplicar limiter global (proteção para todos os endpoints)
app.use(globalLimiter);

// ========== AUTENTICAÇÃO ==========

/**
 * Comparação segura contra timing attacks
 */
function constantTimeEquals(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Middleware para validar token do Dashboard (x-dashboard-token)
 * Usado para operações sensíveis como criar chaves de ativação
 */
const authenticateDashboardToken = (req, res, next) => {
  const token = req.headers['x-dashboard-token'];
  const validToken = process.env.DASHBOARD_ACTIVATION_TOKEN;
  
  // Se não estiver configurado, rejeitar
  if (!validToken) {
    console.error('❌ ERRO: DASHBOARD_ACTIVATION_TOKEN não configurado no environment!');
    return res.status(500).json({ 
      success: false, 
      error: 'server_misconfiguration',
      message: 'Token de autenticação não configurado no servidor'
    });
  }
  
  // Se token não foi enviado, rejeitar
  if (!token) {
    console.warn('⚠️ [Auth] Tentativa de acesso a /activation-keys SEM x-dashboard-token');
    return res.status(401).json({ 
      success: false, 
      error: 'unauthorized',
      message: 'Token de autenticação necessário (header: x-dashboard-token)'
    });
  }
  
  // Comparação segura contra timing attacks
  if (!constantTimeEquals(token, validToken)) {
    console.warn('⚠️ [Auth] Token INVÁLIDO para /activation-keys');
    return res.status(403).json({ 
      success: false, 
      error: 'forbidden',
      message: 'Token de autenticação inválido'
    });
  }
  
  console.log('✅ [Auth] Dashboard autenticado para /activation-keys');
  next();
};

// ========== SERVIÇOS ==========
const ipGeoService = new IPGeolocationService();
const firebaseTracking = new FirebaseTrackingService(); // Inicializa Firebase 'ad-tracking' PRIMEIRO
const activationKeys = new ActivationKeysService(); // Usa a mesma app 'ad-tracking'

// Diagnóstico: verificar se ActivationKeys está operacional
console.log(`📊 ActivationKeys status: ${activationKeys._disabled ? '❌ DESABILITADO' : '✅ OPERACIONAL'}`);

// Função auxiliar para gerar ID
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Função para obter IP real do usuário
function getClientIP(req) {
  return req.ip || 
         req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         req.headers['x-real-ip'] || 
         req.connection?.remoteAddress ||
         'unknown';
}

// Carregar anúncios
const adsPath = path.join(__dirname, 'data', 'ads.json');
let ads = [];

try {
  const adsData = fs.readFileSync(adsPath, 'utf-8');
  ads = JSON.parse(adsData);
  console.log(`✅ Carregados ${ads.length} anúncios`);
} catch (error) {
  console.error('❌ Erro ao carregar ads.json:', error.message);
  process.exit(1);
}

// Índice para round-robin
let currentAdIndex = 0;

// Função para obter próximo anúncio (round-robin)
function getNextAd() {
  if (ads.length === 0) return null;
  const ad = ads[currentAdIndex];
  currentAdIndex = (currentAdIndex + 1) % ads.length;
  return ad;
}

// Função para detectar protocolo correto (considera proxies como Render)
function getProtocol(req) {
  // Verificar header x-forwarded-proto (usado por proxies como Render)
  const forwardedProto = req.get('x-forwarded-proto');
  if (forwardedProto) {
    return forwardedProto.split(',')[0].trim();
  }
  
  // Verificar se está em produção (Render) - sempre HTTPS
  if (process.env.NODE_ENV === 'production' || req.get('host')?.includes('onrender.com')) {
    return 'https';
  }
  
  // Fallback para req.protocol
  return req.protocol;
}

// Função para construir URL completa
function buildAssetUrl(req, assetPath) {
  const protocol = getProtocol(req);
  const host = req.get('host');
  const relativePath = assetPath.replace('public/', '');
  return `${protocol}://${host}/${relativePath}`;
}

// Helper para encontrar arquivo de asset por extensões
function findAsset(adId, extensions) {
  const baseDir = path.join(__dirname, 'public', 'ads', adId);
  
  // Verificar se diretório existe
  if (!fs.existsSync(baseDir)) {
    console.error(`[findAsset] Diretório não encontrado: ${baseDir}`);
    return null;
  }
  
  // Listar arquivos no diretório
  let files;
  try {
    files = fs.readdirSync(baseDir);
  } catch (err) {
    console.error(`[findAsset] Erro ao ler diretório ${baseDir}:`, err.message);
    return null;
  }
  
  // Procurar arquivo que corresponda a uma das extensões
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (extensions.includes(ext)) {
      const fullPath = path.join(baseDir, file);
      console.log(`[findAsset] Arquivo encontrado: ${fullPath}`);
      return fullPath;
    }
  }
  
  // Nenhum arquivo encontrado
  console.error(`[findAsset] Nenhum arquivo encontrado em ${baseDir} com extensões: ${extensions.join(', ')}`);
  console.error(`[findAsset] Arquivos disponíveis: ${files.join(', ')}`);
  return null;
}

// Função para determinar Content-Type por extensão
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.gif': 'image/gif'
  };
  return contentTypes[ext] || 'application/octet-stream';
}

// Função para log de tracking
function logTracking(data) {
  const logPath = path.join(__dirname, 'logs', 'tracking.log');
  const logDir = path.dirname(logPath);
  
  // Criar diretório se não existir
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp} | ${JSON.stringify(data)}\n`;
  
  fs.appendFileSync(logPath, logEntry, 'utf-8');
}

// ========== ENDPOINTS ==========

// Raiz: evita 404 quando alguém acessa GET /
app.get('/', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.status(200).json({ service: 'ad-server', ok: true, health: '/health' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Proxy para imagem do Google Drive
app.get('/proxy-image', async (req, res) => {
  try { //https://drive.google.com/file/d/1vL3kDQ5G0hkgVDLmgY7WhVgkZF1N3qQb/view?usp=sharing
    const driveId = '1vL3kDQ5G0hkgVDLmgY7WhVgkZF1N3qQb';
    
    // Tentar múltiplos formatos de URL do Google Drive
    const urls = [
      `https://drive.google.com/uc?export=view&id=${driveId}`, // Primeiro: view (melhor para imagens)
      `https://drive.google.com/uc?export=download&id=${driveId}`, // Segundo: download
      `https://lh3.googleusercontent.com/d/${driveId}=w1920-h1080`, // Terceiro: thumbnail direto
    ];
    
    let imageData = null;
    let contentType = 'image/jpeg';
    
    // Tentar cada URL até uma funcionar
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Referer': 'https://watchverse-jtkz.onrender.com/'
          },
          redirect: 'follow',
          // Timeout de 10 segundos
          signal: AbortSignal.timeout(10000)
        });
        
        if (response.ok) {
          const contentTypeHeader = response.headers.get('content-type') || '';
          
          // Verificar se é realmente uma imagem (não HTML de erro)
          if (contentTypeHeader.startsWith('image/')) {
            contentType = contentTypeHeader;
            imageData = await response.arrayBuffer();
            
            // Verificar se não é HTML disfarçado (Google Drive às vezes retorna HTML)
            if (imageData.byteLength > 0) {
              const firstBytes = new Uint8Array(imageData.slice(0, 4));
              const isImage = firstBytes[0] === 0xFF && firstBytes[1] === 0xD8 || // JPEG
                             firstBytes[0] === 0x89 && firstBytes[1] === 0x50 || // PNG
                             firstBytes[0] === 0x47 && firstBytes[1] === 0x49;    // GIF
              
              if (isImage || contentTypeHeader.includes('image')) {
                console.log(`[proxy-image] ✅ Imagem carregada com sucesso de: ${url} (${contentTypeHeader}, ${imageData.byteLength} bytes)`);
                break;
              }
            }
          } else {
            console.log(`[proxy-image] ⚠️ URL retornou ${contentTypeHeader} ao invés de imagem: ${url}`);
          }
        } else {
          console.log(`[proxy-image] ⚠️ URL retornou status ${response.status}: ${url}`);
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          console.log(`[proxy-image] ⏱️ Timeout ao tentar URL: ${url}`);
        } else {
          console.log(`[proxy-image] ❌ Erro ao tentar URL ${url}:`, err.message);
        }
        continue;
      }
    }
    
    if (!imageData) {
      // Se nenhuma URL funcionar, retornar erro com instruções
      console.error('[proxy-image] ❌ Nenhuma URL do Google Drive funcionou');
      return res.status(404).json({ 
        error: 'Imagem não encontrada',
        message: 'Não foi possível carregar a imagem do Google Drive.',
        instructions: [
          '1. Certifique-se de que o arquivo está configurado para "Qualquer pessoa com o link pode visualizar"',
          '2. Verifique se o ID do arquivo está correto',
          '3. Tente fazer upload da imagem diretamente no servidor em ad-server/public/ads/comercial/'
        ]
      });
    }
    
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', 'inline');
    res.send(Buffer.from(imageData));
    
  } catch (error) {
    console.error('[proxy-image] ❌ Erro geral ao buscar imagem:', error);
    res.status(500).json({ 
      error: 'Erro ao carregar imagem',
      message: error.message 
    });
  }
});

// Proxy para vídeo do Google Drive
app.get('/proxy-video', async (req, res) => {
  try {
    const fileId = req.query.id;
    
    if (!fileId) {
      return res.status(400).json({ 
        error: 'File ID é obrigatório',
        message: 'Use: /proxy-video?id={FILE_ID}'
      });
    }

    // Headers para simular navegador
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://drive.google.com/',
      'Accept': '*/*'
    };

    // Suporte a HTTP Range requests
    const range = req.headers.range;
    
    // Função auxiliar para verificar se é vídeo
    function isVideo(buffer, contentType) {
      if (!buffer || buffer.byteLength < 4) return false;
      const firstBytes = new Uint8Array(buffer.slice(0, Math.min(100, buffer.length)));
      const isMp4 = buffer.byteLength > 4 && 
                     firstBytes[4] === 0x66 && firstBytes[5] === 0x74 && 
                     firstBytes[6] === 0x79 && firstBytes[7] === 0x70; // 'ftyp'
      const isWebM = buffer.byteLength > 4 && 
                     firstBytes[0] === 0x1A && firstBytes[1] === 0x45 && 
                     firstBytes[2] === 0xDF && firstBytes[3] === 0xA3;
      return isMp4 || isWebM || (contentType && contentType.includes('video'));
    }
    
    // Função auxiliar para extrair código de confirmação do HTML e cookies
    function extractConfirmCode(htmlText, responseHeaders) {
      // 1. Tentar extrair de cookies da resposta
      const setCookie = responseHeaders?.get?.('set-cookie');
      if (setCookie) {
        // Padrão: download_warning_XXXX=YYYY
        const cookieMatch = setCookie.match(/download_warning_(\d+)=([a-zA-Z0-9_-]+)/);
        if (cookieMatch && cookieMatch[2]) {
          console.log(`[proxy-video] Código encontrado em cookie: ${cookieMatch[2]}`);
          return cookieMatch[2];
        }
      }
      
      // 2. Procurar no HTML por padrões de confirmação
      if (htmlText && htmlText.length > 0) {
        // Padrão mais comum: href="/uc?export=download&id=FILE_ID&confirm=XXXX"
        const hrefMatch = htmlText.match(/href=["']\/uc\?[^"']*confirm=([a-zA-Z0-9_-]+)["']/i);
        if (hrefMatch && hrefMatch[1]) {
          console.log(`[proxy-video] Código encontrado em href: ${hrefMatch[1]}`);
          return hrefMatch[1];
        }
        
        // Padrão: confirm=XXXX em qualquer URL
        const confirmMatch = htmlText.match(/confirm=([a-zA-Z0-9_-]{4,})/i);
        if (confirmMatch && confirmMatch[1] && confirmMatch[1] !== 't') {
          console.log(`[proxy-video] Código encontrado em URL: ${confirmMatch[1]}`);
          return confirmMatch[1];
        }
        
        // Padrão: download_warning_XXXX em formulários
        const warningMatch = htmlText.match(/download_warning_(\d+)/);
        if (warningMatch && warningMatch[1]) {
          console.log(`[proxy-video] Código encontrado em warning: ${warningMatch[1]}`);
          return warningMatch[1];
        }
        
        // Padrão: name="download_warning_XXXX" value="YYYY" ou input type="hidden"
        const formMatch = htmlText.match(/name=["']download_warning_\d+["'][^>]*value=["']([^"']+)["']/i) ||
                         htmlText.match(/value=["']([^"']+)["'][^>]*name=["']download_warning_\d+["']/i);
        if (formMatch && formMatch[1]) {
          console.log(`[proxy-video] Código encontrado em formulário: ${formMatch[1]}`);
          return formMatch[1];
        }
        
        // Padrão: onclick ou action com confirm
        const actionMatch = htmlText.match(/action=["']([^"']*confirm=([a-zA-Z0-9_-]+)[^"']*)["']/i);
        if (actionMatch && actionMatch[2]) {
          console.log(`[proxy-video] Código encontrado em action: ${actionMatch[2]}`);
          return actionMatch[2];
        }
        
        // Padrão: window.location ou location.href com confirm
        const locationMatch = htmlText.match(/location\.(href|replace)\(["'][^"']*confirm=([a-zA-Z0-9_-]+)[^"']*["']/i);
        if (locationMatch && locationMatch[2]) {
          console.log(`[proxy-video] Código encontrado em location: ${locationMatch[2]}`);
          return locationMatch[2];
        }
      }
      
      return null;
    }
    
    // Tentar múltiplas URLs em ordem de prioridade
    const urlsToTry = [
      `https://drive.google.com/uc?export=download&id=${fileId}`,
      `https://drive.google.com/uc?id=${fileId}&export=download`,
      `https://drive.google.com/file/d/${fileId}/view?usp=sharing`
    ];
    
    let finalBuffer = null;
    let finalContentType = 'video/mp4';
    let finalContentLength = null;
    let finalUrl = null;
    let cookieJar = []; // Cookie jar compartilhado entre todas as tentativas
    
    for (const url of urlsToTry) {
      try {
        console.log(`[proxy-video] Tentando URL: ${url}`);
        
        // Headers com cookies acumulados de tentativas anteriores
        const requestHeaders = { ...headers };
        if (cookieJar.length > 0) {
          requestHeaders['Cookie'] = cookieJar.join('; ');
        }
        
        const response = await fetch(url, {
          headers: requestHeaders,
          redirect: 'follow'
        });

        // Coletar cookies da resposta para próximas tentativas
        const setCookieHeader = response.headers.get('set-cookie');
        if (setCookieHeader) {
          // Adicionar apenas se não existir já
          if (!cookieJar.includes(setCookieHeader)) {
            cookieJar.push(setCookieHeader);
          }
        }

        if (!response.ok) {
          console.warn(`[proxy-video] URL falhou com status ${response.status}`);
          continue;
        }

        const contentType = response.headers.get('content-type') || '';
        const buffer = await response.arrayBuffer();
        
        // Se for HTML, tentar extrair código de confirmação
        if (contentType.includes('text/html') || buffer.byteLength < 1000) {
          const htmlText = Buffer.from(buffer).toString('utf-8');
          const confirmCode = extractConfirmCode(htmlText, response.headers);
          
          if (confirmCode) {
            console.log(`[proxy-video] Código de confirmação encontrado: ${confirmCode}`);
            // Tentar com código de confirmação - múltiplas variações
            const confirmUrls = [
              `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmCode}`,
              `https://drive.google.com/uc?id=${fileId}&export=download&confirm=${confirmCode}`,
              `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t&uuid=${confirmCode}`
            ];
            
            for (const confirmUrl of confirmUrls) {
              try {
                // Adicionar cookies coletados se houver
                const confirmHeaders = { ...headers };
                if (cookieJar.length > 0) {
                  confirmHeaders['Cookie'] = cookieJar.join('; ');
                }
                
                console.log(`[proxy-video] Tentando URL de confirmação: ${confirmUrl}`);
                const confirmResponse = await fetch(confirmUrl, {
                  headers: confirmHeaders,
                  redirect: 'follow'
                });
                
                // Coletar novos cookies da resposta de confirmação
                const confirmSetCookie = confirmResponse.headers.get('set-cookie');
                if (confirmSetCookie) {
                  cookieJar.push(confirmSetCookie);
                }
                
                if (confirmResponse.ok) {
                  const confirmBuffer = await confirmResponse.arrayBuffer();
                  const confirmContentType = confirmResponse.headers.get('content-type') || '';
                  
                  if (isVideo(confirmBuffer, confirmContentType)) {
                    console.log(`[proxy-video] Download com código de confirmação funcionou! URL: ${confirmUrl}`);
                    finalBuffer = confirmBuffer;
                    finalContentType = confirmContentType.includes('video') ? confirmContentType : 'video/mp4';
                    finalContentLength = confirmResponse.headers.get('content-length');
                    finalUrl = confirmUrl;
                    break;
                  }
                }
              } catch (err) {
                console.warn(`[proxy-video] Erro ao tentar URL de confirmação ${confirmUrl}:`, err.message);
                continue;
              }
            }
            
            if (finalBuffer && isVideo(finalBuffer, finalContentType)) {
              break; // Sucesso, sair do loop
            }
          }
          continue; // Tentar próxima URL
        }
        
        // Verificar se é vídeo
        if (isVideo(buffer, contentType)) {
          console.log(`[proxy-video] Vídeo encontrado na URL: ${url}`);
          finalBuffer = buffer;
          finalContentType = contentType.includes('video') ? contentType : 'video/mp4';
          finalContentLength = response.headers.get('content-length');
          finalUrl = url;
          break;
        }
      } catch (error) {
        console.warn(`[proxy-video] Erro ao tentar URL ${url}:`, error.message);
        continue;
      }
    }
    
    // Se não encontrou vídeo em nenhuma URL, retornar erro
    if (!finalBuffer || !isVideo(finalBuffer, finalContentType)) {
      return res.status(500).json({
        error: 'Não foi possível obter o vídeo do Google Drive',
        message: 'O arquivo pode estar protegido, ser muito grande, ou não estar disponível para download direto. Certifique-se de que o arquivo está configurado para "Qualquer pessoa com o link pode visualizar".',
        fileId: fileId
      });
    }
    
    // Ajustar contentType baseado nos magic bytes
    const firstBytes = new Uint8Array(finalBuffer.slice(0, 8));
    if (firstBytes[4] === 0x66 && firstBytes[5] === 0x74 && firstBytes[6] === 0x79 && firstBytes[7] === 0x70) {
      finalContentType = 'video/mp4';
    } else if (firstBytes[0] === 0x1A && firstBytes[1] === 0x45 && firstBytes[2] === 0xDF && firstBytes[3] === 0xA3) {
      finalContentType = 'video/webm';
    }

    // Se cliente solicitou Range, retornar parcial
    if (range && finalContentLength) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : parseInt(finalContentLength, 10) - 1;
      const chunkSize = (end - start) + 1;

      // Buscar apenas o range solicitado da URL final
      const rangeResponse = await fetch(finalUrl, {
        headers: {
          ...headers,
          'Range': `bytes=${start}-${end}`
        }
      });

      if (rangeResponse.ok) {
        res.status(206);
        res.set({
          'Content-Range': `bytes ${start}-${end}/${finalContentLength}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': finalContentType,
          'Cache-Control': 'public, max-age=3600'
        });

        const rangeBuffer = await rangeResponse.arrayBuffer();
        return res.send(Buffer.from(rangeBuffer));
      }
    }
    
    // Download completo
    res.set({
      'Content-Type': finalContentType,
      'Content-Length': finalBuffer.byteLength || finalContentLength || '',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
      'Content-Disposition': `inline; filename="video.mp4"`
    });

    // Enviar buffer já lido
    res.send(Buffer.from(finalBuffer));
  } catch (error) {
    console.error('[proxy-video] Erro:', error);
    res.status(500).json({ 
      error: 'Erro ao baixar vídeo',
      message: error.message 
    });
  }
});

// Obter próximo anúncio - RETORNA HTML COMERCIAL
app.get('/ad/next', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/html; charset=utf-8');
  
  const ad = getNextAd();
  if (!ad) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Anúncio não disponível</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          h1 { text-align: center; }
        </style>
      </head>
      <body>
        <h1>Nenhum anúncio disponível no momento</h1>
      </body>
      </html>
    `);
  }
  
  // URL da imagem via proxy do servidor (resolve problemas de CORS e hotlinking)
  const protocol = getProtocol(req);
  const host = req.get('host');
  const imageUrl = `${protocol}://${host}/proxy-image`;
  
  // URL de clique do anúncio
  const clickUrl = 'https://watchverse-jtkz.onrender.com/' || '#';
  
  // Log do anúncio escolhido e origin
  const origin = req.get('origin') || 'no-origin';
  console.log(`[AD] Anúncio HTML escolhido: ${ad.id} | Origin: ${origin} | Image URL: ${imageUrl}`);
  
  // HTML do comercial
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WatchVerse</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #fff;
      overflow-x: hidden;
    }
    
    .ad-container {
      max-width: 650px;
      width: 100%;
      background: rgba(255, 255, 255, 0.98);
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 25px 70px rgba(0, 0, 0, 0.35);
      animation: fadeInUp 0.9s ease-out;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
    }
    
    /* Estilos para Landscape (Paisagem) */
    @media (orientation: landscape) and (min-width: 600px) {
      body {
        padding: 20px 40px;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .ad-container {
        max-width: 900px;
        width: 90%;
        height: 90vh;
        max-height: 90vh;
        display: flex;
        flex-direction: row;
        overflow: hidden;
        position: relative;
      }
      
      .ad-image-wrapper {
        width: 50%;
        height: 100%;
        min-height: 100%;
        flex-shrink: 0;
        border-radius: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        z-index: 0;
      }
      
      .ad-image {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center center;
        display: block;
      }
      
      .ad-content {
        width: 50%;
        height: 100%;
        min-height: 100%;
        padding: 30px;
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        overflow-y: auto;
        overflow-x: hidden;
        background: rgba(245, 240, 255, 0.95);
        position: relative;
        z-index: 1;
        flex-shrink: 0;
      }
      
      .ad-container {
        border-radius: 0;
      }
      
      .ad-title {
        font-size: 32px;
        margin-bottom: 10px;
      }
      
      .ad-subtitle {
        font-size: 17px;
        margin-bottom: 20px;
      }
      
      .ad-highlight {
        font-size: 18px;
        padding: 15px 20px;
        margin-bottom: 20px;
      }
      
      .ad-description {
        font-size: 15px;
        margin-bottom: 20px;
      }
      
      .ad-features {
        margin-bottom: 20px;
      }
      
      .ad-features li {
        font-size: 14px;
        padding: 8px 0;
        padding-left: 30px;
      }
      
      .ad-cta {
        padding: 16px 35px;
        font-size: 18px;
      }
      
      .ad-footer {
        margin-top: 15px;
        font-size: 12px;
      }
    }
    
    /* Landscape em telas muito largas */
    @media (orientation: landscape) and (min-width: 1200px) {
      .ad-container {
        max-width: 1100px;
        height: 90vh;
      }
      
      .ad-image-wrapper {
        width: 50%;
        height: 100%;
        min-height: 100%;
        flex-shrink: 0;
      }
      
      .ad-image {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center center;
      }
      
      .ad-content {
        width: 50%;
        height: 100%;
        min-height: 100%;
        padding: 40px;
        overflow-y: auto;
        overflow-x: hidden;
        position: relative;
        z-index: 1;
        flex-shrink: 0;
      }
      
      .ad-title {
        font-size: 38px;
      }
      
      .ad-subtitle {
        font-size: 19px;
      }
    }
    
    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .ad-image-wrapper {
      width: 100%;
      height: 350px;
      overflow: hidden;
      position: relative;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      flex-shrink: 0;
    }
    
    .ad-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
      display: block;
      transition: transform 0.5s ease;
    }
    
    .ad-image:hover {
      transform: scale(1.05);
    }
    
    .ad-content {
      padding: 35px;
      color: #333;
      background: rgba(245, 240, 255, 0.95);
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      position: relative;
      z-index: 1;
      visibility: visible !important;
      opacity: 1 !important;
      display: flex !important;
      flex-direction: column;
    }
    
    .ad-title {
      font-size: 36px;
      font-weight: 800;
      margin-bottom: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      line-height: 1.2;
      word-wrap: break-word;
      overflow-wrap: break-word;
      hyphens: auto;
    }
    
    .ad-subtitle {
      font-size: 19px;
      color: #666;
      margin-bottom: 25px;
      line-height: 1.6;
      font-weight: 500;
    }
    
    .ad-highlight {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 18px 28px;
      border-radius: 12px;
      font-weight: 700;
      text-align: center;
      font-size: 20px;
      margin-bottom: 25px;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
      animation: pulse 2s ease-in-out infinite;
      word-wrap: break-word;
      line-height: 1.4;
    }
    
    @keyframes pulse {
      0%, 100% {
        transform: scale(1);
      }
      50% {
        transform: scale(1.02);
      }
    }
    
    .ad-description {
      font-size: 17px;
      color: #555;
      line-height: 1.9;
      margin-bottom: 28px;
      text-align: left;
      word-wrap: break-word;
    }
    
    .ad-features {
      list-style: none;
      margin-bottom: 30px;
    }
    
    .ad-features li {
      padding: 12px 0;
      padding-left: 35px;
      position: relative;
      color: #444;
      font-size: 16px;
      line-height: 1.6;
    }
    
    .ad-features li:before {
      content: "✓";
      position: absolute;
      left: 0;
      color: #667eea;
      font-weight: bold;
      font-size: 22px;
      line-height: 1.4;
    }
    
    .ad-cta {
      display: block;
      text-align: center;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px 45px;
      border-radius: 50px;
      text-decoration: none;
      font-weight: 800;
      font-size: 20px;
      transition: all 0.3s ease;
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .ad-cta:hover {
      transform: translateY(-3px);
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.7);
    }
    
    .ad-cta:active {
      transform: translateY(-1px);
    }
    
    .ad-footer {
      text-align: center;
      margin-top: 25px;
      font-size: 13px;
      color: #999;
      font-style: italic;
    }
    
    /* Estilos para Tablets e telas médias em Portrait */
    @media (min-width: 601px) and (max-width: 1024px) and (orientation: portrait) {
      .ad-container {
        max-width: 700px;
        width: 95%;
        display: flex;
        flex-direction: column;
      }
      
      .ad-content {
        padding: 40px;
        min-height: auto;
        width: 100%;
        height: auto;
        overflow: visible;
        display: block;
      }
      
      .ad-image-wrapper {
        height: 400px;
        width: 100%;
      }
    }
    
    /* Estilos para Tablets em Landscape (iPad, etc) */
    @media (min-width: 768px) and (max-width: 1024px) and (orientation: landscape) {
      .ad-container {
        max-width: 1000px;
        width: 95%;
        height: 85vh;
        display: flex !important;
        flex-direction: row !important;
      }
      
      .ad-image-wrapper {
        width: 50% !important;
        min-width: 50% !important;
        flex-shrink: 0;
      }
      
      .ad-content {
        width: 50% !important;
        min-width: 50% !important;
        padding: 35px;
        display: flex !important;
        flex-direction: column !important;
        visibility: visible !important;
        opacity: 1 !important;
        height: 100% !important;
        overflow-y: auto;
        overflow-x: hidden;
      }
    }
    
    /* Garantir visibilidade em todas as telas grandes */
    @media (min-width: 1025px) {
      .ad-content {
        display: flex !important;
        visibility: visible !important;
        opacity: 1 !important;
        width: 50% !important;
      }
      
      .ad-image-wrapper {
        width: 50% !important;
      }
      
      .ad-container {
        display: flex !important;
        flex-direction: row !important;
      }
    }
    
    /* Estilos para Portrait (Retrato) - Mobile */
    @media (max-width: 600px) and (orientation: portrait) {
      body {
        padding: 15px;
      }
      
      .ad-container {
        max-width: 100%;
      }
      
      .ad-title {
        font-size: 28px;
      }
      
      .ad-subtitle {
        font-size: 17px;
      }
      
      .ad-highlight {
        font-size: 18px;
        padding: 15px 20px;
      }
      
      .ad-content {
        padding: 25px;
      }
      
      .ad-image-wrapper {
        height: 250px;
      }
    }
    
    /* Landscape em mobile (telas pequenas em paisagem) */
    @media (orientation: landscape) and (max-height: 500px) {
      body {
        padding: 10px;
      }
      
      .ad-container {
        max-width: 100%;
        height: 95vh;
        max-height: 95vh;
        flex-direction: row;
      }
      
      .ad-image-wrapper {
        width: 40%;
        height: 100%;
        min-height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      
      .ad-image {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center center;
      }
      
      .ad-content {
        width: 60%;
        height: 100%;
        min-height: 100%;
        padding: 20px;
        background: rgba(245, 240, 255, 0.95);
        overflow-y: auto;
        overflow-x: hidden;
        position: relative;
        z-index: 1;
        flex-shrink: 0;
      }
      
      .ad-image-wrapper {
        border-radius: 0;
      }
      
      .ad-container {
        border-radius: 0;
      }
      
      .ad-title {
        font-size: 24px;
        margin-bottom: 8px;
      }
      
      .ad-subtitle {
        font-size: 14px;
        margin-bottom: 12px;
      }
      
      .ad-highlight {
        font-size: 14px;
        padding: 10px 15px;
        margin-bottom: 12px;
      }
      
      .ad-description {
        font-size: 13px;
        margin-bottom: 12px;
      }
      
      .ad-features {
        margin-bottom: 12px;
      }
      
      .ad-features li {
        font-size: 12px;
        padding: 6px 0;
        padding-left: 25px;
      }
      
      .ad-cta {
        padding: 12px 25px;
        font-size: 14px;
      }
      
      .ad-footer {
        margin-top: 10px;
        font-size: 11px;
      }
    }
  </style>
</head>
<body>
  <div class="ad-container">
    <div class="ad-image-wrapper">
      <img src="${imageUrl}" alt="Entretenimento Premium" class="ad-image" />
    </div>
    <div class="ad-content">
      <h1 class="ad-title">🎬Transforme Seu Entretenimento</h1>
      <p class="ad-subtitle">Aplicativo de Filmes, Séries e Animes </p>
      
      <div class="ad-highlight">
        ✨ Milhares de Filmes,Séries e Animes Esperando por Você ✨
      </div>   
      
      <ul class="ad-features">
        <li>Clique no botão "Assista Agora" para ir ao Site do WatchVerse</li>
        <li>Insira seu email no campo ativar</li>
        <li>Voce receberá um email com um numero de confirmação que deverá ser inserido no campo "Ativar"</li>
        <li>Depois da confirmação de pagamento pix a chave de ativação é gerada na tela</li>
        <li>Agora é só inserir a chave de ativação no campo "Ativar" e aproveitar um mês de acesso</li>
        <li>As atualizações de conteúdo são semanais </li>
      </ul>
      
      <a href="${clickUrl}" class="ad-cta" target="_blank" rel="noopener noreferrer">
        Começar Agora - É Grátis! 🚀
      </a>
      
      <p class="ad-footer">Oferta especial por tempo limitado • Cancele quando quiser</p>
    </div>
  </div>
</body>
</html>`;
  
  res.send(html);
});

// Servir imagem
app.get('/imagem/:id', (req, res) => {
  const adId = req.params.id;
  const ad = ads.find(a => a.id === adId);
  
  if (!ad) {
    console.error(`[imagem] Anúncio não encontrado: ${adId}`);
    return res.status(404).json({ error: 'Anúncio não encontrado' });
  }
  
  // Procurar arquivo de imagem por extensões
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
  const imagePath = findAsset(adId, imageExtensions);
  
  if (!imagePath) {
    const baseDir = path.join(__dirname, 'public', 'ads', adId);
    console.error(`[imagem] Imagem não encontrada para ${adId} no diretório: ${baseDir}`);
    return res.status(404).json({ 
      error: 'Imagem não encontrada',
      adId: adId,
      searchedDirectory: baseDir,
      expectedExtensions: imageExtensions
    });
  }
  
  // Determinar Content-Type por extensão
  const contentType = getContentType(imagePath);
  
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Content-Type', contentType);
  res.set('Content-Disposition', 'inline');
  
  // Usar sendFile para servir o arquivo
  res.sendFile(imagePath, (err) => {
    if (err) {
      console.error(`[imagem] Erro ao enviar arquivo ${imagePath}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro ao servir imagem' });
      }
    }
  });
});

// Servir vídeo com suporte a HTTP Range
app.get('/video/:id', (req, res) => {
  const adId = req.params.id;
  const ad = ads.find(a => a.id === adId);
  
  if (!ad) {
    console.error(`[video] Anúncio não encontrado: ${adId}`);
    return res.status(404).json({ error: 'Anúncio não encontrado' });
  }
  
  // Procurar arquivo de vídeo por extensão
  const videoExtensions = ['.mp4'];
  const videoPath = findAsset(adId, videoExtensions);
  
  if (!videoPath) {
    const baseDir = path.join(__dirname, 'public', 'ads', adId);
    console.error(`[video] Vídeo não encontrado para ${adId} no diretório: ${baseDir}`);
    return res.status(404).json({ 
      error: 'Vídeo não encontrado',
      adId: adId,
      searchedDirectory: baseDir,
      expectedExtensions: videoExtensions
    });
  }
  
  // Obter estatísticas do arquivo
  let stat;
  try {
    stat = fs.statSync(videoPath);
  } catch (err) {
    console.error(`[video] Erro ao obter estatísticas de ${videoPath}:`, err.message);
    return res.status(500).json({ error: 'Erro ao acessar arquivo de vídeo' });
  }
  
  const fileSize = stat.size;
  const range = req.headers.range;
  
  // Headers de cache
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Content-Disposition', 'inline');
  res.set('Accept-Ranges', 'bytes');
  
  if (range) {
    // Parse do Range header
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    
    // Validar range
    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`);
      return res.json({ error: 'Range não satisfazível' });
    }
    
    const file = fs.createReadStream(videoPath, { start, end });
    
    res.status(206); // Partial Content
    res.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.set('Content-Length', chunksize);
    res.set('Content-Type', 'video/mp4');
    
    file.on('error', (err) => {
      console.error(`[video] Erro ao ler stream de ${videoPath}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro ao servir vídeo' });
      }
    });
    
    file.pipe(res);
  } else {
    // Sem Range header, enviar vídeo completo
    res.set('Content-Length', fileSize);
    res.set('Content-Type', 'video/mp4');
    
    const file = fs.createReadStream(videoPath);
    
    file.on('error', (err) => {
      console.error(`[video] Erro ao ler stream de ${videoPath}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro ao servir vídeo' });
      }
    });
    
    file.pipe(res);
  }
});

// Tracking de eventos (ATUALIZADO COM GEOLOCALIZAÇÃO DO CLIENTE E HORÁRIO)
app.post('/track', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  
  try {
    // PRIORIDADE 1: Usar IP público do cliente se fornecido (mais confiável)
    let clientIP = req.body.clientGeo?.ipAddress;
    
    // PRIORIDADE 2: Usar IP detectado pelo servidor
    if (!clientIP) {
      clientIP = getClientIP(req);
    }
    
    // Log do IP para debug
    if (clientIP && (clientIP.startsWith('10.') || clientIP.startsWith('192.168.') || clientIP.startsWith('172.'))) {
      console.log(`⚠️ IP privado detectado: ${clientIP} - Tentando geolocalização por GPS se disponível`);
    }
    
    // PRIORIDADE 1: Usar GPS do cliente se disponível (mais preciso)
    let geo = { success: false };
    let geoSource = 'none';
    
    if (req.body.clientGeo?.latitude && req.body.clientGeo?.longitude) {
      // GPS do cliente disponível - usar para coordenadas precisas
      console.log(`✅ GPS do cliente disponível: ${req.body.clientGeo.latitude}, ${req.body.clientGeo.longitude}`);
      
      // Tentar geolocalização por IP para obter país/região (GPS não fornece isso diretamente)
      geo = ipGeoService.getLocationByIP(clientIP);
      
      // Se geolocalização por IP funcionar, usar coordenadas GPS do cliente
      if (geo.success) {
        geo.latitude = req.body.clientGeo.latitude;
        geo.longitude = req.body.clientGeo.longitude;
        geo.source = 'client_gps';
        geoSource = 'client_gps';
      }
    }
    
    // PRIORIDADE 2: Geolocalização por IP (se GPS não disponível)
    if (!geo.success) {
      geo = ipGeoService.getLocationByIP(clientIP);
      geoSource = geo.success ? 'ip' : 'none';
      
      // Se falhar, tentar API externa como fallback
      if (!geo.success && process.env.USE_IP_API === 'true') {
        console.log(`🔄 Tentando API externa para IP ${clientIP}...`);
        geo = await ipGeoService.getLocationByIPExternal(clientIP);
        geoSource = geo.success ? 'ip_api' : 'none';
      }
    }
    
    // Log do resultado
    if (!geo.success) {
      console.log(`⚠️ Geolocalização falhou para IP ${clientIP}: ${geo.reason || 'unknown'}`);
    } else {
      console.log(`✅ Geolocalização OK: ${geo.country_name} (${geo.country_code}) - IP: ${clientIP} - Fonte: ${geoSource}`);
    }
    
    // Timestamp UTC atual
    const utcNow = new Date();
    
    // Converter para horário local do usuário (se tiver timezone)
    const localTimeInfo = ipGeoService.convertToLocalTime(
      utcNow, 
      geo.timezone || null
    );
    
    // Preparar dados de tracking
    const trackingData = {
      event: req.body.event || 'unknown',
      ts: req.body.ts || utcNow.toISOString(),
      adId: req.body.adId || null,
      watchedMs: req.body.watchedMs || 0,
      ...req.body
    };

    // Log no arquivo (mantém compatibilidade)
    logTracking(trackingData);

    // Salvar no Firebase com geolocalização E horário local (assíncrono, não bloqueia)
    if (geo.success) {
      const firebaseData = {
        event: trackingData.event,
        adId: trackingData.adId || null,
        ts: utcNow.toISOString(), // Horário UTC
        watchedMs: trackingData.watchedMs || 0,
        localTime: localTimeInfo.localTime ? localTimeInfo.localTime.toISOString() : null,
        localTimeString: localTimeInfo.localTimeString, // String legível
        hourLocal: localTimeInfo.hourLocal, // Hora (0-23)
        dayOfWeek: localTimeInfo.dayOfWeek, // Dia da semana (0-6)
        ipAddress: clientIP, // IP público do cliente
        countryCode: geo.country_code, // ✅ SEMPRE terá countryCode quando geo.success
        countryName: geo.country_name,
        region: geo.region,
        city: geo.city,
        latitude: geo.latitude, // GPS do cliente se disponível
        longitude: geo.longitude, // GPS do cliente se disponível
        timezone: geo.timezone,
        geoSource: geoSource, // Fonte da geolocalização (client_gps, ip, ip_api)
        deviceInfo: req.body.clientGeo?.device || req.body.device_info || null,
        screenWidth: req.body.clientGeo?.screenWidth || null,
        screenHeight: req.body.clientGeo?.screenHeight || null,
        userAgent: req.body.clientGeo?.userAgent || req.get('user-agent') || null,
        eventData: trackingData,
        createdAt: utcNow.toISOString()
      };

      // Salvar assincronamente (não aguardar)
      firebaseTracking.saveTracking(firebaseData).catch(err => {
        console.error('Erro ao salvar tracking no Firebase:', err.message);
        // Não quebrar o fluxo se o Firebase falhar
      });
    } else {
      // Tentar salvar mesmo sem geolocalização (IP inválido ou não encontrado)
      // Mas agora temos IP público do cliente, então podemos tentar geolocalização retroativa depois
      const firebaseData = {
        event: trackingData.event,
        adId: trackingData.adId || null,
        ts: utcNow.toISOString(),
        watchedMs: trackingData.watchedMs || 0,
        localTime: localTimeInfo.localTime ? localTimeInfo.localTime.toISOString() : null,
        localTimeString: localTimeInfo.localTimeString,
        hourLocal: localTimeInfo.hourLocal,
        dayOfWeek: localTimeInfo.dayOfWeek,
        ipAddress: clientIP, // IP público do cliente (útil para migração futura)
        deviceInfo: req.body.clientGeo?.device || req.body.device_info || null,
        screenWidth: req.body.clientGeo?.screenWidth || null,
        screenHeight: req.body.clientGeo?.screenHeight || null,
        userAgent: req.body.clientGeo?.userAgent || req.get('user-agent') || null,
        eventData: trackingData,
        createdAt: utcNow.toISOString()
        // ⚠️ Sem countryCode - mas agora temos IP público para tentar geolocalização retroativa
      };

      firebaseTracking.saveTracking(firebaseData).catch(err => {
        console.error('Erro ao salvar tracking no Firebase:', err.message);
      });
    }

    res.json({ 
      success: true,
      geo: geo.success ? {
        country: geo.country_name,
        region: geo.region,
        city: geo.city,
        timezone: geo.timezone,
        localTime: localTimeInfo.localTimeString,
        hour: localTimeInfo.hourLocal,
        source: geoSource
      } : null
    });
  } catch (error) {
    console.error('Erro ao processar tracking:', error);
    res.json({ success: true }); // Sempre retornar sucesso para não quebrar o app
  }
});

// ========== ENDPOINTS DE ANALYTICS ==========

// Endpoint para estatísticas por horário do dia
app.get('/api/analytics/hours', async (req, res) => {
  try {
    const { adId, country } = req.query;

    const filters = {};
    if (adId) filters.adId = adId;
    if (country) filters.countryCode = country;

    const result = await firebaseTracking.getStatsByHour(filters);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Erro ao buscar estatísticas por horário:', error);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// Endpoint para estatísticas por dia da semana
app.get('/api/analytics/days', async (req, res) => {
  try {
    const { adId, country } = req.query;

    const filters = {};
    if (adId) filters.adId = adId;
    if (country) filters.countryCode = country;

    const result = await firebaseTracking.getStatsByDay(filters);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Erro ao buscar estatísticas por dia:', error);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// Endpoint para estatísticas por país
app.get('/api/analytics/countries', async (req, res) => {
  try {
    const { adId } = req.query;

    const filters = {};
    if (adId) filters.adId = adId;

    const result = await firebaseTracking.getStatsByCountry(filters);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Erro ao buscar estatísticas por país:', error);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// Endpoint completo com geolocalização E horário
app.get('/api/analytics/geolocation', async (req, res) => {
  try {
    const { adId, startDate, endDate, country, hour } = req.query;

    const filters = {};
    if (adId) filters.adId = adId;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    if (country) filters.countryCode = country;
    if (hour !== undefined) filters.hourLocal = parseInt(hour);

    const result = await firebaseTracking.getGeolocationStats(filters);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Erro ao buscar analytics:', error);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// ========== CHAVES DE ATIVAÇÃO (Firebase activation_keys/<KEY>) ==========
// Headers para WebView: sempre JSON e no-store
function setActivationHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'application/json; charset=utf-8');
}

// Diagnóstico: verifica se Firebase Admin está ativo (para testar no APK/navegador)
app.get('/api/activation-keys/status', (req, res) => {
  setActivationHeaders(res);
  res.json({
    success: true,
    activationKeysEnabled: !activationKeys._disabled
  });
});

// ⚠️ ENDPOINT ANTIGO REMOVIDO - Usar GET /api/activation-keys/list com x-admin-token (linha ~1891)
// que retorna array formatado via listKeysFiltered()

// Criar chave (Dashboard): chave como id do nó
app.post('/api/activation-keys', authenticateDashboardToken, async (req, res) => {
  setActivationHeaders(res);
  try {
    const { key } = req.body || {};
    const result = await activationKeys.addKey(key);
    if (result.success) {
      return res.status(201).json({ success: true, key: result.key });
    }
    const status = result.error === 'invalid_key' || result.error === 'duplicate_key' ? 400 : 500;
    return res.status(status).json({
      success: false,
      error: result.error,
      message: result.message || result.error
    });
  } catch (error) {
    console.error('[activation-keys] Erro ao criar chave:', error);
    return res.status(500).json({ success: false, error: 'server_error', message: error.message });
  }
});

// Reivindicar chave (App): busca uma disponível e marca como claimed (deviceId opcional: ?deviceId=xxx)
// Protegido por rate limiting: 5 tentativas por IP a cada 1 minuto
app.get('/api/activation-keys/claim', activationLimiter, async (req, res) => {
  setActivationHeaders(res);
  const origin = req.get('origin') || 'no-origin';
  console.log('[Activation] GET /api/activation-keys/claim | Origin:', origin);

  if (activationKeys._disabled) {
    console.error('[Activation] Servico DESABILITADO - Firebase nao inicializado');
    return res.status(503).json({
      success: false,
      error: 'service_unavailable',
      message: 'Servico de ativacao indisponivel (Firebase nao inicializado)'
    });
  }

  try {
    const deviceId = req.query.deviceId || null;
    const result = await activationKeys.claimKey(deviceId);
    if (result.success) {
      console.log('[Activation] Chave fornecida: ' + result.key);
      return res.json({ success: true, key: result.key });
    }
    const status = result.error === 'no_keys_available' ? 404 : 500;
    console.warn('[Activation] Claim falhou: ' + result.error + ' - ' + result.message);
    return res.status(status).json({
      success: false,
      error: result.error,
      message: result.message || result.error
    });
  } catch (error) {
    console.error('[Activation] Excecao ao reivindicar chave:', error);
    return res.status(500).json({ success: false, error: 'server_error', message: error.message });
  }
});

// Validar e reivindicar chave informada pelo usuário (tela de bloqueio)
// Protegido por rate limiting: 5 tentativas por IP a cada 1 minuto
app.post('/api/activation-keys/validate-and-claim', activationLimiter, async (req, res) => {
  setActivationHeaders(res);
  if (activationKeys._disabled) {
    return res.status(503).json({
      success: false,
      error: 'service_unavailable',
      message: 'Serviço de ativação indisponível'
    });
  }
  try {
    const { key, deviceId } = req.body || {};
    console.log('[Activation] validate-and-claim | chave inserida pelo usuário:', key, '| (tipo:', typeof key, ')');
    // skipLock=true: chave inserida manualmente → desbloqueio imediato sem período de lock
    const result = await activationKeys.claimKeyByValue(key, deviceId || null, true);
    if (result.success) {
      return res.json({ success: true, key: result.key });
    }
    return res.status(400).json({
      success: false,
      error: result.error || 'invalid_key',
      message: result.message || 'Chave inválida'
    });
  } catch (error) {
    console.error('[Activation] validate-and-claim:', error);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Chave inválida' });
  }
});

// Validar chave já reivindicada (Estratégia 1 + 3: Server validation + DeviceId binding)
// Protegido por rate limiting: 10 tentativas por IP a cada 1 minuto
const validationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Muitas tentativas de validação. Tente novamente em 1 minuto.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req),
  skip: (req) => false,
  handler: (req, res) => {
    console.warn(`⚠️ [RateLimit] Muitas tentativas de validação do IP: ${getClientIP(req)}`);
    res.status(429).json({ 
      success: false, 
      error: 'too_many_requests',
      message: 'Muitas tentativas. Aguarde 1 minuto antes de tentar novamente.' 
    });
  }
});

app.post('/api/activation-keys/validate', validationLimiter, async (req, res) => {
  setActivationHeaders(res);
  
  if (activationKeys._disabled) {
    return res.status(503).json({
      success: false,
      error: 'service_unavailable',
      message: 'Serviço de ativação indisponível'
    });
  }

  try {
    const { key, deviceId } = req.body || {};
    
    if (!key) {
      return res.status(400).json({
        success: false,
        error: 'invalid_request',
        message: 'Chave é necessária'
      });
    }

    console.log('[Activation] POST /api/activation-keys/validate | key:', key, '| deviceId:', deviceId || 'não fornecido');

    // Validar chave com servidor (Estratégia 1) + DeviceId binding (Estratégia 3)
    const result = await activationKeys.validateKey(key, deviceId || null);

    // BLOQUEIO: Se chave foi revogada, retornar 403 e detalhe
    if (result.revoked) {
      console.error('[Activation] ❌ BLOQUEADO: Chave foi revogada');
      return res.status(403).json({
        success: false,
        valid: false,
        revoked: true,
        revokeReason: result.revokeReason || 'Chave foi revogada pelo administrador',
        message: `Chave revogada: ${result.revokeReason || 'motivo não especificado'}`
      });
    }

    return res.json({
      success: true,
      valid: result.valid,
      expired: result.expired,
      boundToDevice: result.boundToDevice,
      revoked: false,
      message: result.valid ? 'Chave válida' : 'Chave inválida'
    });
  } catch (error) {
    console.error('[Activation] validate endpoint error:', error);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Erro ao validar chave'
    });
  }
});

// ========== ENDPOINT DE REVOGAÇÃO DE CHAVES ==========

/**
 * POST /api/activation-keys/revoke - Revoga uma chave (admin)
 * Marca a chave como 'revoked' no Firebase, bloqueando acesso imediatamente
 * Quando app tentar validar com POST /validate, será rejeitado
 */
app.post('/api/activation-keys/revoke', async (req, res) => {
  // ⚠️ IMPORTANTE: Adicione autenticação em produção!
  const adminToken = req.headers['x-admin-token'];
  const expectedToken = process.env.ADMIN_TOKEN || 'admin-token-2026';
  
  if (adminToken !== expectedToken) {
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Token de admin inválido ou não fornecido'
    });
  }

  try {
    const { key, reason = 'admin_revoke' } = req.body || {};
    
    if (!key || typeof key !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'invalid_request',
        message: 'Chave é necessária (campo: key)'
      });
    }

    console.log(`[Revoke] Revogando chave: ${key} | Motivo: ${reason}`);
    const result = await activationKeys.revokeKey(key, reason);

    if (result.success) {
      console.log(`[Revoke] ✅ Chave revogada com sucesso: ${key}`);
      return res.json({
        success: true,
        message: result.message,
        revokedAt: new Date().toISOString()
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'revoke_failed',
        message: result.message
      });
    }
  } catch (error) {
    console.error('[Revoke] Erro ao revogar chave:', error);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Erro ao revogar chave'
    });
  }
});

/**
 * POST /api/activation-keys/reset/:key - Redefinir uma chave para 'available' (admin)
 * Reseta uma chave reclamada/usada, permitindo que seja usada novamente
 * Remove deviceId, claimedAt, lockedUntil e retorna status para 'available'
 */
app.post('/api/activation-keys/reset/:key', async (req, res) => {
  // ⚠️ IMPORTANTE: Adicione autenticação em produção!
  const adminToken = req.headers['x-admin-token'];
  const expectedToken = process.env.ADMIN_TOKEN || 'admin-token-2026';
  
  if (adminToken !== expectedToken) {
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Token de admin inválido ou não fornecido'
    });
  }

  try {
    const { key } = req.params;
    
    if (!key) {
      return res.status(400).json({
        success: false,
        error: 'invalid_request',
        message: 'Chave é necessária na URL'
      });
    }

    console.log(`[Reset] Redefinindo chave: ${key}`);
    const result = await activationKeys.resetKey(key);

    if (result.success) {
      console.log(`[Reset] ✅ Chave redefinida com sucesso: ${key}`);
      return res.json({
        success: true,
        message: result.message,
        resetedAt: new Date().toISOString()
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'reset_failed',
        message: result.message
      });
    }
  } catch (error) {
    console.error('[Reset] Erro ao redefinir chave:', error);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Erro ao redefinir chave'
    });
  }
});

// ========== ENDPOINTS DE BLOQUEIO DE CHAVES (DASHBOARD) ==========

// ========== BLOQUEIO DE CHAVES (Admin) ==========

/**
 * POST /api/activation-keys/lock/:key - Bloqueia uma chave (admin)
 * Impede acesso à chave por um período especificado
 * Body: { durationMinutes: 5 } (opcional, padrão 5)
 */
app.post('/api/activation-keys/lock/:key', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  const adminTokenEnv = process.env.ADMIN_TOKEN;
  const expectedToken = adminTokenEnv || 'admin-token-2026';
  
  // 🔍 Debug completo
  console.log(`[Lock] ADMIN_TOKEN Process Environment:`, {
    'process.env.ADMIN_TOKEN': adminTokenEnv,
    'process.env.ADMIN_TOKEN is set': !!adminTokenEnv,
    'fallback applied': !adminTokenEnv
  });
  
  console.log(`[Lock] Token validation:`, {
    received: adminToken,
    expected: expectedToken,
    match: adminToken === expectedToken,
    receivedLength: adminToken ? adminToken.length : 0,
    expectedLength: expectedToken.length,
    received_bytes: adminToken ? Buffer.from(adminToken).toString('hex') : 'undefined',
    expected_bytes: Buffer.from(expectedToken).toString('hex')
  });
  
  if (adminToken !== expectedToken) {
    console.warn(`[Lock] Unauthorized: token mismatch`);
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Token de admin inválido ou não fornecido'
    });
  }

  try {
    const { key } = req.params;
    const { durationMinutes = 5 } = req.body || {};

    if (!key) {
      return res.status(400).json({
        success: false,
        error: 'invalid_request',
        message: 'Chave é necessária na URL'
      });
    }

    console.log(`[Lock] Bloqueando chave: ${key} | Duração: ${durationMinutes} minutos`);

    const result = await activationKeys.lockKey(key, durationMinutes);

    if (!result.success) {
      const status = result.error === 'not_found' ? 404 : 400;
      return res.status(status).json({
        success: false,
        error: result.error,
        message: `Erro ao bloquear chave: ${result.error}`
      });
    }

    return res.json({
      success: true,
      key: key.toUpperCase(),
      lockedUntil: result.lockedUntil,
      minutesLeft: result.minutesLeft,
      message: `Chave bloqueada por ${durationMinutes} minutos`
    });
  } catch (error) {
    console.error('[Lock] Erro ao bloquear chave:', error);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Erro ao bloquear chave'
    });
  }
});

/**
 * POST /api/activation-keys/unlock/:key - Desbloqueia uma chave (admin)
 * Remove o bloqueio de uma chave
 */
app.post('/api/activation-keys/unlock/:key', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  const expectedToken = process.env.ADMIN_TOKEN || 'admin-token-2026';
  
  console.log(`[Unlock] Token validation:`, {
    received: adminToken,
    expected: expectedToken,
    match: adminToken === expectedToken
  });
  
  if (adminToken !== expectedToken) {
    console.warn(`[Unlock] Unauthorized: token mismatch`);
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Token de admin inválido ou não fornecido'
    });
  }

  try {
    const { key } = req.params;

    if (!key) {
      return res.status(400).json({
        success: false,
        error: 'invalid_request',
        message: 'Chave é necessária na URL'
      });
    }

    console.log(`[Unlock] Desbloqueando chave: ${key}`);

    const result = await activationKeys.unlockKey(key);

    if (!result.success) {
      const status = result.error === 'not_found' ? 404 : 400;
      return res.status(status).json({
        success: false,
        error: result.error,
        message: `Erro ao desbloquear chave: ${result.error}`
      });
    }

    return res.json({
      success: true,
      key: key.toUpperCase(),
      message: 'Chave desbloqueada com sucesso'
    });
  } catch (error) {
    console.error('[Unlock] Erro ao desbloquear chave:', error);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Erro ao desbloquear chave'
    });
  }
});

/**
 * GET /api/activation-keys/lock-status/:key - Verifica status de bloqueio (admin)
 * Retorna se a chave está bloqueada e quanto tempo falta
 */
app.get('/api/activation-keys/lock-status/:key', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  const expectedToken = process.env.ADMIN_TOKEN || 'admin-token-2026';
  
  console.log(`[LockStatus] Token validation:`, {
    received: adminToken,
    expected: expectedToken,
    match: adminToken === expectedToken
  });
  
  if (adminToken !== expectedToken) {
    console.warn(`[LockStatus] Unauthorized: token mismatch`);
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Token de admin inválido ou não fornecido'
    });
  }

  try {
    const { key } = req.params;

    if (!key) {
      return res.status(400).json({
        success: false,
        error: 'invalid_request',
        message: 'Chave é necessária na URL'
      });
    }

    const result = await activationKeys.getKeyLockStatus(key);

    if (!result.success) {
      const status = result.error === 'not_found' ? 404 : 400;
      return res.status(status).json({
        success: false,
        error: result.error,
        message: `Erro ao verificar bloqueio: ${result.error}`
      });
    }

    return res.json({
      success: true,
      key: key.toUpperCase(),
      locked: result.locked,
      lockedUntil: result.lockedUntil || null,
      minutesLeft: result.minutesLeft || 0,
      lockedAt: result.lockedAt || null,
      lockedBy: result.lockedBy || null
    });
  } catch (error) {
    console.error('[LockStatus] Erro ao verificar bloqueio:', error);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Erro ao verificar bloqueio'
    });
  }
});

// ========== ENDPOINT DE LISTAGEM DE CHAVES (DASHBOARD) ==========

/**
 * DEBUG: GET /api/activation-keys/debug - Mostra config do token (sem autenticação)
 * Útil para verificar qual token o servidor espera
 */
app.get('/api/activation-keys/debug', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  const adminTokenEnv = process.env.ADMIN_TOKEN;
  const expectedToken = adminTokenEnv || 'admin-token-2026';
  
  console.log(`[Debug] Token info requested`);
  
  res.json({
    success: true,
    debug: {
      'ADMIN_TOKEN environment': adminTokenEnv || 'não setado',
      'fallback used': !adminTokenEnv,
      'expected token': expectedToken,
      'token received in header': adminToken || 'não recebido',
      'tokens match': adminToken === expectedToken,
      'node env': process.env.NODE_ENV || 'development'
    }
  });
});

/**
 * GET /api/activation-keys/list - Lista chaves com filtros (admin)
 * Query params: status (all|available|claimed|revoked), includeExpired (true|false)
 */
app.get('/api/activation-keys/list', validationLimiter, async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  const adminTokenEnv = process.env.ADMIN_TOKEN;
  const expectedToken = adminTokenEnv || 'admin-token-2026';
  
  // 🔍 Debug completo
  console.log(`[List] ADMIN_TOKEN Process Environment:`, {
    'process.env.ADMIN_TOKEN': adminTokenEnv,
    'process.env.ADMIN_TOKEN is set': !!adminTokenEnv,
    'fallback applied': !adminTokenEnv
  });
  
  console.log(`[List] Token validation:`, {
    received: adminToken,
    expected: expectedToken,
    match: adminToken === expectedToken,
    receivedLength: adminToken ? adminToken.length : 0,
    expectedLength: expectedToken.length,
    received_bytes: adminToken ? Buffer.from(adminToken).toString('hex') : 'undefined',
    expected_bytes: Buffer.from(expectedToken).toString('hex')
  });
  
  if (adminToken !== expectedToken) {
    console.warn(`[List] Unauthorized: token mismatch`);
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Token de admin inválido'
    });
  }

  if (activationKeys._disabled) {
    return res.status(503).json({
      success: false,
      error: 'service_unavailable',
      message: 'Serviço de ativação indisponível'
    });
  }

  try {
    const status = (req.query.status || 'all').toLowerCase();
    const includeExpired = req.query.includeExpired === 'true';

    console.log(`[List] Listando chaves com status: ${status}`);

    const result = await activationKeys.listKeysFiltered(status, includeExpired);

    return res.json({
      success: result.success,
      keys: result.keys || [],
      total: result.total || 0,
      byStatus: result.byStatus || {},
      message: `${result.total || 0} chaves encontradas`
    });
  } catch (error) {
    console.error('[List] Erro ao listar chaves:', error);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Erro ao listar chaves'
    });
  }
});

// ========== ENDPOINT DE EXPORTAÇÃO DE CHAVES (DASHBOARD) ==========

/**
 * GET /api/activation-keys/export - Exporta chaves em CSV (admin)
 * Query params: status (available|claimed|revoked), format (csv|json)
 */
app.get('/api/activation-keys/export', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  const expectedToken = process.env.ADMIN_TOKEN || 'admin-token-2026';
  
  if (adminToken !== expectedToken) {
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Token de admin inválido'
    });
  }

  if (activationKeys._disabled) {
    return res.status(503).json({
      success: false,
      error: 'service_unavailable',
      message: 'Serviço de ativação indisponível'
    });
  }

  try {
    const status = (req.query.status || 'available').toLowerCase();
    const format = (req.query.format || 'csv').toLowerCase();

    console.log(`[Export] Exportando chaves com status: ${status} (formato: ${format})`);

    const result = await activationKeys.exportKeysCSV(status);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: 'export_failed',
        message: 'Erro ao exportar chaves'
      });
    }

    if (format === 'json') {
      // Converter CSV para JSON
      const lines = result.csv.split('\n');
      const headers = lines[0].split(',').map(h => h.replace(/"/g, ''));
      const data = lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.replace(/"/g, ''));
        const obj = {};
        headers.forEach((h, i) => obj[h] = values[i]);
        return obj;
      });

      return res.json({
        success: true,
        format: 'json',
        count: result.count,
        data
      });
    } else {
      // Retornar como CSV (download)
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="chaves-${status}-${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(result.csv);
    }
  } catch (error) {
    console.error('[Export] Erro ao exportar chaves:', error);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Erro ao exportar chaves'
    });
  }
});

// ========== ENDPOINT DE MIGRAÇÃO ==========

// Endpoint para migrar dados antigos (adicionar geolocalização retroativa)
app.post('/api/admin/migrate-geolocation', async (req, res) => {
  try {
    // Verificar autenticação (usar token simples ou variável de ambiente)
    const authToken = req.headers['x-admin-token'];
    const expectedToken = process.env.ADMIN_TOKEN || 'migration-token-2026';
    
    if (authToken !== expectedToken) {
      return res.status(401).json({ 
        success: false, 
        error: 'Não autorizado. Forneça header x-admin-token.' 
      });
    }

    console.log('🔄 Iniciando migração de geolocalização...');
    
    // Buscar todos os registros do Firebase
    const { data } = await firebaseTracking.getTracking({ limit: 10000 });
    console.log(`📊 Total de registros encontrados: ${data.length}`);
    
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const item of data) {
      // Pular se já tem countryCode
      if (item.countryCode || item.country_code) {
        skipped++;
        continue;
      }
      
      // Tentar geolocalizar usando IP
      const ip = item.ipAddress || item.ip_address;
      if (!ip || ip === 'unknown' || ip === '::1' || ip === '127.0.0.1' || 
          ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) {
        skipped++;
        continue;
      }
      
      // Obter geolocalização
      const geo = ipGeoService.getLocationByIP(ip);
      
      if (geo.success) {
        const updateData = {
          countryCode: geo.country_code,
          countryName: geo.country_name,
          region: geo.region,
          city: geo.city,
          latitude: geo.latitude,
          longitude: geo.longitude,
          timezone: geo.timezone,
          geoSource: 'migration' // Marcar como migrado
        };
        
        try {
          const result = await firebaseTracking.updateTracking(item.id, updateData);
          if (result.success) {
            updated++;
            if (updated % 10 === 0) {
              console.log(`✅ Progresso: ${updated} atualizados, ${skipped} ignorados, ${errors} erros`);
            }
          } else {
            errors++;
            console.error(`❌ Erro ao atualizar ${item.id}:`, result.error);
          }
        } catch (err) {
          errors++;
          console.error(`❌ Erro ao atualizar ${item.id}:`, err.message);
        }
      } else {
        skipped++;
      }
      
      // Pequeno delay para não sobrecarregar
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    console.log('\n📊 Resumo da migração:');
    console.log(`   ✅ Atualizados: ${updated}`);
    console.log(`   ⏭️  Ignorados: ${skipped}`);
    console.log(`   ❌ Erros: ${errors}`);
    
    res.json({
      success: true,
      stats: {
        total: data.length,
        updated,
        skipped,
        errors
      },
      message: `Migração concluída: ${updated} registros atualizados com geolocalização`
    });
  } catch (error) {
    console.error('❌ Erro na migração:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: 'Erro ao executar migração. Verifique os logs do servidor.'
    });
  }
});

// ========== PAK KEY ENDPOINT ==========

/**
 * Middleware: valida Firebase App Check token (header X-Firebase-AppCheck)
 * Apenas APKs assinados com o keystore correto (Play Integrity) conseguem um token válido.
 * Não requer login do usuário — funciona na inicialização sem autenticação.
 */
const requireAppCheck = async (req, res, next) => {
  const appCheckToken = req.headers['x-firebase-appcheck'];

  if (!appCheckToken) {
    console.warn('⚠️ [PakKey] Requisição sem X-Firebase-AppCheck header - PERMITINDO (Modo Debug/Unenforced)');
    // return res.status(401).json({ success: false, error: 'unauthorized', message: 'App Check token obrigatório' });
    return next(); // Pula a verificação se o token estiver ausente
  }

  try {
    // Reutiliza a app Firebase já inicializada pelo FirebaseTrackingService ('ad-tracking')
    let fbApp;
    try {
      fbApp = admin.app('ad-tracking');
    } catch (appErr) {
      console.error('❌ [PakKey] Firebase app "ad-tracking" não encontrada:', appErr.message);
      return res.status(500).json({ success: false, error: 'server_misconfiguration', message: 'Firebase não inicializado no servidor' });
    }

    const decodedToken = await fbApp.appCheck().verifyToken(appCheckToken);
    req.appCheckToken = decodedToken;
    next();
  } catch (err) {
    console.warn('⚠️ [PakKey] App Check token inválido:', err.code, '-', err.message);
    return res.status(403).json({ success: false, error: 'forbidden', message: 'App Check token inválido ou expirado' });
  }
};

/**
 * Rate limit específico para /api/pak-key
 * - Máximo 10 requisições por IP a cada 5 minutos
 */
const pakKeyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIP(req),
  handler: (req, res) => {
    console.warn(`⚠️ [PakKey] Rate limit excedido: ${getClientIP(req)}`);
    res.status(429).json({ success: false, error: 'too_many_requests', message: 'Muitas requisições. Tente novamente em 5 minutos.' });
  }
});

/**
 * POST /api/pak-key
 * Retorna a chave AES do assets.pak.enc apenas para usuários autenticados via Firebase.
 * A chave é lida de PAK_AES_KEY_HEX (variável de ambiente — nunca commitar no repo).
 */
app.post('/api/pak-key', pakKeyLimiter, requireAppCheck, (req, res) => {
  const hexKey = process.env.PAK_AES_KEY_HEX;

  if (!hexKey) {
    console.error('❌ [PakKey] PAK_AES_KEY_HEX não configurado no environment!');
    return res.status(500).json({ success: false, error: 'server_misconfiguration', message: 'Chave PAK não configurada no servidor' });
  }

  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    console.error('❌ [PakKey] PAK_AES_KEY_HEX inválida (deve ser 64 hex chars = 32 bytes)');
    return res.status(500).json({ success: false, error: 'server_misconfiguration', message: 'Chave PAK mal configurada no servidor' });
  }

  const keyBase64 = Buffer.from(hexKey, 'hex').toString('base64');
  console.log(`✅ [PakKey] Chave entregue via App Check (sub: ${req.appCheckToken?.sub})`);
  res.json({ success: true, key: keyBase64 });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de anúncios rodando na porta ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`📢 Próximo anúncio: http://localhost:${PORT}/ad/next`);
  
  // 🔐 Show token configuration
  const tokenEnv = process.env.ADMIN_TOKEN;
  const tokenUsed = tokenEnv || 'admin-token-2026';
  console.log(`🔐 ADMIN_TOKEN Configuration:`, {
    'env variable set': !!tokenEnv,
    'value used': tokenUsed,
    'from environment': !!tokenEnv,
    'using fallback': !tokenEnv
  });
  
  if (process.env.ALLOWED_ORIGINS) {
    console.log(`🔒 CORS restrito para: ${allowedOrigins.join(', ')}`);
  } else {
    console.log(`🌐 CORS permitindo todas as origens (ALLOWED_ORIGINS não configurado)`);
  }
  
  console.log(`\n📝 Exemplo de configuração ALLOWED_ORIGINS:`);
  console.log(`   ALLOWED_ORIGINS=http://localhost:3000,capacitor://localhost,http://localhost`);
});

/*
 * ========== TESTES ==========
 * 
 * 1) Local:
 *    - rodar server: npm start
 *    - abrir app em http://localhost:3000
 *    - confirmar que /ad/next responde com header Access-Control-Allow-Origin: http://localhost:3000
 *    - verificar no console: [GET] /ad/next | Origin: http://localhost:3000 | Status: 200
 * 
 * 2) Preflight:
 *    - fazer um POST /track com Content-Type: application/json
 *    - verificar que OPTIONS retorna 204/200 ok
 *    - verificar headers: Access-Control-Allow-Methods, Access-Control-Allow-Headers
 * 
 * 3) Vídeo com Range:
 *    - testar /video/:id com header Range: bytes=0-1023
 *    - confirmar exposed headers: Content-Range, Accept-Ranges, Content-Length
 *    - verificar status 206 (Partial Content)
 * 
 * 4) Produção (Render):
 *    - verificar que trust proxy está configurado
 *    - testar com ALLOWED_ORIGINS definido
 *    - verificar logs de origin e ad.id no /ad/next
 */
