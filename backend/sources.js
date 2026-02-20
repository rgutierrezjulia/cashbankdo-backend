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
  categories: 'Array de: "online" | "presencial" | "aéreo" | "entretenimiento" | "supermercado" | "restaurante" | "viaje" | "salud" | "educación" | "otro"',
  cardTypes: 'Array de: "crédito" | "débito"',
  notes: 'Condiciones importantes o restricciones en max 2 oraciones',
  isActive: 'Boolean: true si la fecha actual (hoy) está dentro del periodo de vigencia',
};
