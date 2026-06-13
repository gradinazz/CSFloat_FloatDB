'use strict';

/**
 * TurnstileSolver
 *
 * Клиент для BotsForge/CloudFlare Turnstile solver.
 * Отправляет задачу на локальный сервер (POST /createTask),
 * затем поллит результат (POST /getTaskResult).
 */

const axios = require('axios');

const CSFLOAT_SITE_KEY = '0x4AAAAAAUb7JKShv3EPttt';
const CSFLOAT_WEBSITE_URL = 'https://csfloat.com/db';

class TurnstileSolver {
    /**
     * @param {Object} options
     * @param {string} [options.serverUrl='http://127.0.0.1:5033'] - URL BotsForge сервера
     * @param {string} [options.apiKey='floatdb-local-key'] - API ключ для сервера
     * @param {number} [options.pollIntervalMs=2000] - Интервал опроса результата
     * @param {number} [options.maxPollAttempts=90] - Макс. количество попыток (90 × 2s = 3 min)
     */
    constructor({ serverUrl = 'http://127.0.0.1:5033', apiKey = 'floatdb-local-key', pollIntervalMs = 2000, maxPollAttempts = 90 } = {}) {
        this.serverUrl = serverUrl;
        this.apiKey = apiKey;
        this.pollIntervalMs = pollIntervalMs;
        this.maxPollAttempts = maxPollAttempts;
        this.client = axios.create({ baseURL: serverUrl, timeout: 15000 });
    }

    /**
     * Решает Turnstile challenge и возвращает токен.
     * При ошибке "token not found" (solver ещё не прогрелся) — ретраит до 3 раз.
     * @returns {Promise<string>} Turnstile token
     */
    async solve() {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const taskId = await this._createTask();
                console.log(`[Turnstile] Task created: ${taskId}`);

                const token = await this._pollResult(taskId);
                console.log(`[Turnstile] Token obtained (${token.length} chars)`);
                return token;
            } catch (err) {
                if (attempt < maxRetries && err.message && err.message.includes('token not found')) {
                    const waitSec = attempt * 10;
                    console.log(`[Turnstile] Token not found (attempt ${attempt}/${maxRetries}), retrying in ${waitSec}s...`);
                    await this._delay(waitSec * 1000);
                    continue;
                }
                throw err;
            }
        }
    }

    async _createTask() {
        const resp = await this.client.post('/createTask', {
            clientKey: this.apiKey,
            task: {
                type: 'AntiTurnstileTaskProxyLess',
                websiteURL: CSFLOAT_WEBSITE_URL,
                websiteKey: CSFLOAT_SITE_KEY
            }
        });

        if (resp.data.status !== 'idle' || !resp.data.taskId) {
            throw new Error(`Turnstile createTask failed: ${JSON.stringify(resp.data)}`);
        }
        return resp.data.taskId;
    }

    async _pollResult(taskId) {
        for (let i = 0; i < this.maxPollAttempts; i++) {
            await this._delay(this.pollIntervalMs);

            const resp = await this.client.post('/getTaskResult', {
                clientKey: this.apiKey,
                taskId
            });

            const { status, solution, errorDescription } = resp.data;

            if (status === 'ready' && solution?.token) {
                return solution.token;
            }

            if (status === 'error') {
                throw new Error(`Turnstile solve error: ${errorDescription || 'unknown'}`);
            }

            // status === 'idle' || 'processing' → continue polling
        }

        throw new Error(`Turnstile solve timeout after ${this.maxPollAttempts} attempts`);
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = TurnstileSolver;
