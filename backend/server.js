import dotenv from 'dotenv';
dotenv.config({ override: true });
// ═══════════════════════════════════════════════════════════════════
// SERVIDOR API — CashbackDO
// Express + CORS + Cron job diario a las 6am
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runScraper, runCardCatalogScraper, recategorizePromos } from './scraper.js';
import { redisGet } from './redis.js';

const app = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.resolve(__dirname, '../data');
const DATA_FILE  = path.join(DATA_DIR, 'promos.json');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const SEED_CARDS = path.resolve(__dirname, '../seeds/cards.json');

app.use(cors());
app.use(express.json());

// ───────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────

async function readData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    // Archivo no existe (deploy fresco) — intentar restaurar desde Redis
    const saved = await redisGet('promos');
    if (saved) {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(DATA_FILE, JSON.stringify(saved, null, 2)).catch(() => {});
      console.log('📥 Datos restaurados desde Redis');
      return saved;
    }
    return { promos: [], lastUpdated: null, stats: {}, scrapeHistory: [] };
  }
}

let scrapeInProgress = false;

// ───────────────────────────────────────────────────────────────────
// CRON JOB — Scraping diario a las 6:00 AM (hora RD)
// ───────────────────────────────────────────────────────────────────

cron.schedule('0 6 * * *', async () => {
  if (scrapeInProgress) {
    console.log('⚠️  Scrape ya en progreso, saltando...');
    return;
  }
  console.log('⏰ Cron job disparado — scraping diario iniciando...');
  scrapeInProgress = true;
  try {
    await runScraper();
  } catch (err) {
    console.error('❌ Error en cron scrape:', err);
  } finally {
    scrapeInProgress = false;
  }
}, { timezone: 'America/Santo_Domingo' });

// Actualiza catálogo de tarjetas el 1ro de cada mes a las 3 AM
cron.schedule('0 3 1 * *', async () => {
  console.log('⏰ Cron mensual — actualizando catálogo de tarjetas...');
  try {
    await runCardCatalogScraper();
    console.log('✅ Catálogo de tarjetas actualizado');
  } catch (err) {
    console.error('❌ Error actualizando catálogo de tarjetas:', err);
  }
}, { timezone: 'America/Santo_Domingo' });

// ───────────────────────────────────────────────────────────────────
// RUTAS API
// ───────────────────────────────────────────────────────────────────

// GET /api/promos — todas las promos con filtros opcionales
app.get('/api/promos', async (req, res) => {
  try {
    const data = await readData();
    let { promos } = data;

    const { bank, status, category, cardType, days } = req.query;

    // Filtro por banco
    if (bank) {
      promos = promos.filter(p => p.bankId === bank || p.bank?.toLowerCase() === bank.toLowerCase());
    }

    // Filtro por status
    if (status === 'active') promos = promos.filter(p => p.isActive);
    if (status === 'upcoming') promos = promos.filter(p => p.isUpcoming);
    if (status === 'expired') promos = promos.filter(p => !p.isActive && !p.isUpcoming);
    if (status === 'next15') {
      promos = promos.filter(p => p.isActive || (p.isUpcoming && p.daysUntilStart <= 15));
    }

    // Filtro por categoría
    if (category) {
      promos = promos.filter(p => p.categories?.includes(category));
    }

    // Filtro por tipo de tarjeta
    if (cardType) {
      promos = promos.filter(p => p.cardTypes?.includes(cardType));
    }

    // Solo próximos N días
    if (days) {
      const n = parseInt(days);
      promos = promos.filter(p => {
        if (p.isActive) return true;
        if (p.isUpcoming && p.daysUntilStart <= n) return true;
        return false;
      });
    }

    res.json({
      promos,
      meta: {
        total: promos.length,
        lastUpdated: data.lastUpdated,
        stats: data.stats,
      }
    });
  } catch (err) {
    console.error('❌ Error en /api/promos:', err.message);
    res.status(500).json({ error: 'Error cargando promos', detail: err.message });
  }
});

