// ═══════════════════════════════════════════════════════════════════
// SCRAPER PRINCIPAL — CashbackDO
// Extrae PDFs de bases legales de bancos dominicanos y usa Claude
// para parsear los campos clave de cada promoción.
// ═══════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config({ override: true });
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { BANK_SOURCES, EXTRACTION_SCHEMA } from './sources.js';
import { redisSet } from './redis.js';

// Activar plugin stealth: parchea WebGL, canvas, navigator, chrome runtime, etc.
// Necesario para bypassear Incapsula (Popular) y Akamai (Caribe)
puppeteerExtra.use(StealthPlugin());

// Proxy opcional para evadir bloqueos de IP en datacenters (Railway, etc.)
const PROXY_URL = process.env.PROXY_URL || '';
if (PROXY_URL) console.log(`🌐 Proxy activo: ${PROXY_URL.replace(/\/\/.*@/, '//***@')}`);
const axiosProxy = PROXY_URL ? { httpsAgent: new HttpsProxyAgent(PROXY_URL) } : {};

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.resolve(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'promos.json');
const LOG_FILE  = path.join(DATA_DIR, 'scrape_log.json');
const CARD_FILE = path.join(DATA_DIR, 'cards.json');

// URLs de páginas de tarjetas de cada banco para el catalog scraper
const CARD_PAGE_URLS = {
  banreservas: 'https://www.banreservas.com/tarjetas/',
  bhd: 'https://www.bhd.com.do/homepage-personal/tarjetas/',
  scotiabank: 'https://do.scotiabank.com/banca-personal/tarjetas.html',
  blh: 'https://www.blh.com.do/personas/tarjetas/',
  lafise: 'https://www.lafise.com/blrd/tarjetas.html',
  banesco: 'https://www.banesco.com.do/tarjetas/',
  apap: 'https://www.apap.com.do/productos/tarjetas/',
  cibao: 'https://www.cibao.com.do/banca-personal/tarjetas/',
  bancocaribe: 'https://www.bancocaribe.com.do/tarjetas',
  lanacional: 'https://asociacionlanacional.com.do/tarjetas',
  vimenca: 'https://bancovimenca.com/tarjetas',
  promerica: 'https://promerica.com.do/banca-personal/tarjetas/',
  popular: 'https://popular.com.do/personas/tarjetas/',
  bsc: 'https://bsc.com.do/tarjetas',
  ademi: 'https://bancoademi.com.do/tarjetas/',
  qik: 'https://www.qik.do/tarjetas/',
  bdi: 'https://www.bdi.com.do/tarjetas',
};

// Opciones comunes de Puppeteer: usa Chromium del sistema si está disponible
const PUPPETEER_OPTS = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--dns-server=8.8.8.8',
    ...(PROXY_URL ? [`--proxy-server=${PROXY_URL}`] : []),
  ],
  ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
};

// Lanzador unificado: siempre usa puppeteer-extra con stealth
const launchBrowser = () => puppeteerExtra.launch(PUPPETEER_OPTS);

// ───────────────────────────────────────────────────────────────────
// 0. RETRY WRAPPER — reintenta en errores de DNS y timeout
// ───────────────────────────────────────────────────────────────────

async function withRetry(fn, { retries = 2, delayMs = 3000, label = '' } = {}) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = /ERR_NAME_NOT_RESOLVED|TimeoutError|timeout|ECONNREFUSED|ENOTFOUND|ERR_CONNECTION_RESET/i.test(err.message);
      if (isRetryable && attempt <= retries) {
        console.log(`   🔄 Reintento ${attempt}/${retries} para ${label}: ${err.message.substring(0, 60)}`);
        await new Promise(r => setTimeout(r, delayMs * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ───────────────────────────────────────────────────────────────────
// 1. OBTENER LINKS DE PDFs DE UNA PÁGINA
// ───────────────────────────────────────────────────────────────────

async function getPdfLinksFromHtml(url, selector, keywords, excludeKeywords) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CashbackDO/1.0)' },
      ...axiosProxy,
    });
    const $ = cheerio.load(data);
    const links = [];

    $(selector).each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = ($(el).text() + ' ' + href).toLowerCase();

      // Filtrar por keywords relevantes
      const hasKeyword = keywords.some(k => text.includes(k));
      const hasExclude = excludeKeywords.some(k => text.includes(k));

      if (hasKeyword && !hasExclude && href) {
        // Normalizar URL relativa
        const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
        links.push({ url: fullUrl, text: $(el).text().trim() });
      }
    });

    return links;
  } catch (err) {
    console.error(`❌ Error fetching HTML from ${url}:`, err.message);
    return [];
  }
}

async function getPdfLinksFromDynamic(url, selector, keywords, excludeKeywords) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (compatible; CashbackDO/1.0)');
    await withRetry(
      () => page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }),
      { retries: 2, label: url }
    );

    // Esperar a que cargue el contenido
    await new Promise(r => setTimeout(r, 5000));

    const links = await page.evaluate((selector, keywords, excludeKeywords) => {
      const results = [];
      document.querySelectorAll(selector).forEach(el => {
        const href = el.getAttribute('href') || '';
        const text = (el.textContent + ' ' + href).toLowerCase();
        const hasKeyword = keywords.some(k => text.includes(k));
        const hasExclude = excludeKeywords.some(k => text.includes(k));
        if (hasKeyword && !hasExclude && href) {
          results.push({ url: href.startsWith('http') ? href : new URL(href, window.location.href).href, text: el.textContent.trim() });
        }
      });
      return results;
    }, selector, keywords, excludeKeywords);

    return links;
  } catch (err) {
    console.error(`❌ Error with Puppeteer on ${url}:`, err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ───────────────────────────────────────────────────────────────────
// 2. DESCARGAR PDF Y CONVERTIR A BASE64
// ───────────────────────────────────────────────────────────────────

async function downloadPdfAsBase64(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CashbackDO/1.0)' },
      ...axiosProxy,
    });
    const buffer = Buffer.from(response.data);
    return buffer.toString('base64');
  } catch (err) {
    console.error(`❌ Error downloading PDF ${url}:`, err.message);
    return null;
  }
}

// Normaliza la respuesta de Claude: maneja arrays, objetos con keys numéricos, y objetos simples
function normalizeExtractedPromos(data, bankName, sourceUrl, idBase) {
  const stamp = { bank: bankName, sourceUrl, extractedAt: new Date().toISOString() };

  let items;
  if (Array.isArray(data)) {
    items = data;
  } else if (typeof data === 'object' && data !== null) {
    // Claude a veces devuelve {"0": {...}, "1": {...}} en vez de [{...}, {...}]
    const numericKeys = Object.keys(data).filter(k => /^\d+$/.test(k));
    if (numericKeys.length > 0 && typeof data[numericKeys[0]] === 'object') {
      items = numericKeys.sort((a, b) => a - b).map(k => data[k]);
    } else {
      items = [data];
    }
  } else {
    items = [data];
  }

  return items.filter(item => item && item.title).map((item, i) => ({
    ...item,
    ...stamp,
    id: items.length === 1 ? generateId(idBase) : generateId(`${idBase}::${i}`),
  }));
}

// ───────────────────────────────────────────────────────────────────
// 3. EXTRAER DATOS DEL PDF CON CLAUDE AI
// ───────────────────────────────────────────────────────────────────

