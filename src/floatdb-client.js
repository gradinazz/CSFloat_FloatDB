'use strict';

/**
 * FloatDBClient
 *
 * Клиент для CSFloat FloatDB API.
 * Комбинирует session cookie + Turnstile token для запросов к /api/v1/floatdb/search.
 *
 * Принимает "сырые" query-параметры (как в URL CSFloat) и прокидывает их в API.
 * Автоматически добавляет token (Turnstile) и fid (fingerprint).
 */

const axios = require('axios');
const crypto = require('crypto');

const { BROWSER_UA, delay } = require('./utils');

const FLOATDB_SEARCH_URL = 'https://csfloat.com/api/v1/floatdb/search';
const REQUEST_TIMEOUT_MS = 30000;

// Сколько раз пробуем восстановиться после "обычного" 401/403 (re-solve → refresh session).
const MAX_AUTH_RETRIES = 2;

// Анти-бот стенка: 401 code 116 ("failed to verify recaptcha") и 429 (rate limit).
// Это поведенческий троттлинг — лечится паузой, а не мгновенным пере-solve.
// Ретраим БЕСКОНЕЧНО (пока стенка не спадёт), но длительность паузы ограничена потолком.
const RECAPTCHA_THROTTLE_CODE = 116;
const THROTTLE_BACKOFF_MAX_MS = 10 * 60 * 1000; // потолок паузы между попытками — 10 мин

class FloatDBClient {
    /**
     * @param {Object} options
     * @param {Object} options.session - CSFloatSession instance
     * @param {Object} options.solver - TurnstileSolver instance
     */
    constructor({ session, solver }) {
        this.session = session;
        this.solver = solver;
        this.sessionJWT = null;
    }

    /**
     * Выполняет поиск в FloatDB.
     *
     * @param {Object} params - Объект с query-параметрами (ключи = имена параметров API).
     * @param {Object} [context] - Контекст для переиспользования token/fid между страницами.
     *   { token, fid } — если передан, Turnstile не решается заново.
     * @returns {Promise<{count: number, results: Array, context: Object}>}
     */
    async search(params = {}, context = null) {
        await this._ensureSession();

        // Решаем Turnstile только если нет готового контекста
        let token, fid;
        if (context && context.token && context.fid) {
            token = context.token;
            fid = context.fid;
        } else {
            console.log('[FloatDB] Solving Turnstile...');
            token = await this.solver.solve();
            fid = this._generateFid();
        }

        const { data, token: usedToken, fid: usedFid } = await this._request(params, token, fid);
        return { ...data, context: { token: usedToken, fid: usedFid } };
    }

