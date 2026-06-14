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

// Сколько раз пробуем восстановиться после 401/403 (re-solve → refresh session).
const MAX_AUTH_RETRIES = 2;

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
     * @param {Object} params - Те же что и search()
     * @param {number} [maxPages=3] - Макс. количество страниц
     * @param {number} [delayMs=1000] - Задержка между запросами (мс)
     * @returns {Promise<Array>} Все результаты
     */
    async searchAll(params = {}, maxPages = 3, delayMs = 1000) {
        const allResults = [];
        let totalCount = 0;
        const limit = parseInt(params.limit ?? '100', 10);

        await this._ensureSession();

        // Pre-solve first token
        console.log('[FloatDB] Solving initial Turnstile...');
        let nextToken = await this.solver.solve();
        const fid = this._generateFid();

        for (let page = 0; page < maxPages; page++) {
            if (page > 0) {
                await delay(delayMs);
            }

            const pageParams = { ...params };
            if (page > 0) {
                pageParams.start = String(page * limit);
            }

            // Use the pre-solved token for this request
            const currentToken = nextToken;

            // Start solving next token IN PARALLEL with the API request (pipeline)
            const needsMore = (page + 1) < maxPages;
            let nextTokenPromise = null;
            if (needsMore) {
                nextTokenPromise = this.solver.solve().catch(err => {
                    console.log(`[FloatDB] Pre-solve failed: ${err.message}, will solve on demand`);
                    return null;
                });
            }

            // Make API request with current token
            const { data } = await this._request(pageParams, currentToken, fid);

            if (page === 0) totalCount = data.count;

            if (!data.results || data.results.length === 0) break;

            allResults.push(...data.results);
            console.log(`[FloatDB] Page ${page + 1}: +${data.results.length} items, ${allResults.length}/${totalCount} total`);

            // Если вернулось меньше limit — больше нет результатов
            if (data.results.length < limit) break;

            // Get the pre-solved next token (or solve fresh if it failed)
            if (needsMore) {
                nextToken = await nextTokenPromise;
                if (!nextToken) {
                    console.log('[FloatDB] Solving Turnstile (on demand)...');
                    nextToken = await this.solver.solve();
                }
            }
        }

        return allResults;
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
    async _request(params, token, fid, attempt = 0) {
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

            if ((status === 401 || status === 403) && attempt < MAX_AUTH_RETRIES) {
                if (attempt === 0) {
                    console.log(`[FloatDB] Got ${status}, solving new Turnstile...`);
                } else {
                    console.log(`[FloatDB] Got ${status} again, refreshing session...`);
                    await this.refreshSession();
                }
                const freshToken = await this.solver.solve();
                return this._request(params, freshToken, this._generateFid(), attempt + 1);
            }

            if (status === 429) {
                const waitMs = 5 * 60 * 1000 + Math.floor(Math.random() * 5 * 60 * 1000); // 5-10 мин
                console.log(`[FloatDB] Got 429 (rate limit), waiting ${(waitMs / 60000).toFixed(1)} min...`);
                await delay(waitMs);
                const freshToken = await this.solver.solve();
                return this._request(params, freshToken, this._generateFid(), attempt); // 429 не тратит попытки auth
            }

            throw err;
        }
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
