'use strict';

/**
 * BatchProcessor
 *
 * Оркестрация batch-обработки задач из входного файла.
 * Поддерживает:
 * - sticker + --count -> CraftCounter
 * - sticker + --parse -> searchCount
 * - url + --parse -> searchCount
 * - url без --count -> search с полными результатами
 */

const { parseCSFloatUrl } = require('./file-reader');
const CraftCounter = require('./craft-counter');
const { delay } = require('./utils');

class BatchProcessor {
    /**
     * @param {Object} options
     * @param {Object} options.client - FloatDBClient instance
     * @param {number} [options.delayMs=1500] - Задержка между задачами
     */
    constructor({ client, delayMs = 1500, category = null }) {
        this.client = client;
        this.delayMs = delayMs;
        this.category = category;
        this.craftCounter = new CraftCounter({ client, delayMs, category });
    }

    /**
     * Обрабатывает массив задач.
     *
     * @param {Array} tasks - Задачи из readInputFile()
     * @param {Object} options
     * @param {boolean} [options.countOnly=false] - Только count
     * @param {boolean} [options.craftLevels=false] - Считать craft-уровни
     * @returns {Promise<Object>} Результаты
     */
    async process(tasks, { countOnly = false, craftLevels = false } = {}) {
        const results = {};
        const errors = {};

        console.log(`[Batch] Processing ${tasks.length} tasks (countOnly=${countOnly}, craftLevels=${craftLevels})`);

        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];

            if (i > 0) {
                console.log(`[Batch] Waiting ${this.delayMs / 1000}s before next task...`);
                await delay(this.delayMs);
            }

            console.log(`[Batch] [${i + 1}/${tasks.length}] ${task.name}`);

            try {
                if (task.type === 'sticker' && craftLevels) {
                    results[task.name] = await this.craftCounter.countCraftLevels(task.stickerId, task.name);
                } else if (task.type === 'sticker' && countOnly) {
                    const stickers = JSON.stringify([{ i: String(task.stickerId) }]);
                    const params = { stickers, min: '0', max: '1' };
                    if (this.category) params.category = this.category;
                    const data = await this.client.searchCount(params);
                    results[task.name] = { stickerId: task.stickerId, count: data.count };
                } else if (task.type === 'url' && countOnly) {
                    const params = parseCSFloatUrl(task.url);
                    const data = await this.client.searchCount(params);
                    results[task.name] = { count: data.count };
                } else if (task.type === 'url') {
                    const params = parseCSFloatUrl(task.url);
                    const data = await this.client.search(params);
                    results[task.name] = { count: data.count, results: data.results };
                } else {
                    console.warn(`[Batch] Unknown task type/mode for: ${task.name}`);
                }
            } catch (err) {
                console.error(`[Batch] Error processing ${task.name}: ${err.message}`);
                errors[task.name] = err.message;
            }
        }

        const output = {
            timestamp: new Date().toISOString(),
            task_count: tasks.length,
            results
        };

        if (Object.keys(errors).length > 0) {
            output.errors = errors;
        }

        return output;
    }
}

module.exports = BatchProcessor;
