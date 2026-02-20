// ═══════════════════════════════════════════════════════════════════
// SCRAPER PRINCIPAL — CashbackDO
// Extrae PDFs de bases legales de bancos dominicanos y usa Claude
// para parsear los campos clave de cada promoción.
// ═══════════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { BANK_SOURCES, EXTRACTION_SCHEMA } from './sources.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DATA_FILE = '../data/promos.json';
const LOG_FILE = '../data/scrape_log.json';

// Opciones comunes de Puppeteer: usa Chromium del sistema si está disponible
const PUPPETEER_OPTS = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
};

// ───────────────────────────────────────────────────────────────────
// 1. OBTENER LINKS DE PDFs DE UNA PÁGINA
// ───────────────────────────────────────────────────────────────────

async function getPdfLinksFromHtml(url, selector, keywords, excludeKeywords) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CashbackDO/1.0)' }
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
    browser = await puppeteer.launch(PUPPETEER_OPTS);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (compatible; CashbackDO/1.0)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Esperar a que cargue el contenido
    await new Promise(r => setTimeout(r, 3000));

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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CashbackDO/1.0)' }
    });
    const buffer = Buffer.from(response.data);
    return buffer.toString('base64');
  } catch (err) {
    console.error(`❌ Error downloading PDF ${url}:`, err.message);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// 3. EXTRAER DATOS DEL PDF CON CLAUDE AI
// ───────────────────────────────────────────────────────────────────

async function extractPromoFromPdf(pdfBase64, pdfUrl, bankName) {
  const today = new Date().toISOString().split('T')[0];
  const schemaStr = JSON.stringify(EXTRACTION_SCHEMA, null, 2);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1500,
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

La fecha de hoy es ${today}.

Si es un cashback o descuento, devuelve SOLAMENTE un objeto JSON válido con exactamente estos campos:
${schemaStr}

Reglas importantes:
- Las fechas deben estar en formato YYYY-MM-DD. Si solo hay mes/año, usa el primer o último día del mes según corresponda.
- Si un campo no aplica o no está en el PDF, usa null.
- isActive = true si today (${today}) está entre validFrom y validUntil (inclusive).
- Para establishments, lista solo los nombres de comercios específicos, máximo 10.
- Para eligibleCards, sé específico (ej: ["Visa Platinum Banreservas", "Mastercard Black Banreservas"]).
- Responde SOLO con el JSON o con SKIP, sin texto adicional, sin markdown, sin explicaciones.`
          }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    if (text.toUpperCase() === 'SKIP') {
      console.log(`   ⏭️  Claude: promo no es cashback/descuento, saltando.`);
      return null;
    }
    // Limpiar posibles backticks
    const clean = text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);

    return {
      ...data,
      bank: bankName,
      sourceUrl: pdfUrl,
      extractedAt: new Date().toISOString(),
      id: generateId(pdfUrl),
    };
  } catch (err) {
    console.error(`❌ Error extracting from PDF ${pdfUrl}:`, err.message);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// 3b. EXTRAER DATOS DE TEXTO (para bancos sin PDF)
// ───────────────────────────────────────────────────────────────────

async function extractPromoFromText(title, description, bankName, cardId) {
  const today = new Date().toISOString().split('T')[0];
  const schemaStr = JSON.stringify(EXTRACTION_SCHEMA, null, 2);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Eres un extractor de datos de promociones bancarias dominicanas.

Analiza esta promoción de ${bankName} y determina si es un cashback o descuento directo.

Título: ${title}
Descripción: ${description || '(sin descripción)'}

IMPORTANTE: Esta app SOLO muestra cashbacks y descuentos directos. Si la promoción NO es un cashback, devolución en efectivo o descuento directo en el precio (por ejemplo: conciertos, sorteos, millas, cuotas sin intereses, membresías, preventas, rifas, gimnasios, remesas, bienvenida), devuelve ÚNICAMENTE la palabra SKIP, sin nada más.

La fecha de hoy es ${today}.

Si es un cashback o descuento, devuelve SOLAMENTE un objeto JSON válido con exactamente estos campos:
${schemaStr}

Reglas importantes:
- Las fechas deben estar en formato YYYY-MM-DD. Infiere el año si no está explícito (estamos en ${today.substring(0,4)}).
- Si un campo no aplica o no está disponible, usa null.
- isActive = true si today (${today}) está entre validFrom y validUntil (inclusive).
- Responde SOLO con el JSON o con SKIP, sin texto adicional, sin markdown, sin explicaciones.`
      }]
    });

    const text = response.content[0].text.trim();
    if (text.toUpperCase() === 'SKIP') {
      console.log(`   ⏭️  Claude: "${title.substring(0, 50)}" no es cashback/descuento, saltando.`);
      return null;
    }
    const clean = text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);

    return {
      ...data,
      bank: bankName,
      sourceUrl: 'https://bhd.com.do/homepage-personal/otros-servicios/products/259',
      extractedAt: new Date().toISOString(),
      id: generateId(`bhd-card-${cardId}`),
    };
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
    const { data } = await axios.get(url, { timeout: 8000 });
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

