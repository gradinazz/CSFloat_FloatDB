'use strict';

/**
 * CraftCounter
 *
 * Подсчёт craft-уровней (5x/4x/3x/2x/1x) для стикеров.
 * Алгоритм аналогичен checker.py:
 * 1. Для каждого уровня N (5→1): запрос с N копиями стикера
 * 2. atLeast[N] = count
 * 3. net[N] = atLeast[N] - atLeast[N+1]
 * 4. totalApplied = sum(N * net[N])
 *
 * Splitting >40k: API лимит count=40000.
 * Если count >= 40000, разбиваем на float sub-ranges и суммируем.
 */

const COUNT_LIMIT = 40000;

const DEFAULT_SUB_RANGES = [
    [0, 0.07],
    [0.07, 0.15],
    [0.15, 0.38],
    [0.38, 0.45],
    [0.45, 1.0]
];

class CraftCounter {
    /**
     * @param {Object} options
     * @param {Object} options.client - FloatDBClient instance
     * @param {number} [options.delayMs=1500] - Задержка между запросами
     */
    constructor({ client, delayMs = 1500, category = null }) {
        this.client = client;
        this.delayMs = delayMs;
        this.category = category;
    }

    /**
     * Подсчёт craft-уровней для одного стикера.
     *
     * @param {number} stickerId - ID стикера
     * @param {string} [name] - Имя стикера (для логов)
     * @returns {Promise<{stickerId: number, atLeast: Object, net: Object, totalApplied: number}>}
     */
    async countCraftLevels(stickerId, name) {
        const label = name || `sticker#${stickerId}`;
        console.log(`[CraftCounter] Counting craft levels for ${label} (ID: ${stickerId})`);

        const atLeast = {};
        let context = null;

        // Запросы от 5 до 1 копии стикера
        for (let level = 5; level >= 1; level--) {
            if (level < 5) {
                await this._delay(this.delayMs);
            }

            const stickers = JSON.stringify(
                Array.from({ length: level }, () => ({ i: String(stickerId) }))
            );
            const params = { stickers, min: '0', max: '1' };
            if (this.category) params.category = this.category;

            const count = await this._getCount(params, context, label, level);
            context = count.context;
            atLeast[level] = count.total;

            console.log(`[CraftCounter] ${label}: atLeast[${level}x] = ${atLeast[level]}`);
        }

        // Вычисляем net: net[N] = atLeast[N] - atLeast[N+1]
        const net = {};
        for (let level = 5; level >= 1; level--) {
            net[level] = atLeast[level] - (atLeast[level + 1] || 0);
        }

        // totalApplied = sum(N * net[N])
        const totalApplied = 5 * net[5] + 4 * net[4] + 3 * net[3] + 2 * net[2] + 1 * net[1];

        console.log(`[CraftCounter] ${label}: net = ${JSON.stringify(net)}, totalApplied = ${totalApplied}`);

        return { stickerId, atLeast, net, totalApplied };
    }

    /**
     * Получает count с автоматическим splitting при >= 40000.
     *
     * @param {Object} params - Query-параметры
     * @param {Object} context - token/fid context
     * @param {string} label - Имя для логов
     * @param {number} level - Уровень (для логов)
     * @returns {Promise<{total: number, context: Object}>}
     */
    async _getCount(params, context, label, level) {
        const result = await this.client.searchCount(params, context);

        if (result.count < COUNT_LIMIT) {
            return { total: result.count, context: result.context };
        }

        console.log(`[CraftCounter] ${label} ${level}x: count=${result.count} >= ${COUNT_LIMIT}, splitting by float ranges...`);
        return this._getCountSplit(params, result.context, label, level, DEFAULT_SUB_RANGES);
    }

    /**
     * Разбивает запрос на float sub-ranges и суммирует count.
     * Рекурсивно бисектирует если sub-range тоже >= 40k.
     */
    async _getCountSplit(params, context, label, level, ranges) {
        let total = 0;
        let ctx = context;

        for (const [min, max] of ranges) {
            await this._delay(this.delayMs);

            const rangeParams = { ...params, min: String(min), max: String(max) };
            const result = await this.client.searchCount(rangeParams, ctx);
            ctx = result.context;

            if (result.count >= COUNT_LIMIT) {
                // Рекурсивная бисекция
                const mid = (min + max) / 2;
                console.log(`[CraftCounter] ${label} ${level}x: sub-range [${min}, ${max}] still >= ${COUNT_LIMIT}, bisecting at ${mid}`);
                const left = await this._getCountSplit(params, ctx, label, level, [[min, mid]]);
                ctx = left.context;
                await this._delay(this.delayMs);
                const right = await this._getCountSplit(params, ctx, label, level, [[mid, max]]);
                ctx = right.context;
                total += left.total + right.total;
            } else {
                console.log(`[CraftCounter] ${label} ${level}x: sub-range [${min}, ${max}] count=${result.count}`);
                total += result.count;
            }
        }

        return { total, context: ctx };
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = CraftCounter;