    /**
     * Поиск по нескольким страницам.
     * Пагинация через параметр start (offset).
     * Pipeline: следующий Turnstile token решается параллельно с текущим запросом.
     *
     * Устойчивость:
     *  - fid ротируется на каждую страницу, задержка с джиттером (анти-детект);
     *  - 116/429 обрабатываются внутри _request паузой+ретраем (бесконечно, пока не спадёт);
     *  - любая неустранимая ошибка НЕ роняет процесс: возвращаем уже собранное
     *    + nextOffset для докачки (resume), вызвав onProgress с последним состоянием.
     *
     * @param {Object} params - Те же что и search()
     * @param {Object} [options]
     * @param {number} [options.maxPages=Infinity] - Макс. количество страниц
     * @param {number} [options.delayMs=1500] - Базовая задержка между запросами (мс)
     * @param {number} [options.startOffset=0] - Смещение старта (для resume)
     * @param {Function} [options.onProgress] - async ({results, offset, totalCount, completed, error}) после каждой страницы
     * @returns {Promise<{results: Array, count: number, completed: boolean, nextOffset: number, error?: Error}>}
     */
    async searchAll(params = {}, { maxPages = Infinity, delayMs = 1500, startOffset = 0, onProgress = null } = {}) {
        const limit = parseInt(params.limit ?? '100', 10);
        await this._ensureSession();

        const allResults = [];
        let totalCount = 0;
        let offset = startOffset;
        let completed = false;

        // Pre-solve first token
        console.log('[FloatDB] Solving initial Turnstile...');
        let nextToken = await this.solver.solve();

        try {
            for (let page = 0; page < maxPages; page++) {
                if (page > 0 || startOffset > 0) {
                    await delay(this._jitter(delayMs));
                }

                const pageParams = { ...params };
                if (offset > 0) pageParams.start = String(offset);

                const currentToken = nextToken;
                const fid = this._generateFid(); // ротация fid на каждую страницу

                // Pre-solve следующий token параллельно с текущим запросом (pipeline)
                const needsMore = (page + 1) < maxPages;
                let nextTokenPromise = null;
                if (needsMore) {
                    nextTokenPromise = this.solver.solve().catch(err => {
                        console.log(`[FloatDB] Pre-solve failed: ${err.message}, will solve on demand`);
                        return null;
                    });
                }

                const { data } = await this._request(pageParams, currentToken, fid);

                if (totalCount === 0) totalCount = data.count;

                const batch = data.results || [];
                if (batch.length === 0) { completed = true; break; }

                allResults.push(...batch);
                offset += batch.length;
                console.log(`[FloatDB] Page ${page + 1}: +${batch.length} items, ${allResults.length} fetched, offset=${offset}/${totalCount}`);

                if (onProgress) await onProgress({ results: allResults, offset, totalCount, completed: false });

                // Если вернулось меньше limit — больше нет результатов
                if (batch.length < limit) { completed = true; break; }

                // Берём pre-solved token (или решаем на месте, если pre-solve упал)
                if (needsMore) {
                    nextToken = await nextTokenPromise;
                    if (!nextToken) {
                        console.log('[FloatDB] Solving Turnstile (on demand)...');
                        nextToken = await this.solver.solve();
                    }
                }
            }
            if (!completed) completed = (offset >= totalCount); // упёрлись в maxPages
        } catch (err) {
            console.error(`[FloatDB] Crawl stopped at offset=${offset}: ${err.message}`);
            if (onProgress) await onProgress({ results: allResults, offset, totalCount, completed: false, error: err.message });
            return { results: allResults, count: totalCount, completed: false, nextOffset: offset, error: err };
        }

        if (onProgress) await onProgress({ results: allResults, offset, totalCount, completed });
        return { results: allResults, count: totalCount, completed, nextOffset: offset };
    }

    /**
     * Выполняет поиск и возвращает только count + context.
     * Использует limit=1 для минимальной нагрузки.
     *
     * @param {Object} params - Query-параметры (как в search)
     * @param {Object} [context] - Контекст для переиспользования token/fid
     * @returns {Promise<{count: number, context: Object}>}
     */
    async searchCount(params = {}, context = null) {
        const countParams = { ...params, limit: '1' };
        const data = await this.search(countParams, context);
        return { count: data.count, context: data.context };
    }

    /**
     * Обновить session (если expired)
     */
    async refreshSession() {
        this.sessionJWT = await this.session.getSession();
    }

    // --- Внутренние помощники ---

    async _ensureSession() {
        if (!this.sessionJWT) {
            this.sessionJWT = await this.session.getSession();
        }
    }