async function processBankFromStrapiApi(source, existingIds) {
  try {
    const { data } = await axios.get(source.strapiUrl, { timeout: 15000 });
    const cards = data?.data?.attributes?.product_cards?.data || [];
    console.log(`   📋 ${cards.length} cards en la API`);

    const newPromos = [];
    let processed = 0;
    let skipped = 0;

    for (const card of cards) {
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
      const promo = await extractPromoFromText(title, richDesc, source.name, card.id);

      if (promo) {
        promo.bankId = source.id;
        promo.bankColor = source.color;
        newPromos.push(promo);
        processed++;
        console.log(`   ✅ ${promo.title}`);
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
// 3c2. EXTRAER DATOS DE PÁGINA HTML COMPLETA (Scotiabank, BLH)
// ───────────────────────────────────────────────────────────────────

async function extractPromoFromPageText(pageText, bankName, sourceUrl) {
  const today = new Date().toISOString().split('T')[0];
  const schemaStr = JSON.stringify(EXTRACTION_SCHEMA, null, 2);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Eres un extractor de datos de promociones bancarias dominicanas.

Analiza el siguiente texto de una página web de ${bankName} que describe una promoción.

TEXTO DE LA PÁGINA:
${pageText.substring(0, 2500)}

IMPORTANTE: Esta app SOLO muestra cashbacks y descuentos directos. Si la promoción NO es un cashback, devolución en efectivo o descuento directo en el precio (por ejemplo: conciertos, sorteos, millas, cuotas sin intereses, membresías, preventas, rifas, gimnasios, remesas), devuelve ÚNICAMENTE la palabra SKIP, sin nada más.

La fecha de hoy es ${today}.

Si es un cashback o descuento, devuelve SOLAMENTE un objeto JSON válido con exactamente estos campos:
${schemaStr}

Reglas importantes:
- Las fechas deben estar en formato YYYY-MM-DD. Infiere el año si no está explícito (estamos en ${today.substring(0,4)}).
- Si un campo no aplica o no está disponible, usa null.
- isActive = true si today (${today}) está entre validFrom y validUntil (inclusive).
- Si el texto describe múltiples promociones, extrae solo la promoción principal.
- Responde SOLO con el JSON o con SKIP, sin texto adicional, sin markdown, sin explicaciones.`
      }]
    });

    const raw = response.content[0].text.trim();
    if (raw.toUpperCase() === 'SKIP') {
      console.log(`   ⏭️  Claude: página no es cashback/descuento, saltando.`);
      return null;
    }
    const clean = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);
    return {
      ...data,
      bank: bankName,
      sourceUrl,
      extractedAt: new Date().toISOString(),
      id: generateId(sourceUrl),
    };
  } catch (err) {
    console.error(`❌ Error extrayendo página ${sourceUrl}:`, err.message);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// 3d. PROCESAR BANCO VÍA PÁGINAS HTML DE PROMOS (Scotiabank, BLH)
// ───────────────────────────────────────────────────────────────────

async function getPromoLinksFromListingPages(source) {
  const links = new Set();
  let browser;
  try {
    console.log(`   🌐 Lanzando Puppeteer para ${source.name}...`);
    browser = await puppeteer.launch(PUPPETEER_OPTS);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    console.log(`   ✅ Puppeteer lanzado OK`);

    for (const listingUrl of (source.listingPages || [source.promoListUrl])) {
      try {
        console.log(`   📃 Cargando: ${listingUrl}`);
        await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
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
  let browser;
  try {
    browser = await puppeteer.launch(PUPPETEER_OPTS);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));
    // Extraer el texto del artículo/main, ignorando nav y footer
    const text = await page.evaluate(() => {
      const el = document.querySelector('article, main, .entry-content, .promo-detail, #main-content, .content-area');
      return el ? el.innerText : document.body.innerText;
    });
    return text.substring(0, 3000);
  } catch (e) {
    console.error(`   ⚠️  Error extrayendo texto de ${url}:`, e.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

async function processBankFromHtmlPromoPages(source, existingIds) {
  console.log(`   🔍 Buscando links en ${(source.listingPages || []).length} páginas de listado...`);
  const promoLinks = await getPromoLinksFromListingPages(source);
  console.log(`   📄 Encontrados ${promoLinks.length} links de promos`);

  const newPromos = [];
  let processed = 0;
  let skipped = 0;

  for (const url of promoLinks.slice(0, 20)) {
    const id = generateId(url);
    if (existingIds.has(id)) { skipped++; continue; }

    console.log(`   📖 Leyendo: ${url.substring(0, 80)}...`);
    const text = await extractTextFromPromoPage(url);
    if (!text) { skipped++; continue; }

    const textLower = text.toLowerCase();
    const hasKeyword = source.keywords.some(k => textLower.includes(k));
    if (!hasKeyword) { skipped++; continue; }

    console.log(`   🤖 Extrayendo con Claude...`);
    const promo = await extractPromoFromPageText(text, source.name, url);
    if (promo) {
      promo.bankId = source.id;
      promo.bankColor = source.color;
      newPromos.push(promo);
      processed++;
      console.log(`   ✅ ${promo.title}`);
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

async function loadExistingData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { promos: [], lastUpdated: null, scrapeHistory: [] };
  }
}

// ───────────────────────────────────────────────────────────────────
// 5. PROCESAR UN BANCO COMPLETO
// ───────────────────────────────────────────────────────────────────

async function processBank(source, existingIds) {
  console.log(`\n🏦 Procesando ${source.name}...`);

  // Estrategia Strapi API (BHD y similares)
  if (source.strategy === 'strapi_api') {
    return await processBankFromStrapiApi(source, existingIds);
  }

  // Estrategia HTML promo pages (Scotiabank, BLH)
  if (source.strategy === 'html_promo_pages') {
    return await processBankFromHtmlPromoPages(source, existingIds);
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
    const id = generateId(link.url);

    // Skip si ya lo procesamos antes
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
    const promo = await extractPromoFromPdf(pdfBase64, link.url, source.name);

    if (promo) {
      promo.bankId = source.id;
      promo.bankColor = source.color;
      newPromos.push(promo);
      processed++;
      console.log(`   ✅ ${promo.title}`);
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

export async function runScraper(banksToProcess = null) {
  console.log('\n🚀 CashbackDO Scraper iniciando...');
  console.log(`⏰ ${new Date().toLocaleString('es-DO')}\n`);

  const startTime = Date.now();
  const existing = await loadExistingData();
  const existingIds = new Set(existing.promos.map(p => p.id));

  const sources = banksToProcess
    ? BANK_SOURCES.filter(s => banksToProcess.includes(s.id))
    : BANK_SOURCES;

  const allNewPromos = [];

  for (const source of sources) {
    try {
      const newPromos = await processBank(source, existingIds);
      allNewPromos.push(...newPromos);
    } catch (err) {
      console.error(`❌ Error procesando ${source.name}:`, err.message);
    }
  }

  // Combinar nuevas con existentes
  const combined = [...existing.promos, ...allNewPromos];

  // Refrescar estado activo/próximo de TODAS las promos
  const updated = refreshActiveStatus(combined);

  // Ordenar: activas primero, luego próximas, luego expiradas
  updated.sort((a, b) => {
    const order = (p) => p.isActive ? 0 : p.isUpcoming ? 1 : 2;
    return order(a) - order(b) || new Date(b.validUntil) - new Date(a.validUntil);
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const result = {
    promos: updated,
    lastUpdated: new Date().toISOString(),
    stats: {
      total: updated.length,
      active: updated.filter(p => p.isActive).length,
      upcoming: updated.filter(p => p.isUpcoming && p.daysUntilStart <= 15).length,
      expired: updated.filter(p => !p.isActive && !p.isUpcoming).length,
      newThisRun: allNewPromos.length,
      scrapeTimeSeconds: parseFloat(elapsed),
    },
    scrapeHistory: [
      {
        date: new Date().toISOString(),
        newPromos: allNewPromos.length,
        totalPromos: updated.length,
        durationSeconds: parseFloat(elapsed),
      },
      ...(existing.scrapeHistory || []).slice(0, 29), // últimas 30 ejecuciones
    ]
  };

  await fs.mkdir('../data', { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(result, null, 2));

  console.log(`\n✅ Scraping completo en ${elapsed}s`);
  console.log(`   📊 Total: ${result.stats.total} promos`);
  console.log(`   ✅ Activas: ${result.stats.active}`);
  console.log(`   ⏳ Próximas: ${result.stats.upcoming}`);
  console.log(`   🆕 Nuevas este run: ${result.stats.newThisRun}`);

  return result;
}

// Ejecutar directamente si se llama como script
if (process.argv[1].endsWith('scraper.js')) {
  runScraper().catch(console.error);
}