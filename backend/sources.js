// ═══════════════════════════════════════════════════════════════════
// FUENTES DE BANCOS DOMINICANOS
// Agrega o modifica bancos aquí. El scraper los procesará todos.
// ═══════════════════════════════════════════════════════════════════

export const BANK_SOURCES = [
  {
    id: 'banreservas',
    name: 'Banreservas',
    color: '#d4a017',
    // Página principal de bases de promociones
    promoListUrl: 'https://www.banreservas.com/pages/bases-de-promociones/',
    // Estrategia: la página lista PDFs directamente en el HTML
    strategy: 'html_pdf_links',
    // Selector CSS para encontrar los links de PDF
    pdfLinkSelector: 'a[href$=".pdf"]',
    // Palabras clave: SOLO cashback/devolución/descuento directo
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    // Palabras a EXCLUIR
    excludeKeywords: ['vencid', 'archivo'],
  },
  {
    id: 'bhd',
    name: 'BHD',
    color: '#e63946',
    strategy: 'strapi_api',
    // Página "+ Promociones BHD" — contiene promos activas mezcladas (Día PLUS, descuentos, etc.)
    strapiUrl: 'https://backend.bhd.com.do/api/t-3-s/259?populate=deep&pagination%5BpageSize%5D=50&pagination%5Bpage%5D=1',
    sourceUrl: 'https://www.bhd.com.do/homepage-personal/products/259',
    // 'plus bhd' captura los "Día PLUS BHD" (cashback días específicos)
    // 'oferta' captura otras promos con descuento o devolución
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso', 'plus bhd', 'oferta'],
    // Claude filtra los no-cashbacks como segunda pasada
    excludeKeywords: ['ganador', 'concurso', 'sorteo', 'millas', 'remesa', 'cuota', 'concierto', 'membres', 'gimnas', 'gym'],
    // Contexto adicional para Claude al analizar cards de esta fuente
    cardContextHint: '"Día PLUS BHD" y "Oferta Día PLUS" son el programa de cashback diario de BHD: ofrecen devolución en efectivo (cashback) en compras en comercios específicos durante un día concreto. Las ofertas de categoría/tienda (Gastos educativos, Corripio, San Valentín) pueden ser descuentos directos o cashback en esa categoría.',
    // API de detalles: cada card tiene una página t-4-s con el % de devolución completo
    detailApi: 'https://backend.bhd.com.do/api/t-4-s',
  },
  {
    id: 'scotiabank',
    name: 'Scotiabank',
    color: '#e8003d',
    strategy: 'html_promo_pages',
    // Página de listado — tiene paginación tipo .2.all.all.all.html
    promoListUrl: 'https://do.scotiabank.com/banca-personal/promociones.html',
    listingPages: [
      'https://do.scotiabank.com/banca-personal/promociones.html',
      'https://do.scotiabank.com/banca-personal/promociones.2.all.all.all.html',
      'https://do.scotiabank.com/banca-personal/promociones.3.all.all.all.html',
    ],
    // Selector para links a páginas individuales de promo
    promoLinkSelector: 'a[href*="/post."]',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    excludeKeywords: [],
  },
  {
    id: 'blh',
    name: 'Banco López de Haro',
    color: '#2d6a4f',
    strategy: 'html_promo_pages',
    promoListUrl: 'https://www.blh.com.do/category/promociones/',
    listingPages: ['https://www.blh.com.do/category/promociones/'],
    promoLinkSelector: 'article a[href*="blh.com.do"], h2.entry-title a, .post-title a',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    excludeKeywords: [],
  },
  {
    id: 'lafise',
    name: 'LAFISE',
    color: '#0077b6',
    strategy: 'lafise_json',
    // JSON con todas las promos — se actualiza cuando hay campañas activas
    jsonUrl: 'https://www.lafise.com/blrd/web-resources/widgets/promociones.json',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    // Excluir programas de puntos/lealtad que no son cashback directo
    excludeKeywords: ['lealtad', 'puntos', 'programa'],
  },
  {
    id: 'banesco',
    name: 'Banesco',
    color: '#C8102E',
    strategy: 'html_promo_pages',
    promoListUrl: 'https://www.banesco.com.do/promociones/',
    listingPages: ['https://www.banesco.com.do/promociones/'],
    // Cada promo es una sub-página: /promociones/[slug]/
    promoLinkSelector: 'a[href*="/promociones/"]:not([href$="/promociones/"])',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    // Excluir noticias, concursos, resúmenes mensuales y cuotas sin intereses
    excludeKeywords: ['concurso', 'sorteo', 'millas', 'puntos', 'resumen', 'inaugura', 'multicredito', 'copa mundial'],
  },
  {
    id: 'apap',
    name: 'APAP',
    color: '#CC0000',
    strategy: 'html_pdf_links',
    // Página Cashblack con PDF de bases legales
    promoListUrl: 'https://www.apap.com.do/cashblack/',
    pdfLinkSelector: 'a[href*=".pdf"]',
    keywords: ['cashback', 'devoluc', 'descuento', 'reembolso', 'promo'],
    excludeKeywords: ['pasivos', 'sorteo', 'concurso'],
  },
  {
    id: 'cibao',
    name: 'Asociación Cibao',
    color: '#004C97',
    strategy: 'html_promo_pages',
    promoListUrl: 'https://www.cibao.com.do/banca-personal/ofertas-y-promociones/',
    listingPages: ['https://www.cibao.com.do/banca-personal/ofertas-y-promociones/'],
    // El índice enlaza a páginas mensuales: /ofertas-de-febrero, /ofertas-de-enero, etc.
    promoLinkSelector: 'a[href*="/ofertas-de-"]',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    excludeKeywords: ['sorteo', 'concurso', 'ahorro', 'pasos'],
  },
  {
    id: 'bancocaribe',
    name: 'Banco Caribe',
    color: '#005FA8',
    strategy: 'html_promo_pages',
    promoListUrl: 'https://www.bancocaribe.com.do/novedades',
    listingPages: ['https://www.bancocaribe.com.do/novedades'],
    promoLinkSelector: 'a[href*="bancocaribe.com.do/novedades/"], article a, h2 a, h3 a',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    excludeKeywords: ['sorteo', 'concurso', 'millas'],
  },
  {
    id: 'lanacional',
    name: 'La Nacional',
    color: '#8B1A1A',
    // Las ofertas son inline en una sola página — no hay sub-páginas individuales
    strategy: 'html_inline_cards',
    promoListUrl: 'https://asociacionlanacional.com.do/ofertas-tarjetas',
    cardSelector: '.ofertasTarjetas .boxOffer',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    excludeKeywords: ['sorteo', 'concurso', 'millas'],
  },
  {
    id: 'vimenca',
    name: 'Banco Vimenca',
    color: '#003366',
    // Sitio React SPA — Puppeteer renderiza y luego busca en .promociones-activas
    strategy: 'html_promo_pages',
    promoListUrl: 'https://bancovimenca.com/promociones',
    listingPages: ['https://bancovimenca.com/promociones'],
    promoLinkSelector: '.promociones-activas a, .promocionactiva a, .swiper-slide a[href*="promoci"], a[href*="bancovimenca.com/promoci"]',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    excludeKeywords: ['sorteo', 'concurso', 'millas', 'remesa'],
  },
  {
    id: 'promerica',
    name: 'Promerica',
    color: '#E8622A',
    // Sitio jQuery jplist — JS renderiza las cards en .jplist-item
    strategy: 'html_promo_pages',
    promoListUrl: 'https://promerica.com.do/banca-personal/promociones/',
    listingPages: ['https://promerica.com.do/banca-personal/promociones/'],
    promoLinkSelector: '.jplist-item a, .card-promo a, a[href*="/banca-personal/promociones/"]',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    excludeKeywords: ['puntos', 'lealtad', 'sorteo', 'millas'],
  },
  {
    id: 'popular',
    name: 'Banco Popular',
    color: '#FF0000',
    // Incapsula WAF bloquea axios — usamos dynamic_js (Puppeteer+stealth) para pasar la protección
    strategy: 'dynamic_js',
    promoListUrl: 'https://popular.com.do/personas/tarjetas/promociones/',
    pdfLinkSelector: 'a[href*=".pdf"], a[href*="SiteCollectionDocuments"]',
    keywords: ['cashback', 'devoluc', 'descuento', 'reembolso'],
    excludeKeywords: ['sorteo', 'concurso', 'millas', 'cuota'],
  },
  {
    id: 'bsc',
    name: 'Banco Santa Cruz',
    color: '#12499B',
    // SPA Vue.js + Vuetify — Puppeteer renderiza y sigue links con IDs MongoDB
    strategy: 'html_promo_pages',
    promoListUrl: 'https://bsc.com.do/beneficios',
    listingPages: [
      'https://bsc.com.do/beneficios',
      'https://bsc.com.do/beneficios/categoria/hogar',
      'https://bsc.com.do/beneficios/categoria/tus-tiendas',
      'https://bsc.com.do/promociones',
    ],
    promoLinkSelector: 'a[href*="/about/prouser/"], a[href*="/products/cards/"][href*="/item/"], a.v-card[href], .v-card a[href*="bsc.com.do"]',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    excludeKeywords: ['sorteo', 'concurso', 'millas', 'puntos'],
  },
  {
    id: 'ademi',
    name: 'Banco Ademi',
    color: '#0056A2',
    // WordPress con API REST nativa — categoría 112 = "Promociones", ~50 posts con bases legales inline
    strategy: 'wp_api',
    wpApiUrl: 'https://bancoademi.com.do/wp-json/wp/v2/posts?categories=112&per_page=50&orderby=date&order=desc&_fields=id,title,slug,link,date,content',
    promoListUrl: 'https://bancoademi.com.do/category/promociones/',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso', 'ahorro'],
    excludeKeywords: ['sorteo', 'concurso', 'millas', 'puntos', 'cumbre', 'certificac', 'emprendedor', 'embajador', 'felaban', 'bcie', 'financing'],
    cardContextHint: 'IMPORTANTE: Las promos de Banco Ademi son ofertas COMPUESTAS: la tienda ofrece su propio descuento (ej: 80% en venta de pasillo) y ADICIONALMENTE la tarjeta Ademi da un cashback/devolución extra. El porcentaje total anunciado (ej: "hasta 85% de ahorro") combina ambos. Debes extraer SOLO la porción que corresponde a la tarjeta Ademi (el cashback o devolución adicional que acredita el banco), NO el descuento de la tienda. Busca en las bases legales frases como "X% de devolución adicional", "el banco acreditará X%", o "devolución de hasta X% sobre el consumo". Si no puedes separar claramente la parte del banco, usa null en percentage.',
  },
  {
    id: 'qik',
    name: 'Qik',
    color: '#0082CD',
    // Banco digital dominicano (subsidiaria Grupo Popular). Sitio AEM estático — axios funciona directamente.
    strategy: 'html_pdf_links',
    promoListUrl: 'https://www.qik.do/Promociones_TC_Qik.html',
    pdfLinkSelector: 'a[href*="/content/dam/qik/legal/promociones/"][href$=".pdf"], a[href$=".pdf"]',
    keywords: ['cashback', 'devoluc', 'descuento', 'reembolso'],
    excludeKeywords: ['sorteo', 'concurso', 'millas', 'puntos', 'derechos', 'deberes'],
  },
  {
    id: 'bdi',
    name: 'Banco BDI',
    color: '#1A3A6B',
    // Umbraco CMS, carga con axios, novedades en /novedades/?category=Promociones
    strategy: 'html_promo_pages',
    promoListUrl: 'https://www.bdi.com.do/novedades?category=Promociones',
    listingPages: ['https://www.bdi.com.do/novedades?category=Promociones'],
    promoLinkSelector: 'article h2 a, article a[href*="/novedades/"]',
    keywords: ['devoluc', 'cashback', 'descuento', 'reembolso'],
    excludeKeywords: ['sorteo', 'concurso', 'millas', 'cuota', 'apple pay', 'ranking', 'inclusion'],
  },
];