async function extractPromoFromPdf(pdfBase64, pdfUrl, bankName, existingContext = null) {
  const today = new Date().toISOString().split('T')[0];
  const schemaStr = JSON.stringify(EXTRACTION_SCHEMA, null, 2);
  const dedupBlock = buildDedupInstructions(existingContext);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
          },
          {
            type: 'text',
            text: `Eres un extractor de datos de promociones bancarias dominicanas.

Analiza este PDF de bases legales de ${bankName} y extrae la información de la promoción.

IMPORTANTE: Esta app SOLO muestra cashbacks y descuentos directos. Si la promoción NO es un cashback, devolución en efectivo o descuento directo en el precio (por ejemplo: conciertos, sorteos, millas, cuotas sin intereses, membresías, preventas, rifas, gimnasios, remesas), devuelve ÚNICAMENTE la palabra SKIP, sin nada más.

${dedupBlock}La fecha de hoy es ${today}.

Si es un cashback o descuento, devuelve SOLAMENTE un objeto JSON válido con exactamente estos campos:
${schemaStr}

Reglas importantes:
- Las fechas deben estar en formato YYYY-MM-DD. Si solo hay mes/año, usa el primer o último día del mes según corresponda.
- Si un campo no aplica o no está en el PDF, usa null.
- isActive = true si today (${today}) está entre validFrom y validUntil (inclusive).
- Para establishments, lista solo los nombres de comercios específicos, máximo 10.
- Para eligibleCards, sé específico (ej: ["Visa Platinum Banreservas", "Mastercard Black Banreservas"]).
- Para conditions, extrae restricciones que podrían descalificar al usuario (ej: "Una vez por cliente", "Consumo mínimo de RD$3,000 en una sola transacción", "Solo aplica los viernes"). Si no hay condiciones especiales, usa [].
- Responde SOLO con el JSON, KNOWN o SKIP, sin texto adicional, sin markdown, sin explicaciones.`
          }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    if (text.toUpperCase() === 'SKIP') {
      console.log(`   ⏭️  Claude: promo no es cashback/descuento, saltando.`);
      return null;
    }
    if (text.toUpperCase() === 'KNOWN') {
      console.log(`   🔄 Claude: promo ya conocida, saltando.`);
      return { _action: 'known' };
    }
    // Limpiar posibles backticks
    const clean = text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);

    return normalizeExtractedPromos(data, bankName, pdfUrl, pdfUrl);
  } catch (err) {
    console.error(`❌ Error extracting from PDF ${pdfUrl}:`, err.message);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// 3b. EXTRAER DATOS DE TEXTO (para bancos sin PDF)
// ───────────────────────────────────────────────────────────────────

async function extractPromoFromText(title, description, bankName, cardId, existingContext = null) {
  const today = new Date().toISOString().split('T')[0];
  const schemaStr = JSON.stringify(EXTRACTION_SCHEMA, null, 2);
  const dedupBlock = buildDedupInstructions(existingContext);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Eres un extractor de datos de promociones bancarias dominicanas.

Analiza esta promoción de ${bankName} y determina si es un cashback o descuento directo.

Título: ${title}
Descripción: ${description || '(sin descripción)'}

IMPORTANTE: Esta app SOLO muestra cashbacks y descuentos directos. Si la promoción NO es un cashback, devolución en efectivo o descuento directo en el precio (por ejemplo: conciertos, sorteos, millas, cuotas sin intereses, membresías, preventas, rifas, gimnasios, remesas, bienvenida), devuelve ÚNICAMENTE la palabra SKIP, sin nada más.

${dedupBlock}La fecha de hoy es ${today}.

Si es un cashback o descuento, devuelve SOLAMENTE un objeto JSON válido con exactamente estos campos:
${schemaStr}

Reglas importantes:
- Las fechas deben estar en formato YYYY-MM-DD. Infiere el año si no está explícito (estamos en ${today.substring(0,4)}).
- Si un campo no aplica o no está disponible, usa null.
- isActive = true si today (${today}) está entre validFrom y validUntil (inclusive).
- Para conditions, extrae restricciones que podrían descalificar al usuario (ej: "Una vez por cliente", "Consumo mínimo de RD$3,000 en una sola transacción", "Solo aplica los viernes"). Si no hay condiciones especiales, usa [].
- Responde SOLO con el JSON, KNOWN o SKIP, sin texto adicional, sin markdown, sin explicaciones.`
      }]
    });

    const text = response.content[0].text.trim();
    if (text.toUpperCase() === 'SKIP') {
      console.log(`   ⏭️  Claude: "${title.substring(0, 50)}" no es cashback/descuento, saltando.`);
      return null;
    }
    if (text.toUpperCase() === 'KNOWN') {
      console.log(`   🔄 Claude: "${title.substring(0, 50)}" ya conocida, saltando.`);
      return { _action: 'known' };
    }
    const clean = text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);
    const srcUrl = 'https://bhd.com.do/homepage-personal/otros-servicios/products/259';

    return normalizeExtractedPromos(data, bankName, srcUrl, `bhd-card-${cardId}`);
  } catch (err) {
    console.error(`❌ Error extrayendo texto "${title}":`, err.message);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// 3c. PROCESAR BANCO VÍA STRAPI API (BHD)
// ───────────────────────────────────────────────────────────────────

// Busca el detalle completo de una promo BHD en t-4-s por título
// Devuelve texto rico con porcentaje, requisitos, topes, etc.
async function getBhdPromoDetail(title) {
  try {
    const q = encodeURIComponent(title.substring(0, 60));
    const url = `https://backend.bhd.com.do/api/t-4-s?filters[heading][$containsi]=${q}&populate=deep&pagination%5BpageSize%5D=3`;
    const { data } = await axios.get(url, { timeout: 8000, ...axiosProxy });
    const items = data?.data || [];
    if (items.length === 0) return null;

    // Tomar el más parecido al título original
    const match = items.find(i =>
      i.attributes.heading?.toLowerCase().includes(title.toLowerCase().substring(0, 25))
    ) || items[0];

    const attrs = match.attributes;
    const paragraphs = (attrs.paragraph || [])
      .map(p => p.paratext || '').filter(Boolean).join('\n');
    const reqs = (attrs.requisite?.reqdata || [])
      .map(r => r.detail || '').filter(Boolean).join('\n');

    return [paragraphs, reqs ? `Requisitos:\n${reqs}` : ''].filter(Boolean).join('\n\n');
  } catch {
    return null;
  }
}

