import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;

// Trust proxy para produção (Render, etc)
app.set('trust proxy', 1);

// CORS configurável via variável de ambiente
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

// Função para verificar se origin é permitida
function isAllowedOrigin(origin) {
  // Se origin for undefined (curl, server-to-server), permitir
  if (!origin) {
    return true;
  }
  
  // Se ALLOWED_ORIGINS definido: permitir apenas se origin estiver na lista
  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin);
  }
  
  // Se ALLOWED_ORIGINS não definido: permitir tudo (modo dev)
  return true;
}

// Configuração CORS
const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
  credentials: false,
  maxAge: 86400
};

// Aplicar CORS globalmente (sempre habilitado)
app.use(cors(corsOptions));
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

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Obter próximo anúncio
app.get('/ad/next', (req, res) => {
  res.set('Cache-Control', 'no-store');
  
  const ad = getNextAd();
  if (!ad) {
    return res.status(404).json({ error: 'Nenhum anúncio disponível' });
  }
  
  // Determinar asset principal baseado no tipo
  const protocol = getProtocol(req);
  const host = req.get('host');
  const mainAsset = ad.type === 'video' 
    ? `${protocol}://${host}/video/${ad.id}`
    : `${protocol}://${host}/imagem/${ad.id}`;
  
  const fallbackAsset = `${protocol}://${host}/imagem/${ad.id}`;
  
  // Log do anúncio escolhido e origin
  const origin = req.get('origin') || 'no-origin';
  console.log(`[AD] Anúncio escolhido: ${ad.id} | Origin: ${origin}`);
  
  res.json({
    id: ad.id,
    type: ad.type,
    src: mainAsset,
    fallbackSrc: fallbackAsset,
    clickUrl: ad.clickUrl,
    minSeconds: ad.minSeconds,
    maxSeconds: ad.maxSeconds,
    allowSkipAfter: ad.allowSkipAfter,
    muteByDefault: ad.muteByDefault
  });
});

// Servir imagem
app.get('/imagem/:id', (req, res) => {
  const adId = req.params.id;
  const ad = ads.find(a => a.id === adId);
  
  if (!ad) {
    return res.status(404).json({ error: 'Anúncio não encontrado' });
  }
  
  const imagePath = path.join(__dirname, ad.imagePath);
  
  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ error: 'Imagem não encontrada' });
  }
  
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Content-Type', 'image/jpeg');
  res.set('Content-Disposition', 'inline');
  
  const imageStream = fs.createReadStream(imagePath);
  imageStream.pipe(res);
});

// Servir vídeo com suporte a HTTP Range
app.get('/video/:id', (req, res) => {
  const adId = req.params.id;
  const ad = ads.find(a => a.id === adId);
  
  if (!ad) {
    return res.status(404).json({ error: 'Anúncio não encontrado' });
  }
  
  const videoPath = path.join(__dirname, ad.videoPath);
  
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Vídeo não encontrado' });
  }
  
  const stat = fs.statSync(videoPath);
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
    const file = fs.createReadStream(videoPath, { start, end });
    
    res.status(206); // Partial Content
    res.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.set('Content-Length', chunksize);
    res.set('Content-Type', 'video/mp4');
    
    file.pipe(res);
  } else {
    // Sem Range header, enviar vídeo completo
    res.set('Content-Length', fileSize);
    res.set('Content-Type', 'video/mp4');
    
    const file = fs.createReadStream(videoPath);
    file.pipe(res);
  }
});

// Tracking de eventos
app.post('/track', (req, res) => {
  res.set('Cache-Control', 'no-store');
  
  try {
    const trackingData = {
      event: req.body.event || 'unknown',
      ts: req.body.ts || new Date().toISOString(),
      adId: req.body.adId || null,
      watchedMs: req.body.watchedMs || 0,
      ...req.body
    };
    
    logTracking(trackingData);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao processar tracking:', error);
    res.status(500).json({ error: 'Erro ao processar tracking' });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de anúncios rodando na porta ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`📢 Próximo anúncio: http://localhost:${PORT}/ad/next`);
  
  if (allowedOrigins.length > 0) {
    console.log(`🔒 CORS restrito para: ${allowedOrigins.join(', ')}`);
  } else {
    console.log(`🌐 CORS permitindo todas as origens (modo dev)`);
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