    /**
     * Единая точка HTTP-запроса к FloatDB с обработкой 401/403/429.
     *
     * Восстановление:
     *  - 401/403, попытка 1: решаем новый Turnstile (token протух);
     *  - 401/403, попытка 2: обновляем session JWT и решаем новый Turnstile;
     *  - 429: ждём 5-10 мин и повторяем со свежим token (без расхода попыток auth).
     *
     * @returns {Promise<{data: Object, token: string, fid: string}>}
     *   token/fid — фактически использованные при успешном запросе (для переиспользования).
     */
    async _request(params, token, fid, retries = { auth: 0, throttle: 0 }) {
        const queryParams = this._buildQuery(params, token, fid);
        const url = `${FLOATDB_SEARCH_URL}?${queryParams.toString()}`;
        console.log(`[FloatDB] Searching: ${this._maskQuery(queryParams)}`);

        try {
            const resp = await axios.get(url, {
                headers: this._headers(),
                timeout: REQUEST_TIMEOUT_MS
            });
            console.log(`[FloatDB] Found ${resp.data.count} results (returned ${resp.data.results?.length ?? 0})`);
            return { data: resp.data, token, fid };
        } catch (err) {
            const status = err.response?.status;
            const code = err.response?.data?.code;

            // --- Поведенческий троттлинг: 429 ИЛИ 401 code 116 ("failed to verify recaptcha") ---
            // Свежий токен тут не помогает мгновенно — нужно дать сессии "остыть".
            // Ретраим бесконечно: ждём и пробуем снова, пока стенка не спадёт.
            if (status === 429 || (status === 401 && code === RECAPTCHA_THROTTLE_CODE)) {
                const waitMs = this._throttleBackoff(status, retries.throttle);
                const tag = status === 429 ? '429 (rate limit)' : `401 code ${code} (recaptcha wall)`;
                console.log(`[FloatDB] Throttled: ${tag}, waiting ${(waitMs / 1000).toFixed(0)}s (attempt ${retries.throttle + 1}, retrying until it clears)...`);
                await delay(waitMs);
                const freshToken = await this.solver.solve();
                return this._request(params, freshToken, this._generateFid(), { ...retries, throttle: retries.throttle + 1 });
            }

            // --- Обычные 401/403: токен/сессия протухли ---
            if ((status === 401 || status === 403) && retries.auth < MAX_AUTH_RETRIES) {
                if (retries.auth === 0) {
                    console.log(`[FloatDB] Got ${status}, solving new Turnstile...`);
                } else {
                    console.log(`[FloatDB] Got ${status} again, refreshing session...`);
                    await this.refreshSession();
                }
                const freshToken = await this.solver.solve();
                return this._request(params, freshToken, this._generateFid(), { ...retries, auth: retries.auth + 1 });
            }

            throw err;
        }
    }

    /**
     * Бэкофф для троттлинга.
     *  - 429 (rate limit): 5-10 мин;
     *  - 116 (recaptcha wall): эскалирующий 60с + n*30с за каждую попытку,
     *    с потолком THROTTLE_BACKOFF_MAX_MS, + джиттер 0-60с.
     */
    _throttleBackoff(status, throttleCount) {
        if (status === 429) {
            return 5 * 60 * 1000 + Math.floor(Math.random() * 5 * 60 * 1000); // 5-10 мин
        }
        const base = Math.min(60 * 1000 + throttleCount * 30 * 1000, THROTTLE_BACKOFF_MAX_MS);
        return base + Math.floor(Math.random() * 60 * 1000); // +0-60с джиттер
    }

    /** Случайный джиттер задержки: 0.75x..1.5x от базовой. */
    _jitter(ms) {
        return Math.floor(ms * (0.75 + Math.random() * 0.75));
    }

    /**
     * Строит query-параметры: прокидывает params как есть, гарантирует min/max/limit,
     * добавляет служебные token/fid.
     */
    _buildQuery(params, token, fid) {
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null && value !== '') {
                queryParams.set(key, String(value));
            }
        }
        if (!queryParams.has('min')) queryParams.set('min', '0');
        if (!queryParams.has('max')) queryParams.set('max', '1');
        if (!queryParams.has('limit')) queryParams.set('limit', '100');
        queryParams.set('token', token);
        queryParams.set('fid', fid);
        return queryParams;
    }

    /** Маскирует token и убирает fid в логах. */
    _maskQuery(queryParams) {
        return queryParams.toString()
            .replace(/&token=[^&]+/, '&token=***')
            .replace(/&fid=[^&]+/, '');
    }

    _headers() {
        return {
            Cookie: `session=${this.sessionJWT}`,
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://csfloat.com/db',
            Origin: 'https://csfloat.com',
            'User-Agent': BROWSER_UA
        };
    }

    /**
     * Генерирует случайный fingerprint ID (аналог fid из запроса).
     * 15 байт base64url = ровно 20 символов.
     */
    _generateFid() {
        return crypto.randomBytes(15).toString('base64url').slice(0, 20);
    }
}

module.exports = FloatDBClient;