async function processBankFromStrapiApi(source, existingIds, existingContext, maxPerBank = Infinity) {
  try {
    const { data } = await axios.get(source.strapiUrl, { timeout: 15000, ...axiosProxy });
    const cards = data?.data?.attributes?.product_cards?.data || [];
    console.log(`   📋 ${cards.length} cards en la API`);

    const newPromos = [];
    let processed = 0;
    let skipped = 0;

    for (const card of cards) {
      if (processed >= maxPerBank) break;
      const { title, description } = card.attributes;
      const id = generateId(`bhd-card-${card.id}`);

      if (existingIds.has(id)) { skipped++; continue; }

      const text = `${title} ${description || ''}`.toLowerCase();
      const hasKeyword = source.keywords.some(k => text.includes(k));
      const hasExclude = source.excludeKeywords?.some(k => text.includes(k));
      if (!hasKeyword || hasExclude) { skipped++; continue; }

      // Buscar detalle completo en t-4-s (tiene el % de devolución)
      const detail = source.detailApi ? await getBhdPromoDetail(title) : null;
      if (detail) console.log(`   🔍 Detalle encontrado para: ${title.substring(0, 50)}`);

      console.log(`   🤖 Extrayendo: ${title.substring(0, 60)}...`);
      const richDesc = detail || (source.cardContextHint
        ? `[CONTEXTO: ${source.cardContextHint}]\n${description || ''}`
        : description);
      const result = await extractPromoFromText(title, richDesc, source.name, card.id, existingContext);

      if (result && result._action === 'known') { skipped++; continue; }

      if (result) {
        for (const promo of result) {
          promo.bankId = source.id;
          promo.bankColor = source.color;
          newPromos.push(promo);
          processed++;
          console.log(`   ✅ ${promo.title}`);
        }
      }

      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} saltadas`);
    return newPromos;
  } catch (err) {
    console.error(`❌ Error procesando ${source.name} (Strapi):`, err.message);
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────
// 3c1b. PROCESAR BANCO VÍA STRAPI REST API CON PDFs (Vimenca)
//       Fetch promos desde Strapi público, descarga PDFs adjuntos
// ───────────────────────────────────────────────────────────────────

async function processBankFromStrapiPdf(source, existingIds, existingContext, maxPerBank = Infinity) {
  try {
    const { data } = await axios.get(source.strapiUrl, { timeout: 15000, ...axiosProxy });
    const items = data?.data || [];
    console.log(`   📋 ${items.length} items en Strapi API`);

    const newPromos = [];
    let processed = 0, skipped = 0;

    for (const item of items) {
      if (processed >= maxPerBank) break;

      const titulo = item.titulo || item.title || '';
      const pdfUrl = item.archivo?.url || null;
      const link = item.link || pdfUrl || '';
      const idBase = link || `${source.id}-strapi-${item.id || item.documentId}`;
      const id = generateId(idBase);

      if (existingIds.has(id)) { skipped++; continue; }

      // Pre-filtrar por título
      const titleLower = titulo.toLowerCase();
      const hasExclude = (source.excludeKeywords || []).some(k => titleLower.includes(k));
      if (hasExclude) { skipped++; continue; }

      // Si hay PDF, descargar y extraer con Claude
      if (pdfUrl) {
        console.log(`   📄 Descargando PDF: ${titulo.substring(0, 60)}...`);
        const base64 = await downloadPdfAsBase64(pdfUrl);
        if (!base64) { skipped++; continue; }

        console.log(`   🤖 Extrayendo con Claude...`);
        const result = await extractPromoFromPdf(base64, pdfUrl, source.name, existingContext);

        if (result && result._action === 'known') { skipped++; continue; }

        if (result) {
          for (const promo of result) {
            promo.bankId = source.id;
            promo.bankColor = source.color;
            newPromos.push(promo);
            processed++;
            console.log(`   ✅ ${promo.title}`);
          }
        }
      } else if (link) {
        // Sin PDF — extraer texto de la página enlazada
        console.log(`   📖 Leyendo página: ${titulo.substring(0, 60)}...`);
        const text = await extractTextFromPromoPageAxios(link);
        if (!text) { skipped++; continue; }

        const textLower = text.toLowerCase();
        const hasKeyword = source.keywords.some(k => textLower.includes(k));
        if (!hasKeyword) { skipped++; continue; }

        console.log(`   🤖 Extrayendo con Claude...`);
        const result = await extractPromoFromPageText(text, source.name, link, existingContext);

        if (result && result._action === 'known') { skipped++; continue; }

        if (result) {
          for (const promo of result) {
            promo.bankId = source.id;
            promo.bankColor = source.color;
            newPromos.push(promo);
            processed++;
            console.log(`   ✅ ${promo.title}`);
          }
        }
      } else {
        skipped++;
        continue;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} saltadas`);
    return newPromos;
  } catch (err) {
    console.error(`❌ Error procesando ${source.name} (Strapi PDF):`, err.message);
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────
// 3c1c. PROCESAR BANCO VÍA INSTAGRAM (Apify free tier)
//       Fetch recent posts from Instagram, filter by keywords,
//       extract promo details with Claude AI from captions.
// ───────────────────────────────────────────────────────────────────

async function processBankFromInstagram(source, existingIds, existingContext, maxPerBank = Infinity) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) {
    console.error(`   ⚠️  APIFY_API_TOKEN no configurado — saltando ${source.name}`);
    return [];
  }

  try {
    console.log(`   📸 Buscando posts de @${source.instagramHandle} via Apify...`);

    // Run Apify Instagram Scraper synchronously — returns dataset items directly
    const { data: posts } = await axios.post(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        directUrls: [`https://www.instagram.com/${source.instagramHandle}/`],
        resultsType: 'posts',
        resultsLimit: 30,
      },
      { timeout: 120000 }  // Apify sync runs can take up to 2 min
    );

    if (!Array.isArray(posts) || posts.length === 0) {
      console.log(`   📭 No se encontraron posts para @${source.instagramHandle}`);
      return [];
    }
    console.log(`   📋 ${posts.length} posts encontrados`);

    // Pre-filter by keywords in caption
    const matching = posts.filter(post => {
      const caption = (post.caption || '').toLowerCase();
      const hasKeyword = source.keywords.some(k => caption.includes(k));
      const hasExclude = (source.excludeKeywords || []).some(k => caption.includes(k));
      return hasKeyword && !hasExclude;
    });
    console.log(`   🔍 ${matching.length} posts coinciden con keywords`);

    const newPromos = [];
    let processed = 0, skipped = 0;

    for (const post of matching) {
      if (processed >= maxPerBank) break;

      const postUrl = post.url || `https://www.instagram.com/p/${post.shortCode}/`;
      const id = generateId(postUrl);
      if (existingIds.has(id)) { skipped++; continue; }

      const caption = post.caption || '';
      if (caption.length < 30) { skipped++; continue; }  // Skip very short captions

      console.log(`   🤖 Extrayendo con Claude: ${caption.substring(0, 60)}...`);
      const result = await extractPromoFromPageText(caption, source.name, postUrl, existingContext);

      if (result && result._action === 'known') { skipped++; continue; }

      if (result) {
        for (const promo of result) {
          promo.bankId = source.id;
          promo.bankColor = source.color;
          promo.sourceUrl = postUrl;
          newPromos.push(promo);
          processed++;
          console.log(`   ✅ ${promo.title}`);
        }
      }

      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} saltadas`);
    return newPromos;
  } catch (err) {
    console.error(`❌ Error procesando ${source.name} (Instagram):`, err.message);
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────
// 3c2. PROCESAR LAFISE VÍA JSON API
// ───────────────────────────────────────────────────────────────────

async function processBankFromLafiseJson(source, existingIds, existingContext, maxPerBank = Infinity) {
  try {
    const { data } = await axios.get(source.jsonUrl, { timeout: 10000, ...axiosProxy });
    const items = data?.promos || [];
    console.log(`   📋 ${items.length} promos en el JSON`);

    const newPromos = [];
    let processed = 0;
    let skipped = 0;

    for (const item of items) {
      if (processed >= maxPerBank) break;
      const fullTitle = `${item.title} ${item.conector} ${item.sub_title}`.trim().replace(/\s+/g, ' ');
      const id = generateId(`lafise-${fullTitle}`);

      if (existingIds.has(id)) { skipped++; continue; }

      const text = `${fullTitle} ${item.img?.alt || ''}`.toLowerCase();
      const hasKeyword = source.keywords.some(k => text.includes(k));
      const hasExclude = source.excludeKeywords?.some(k => text.includes(k));
      if (!hasKeyword || hasExclude) { skipped++; continue; }

      const description = `${fullTitle}. Vigencia: ${item.fecha}. Aplica con: ${item.tipo}.`;
      console.log(`   🤖 Extrayendo: ${fullTitle.substring(0, 60)}...`);
      const result = await extractPromoFromText(fullTitle, description, source.name, fullTitle, existingContext);

      if (result && result._action === 'known') { skipped++; continue; }

      if (result) {
        for (const promo of result) {
          promo.bankId = source.id;
          promo.bankColor = source.color;
          promo.sourceUrl = item.url_reglamento || item.cta || source.jsonUrl;
          promo.id = id;
          newPromos.push(promo);
          processed++;
          console.log(`   ✅ ${promo.title}`);
        }
      }

      await new Promise(r => setTimeout(r, 400));
    }

    console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} saltadas`);
    return newPromos;
  } catch (err) {
    console.error(`❌ Error procesando ${source.name} (JSON):`, err.message);
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────
// 3c3. EXTRAER DATOS DE PÁGINA HTML COMPLETA (Scotiabank, BLH)
// ───────────────────────────────────────────────────────────────────

async function extractPromoFromPageText(pageText, bankName, sourceUrl, existingContext = null) {
  const today = new Date().toISOString().split('T')[0];
  const schemaStr = JSON.stringify(EXTRACTION_SCHEMA, null, 2);
  const dedupBlock = buildDedupInstructions(existingContext);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Eres un extractor de datos de promociones bancarias dominicanas.

Analiza el siguiente texto de una página web de ${bankName} que describe una promoción.

TEXTO DE LA PÁGINA:
${pageText.substring(0, 8000)}

IMPORTANTE: Esta app SOLO muestra cashbacks y descuentos directos. Si la promoción NO es un cashback, devolución en efectivo o descuento directo en el precio (por ejemplo: conciertos, sorteos, millas, cuotas sin intereses, membresías, preventas, rifas, gimnasios, remesas), devuelve ÚNICAMENTE la palabra SKIP, sin nada más.

${dedupBlock}La fecha de hoy es ${today}.

Si es un cashback o descuento, devuelve SOLAMENTE un objeto JSON válido con exactamente estos campos:
${schemaStr}

Reglas importantes:
- Las fechas deben estar en formato YYYY-MM-DD. Infiere el año si no está explícito (estamos en ${today.substring(0,4)}).
- Si un campo no aplica o no está disponible, usa null.
- isActive = true si today (${today}) está entre validFrom y validUntil (inclusive).
- Si el texto describe múltiples promociones, devuelve un ARRAY JSON de objetos (cada uno con los mismos campos del schema).
- Para conditions, extrae restricciones que podrían descalificar al usuario (ej: "Una vez por cliente", "Consumo mínimo de RD$3,000 en una sola transacción", "Solo aplica los viernes"). Si no hay condiciones especiales, usa [].
- Responde SOLO con el JSON, KNOWN o SKIP, sin texto adicional, sin markdown, sin explicaciones.`
      }]
    });

    const raw = response.content[0].text.trim();
    if (raw.toUpperCase() === 'SKIP') {
      console.log(`   ⏭️  Claude: página no es cashback/descuento, saltando.`);
      return null;
    }
    if (raw.toUpperCase() === 'KNOWN') {
      console.log(`   🔄 Claude: promo ya conocida, saltando.`);
      return { _action: 'known' };
    }
    const clean = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);

    return normalizeExtractedPromos(data, bankName, sourceUrl, sourceUrl);
  } catch (err) {
    console.error(`❌ Error extrayendo página ${sourceUrl}:`, err.message);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// 3c4. PROCESAR BANCO VÍA WORDPRESS REST API (Banco Ademi)
// ───────────────────────────────────────────────────────────────────

async function processBankFromWpApi(source, existingIds, existingContext, maxPerBank = Infinity) {
  try {
    const { data } = await axios.get(source.wpApiUrl, { timeout: 15000, ...axiosProxy });
    const posts = Array.isArray(data) ? data : [];
    console.log(`   📋 ${posts.length} posts en la WP API`);

    const newPromos = [];
    let processed = 0, skipped = 0;

    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    for (const post of posts) {
      if (processed >= maxPerBank) break;
      const title = post.title?.rendered || '';
      const link = post.link || source.promoListUrl;
      const id = generateId(link);

      if (existingIds.has(id)) { skipped++; continue; }

      // Saltar posts más viejos de 90 días
      if (post.date && new Date(post.date) < ninetyDaysAgo) { skipped++; continue; }

      // Convertir HTML del post a texto plano con cheerio
      const $ = cheerio.load(post.content?.rendered || '');
      const contentText = $.text().replace(/\s+/g, ' ').trim();
      const fullText = `${title}\n${contentText}`;
      const textLower = fullText.toLowerCase();

      const hasKeyword = source.keywords.some(k => textLower.includes(k));
      const hasExclude = source.excludeKeywords?.some(k => textLower.includes(k));
      if (!hasKeyword || hasExclude) { skipped++; continue; }

      const contextHint = source.cardContextHint ? `[CONTEXTO: ${source.cardContextHint}]\n\n` : '';
      const pageText = `${contextHint}${fullText}`.substring(0, 2500);

      console.log(`   🤖 Extrayendo: ${title.substring(0, 60)}...`);
      const result = await extractPromoFromPageText(pageText, source.name, link, existingContext);

      if (result && result._action === 'known') { skipped++; continue; }

      if (result) {
        for (const promo of result) {
          promo.bankId = source.id;
          promo.bankColor = source.color;
          promo.sourceUrl = link;
          promo.id = id;
          newPromos.push(promo);
          processed++;
          console.log(`   ✅ ${promo.title}`);
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} saltadas`);
    return newPromos;
  } catch (err) {
    console.error(`❌ Error procesando ${source.name} (WP API):`, err.message);
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────
// 3c5. PROCESAR BANCO VÍA CARDS INLINE EN PÁGINA DE LISTADO (La Nacional)
// ───────────────────────────────────────────────────────────────────

async function processBankFromInlineCards(source, existingIds, existingContext, maxPerBank = Infinity) {
  let browser;
  try {
    console.log(`   🌐 Cargando página de listado inline para ${source.name}...`);
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    await withRetry(
      () => page.goto(source.promoListUrl, { waitUntil: 'networkidle2', timeout: 60000 }),
      { retries: 2, label: source.promoListUrl }
    );
    await new Promise(r => setTimeout(r, 5000));

    const cards = await page.evaluate((sel) =>
      [...document.querySelectorAll(sel)].map(el => el.innerText.trim()).filter(Boolean)
    , source.cardSelector);

    console.log(`   📋 ${cards.length} cards inline encontradas`);

    const newPromos = [];
    let processed = 0, skipped = 0;

    for (const cardText of cards) {
      if (processed >= maxPerBank) break;
      const textLower = cardText.toLowerCase();
      const hasKeyword = source.keywords.some(k => textLower.includes(k));
      const hasExclude = source.excludeKeywords?.some(k => textLower.includes(k));
      if (!hasKeyword || hasExclude) { skipped++; continue; }

      const id = generateId(`${source.id}-${cardText.substring(0, 80)}`);
      if (existingIds.has(id)) { skipped++; continue; }

      console.log(`   🤖 Extrayendo: ${cardText.substring(0, 60).replace(/\n/g, ' ')}...`);
      const result = await extractPromoFromPageText(cardText, source.name, source.promoListUrl, existingContext);

      if (result && result._action === 'known') { skipped++; continue; }

      if (result) {
        for (const promo of result) {
          promo.bankId = source.id;
          promo.bankColor = source.color;
          promo.id = id;
          newPromos.push(promo);
          processed++;
          console.log(`   ✅ ${promo.title}`);
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} saltadas`);
    return newPromos;
  } catch (err) {
    console.error(`❌ Error en inline cards ${source.name}:`, err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ───────────────────────────────────────────────────────────────────
// 3d0. AXIOS+CHEERIO FALLBACK — para sitios que funcionan sin JS
//      pero Puppeteer falla desde datacenter (DNS, timeout, IP block)
// ───────────────────────────────────────────────────────────────────

async function getPromoLinksViaAxios(source) {
  const links = new Set();
  for (const listingUrl of (source.listingPages || [source.promoListUrl])) {
    try {
      console.log(`   📃 Cargando (axios): ${listingUrl}`);
      const { data } = await axios.get(listingUrl, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        ...axiosProxy,
      });
      const $ = cheerio.load(data);
      $(source.promoLinkSelector).each((_, el) => {
        const href = $(el).attr('href');
        if (href) {
          const fullUrl = href.startsWith('http') ? href : new URL(href, listingUrl).href;
          links.add(fullUrl);
        }
      });
      console.log(`   🔗 Links encontrados: ${links.size}`);
    } catch (e) {
      console.error(`   ⚠️  Error axios en listing ${listingUrl}:`, e.message);
    }
  }
  return [...links];
}

async function extractTextFromPromoPageAxios(url) {
  try {
    return await withRetry(async () => {
      const { data } = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        ...axiosProxy,
      });
      const $ = cheerio.load(data);
      // Eliminar nav, footer, sidebar, scripts
      $('nav, footer, aside, script, style, .sidebar, .menu, .header').remove();
      const el = $('article, main, .entry-content, .promo-detail, #main-content, .content-area, .post-content');
      const text = el.length ? el.text() : $('body').text();
      // Higher limit for pages that may contain multiple promos (e.g., Cibao monthly pages)
      return text.replace(/\s+/g, ' ').trim().substring(0, 8000);
    }, { retries: 1, label: url });
  } catch (e) {
    console.error(`   ⚠️  Error axios extrayendo texto de ${url}:`, e.message);
    return null;
  }
}

// Curl-based fallback for servers with malformed HTTP headers (e.g. BLH)
function extractTextFromPromoPageCurl(url) {
  try {
    const data = execSync(
      `curl -s -k --max-time 15 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" "${url}"`,
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }
    );
    const $ = cheerio.load(data);
    $('nav, footer, aside, script, style, .sidebar, .menu, .header').remove();
    const el = $('article, main, .entry-content, .promo-detail, #main-content, .content-area, .post-content');
    const text = el.length ? el.text() : $('body').text();
    return text.replace(/\s+/g, ' ').trim().substring(0, 8000);
  } catch (e) {
    console.error(`   ⚠️  Error curl extrayendo texto de ${url}:`, e.message);
    return null;
  }
}

async function processBankFromHtmlAxios(source, existingIds, existingContext, maxPerBank = Infinity) {
  console.log(`   🔍 Buscando links via axios en ${(source.listingPages || []).length} páginas de listado...`);
  const promoLinks = await getPromoLinksViaAxios(source);
  console.log(`   📄 Encontrados ${promoLinks.length} links de promos`);

  const newPromos = [];
  let processed = 0;
  let skipped = 0;

  for (const url of promoLinks.slice(0, 20)) {
    if (processed >= maxPerBank) break;
    const id = generateId(url);
    if (existingIds.has(id)) { skipped++; continue; }

    console.log(`   📖 Leyendo (axios): ${url.substring(0, 80)}...`);
    const text = await extractTextFromPromoPageAxios(url);
    if (!text) { skipped++; continue; }

    const textLower = text.toLowerCase();
    const hasKeyword = source.keywords.some(k => textLower.includes(k));
    if (!hasKeyword) { skipped++; continue; }

    console.log(`   🤖 Extrayendo con Claude...`);
    const result = await extractPromoFromPageText(text, source.name, url, existingContext);

    if (result && result._action === 'known') { skipped++; continue; }

    if (result) {
      for (const promo of result) {
        promo.bankId = source.id;
        promo.bankColor = source.color;
        newPromos.push(promo);
        processed++;
        console.log(`   ✅ ${promo.title}`);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} saltadas`);
  return newPromos;
}

// ───────────────────────────────────────────────────────────────────
// 3d0b. RSS FEED STRATEGY — para WordPress con RSS (BLH)
//       Obtiene URLs de artículos del feed, luego curl+cheerio
//       (BLH sends malformed HTTP headers that break all Node.js parsers)
// ───────────────────────────────────────────────────────────────────

async function processBankFromRss(source, existingIds, existingContext, maxPerBank = Infinity) {
  try {
    console.log(`   📡 Fetching RSS feed: ${source.rssUrl}`);
    // BLH sends malformed HTTP headers ("HTTP X-Frame-Options") that crash all Node.js HTTP
    // parsers (axios, fetch, https). Use curl which tolerates non-conformant headers.
    const data = execSync(
      `curl -s -k --max-time 15 -A "Mozilla/5.0 (compatible; CashbackDO/1.0)" "${source.rssUrl}"`,
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }
    );
    const $ = cheerio.load(data, { xmlMode: true });
    const items = [];
    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      if (link) items.push({ title, link });
    });
    console.log(`   📋 ${items.length} artículos en el feed RSS`);

    const newPromos = [];
    let processed = 0, skipped = 0;

    for (const item of items) {
      if (processed >= maxPerBank) break;
      const id = generateId(item.link);
      if (existingIds.has(id)) { skipped++; continue; }

      // Pre-filtrar por título (excluir sorteos, concursos, etc.)
      const titleLower = item.title.toLowerCase();
      const hasExclude = (source.excludeKeywords || []).some(k => titleLower.includes(k));
      if (hasExclude) { skipped++; continue; }

      console.log(`   📖 Leyendo: ${item.title.substring(0, 60)}...`);
      // Use curl for page text too — same malformed-header issue on all blh.com.do pages
      const text = extractTextFromPromoPageCurl(item.link);
      if (!text) { skipped++; continue; }

      const textLower = text.toLowerCase();
      const hasKeyword = source.keywords.some(k => textLower.includes(k));
      if (!hasKeyword) { skipped++; continue; }

      console.log(`   🤖 Extrayendo con Claude...`);
      const result = await extractPromoFromPageText(text, source.name, item.link, existingContext);

      if (result && result._action === 'known') { skipped++; continue; }

      if (result) {
        for (const promo of result) {
          promo.bankId = source.id;
          promo.bankColor = source.color;
          newPromos.push(promo);
          processed++;
          console.log(`   ✅ ${promo.title}`);
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} saltadas`);
    return newPromos;
  } catch (err) {
    console.error(`❌ Error procesando ${source.name} (RSS):`, err.message);
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────
// 3d. PROCESAR BANCO VÍA PÁGINAS HTML DE PROMOS (Scotiabank)
// ───────────────────────────────────────────────────────────────────

async function getPromoLinksFromListingPages(source) {
  const links = new Set();
  let browser;
  try {
    console.log(`   🌐 Lanzando Puppeteer para ${source.name}...`);
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    console.log(`   ✅ Puppeteer lanzado OK`);

    // Ocultar señales de automatización (ayuda con Akamai/Cloudflare)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    for (const listingUrl of (source.listingPages || [source.promoListUrl])) {
      try {
        console.log(`   📃 Cargando: ${listingUrl}`);
        await withRetry(
          () => page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 60000 }),
          { retries: 2, label: listingUrl }
        );
        await new Promise(r => setTimeout(r, 5000));
        const found = await page.evaluate((sel) =>
          [...new Set([...document.querySelectorAll(sel)].map(a => a.href).filter(Boolean))]
        , source.promoLinkSelector);
        console.log(`   🔗 Links encontrados en esta página: ${found.length}`);
        found.forEach(l => links.add(l));
      } catch (e) {
        console.error(`   ⚠️  Error en listing ${listingUrl}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`   ❌ Error lanzando Puppeteer para ${source.name}:`, e.message);
  } finally {
    if (browser) await browser.close();
  }
  return [...links];
}

async function extractTextFromPromoPage(url) {
  try {
    return await withRetry(async () => {
      let browser;
      try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(r => setTimeout(r, 2000));
        // Extraer el texto del artículo/main, ignorando nav y footer
        const text = await page.evaluate(() => {
          const el = document.querySelector('article, main, .entry-content, .promo-detail, #main-content, .content-area');
          return el ? el.innerText : document.body.innerText;
        });
        return text.substring(0, 8000);
      } finally {
        if (browser) await browser.close();
      }
    }, { retries: 1, label: url });
  } catch (e) {
    console.error(`   ⚠️  Error extrayendo texto de ${url}:`, e.message);
    return null;
  }
}

async function processBankFromHtmlPromoPages(source, existingIds, existingContext, maxPerBank = Infinity) {
  console.log(`   🔍 Buscando links en ${(source.listingPages || []).length} páginas de listado...`);
  const promoLinks = await getPromoLinksFromListingPages(source);
  console.log(`   📄 Encontrados ${promoLinks.length} links de promos`);

  const newPromos = [];
  let processed = 0;
  let skipped = 0;

  for (const url of promoLinks.slice(0, 20)) {
    if (processed >= maxPerBank) break;
    const id = generateId(url);
    if (existingIds.has(id)) { skipped++; continue; }

    console.log(`   📖 Leyendo: ${url.substring(0, 80)}...`);
    const text = await extractTextFromPromoPage(url);
    if (!text) { skipped++; continue; }

    const textLower = text.toLowerCase();
    const hasKeyword = source.keywords.some(k => textLower.includes(k));
    if (!hasKeyword) { skipped++; continue; }

    console.log(`   🤖 Extrayendo con Claude...`);
    const result = await extractPromoFromPageText(text, source.name, url, existingContext);

    if (result && result._action === 'known') { skipped++; continue; }

    if (result) {
      for (const promo of result) {
        promo.bankId = source.id;
        promo.bankColor = source.color;
        newPromos.push(promo);
        processed++;
        console.log(`   ✅ ${promo.title}`);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} saltadas`);
  return newPromos;
}

// ───────────────────────────────────────────────────────────────────
// 4. DEDUPLICAR — no procesar PDFs ya vistos
// ───────────────────────────────────────────────────────────────────

function generateId(url) {
  // Hash simple basado en la URL
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

const EMPTY_SCRAPER_DATA = { promos: [], lastUpdated: null, scrapeHistory: [] };

async function loadExistingData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    // Defensive: file may contain corrupted Redis restore (e.g. string or array instead of object)
    if (!data || typeof data !== 'object' || !Array.isArray(data.promos)) {
      console.warn('⚠️  Datos existentes con estructura inesperada, empezando vacío');
      return EMPTY_SCRAPER_DATA;
    }
    return data;
  } catch {
    return EMPTY_SCRAPER_DATA;
  }
}

// ───────────────────────────────────────────────────────────────────
// 4b. CONTEXTO DE PROMOS EXISTENTES PARA DEDUP INTELIGENTE
// ───────────────────────────────────────────────────────────────────

function formatExistingPromosForContext(allPromos, bankId) {
  const today = new Date().toISOString().split('T')[0];
  // Include recently-expired promos (last 14 days) so Claude can detect
  // extensions/renewals of promos that expired and were later re-launched
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const relevantForBank = allPromos.filter(p =>
    p.bankId === bankId && p.validUntil && p.validUntil >= fourteenDaysAgo
  );
  if (relevantForBank.length === 0) return null;

  const lines = relevantForBank.map(p => {
    const estab = Array.isArray(p.establishments) ? p.establishments.slice(0, 3).join(', ') : '';
    const status = p.validUntil < today ? ' [EXPIRADA]' : '';
    return `- [${p.id}] "${p.title}" | ${p.percentage || '?'} | ${p.validFrom || '?'}→${p.validUntil || '?'}${status} | ${estab}`;
  });
  return lines.join('\n');
}

function buildDedupInstructions(existingContext) {
  if (!existingContext) return '';
  return `
DEDUPLICACIÓN: Ya tenemos estas promos (activas y recientemente expiradas) de este banco:
${existingContext}

Las promos marcadas [EXPIRADA] vencieron hace poco. Los bancos frecuentemente EXTIENDEN promos después de que expiran (misma promo, nuevas fechas).

Para cada promo que analices:
- Si ya existe en la lista anterior SIN cambios relevantes, devuelve ÚNICAMENTE la palabra KNOWN (sin nada más).
- Si existe pero tiene cambios (fechas extendidas, porcentaje diferente, términos actualizados), devuelve el JSON con los campos actualizados MÁS estos campos adicionales: "_action": "correction", "_correctedId": "[id de la promo existente que corrige]".
- IMPORTANTE: Si una promo [EXPIRADA] aparece de nuevo con nuevas fechas, es una EXTENSIÓN. Devuelve el JSON actualizado con "_action": "correction" y el "_correctedId" de la promo expirada.
- Si es una promo genuinamente nueva que no aparece arriba, devuelve el JSON normal con "_action": "new".
- Si no es cashback/descuento, devuelve SKIP como siempre.

`;
}

// ───────────────────────────────────────────────────────────────────
// 5. PROCESAR UN BANCO COMPLETO
// ───────────────────────────────────────────────────────────────────

async function processBank(source, existingIds, allPromos, maxPerBank = Infinity) {
  console.log(`\n🏦 Procesando ${source.name}...`);

  const existingContext = formatExistingPromosForContext(allPromos, source.id);

  // Estrategia Strapi API (BHD y similares)
  if (source.strategy === 'strapi_api') {
    return await processBankFromStrapiApi(source, existingIds, existingContext, maxPerBank);
  }

  // Estrategia Strapi API con PDFs adjuntos (Vimenca)
  if (source.strategy === 'strapi_pdf') {
    return await processBankFromStrapiPdf(source, existingIds, existingContext, maxPerBank);
  }

  // Estrategia Instagram via Apify (Banco Popular)
  if (source.strategy === 'instagram_apify') {
    return await processBankFromInstagram(source, existingIds, existingContext, maxPerBank);
  }

  // Estrategia JSON API (LAFISE)
  if (source.strategy === 'lafise_json') {
    return await processBankFromLafiseJson(source, existingIds, existingContext, maxPerBank);
  }

  // Estrategia HTML promo pages via Puppeteer (Scotiabank, Banesco, etc.)
  if (source.strategy === 'html_promo_pages') {
    return await processBankFromHtmlPromoPages(source, existingIds, existingContext, maxPerBank);
  }

  // Estrategia HTML promo pages via axios+cheerio (Cibao, BDI — no necesitan JS)
  if (source.strategy === 'axios_html_promo_pages') {
    return await processBankFromHtmlAxios(source, existingIds, existingContext, maxPerBank);
  }

  // Estrategia RSS feed → axios (BLH WordPress)
  if (source.strategy === 'wp_rss') {
    return await processBankFromRss(source, existingIds, existingContext, maxPerBank);
  }

  // Estrategia WordPress REST API (Banco Ademi)
  if (source.strategy === 'wp_api') {
    return await processBankFromWpApi(source, existingIds, existingContext, maxPerBank);
  }

  // Estrategia inline cards (La Nacional — ofertas en una sola página sin sub-páginas)
  if (source.strategy === 'html_inline_cards') {
    return await processBankFromInlineCards(source, existingIds, existingContext, maxPerBank);
  }

  // Obtener links de PDFs
  let pdfLinks = [];
  if (source.strategy === 'html_pdf_links') {
    pdfLinks = await getPdfLinksFromHtml(
      source.promoListUrl, source.pdfLinkSelector,
      source.keywords, source.excludeKeywords
    );
  } else if (source.strategy === 'dynamic_js') {
    pdfLinks = await getPdfLinksFromDynamic(
      source.promoListUrl, source.pdfLinkSelector,
      source.keywords, source.excludeKeywords
    );
  }

  console.log(`   📄 Encontrados ${pdfLinks.length} PDFs`);
  // Solo los primeros 20 PDFs (más recientes)
  const limitedLinks = pdfLinks.slice(0, 20);
  console.log(`   🔒 Limitado a ${limitedLinks.length} PDFs más recientes`);

  const newPromos = [];
  let processed = 0;
  let skipped = 0;

  for (const link of limitedLinks) {
    if (processed >= maxPerBank) break;

    const id = generateId(link.url);

    // Skip si ya lo procesamos antes (no re-descargar PDFs conocidos)
    if (existingIds.has(id)) {
      skipped++;
      continue;
    }

    // Skip si el PDF tiene más de 30 días
    const urlLower = link.url.toLowerCase() + link.text.toLowerCase();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const monthMatch = urlLower.match(/(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)-?(\d{4})/);
    if (monthMatch) {
      const months = { enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,octubre:9,noviembre:10,diciembre:11 };
      const pdfDate = new Date(parseInt(monthMatch[2]), months[monthMatch[1]], 1);
      if (pdfDate < thirtyDaysAgo) {
        console.log(`   ⏭️  Saltando PDF antiguo: ${link.text.substring(0, 50)}`);
        skipped++;
        continue;
      }
    }

    console.log(`   ⬇️  Descargando: ${link.text.substring(0, 60)}...`);

    const pdfBase64 = await downloadPdfAsBase64(link.url);
    if (!pdfBase64) continue;

    console.log(`   🤖 Extrayendo con Claude AI...`);
    const result = await extractPromoFromPdf(pdfBase64, link.url, source.name, existingContext);

    if (result && result._action === 'known') { skipped++; continue; }

    if (result) {
      for (const promo of result) {
        promo.bankId = source.id;
        promo.bankColor = source.color;
        newPromos.push(promo);
        processed++;
        console.log(`   ✅ ${promo.title}`);
      }
    }

    // Rate limit: pausa entre PDFs para no sobrecargar
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`   📊 ${source.name}: ${processed} nuevas, ${skipped} ya conocidas`);
  return newPromos;
}

// ───────────────────────────────────────────────────────────────────
// 6. ACTUALIZAR ESTADO DE PROMOS EXISTENTES
// ───────────────────────────────────────────────────────────────────

function refreshActiveStatus(promos) {
  const today = new Date().toISOString().split('T')[0];
  return promos.map(p => {
    if (!p.validFrom || !p.validUntil) return p;
    const isActive = today >= p.validFrom && today <= p.validUntil;
    const isUpcoming = today < p.validFrom;
    const daysUntilExpiry = p.validUntil
      ? Math.round((new Date(p.validUntil) - new Date(today)) / 86400000)
      : null;
    const daysUntilStart = p.validFrom && isUpcoming
      ? Math.round((new Date(p.validFrom) - new Date(today)) / 86400000)
      : null;

    return { ...p, isActive, isUpcoming, daysUntilExpiry, daysUntilStart };
  });
}

// ───────────────────────────────────────────────────────────────────
// 7. FUNCIÓN PRINCIPAL DEL SCRAPER
// ───────────────────────────────────────────────────────────────────

export async function runScraper(banksToProcess = null, { maxPerBank = Infinity } = {}) {
  console.log('\n🚀 CashbackDO Scraper iniciando...');
  console.log(`⏰ ${new Date().toLocaleString('es-DO')}\n`);

  const startTime = Date.now();
  const existing = await loadExistingData();
  const existingIds = new Set(existing.promos.map(p => p.id));

  const sources = banksToProcess
    ? BANK_SOURCES.filter(s => banksToProcess.includes(s.id))
    : BANK_SOURCES;

  const allNewPromos = [];
  const bankResults = [];
  const CIRCUIT_BREAKER_SAMPLE = 3;
  let abortedReason = null;

  for (const source of sources) {
    const bankStart = Date.now();
    try {
      const newPromos = await processBank(source, existingIds, existing.promos, maxPerBank);
      allNewPromos.push(...newPromos);
      bankResults.push({
        bankId: source.id,
        name: source.name,
        status: 'ok',
        promosFound: newPromos.length,
        durationSeconds: parseFloat(((Date.now() - bankStart) / 1000).toFixed(1)),
      });
    } catch (err) {
      console.error(`❌ Error procesando ${source.name}:`, err.message);
      bankResults.push({
        bankId: source.id,
        name: source.name,
        status: 'error',
        error: err.message,
        promosFound: 0,
        durationSeconds: parseFloat(((Date.now() - bankStart) / 1000).toFixed(1)),
      });
    }

    // Circuit breaker: abort early if all sample banks errored (not just 0 new promos — steady-state dedup means 0 is normal)
    if (bankResults.length === CIRCUIT_BREAKER_SAMPLE) {
      const errors = bankResults.filter(r => r.status === 'error');
      if (errors.length === CIRCUIT_BREAKER_SAMPLE) {
        const errorMsgs = errors.map(r => r.error);
        const commonError = errorMsgs.length >= 2 && errorMsgs.every(e => e === errorMsgs[0])
          ? errorMsgs[0]
          : null;

        abortedReason = commonError
          ? `All ${CIRCUIT_BREAKER_SAMPLE} banks failed with same error: ${commonError}`
          : `All ${CIRCUIT_BREAKER_SAMPLE} banks failed with errors`;

        console.error(`\n🛑 CIRCUIT BREAKER: ${abortedReason}`);
        console.error('   Aborting scrape to avoid wasting time. Fix the issue and retry.\n');
        break;
      }
    }
  }

  // Separar promos genuinamente nuevas de correcciones
  const genuinelyNew = allNewPromos.filter(p => p._action !== 'correction');
  const corrections = allNewPromos.filter(p => p._action === 'correction');

  // Aplicar correcciones sobre promos existentes
  const correctedExisting = existing.promos.map(p => {
    const correction = corrections.find(c => c._correctedId === p.id);
    if (!correction) return p;

    console.log(`   🔧 Corrección aplicada: "${p.title}" ← actualizado`);
    const merged = { ...p };
    for (const [key, val] of Object.entries(correction)) {
      if (['_action', '_correctedId', 'id', 'extractedAt'].includes(key)) continue;
      if (val !== null && val !== undefined) merged[key] = val;
    }
    merged.correctedAt = new Date().toISOString();
    return merged;
  });

  // Limpiar campos internos de promos nuevas
  const cleanNew = genuinelyNew.map(p => {
    const { _action, _correctedId, ...clean } = p;
    return clean;
  });

  // Combinar existentes (con correcciones aplicadas) + genuinamente nuevas
  const combined = [...correctedExisting, ...cleanNew];

  // Dedup por contenido: si dos promos tienen mismo banco+título+fecha, queda la más reciente
  const deduped = [];
  const seen = new Map();
  for (const p of combined) {
    if (!p.title) continue; // descartar promos sin título
    const key = `${p.bankId}::${p.title}::${p.validFrom || ''}`;
    const existing = seen.get(key);
    if (existing) {
      // Quedarse con la más reciente
      if ((p.extractedAt || '') > (existing.extractedAt || '')) {
        deduped[deduped.indexOf(existing)] = p;
        seen.set(key, p);
      }
    } else {
      seen.set(key, p);
      deduped.push(p);
    }
  }

  // Refrescar estado activo/próximo de TODAS las promos
  const updated = refreshActiveStatus(deduped);

  // Ordenar: activas primero, luego próximas, luego expiradas
  updated.sort((a, b) => {
    const order = (p) => p.isActive ? 0 : p.isUpcoming ? 1 : 2;
    return order(a) - order(b) || new Date(b.validUntil) - new Date(a.validUntil);
  });

  const dedupedCount = combined.length - deduped.length;
  if (dedupedCount > 0) {
    console.log(`   🧹 Dedup: ${dedupedCount} duplicados eliminados (${combined.length} → ${deduped.length})`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const result = {
    promos: updated,
    lastUpdated: new Date().toISOString(),
    stats: {
      total: updated.length,
      active: updated.filter(p => p.isActive).length,
      upcoming: updated.filter(p => p.isUpcoming && p.daysUntilStart <= 15).length,
      expired: updated.filter(p => !p.isActive && !p.isUpcoming).length,
      newThisRun: cleanNew.length,
      correctionsThisRun: corrections.length,
      duplicatesRemoved: dedupedCount,
      scrapeTimeSeconds: parseFloat(elapsed),
    },
    scrapeHistory: [
      {
        date: new Date().toISOString(),
        newPromos: cleanNew.length,
        correctionsThisRun: corrections.length,
        totalPromos: updated.length,
        durationSeconds: parseFloat(elapsed),
        bankResults,
        ...(abortedReason ? { abortedReason } : {}),
      },
      ...(existing.scrapeHistory || []).slice(0, 29), // últimas 30 ejecuciones
    ]
  };

  // Re-categorizar con keyword matching para corregir categorías imprecisas del LLM
  result.promos = result.promos.map(p => ({ ...p, categories: categorizePromo(p) }));

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(result, null, 2));
  await redisSet('promos', result);
  console.log('☁️  Datos guardados en Redis');

  console.log(`\n✅ Scraping completo en ${elapsed}s`);
  console.log(`   📊 Total: ${result.stats.total} promos`);
  console.log(`   ✅ Activas: ${result.stats.active}`);
  console.log(`   ⏳ Próximas: ${result.stats.upcoming}`);
  console.log(`   🆕 Nuevas este run: ${result.stats.newThisRun}`);
  if (result.stats.correctionsThisRun > 0) {
    console.log(`   🔧 Correcciones: ${result.stats.correctionsThisRun}`);
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────
// 8. CATEGORIZADOR DE PROMOS — keyword-based, sobrescribe categorías
//    imprecisas del LLM (online/presencial) con categorías comerciales
// ───────────────────────────────────────────────────────────────────

const CATEGORY_KEYWORDS = {
  supermercado: [
    'sirena', 'la sirena', 'nacional', 'national', 'jumbo', 'pola', 'súper pola', 'super pola',
    'bravo', 'el bravo', 'iberia market', 'supermercado', 'hiper', 'hipermercado', 'olé',
    'mr. price', 'economax', 'carrefour',
  ],
  farmacia: [
    'carol', 'farmacia', 'farmacias carol', 'farma', 'droguería', 'botica',
    'medic', 'farmacéutic',
  ],
  restaurante: [
    'restaurant', 'burger', "mcdonald's", 'mcdonalds', 'pollo rey', 'kfc', 'subway', 'pizza',
    'domino', 'papa john', 'wendys', 'wendy', 'hard rock cafe', 'applebee', 'chilis', 'chili',
    'friday', 'tony roma', 'olive garden', 'sushi', 'grill', 'bistro', 'cafetería', 'café',
    'comida', 'deli', 'panadería', 'pastelería', 'food', 'comedero', 'asador',
    'delivery', 'rappi', 'ubereats', 'ifood', 'pedidos ya',
  ],
  retail: [
    'zara', 'h&m', 'corripio', 'almacén', 'tienda', 'mall', 'ágora', 'agora',
    'centro cuesta nacional', 'ccn', 'jumbo retail', 'plaza lama', 'boh', 'blue mall',
    'acropolis', 'sambil', 'centro comercial', 'ropa', 'calzado', 'zapatos',
    'electrónic', 'electrodoméstic', 'anthony', 'macrocentro', 'ferretería',
    'librería', 'papelería', 'joyería', 'optic', 'bisuter', 'jugueter',
    'apple store', 'samsung', 'lg', 'muebl',
  ],
  online: [
    'amazon', 'shein', 'aliexpress', 'ebay', 'etsy', 'online', 'compra en línea',
    'compras online', 'e-commerce', 'ecommerce', 'internet', 'app ', 'página web',
    'marketplace',
  ],
  viaje: [
    'american airlines', 'jetblue', 'jet blue', 'copa airlines', 'iberia', 'spirit',
    'frontier', 'united', 'delta', 'aerolínea', 'aeropuerto', 'vuelo', 'aéreo',
    'hotel', 'airbnb', 'booking', 'expedia', 'crucero', 'carnival', 'royal caribbean',
    'viaje', 'turismo', 'hospedaje', 'alojamiento',
  ],
  entretenimiento: [
    'cinemark', 'caribbean cinemas', 'cine', 'netflix', 'spotify', 'disney',
    'bowling', 'laser tag', 'karting', 'escape room', 'parque', 'acuático',
    'spa', 'masaje', 'salón de belleza', 'peluquería', 'fitness', 'gym', 'gimnasio',
    'crossfit', 'pilates', 'yoga', 'club', 'disco', 'teatro', 'concierto',
    'citi field', 'country club', 'golf',
  ],
  educación: [
    'universidad', 'colegio', 'escuela', 'educación', 'intec', 'pucmm', 'uasd',
    'apec', 'unibe', 'utesa', 'unicaribe', 'unphu', 'o&m', 'o and m', 'ufhec',
    'matrícula', 'curso', 'academia', 'capacitación', 'estudio',
  ],
  combustible: [
    'esso', 'shell', 'texaco', 'gasolinera', 'combustible', 'gasolina',
    'estación de servicio', 'gulf', 'pdv',
  ],
  bebidas: [
    'bar', 'cerveza', 'heineken', 'presidente', 'brahma', 'corona', 'ron',
    'whisky', 'whiskey', 'licor', 'vino', 'bodega', 'spirits', 'craft beer',
    'cantina', 'pub', 'lounge',
  ],
};

// Asigna categorías comerciales a una promo basándose en título, descripción y establecimientos
export function categorizePromo(promo) {
  const searchText = [
    promo.title || '',
    promo.description || '',
    ...(Array.isArray(promo.establishments) ? promo.establishments : [promo.establishments || '']),
  ].join(' ').toLowerCase();

  const assigned = new Set();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => searchText.includes(kw))) {
      assigned.add(cat);
    }
  }

  // Si no matcheó nada, conservar lo que tenía; si tenía solo online/presencial → otro
  const oldCats = (promo.categories || []).filter(
    c => !['online', 'presencial', 'otro'].includes(c)
  );
  // Merge: keyword matches + categorías LLM que no sean canal genérico
  const merged = [...new Set([...assigned, ...oldCats])];
  return merged.length > 0 ? merged : ['otro'];
}

// Re-categoriza todas las promos del archivo de datos y guarda
export async function recategorizePromos() {
  let data;
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    data = JSON.parse(raw);
  } catch {
    return { error: 'No hay datos para re-categorizar' };
  }

  let changed = 0;
  data.promos = data.promos.map(p => {
    const newCats = categorizePromo(p);
    const oldStr = JSON.stringify((p.categories || []).sort());
    const newStr = JSON.stringify(newCats.sort());
    if (oldStr !== newStr) changed++;
    return { ...p, categories: newCats };
  });

  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
  await redisSet('promos', data);
  console.log(`♻️  Re-categorización: ${changed} promos actualizadas`);
  return { changed, total: data.promos.length };
}

// ───────────────────────────────────────────────────────────────────
// 9. CARD CATALOG SCRAPER — actualización mensual de tarjetas
// ───────────────────────────────────────────────────────────────────

export async function runCardCatalogScraper() {
  console.log('\n🃏 CashbackDO Card Catalog Scraper iniciando...');
  console.log(`⏰ ${new Date().toLocaleString('es-DO')}\n`);

  // Cargar catálogo existente
  let catalog = {};
  try {
    const raw = await fs.readFile(CARD_FILE, 'utf-8');
    catalog = JSON.parse(raw);
  } catch {
    console.log('   📭 Sin catálogo previo, iniciando desde cero');
  }

  let updatedBanks = 0;

  for (const source of BANK_SOURCES) {
    const url = CARD_PAGE_URLS[source.id];
    if (!url) continue;

    console.log(`\n🏦 Buscando tarjetas de ${source.name}...`);

    let pageText = '';
    let browser;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2000));
      pageText = await page.evaluate(() => {
        const el = document.querySelector('main, .products, .tarjetas, #content, .content-area');
        return el ? el.innerText.substring(0, 3000) : document.body.innerText.substring(0, 3000);
      });
    } catch (e) {
      console.log(`   ⚠️  Error visitando ${url}: ${e.message}`);
    } finally {
      if (browser) await browser.close();
    }

    if (!pageText) {
      console.log(`   ⏭️  Sin contenido, saltando ${source.name}`);
      continue;
    }

    try {
      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Eres un extractor de catálogo de tarjetas bancarias dominicanas.

Del siguiente texto de la página de tarjetas de ${source.name}, extrae la lista de tarjetas de crédito y débito disponibles.

TEXTO:
${pageText}

Devuelve SOLAMENTE un array JSON con objetos de este formato exacto:
[
  { "id": "${source.id}-visa-clasica", "name": "Visa Clásica ${source.name}", "network": "Visa", "type": "crédito" }
]

Reglas:
- "network": "Visa" | "Mastercard" | "American Express"
- "type": "crédito" | "débito"
- "id": ${source.id}-[network-en-minusculas]-[tipo-en-minusculas] (ej: "${source.id}-visa-platinum")
- "name": nombre completo oficial incluyendo el nombre del banco al final
- Solo incluye tarjetas explícitamente mencionadas en el texto
- Si no puedes identificar tarjetas específicas, devuelve []
- SOLO el array JSON, sin texto adicional ni markdown`
        }]
      });

      const raw = response.content[0].text.trim();
      const clean = raw.replace(/```json|```/g, '').trim();
      const scrapedCards = JSON.parse(clean);

      if (Array.isArray(scrapedCards) && scrapedCards.length > 0) {
        const existingBank = catalog[source.id] || { name: source.name, color: source.color, cards: [] };
        const existingIds = new Set(existingBank.cards.map(c => c.id));
        const newCards = scrapedCards.filter(c => c.id && c.name && !existingIds.has(c.id));

        if (newCards.length > 0) {
          catalog[source.id] = {
            ...existingBank,
            name: source.name,
            color: source.color,
            cards: [...existingBank.cards, ...newCards],
          };
          console.log(`   ✅ ${source.name}: ${newCards.length} tarjeta(s) nueva(s) añadida(s)`);
          updatedBanks++;
        } else {
          console.log(`   ✓  ${source.name}: sin tarjetas nuevas (${existingBank.cards.length} ya en catálogo)`);
        }
      } else {
        console.log(`   ⏭️  ${source.name}: no se pudieron extraer tarjetas`);
      }
    } catch (e) {
      console.error(`   ❌ Error extrayendo tarjetas de ${source.name}:`, e.message);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CARD_FILE, JSON.stringify(catalog, null, 2));

  console.log(`\n✅ Catálogo de tarjetas actualizado: ${updatedBanks} banco(s) con nuevas tarjetas`);
  return catalog;
}

// Ejecutar directamente si se llama como script
if (process.argv[1].endsWith('scraper.js')) {
  runScraper().catch(console.error);
}