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

const FLOATDB_SEARCH_URL = 'https://csfloat.com/api/v1/floatdb/search';

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
        // Ensure session
        if (!this.sessionJWT) {
            this.sessionJWT = await this.session.getSession();
        }

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

        // Build query params — прокидываем всё из params как есть
        const queryParams = new URLSearchParams();

        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null && value !== '') {
                queryParams.set(key, String(value));
            }
        }

        // Гарантируем наличие min/max/limit
        if (!queryParams.has('min')) queryParams.set('min', '0');
        if (!queryParams.has('max')) queryParams.set('max', '1');
        if (!queryParams.has('limit')) queryParams.set('limit', '100');

        // Добавляем служебные параметры
        queryParams.set('token', token);
        queryParams.set('fid', fid);

        const url = `${FLOATDB_SEARCH_URL}?${queryParams.toString()}`;

        console.log(`[FloatDB] Searching: ${queryParams.toString().replace(/&token=[^&]+/, '&token=***').replace(/&fid=[^&]+/, '')}`);

        let resp;
        try {
            resp = await axios.get(url, {
                headers: {
                    Cookie: `session=${this.sessionJWT}`,
                    Accept: 'application/json, text/plain, */*',
                    Referer: 'https://csfloat.com/db',
                    Origin: 'https://csfloat.com',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
                },
                timeout: 30000
            });
        } catch (err) {
            // При 401/403 — token или session могли протухнуть
            if (err.response && (err.response.status === 401 || err.response.status === 403)) {
                if (context) {
                    // Был context — решаем новый Turnstile
                    console.log(`[FloatDB] Got ${err.response.status}, solving new Turnstile...`);
                    return this.search(params, null);
                }
                // Не было context — возможно session JWT истёк, обновляем
                if (!this._retrying401) {
                    this._retrying401 = true;
                    console.log(`[FloatDB] Got ${err.response.status} without context, refreshing session...`);
                    try {
                        await this.refreshSession();
                        return await this.search(params, null);
                    } finally {
                        this._retrying401 = false;
                    }
                }
                // Если уже ретраили — пробрасываем ошибку
            }
            // При 429 — rate limit, ждём и повторяем (backoff 5-10 мин)
            if (err.response && err.response.status === 429) {
                const waitMs = 5 * 60 * 1000 + Math.floor(Math.random() * 5 * 60 * 1000); // 5-10 мин
                console.log(`[FloatDB] Got 429 (rate limit), waiting ${(waitMs / 60000).toFixed(1)} min...`);
                await this._delay(waitMs);
                return this.search(params, null); // новый token после ожидания
            }
            throw err;
        }

        if (resp.status !== 200) {
            throw new Error(`FloatDB search returned ${resp.status}: ${JSON.stringify(resp.data)}`);
        }

        console.log(`[FloatDB] Found ${resp.data.count} results (returned ${resp.data.results?.length ?? 0})`);
        return { ...resp.data, context: { token, fid } };
    }

    /**
     * Поиск по нескольким страницам.
     * Пагинация через параметр start (offset).
     * Turnstile решается один раз, token/fid переиспользуются.
     *
     * @param {Object} params - Те же что и search()
     * @param {number} [maxPages=3] - Макс. количество страниц
     * @param {number} [delayMs=1000] - Задержка между запросами (мс)
     * @returns {Promise<Array>} Все результаты
     */
    async searchAll(params = {}, maxPages = 3, delayMs = 1000) {
        const allResults = [];
        let totalCount = 0;
        let context = null;
        const limit = parseInt(params.limit ?? '100', 10);

        for (let page = 0; page < maxPages; page++) {
            if (page > 0) {
                console.log(`[FloatDB] Waiting ${delayMs / 1000}s before next page...`);
                await this._delay(delayMs);
            }

            const pageParams = { ...params };
            if (page > 0) {
                pageParams.start = String(page * limit);
            }

            const data = await this.search(pageParams, context);
            context = data.context; // переиспользуем token/fid
            if (page === 0) totalCount = data.count;

            if (!data.results || data.results.length === 0) break;

            allResults.push(...data.results);
            console.log(`[FloatDB] Page ${page + 1}: +${data.results.length} items, ${allResults.length}/${totalCount} total`);

            // Если вернулось меньше limit — больше нет результатов
            if (data.results.length < limit) break;
        }

        return allResults;
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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

    /**
     * Генерирует случайный fingerprint ID (аналог fid из запроса)
     */
    _generateFid() {
        return crypto.randomBytes(10).toString('base64url').slice(0, 20).toLowerCase();
    }
}

module.exports = FloatDBClient;
