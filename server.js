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

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
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
  
  // URL da imagem do Google Drive (convertida para link direto)
  const imageUrl = 'https://drive.google.com/uc?export=view&id=1fPU_2vU-6jvHpevpFmBc4A6dsT8FdLv3';
  
  // URL de clique do anúncio
  const clickUrl = ad.clickUrl || '#';
  
  // Log do anúncio escolhido e origin
  const origin = req.get('origin') || 'no-origin';
  console.log(`[AD] Anúncio HTML escolhido: ${ad.id} | Origin: ${origin}`);
  
  // HTML do comercial
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Descubra o Melhor Entretenimento</title>
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
    }
    
    .ad-container {
      max-width: 650px;
      width: 100%;
      background: rgba(255, 255, 255, 0.98);
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 25px 70px rgba(0, 0, 0, 0.35);
      animation: fadeInUp 0.9s ease-out;
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
    }
    
    .ad-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.5s ease;
    }
    
    .ad-image:hover {
      transform: scale(1.05);
    }
    
    .ad-content {
      padding: 35px;
      color: #333;
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
      text-align: justify;
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
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
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
    
    @media (max-width: 600px) {
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
  </style>
</head>
<body>
  <div class="ad-container">
    <div class="ad-image-wrapper">
      <img src="${imageUrl}" alt="Entretenimento Premium" class="ad-image" />
    </div>
    <div class="ad-content">
      <h1 class="ad-title">🎬 Transforme Seu Entretenimento</h1>
      <p class="ad-subtitle">A experiência cinematográfica que você sempre sonhou está ao seu alcance</p>
      
      <div class="ad-highlight">
        ✨ Milhares de Filmes e Séries Esperando por Você ✨
      </div>
      
      <p class="ad-description">
        Descubra um mundo de entretenimento sem limites! Nossa plataforma oferece o melhor conteúdo 
        para você assistir quando e onde quiser. Qualidade premium, sem complicações. 
        Transforme cada momento em uma experiência inesquecível.
      </p>
      
      <ul class="ad-features">
        <li>Catálogo exclusivo com milhares de títulos</li>
        <li>Qualidade HD e 4K Ultra disponível</li>
        <li>Assista offline quando quiser</li>
        <li>Sem interrupções durante os filmes</li>
        <li>Interface intuitiva e moderna</li>
        <li>Atualizações semanais de conteúdo</li>
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