// GET /api/promos/:id — una promo específica
app.get('/api/promos/:id', async (req, res) => {
  try {
    const data = await readData();
    const promo = data.promos.find(p => p.id === req.params.id);
    if (!promo) return res.status(404).json({ error: 'Promo no encontrada' });
    res.json(promo);
  } catch (err) {
    console.error('❌ Error en /api/promos/:id:', err.message);
    res.status(500).json({ error: 'Error cargando promo', detail: err.message });
  }
});

// GET /api/stats — estadísticas generales
app.get('/api/stats', async (req, res) => {
  try {
    const data = await readData();
    const { promos, lastUpdated, stats, scrapeHistory } = data;

    const byBank = {};
    promos.forEach(p => {
      if (!byBank[p.bank]) byBank[p.bank] = { total: 0, active: 0, upcoming: 0 };
      byBank[p.bank].total++;
      if (p.isActive) byBank[p.bank].active++;
      if (p.isUpcoming) byBank[p.bank].upcoming++;
    });

    res.json({
      lastUpdated,
      stats,
      byBank,
      scrapeHistory: scrapeHistory?.slice(0, 10),
      nextScrape: getNextCronTime(),
    });
  } catch (err) {
    console.error('❌ Error en /api/stats:', err.message);
    res.status(500).json({ error: 'Error cargando stats', detail: err.message });
  }
});

