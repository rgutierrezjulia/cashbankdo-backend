# CashbackDO - Claude Project Memory

## What This Is
AI-powered scraper for Dominican bank cashback/discount promotions. Scrapes 16 banks daily at 6 AM (Dominican time), extracts promo details via Claude API, serves via Express REST API. Deployed on Railway.

## Architecture
- **Backend**: `backend/server.js` (Express + cron) + `backend/scraper.js` (scraping + Claude AI extraction)
- **Bank config**: `backend/sources.js` — each bank has an `id`, `strategy`, URLs, keywords
- **Data**: `data/promos.json` (local) + Upstash Redis (backup)
- **Frontend**: `frontend/index.html` (single-file SPA)
- **Deploy**: Railway (auto-deploys on push to `master`), GitHub Actions pings `/api/health` every 5 min to prevent sleep

## Scraping Strategies (8 types)
- `html_pdf_links` — Banreservas, APAP
- `strapi_api` — BHD (has `detailApi` for card details)
- `html_promo_pages` — Scotiabank, Banesco, Banco Caribe, Promerica, Banco Santa Cruz
- `axios_html_promo_pages` — Asociacion Cibao, Banco BDI (bypasses Railway IP blocking)
- `wp_rss` — Banco Lopez de Haro
- `wp_api` — Banco Ademi
- `lafise_json` — LAFISE
- `html_inline_cards` — La Nacional
- `strapi_pdf` — Banco Vimenca
- `dynamic_js` — Qik (AEM CMS, Puppeteer stealth)
- `instagram_apify` — **Banco Popular** (Incapsula WAF blocks datacenter IPs; scrapes @popularenlinea Instagram via Apify free tier). Requires `APIFY_API_TOKEN` env var.

## Deduplication System (CRITICAL — read carefully)
The scraper uses Claude AI for intelligent deduplication. On each run, it sends existing active promos as context and asks Claude to respond:
- **KNOWN** — promo exists unchanged, skip it
- **SKIP** — not a cashback/discount promo
- **JSON with `_action: "correction"`** — promo exists but has changes (extended dates, different %, updated terms). Includes `_correctedId` to link to original.
- **JSON with `_action: "new"`** — genuinely new promo

### Promo extensions & recently-expired context (FIXED)
`formatExistingPromosForContext()` includes promos expired within the last **14 days** (tagged `[EXPIRADA]`) in the context sent to Claude. This allows Claude to detect when banks extend/renew an expired promo with new dates and issue a `_action: "correction"` instead of treating it as brand new.

**Why this matters**: Dominican banks frequently extend promos after they expire (e.g., education cashback Feb 8-13, then extended Feb 16-20). Without seeing the expired original, Claude cannot link the extension back.

### Historical example
Banco Popular had an education cashback promo (Feb 8-13). On Feb 16, they extended it to Feb 20. The scraper missed it because: (1) API credits ran out Feb 14-15, (2) when it ran again, the original was expired and excluded from dedup context. Fixed by including 14-day expired promos.

## Manual Scrape
```
POST https://cashbankdo-backend-production.up.railway.app/api/scrape
Header: X-API-Key: <ADMIN_API_KEY from Railway env vars>
Body: {"banks": ["popular"]}  // optional, omit for all banks
```

## Environment Variables (Railway)
- `ANTHROPIC_API_KEY` — Claude API key (check credits if scraper fails silently!)
- `ADMIN_API_KEY` — protects manual scrape endpoint
- `APIFY_API_TOKEN` — required for Banco Popular Instagram strategy
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — Redis backup
- `PROXY_URL` — optional, for banks that block datacenter IPs

## Common Failure Modes
1. **Scraper doesn't run / all banks fail**: Check Anthropic API credits first. The circuit breaker aborts if the first 3 banks fail with the same error.
2. **Banco Popular returns 0 promos**: Was using `dynamic_js` (Puppeteer) which got blocked by Incapsula WAF. Now uses `instagram_apify` strategy.
3. **Promo extensions not detected**: See "KNOWN BUG" above. Recently-expired promos are excluded from dedup context.

## Lessons Learned
- Dominican banks frequently extend promos with new dates after the original expires. The dedup system MUST account for this by including recently-expired promos in the context window.
- Always verify merges actually landed on `master` and were pushed. Worktree branches (`.claude/worktrees/`) don't auto-merge.
- Railway auto-deploys on push to `master`. After merging, confirm deployment before triggering a scrape.
- When API credits run out, the scraper fails silently (0 promos found per bank, no crash). Check `/api/stats` scrape history for suspicious all-zero runs.

## Git Workflow
- Main branch: `master`
- Claude worktrees: `.claude/worktrees/<name>` with branches `claude/<name>`
- PRs go through GitHub. Worktree branches must be pushed and PR'd to merge into `master`.
- Always confirm the commit is on `master` AND pushed to `origin/master` before assuming Railway has it.

## Key Files to Edit
- Add/modify a bank: `backend/sources.js`
- Change scraping logic: `backend/scraper.js`
- Change API routes or cron schedule: `backend/server.js`
- Frontend: `frontend/index.html`

## ACTION REQUIRED: Rotate ADMIN_API_KEY
The ADMIN_API_KEY was exposed in a chat session on 2026-02-23. **Remind the user to rotate it** in Railway dashboard → Variables tab. The key is only used server-side for manual scrape triggers, so just update it in Railway and remember the new value.

## Monetization (exploring)
- AdSense requires a custom domain — not viable during beta on GitHub Pages / free subdomains
- **Affiliate links with Dominican banks** is the preferred strategy — natural fit since the app already shows which cards have the best promos. Research which banks (Popular, BHD, Banreservas, etc.) offer affiliate/referral programs for card applications.
- Frontend is currently hosted at: https://rgutierrezjulia.github.io/cashbankdo-backend/
- Consider migrating frontend to Netlify (`cashbackdo.netlify.app`) for a cleaner URL, then eventually buy a `.com.do` domain when ready to monetize with AdSense
