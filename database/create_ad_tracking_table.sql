-- ============================================
-- Tabela para tracking de anúncios com geolocalização
-- ============================================
-- Execute este SQL no seu banco PostgreSQL
-- ============================================

-- Criar tabela ad_tracking
CREATE TABLE IF NOT EXISTS ad_tracking (
  id VARCHAR(255) PRIMARY KEY,
  event VARCHAR(50) NOT NULL, -- 'ad_impression', 'ad_click', 'ad_complete', etc.
  ad_id VARCHAR(255),
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Horário UTC do servidor
  
  -- Horário local do usuário
  local_time TIMESTAMP, -- Horário local convertido
  local_time_string VARCHAR(50), -- Formato legível: "2026-01-30 15:30:00"
  hour_local INTEGER, -- Hora local (0-23)
  day_of_week INTEGER, -- Dia da semana (0=domingo, 6=sábado)
  
  -- Geolocalização por IP
  ip_address VARCHAR(45),
  country_code VARCHAR(2),      -- 'BR', 'US', etc.
  country_name VARCHAR(100),   -- 'Brazil', 'United States'
  region VARCHAR(100),          -- 'São Paulo', 'California'
  city VARCHAR(100),            -- 'São Paulo', 'Los Angeles'
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  timezone VARCHAR(50),         -- 'America/Sao_Paulo'
  
  -- Dados adicionais
  device_info TEXT,
  user_agent TEXT,
  referer TEXT,
  
  -- Dados do evento (JSON para flexibilidade)
  event_data JSONB,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- Índices para consultas eficientes
-- ============================================

CREATE INDEX IF NOT EXISTS idx_tracking_event ON ad_tracking(event);
CREATE INDEX IF NOT EXISTS idx_tracking_ad_id ON ad_tracking(ad_id);
CREATE INDEX IF NOT EXISTS idx_tracking_country ON ad_tracking(country_code);
CREATE INDEX IF NOT EXISTS idx_tracking_ts ON ad_tracking(ts);
CREATE INDEX IF NOT EXISTS idx_tracking_ip ON ad_tracking(ip_address);
CREATE INDEX IF NOT EXISTS idx_tracking_hour_local ON ad_tracking(hour_local);
CREATE INDEX IF NOT EXISTS idx_tracking_day_week ON ad_tracking(day_of_week);
CREATE INDEX IF NOT EXISTS idx_tracking_local_time ON ad_tracking(local_time);

-- ============================================
-- Exemplos de consultas úteis
-- ============================================

-- Ver visualizações por horário do dia (Brasil)
-- SELECT 
--   hour_local,
--   COUNT(*) as total,
--   COUNT(CASE WHEN event = 'ad_click' THEN 1 END) as clicks
-- FROM ad_tracking
-- WHERE country_code = 'BR'
-- GROUP BY hour_local
-- ORDER BY hour_local;

-- Ver horários de pico por país
-- SELECT 
--   country_name,
--   hour_local,
--   COUNT(*) as impressions
-- FROM ad_tracking
-- GROUP BY country_name, hour_local
-- ORDER BY impressions DESC
-- LIMIT 20;

-- Ver distribuição por dia da semana
-- SELECT 
--   CASE day_of_week
--     WHEN 0 THEN 'Domingo'
--     WHEN 1 THEN 'Segunda'
--     WHEN 2 THEN 'Terça'
--     WHEN 3 THEN 'Quarta'
--     WHEN 4 THEN 'Quinta'
--     WHEN 5 THEN 'Sexta'
--     WHEN 6 THEN 'Sábado'
--   END as dia,
--   COUNT(*) as total
-- FROM ad_tracking
-- GROUP BY day_of_week
-- ORDER BY day_of_week;

-- Ver estatísticas por país
-- SELECT 
--   country_name,
--   COUNT(*) as total_impressions,
--   COUNT(DISTINCT ip_address) as unique_users,
--   COUNT(CASE WHEN event = 'ad_click' THEN 1 END) as clicks
-- FROM ad_tracking
-- WHERE country_code IS NOT NULL
-- GROUP BY country_name
-- ORDER BY total_impressions DESC;
