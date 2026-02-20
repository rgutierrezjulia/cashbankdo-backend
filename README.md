# CashbackDO 🇩🇴💰
> Scraper automático de cashbacks y descuentos de bancos dominicanos, impulsado por IA

## ¿Qué hace?

- **Scraping diario a las 6 AM** (hora RD) de los sitios de todos los bancos dominicanos
- **Claude AI extrae** porcentaje, tope, mínimo, fechas y tarjetas elegibles de cada promoción
- **API REST** que sirve los datos al frontend
- **Frontend reactivo** con filtros, wallet de tarjetas, geolocalización y notificaciones

## Bancos soportados

| Banco | Estrategia | Fuente |
|-------|-----------|--------|
| Banreservas | `html_pdf_links` | Bases de promociones (PDFs) |
| BHD | `strapi_api` | `backend.bhd.com.do/api/t-3-s/259` — incluye Día PLUS cashback |
| Scotiabank | `html_promo_pages` | Páginas de promociones individuales |
| Banco López de Haro | `html_promo_pages` | Blog de promociones |
| LAFISE | `dynamic_js` | Página de promociones (carga con JS) |

---

## Instalación (15 minutos)

### 1. Requisitos
- Node.js 18+
- Cuenta en Anthropic → [console.anthropic.com](https://console.anthropic.com/)

### 2. Instalar dependencias

```bash
cd backend
npm install
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env`:
```env
ANTHROPIC_API_KEY=sk-ant-tu-key-aqui
ADMIN_API_KEY=pon_algo_seguro_aqui_123
PORT=3001
```

### 4. Iniciar el servidor

```bash
npm start
```

El servidor arrancará y automáticamente:
- Revisará si hay datos previos
- Si no los hay, iniciará un scraping completo de todos los bancos
- Programará scraping diario a las 6:00 AM

### 5. Abrir el frontend

Abre `frontend/index.html` en tu navegador.

Cuando te pida la URL del servidor, ingresa:
```
http://localhost:3001
```

---

## Estructura del proyecto

```
cashbankdo-backend/
├── backend/
│   ├── server.js       # API Express + cron job
│   ├── scraper.js      # Lógica de scraping + Claude AI
│   ├── sources.js      # Config de bancos y URLs ← edita aquí para agregar bancos
│   ├── .env.example    # Variables de entorno
│   └── package.json
├── frontend/
│   └── index.html      # App completa (single file)
└── data/
    └── promos.json     # Base de datos JSON (generada automáticamente)
```

---

## API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/promos` | Todas las promos (con filtros) |
| `GET` | `/api/promos?status=active` | Solo vigentes hoy |
| `GET` | `/api/promos?status=next15` | Vigentes + próximas 15 días |
| `GET` | `/api/promos?bank=banreservas` | Por banco |
| `GET` | `/api/stats` | Estadísticas y últimos scrapes |
| `GET` | `/api/banks` | Lista de bancos con conteos |
| `POST` | `/api/match-wallet` | Matching tarjetas → promos |
| `POST` | `/api/nearby` | Promos según ubicación |
| `POST` | `/api/scrape` | Disparar scrape manual (requiere `X-API-Key`) |
| `GET` | `/api/health` | Estado del servidor |

### Ejemplo: match-wallet

```bash
curl -X POST http://localhost:3001/api/match-wallet \
  -H "Content-Type: application/json" \
  -d '{"cards":[{"bank":"Banreservas","name":"Visa Platinum","tipo":"crédito"}]}'
```

### Ejemplo: scrape manual

```bash
curl -X POST http://localhost:3001/api/scrape \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu_admin_key" \
  -d '{}'
```

---

## Agregar un banco

Edita `backend/sources.js` y agrega un objeto al array `BANK_SOURCES`.

### Estrategia: `html_pdf_links`
Para bancos que listan PDFs directamente en el HTML de la página.

```js
{
  id: 'mi_banco',
  name: 'Mi Banco RD',
  color: '#ff6600',
  strategy: 'html_pdf_links',
  promoListUrl: 'https://www.mibanco.com.do/promociones/',
  pdfLinkSelector: 'a[href$=".pdf"]',
  keywords: ['devoluc', 'descuento', 'cashback'],
  excludeKeywords: ['vencid'],
}
```

### Estrategia: `dynamic_js`
Para bancos cuya página carga con JavaScript (usa Puppeteer).

```js
{
  id: 'mi_banco',
  name: 'Mi Banco RD',
  color: '#ff6600',
  strategy: 'dynamic_js',
  promoListUrl: 'https://www.mibanco.com.do/promociones/',
  pdfLinkSelector: 'a[href$=".pdf"]',
  keywords: ['devoluc', 'descuento', 'cashback'],
  excludeKeywords: [],
}
```

### Estrategia: `html_promo_pages`
Para bancos con páginas individuales por promo (ej. Scotiabank, BLH).

```js
{
  id: 'mi_banco',
  name: 'Mi Banco RD',
  color: '#ff6600',
  strategy: 'html_promo_pages',
  promoListUrl: 'https://www.mibanco.com.do/promociones/',
  listingPages: [
    'https://www.mibanco.com.do/promociones/',
    'https://www.mibanco.com.do/promociones/page/2/',
  ],
  promoLinkSelector: 'article a[href]',
  keywords: ['devoluc', 'descuento', 'cashback'],
  excludeKeywords: [],
}
```

### Estrategia: `strapi_api`
Para bancos con backend Strapi (ej. BHD). Soporta el campo opcional `cardContextHint` para darle a Claude contexto sobre programas propietarios (como "Día PLUS BHD").

```js
{
  id: 'mi_banco',
  name: 'Mi Banco RD',
  color: '#ff6600',
  strategy: 'strapi_api',
  strapiUrl: 'https://backend.mibanco.com.do/api/promotions/1?populate=deep&pagination%5BpageSize%5D=50',
  sourceUrl: 'https://www.mibanco.com.do/promociones',
  keywords: ['devoluc', 'cashback', 'descuento', 'oferta'],
  excludeKeywords: ['millas', 'concierto', 'sorteo'],
  // Opcional: contexto que Claude recibe al analizar cada card
  cardContextHint: '"Día PLUS" es el programa de cashback diario de este banco.',
}
```

---

## Deploy en producción

### Opción A: Railway (recomendado)
1. Conecta este repo en [railway.app](https://railway.app)
2. Agrega las variables de entorno en el dashboard

### Opción B: VPS con PM2
```bash
npm install -g pm2
pm2 start backend/server.js --name cashbackdo
pm2 startup
```

### Frontend
Sirve `frontend/index.html` desde GitHub Pages, Netlify o cualquier hosting estático.
Configura `API_BASE` al URL de tu servidor en producción.

---

## Costos estimados

| Item | Costo |
|------|-------|
| Claude API (Opus, ~50 PDFs/día) | ~$0.50–2.00/día |
| Railway hosting backend | Gratis (hobby plan) |
| Frontend hosting | Gratis (GitHub Pages) |

---

## Notas técnicas

- Los PDFs se procesan con Claude claude-opus-4-6 (visión de documentos)
- Los datos se almacenan en `data/promos.json` (sin base de datos)
- El scraper deduplica por URL para no reprocesar contenido ya visto
- Puppeteer se usa para páginas cargadas por JavaScript
- El estado activo/próximo se recalcula en cada request
