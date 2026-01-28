import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;

// CORS configurável via variável de ambiente
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

if (allowedOrigins.length > 0) {
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true
  }));
}

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

// Função para construir URL completa
function buildAssetUrl(req, assetPath) {
  const protocol = req.protocol;
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
  const mainAsset = ad.type === 'video' 
    ? `${req.protocol}://${req.get('host')}/video/${ad.id}`
    : `${req.protocol}://${req.get('host')}/imagem/${ad.id}`;
  
  const fallbackAsset = `${req.protocol}://${req.get('host')}/imagem/${ad.id}`;
  
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
});