// Campos que Claude debe extraer de cada PDF
export const EXTRACTION_SCHEMA = {
  title: 'Nombre corto de la promoción',
  description: 'Descripción de qué trata la promo en 1-2 oraciones',
  percentage: 'Porcentaje de devolución o descuento (ej: "15%", o null)',
  promoType: 'Tipo: "devolución" | "descuento"',
  eligibleCards: 'Array de strings con tarjetas que aplican',
  minimumSpend: 'Consumo mínimo requerido (string con monto y moneda)',
  maxReturn: 'Tope máximo de devolución (string con monto y moneda)',
  validFrom: 'Fecha inicio formato YYYY-MM-DD',
  validUntil: 'Fecha fin formato YYYY-MM-DD',
  creditingDate: 'Cuándo se acredita la devolución (string descriptivo)',
  establishments: 'Array de strings con comercios o plataformas participantes',
  categories: 'Array de: "supermercado" | "farmacia" | "restaurante" | "retail" | "online" | "viaje" | "entretenimiento" | "educación" | "combustible" | "bebidas" | "otro"',
  cardTypes: 'Array de: "crédito" | "débito"',
  notes: 'Condiciones importantes o restricciones en max 2 oraciones',
  isActive: 'Boolean: true si la fecha actual (hoy) está dentro del periodo de vigencia',
};