// GET /api/card-catalog — catálogo de tarjetas por banco
app.get('/api/card-catalog', async (req, res) => {
  try {
    const raw = await fs.readFile(CARDS_FILE, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.json({});
  }
});

// PUT /api/card-catalog — update card catalog (admin only)
app.put('/api/card-catalog', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const catalog = req.body;
    if (!catalog || typeof catalog !== 'object' || Object.keys(catalog).length === 0) {
      return res.status(400).json({ error: 'Invalid catalog data' });
    }
    await fs.writeFile(CARDS_FILE, JSON.stringify(catalog, null, 2), 'utf-8');
    res.json({ ok: true, banks: Object.keys(catalog).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/banks — lista de bancos disponibles
app.get('/api/banks', async (req, res) => {
  try {
    const { BANK_SOURCES } = await import('./sources.js');
    const data = await readData();

    const banks = BANK_SOURCES.map(b => ({
      id: b.id,
      name: b.name,
      color: b.color,
      promoCount: data.promos.filter(p => p.bankId === b.id).length,
      activeCount: data.promos.filter(p => p.bankId === b.id && p.isActive).length,
    }));

    res.json(banks);
  } catch (err) {
    console.error('❌ Error en /api/banks:', err.message);
    res.status(500).json({ error: 'Error cargando banks', detail: err.message });
  }
});

// POST /api/match-wallet — dadas las tarjetas del usuario, retorna promos que aplican
// Acepta formato nuevo { bankId, cardId, name, type } y antiguo { bank, name, tipo }
app.post('/api/match-wallet', async (req, res) => {
  try {
    const { cards } = req.body;
    if (!cards || !Array.isArray(cards)) {
      return res.status(400).json({ error: 'Envía un array de cards' });
    }

    const data = await readData();
    const activeAndUpcoming = data.promos.filter(p => p.isActive || p.isUpcoming);

    const matches = cards.map(card => {
      // Normalizar: soporte para formato nuevo (bankId) y antiguo (bank)
      const bankId = card.bankId || card.bank?.toLowerCase().replace(/\s+/g, '');
      const bankName = card.bank || card.name;
      const cardType = card.type || card.tipo;
      const cardName = card.name;

      const matchingPromos = activeAndUpcoming.filter(promo => {
        // Matching por bankId exacto (nuevo) o por nombre de banco (antiguo)
        const bankMatch = promo.bankId === bankId ||
                          promo.bank?.toLowerCase().includes(bankName?.toLowerCase()) ||
                          promo.bankId === bankName?.toLowerCase();
        if (!bankMatch) return false;

        // Verificar tipo de tarjeta
        if (cardType && promo.cardTypes?.length > 0) {
          if (!promo.cardTypes.includes(cardType)) return false;
        }

        return true;
      });

      return {
        card,
        promos: matchingPromos,
        promoCount: matchingPromos.length,
      };
    });

    res.json({ matches });
  } catch (err) {
    console.error('❌ Error en /api/match-wallet:', err.message);
    res.status(500).json({ error: 'Error en match-wallet', detail: err.message });
  }
});

// POST /api/nearby — dado lat/lng, retorna promos con comercios cercanos
app.post('/api/nearby', async (req, res) => {
  try {
    const { lat, lng, radiusKm = 2 } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'Envía lat y lng' });

    const data = await readData();
    const active = data.promos.filter(p => p.isActive);

    // Nota: Para geolocalización real necesitarías una base de datos de
    // coordenadas de cada comercio. Por ahora retornamos promos activas
    // con establecimientos físicos (presenciales).
    const nearbyPromos = active.filter(p =>
      p.categories?.includes('presencial') ||
      p.categories?.includes('supermercado') ||
      p.categories?.includes('restaurante')
    );

    res.json({
      lat, lng, radiusKm,
      promos: nearbyPromos,
      note: 'Para geolocalización exacta, integra Google Places API con los establecimientos de cada promo'
    });
  } catch (err) {
    console.error('❌ Error en /api/nearby:', err.message);
    res.status(500).json({ error: 'Error en nearby', detail: err.message });
  }
});

// POST /api/scrape — disparar scrape manual (protegido con API key)
app.post('/api/scrape', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (scrapeInProgress) {
    return res.status(409).json({ error: 'Scrape ya en progreso', scrapeInProgress: true });
  }

  const { banks } = req.body; // opcional: array de bank IDs específicos

  res.json({ message: 'Scrape iniciado en background', banks: banks || 'todos' });

  // Ejecutar en background
  scrapeInProgress = true;
  runScraper(banks).catch(console.error).finally(() => {
    scrapeInProgress = false;
  });
});

// POST /api/recategorize — re-categoriza promos existentes con keyword matching (sin re-scrapear)
app.post('/api/recategorize', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const result = await recategorizePromos();
    res.json({ message: 'Re-categorización completa', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scrape-cards — actualizar catálogo de tarjetas (protegido con API key)
app.post('/api/scrape-cards', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  res.json({ message: 'Card catalog scrape iniciado en background' });
  runCardCatalogScraper().catch(console.error);
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    scrapeInProgress,
    time: new Date().toISOString(),
    nextScrape: getNextCronTime(),
  });
});

// ───────────────────────────────────────────────────────────────────
// HELPER: calcular próxima ejecución del cron
// ───────────────────────────────────────────────────────────────────

function getNextCronTime() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

// ───────────────────────────────────────────────────────────────────
// INICIO
// ───────────────────────────────────────────────────────────────────

async function seedDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // Always update cards.json from the seed (Docker image) on startup
  // This ensures card catalog changes are deployed with each build
  try {
    await fs.copyFile(SEED_CARDS, CARDS_FILE);
    console.log('🌱 cards.json actualizado desde imagen Docker');
  } catch (err) {
    // Seed file may not exist in dev; check if volume already has one
    try {
      await fs.access(CARDS_FILE);
      console.log('📂 cards.json encontrado en volumen');
    } catch {
      console.warn('⚠️  No se pudo encontrar cards.json:', err.message);
    }
  }
}

seedDataDir().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 CashbackDO API corriendo en http://localhost:${PORT}`);
    console.log(`📅 Scraping diario programado para las 6:00 AM (hora RD)`);
    console.log(`🔑 Configura ANTHROPIC_API_KEY y ADMIN_API_KEY en .env\n`);

    // Scrape inicial al arrancar si no hay datos
    readData().then(data => {
      if (!data.lastUpdated) {
        console.log('📭 Sin datos previos — ejecutando scrape inicial...');
        scrapeInProgress = true;
        runScraper().catch(console.error).finally(() => {
          scrapeInProgress = false;
        });
      } else {
        const hoursAgo = (Date.now() - new Date(data.lastUpdated)) / 3600000;
        console.log(`📦 Datos existentes (hace ${hoursAgo.toFixed(1)}h)`);
        if (hoursAgo > 24) {
          console.log('⚠️  Datos de más de 24h — ejecutando scrape de actualización...');
          scrapeInProgress = true;
          runScraper().catch(console.error).finally(() => {
            scrapeInProgress = false;
          });
        }
      }
    });
  });
});

export default app;
