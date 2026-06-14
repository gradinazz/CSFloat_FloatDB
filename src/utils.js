'use strict';

/**
 * Общие утилиты и константы проекта.
 */

// Единый User-Agent для всех HTTP-запросов (Steam, CSFloat).
const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/**
 * Промис-задержка.
 * @param {number} ms - миллисекунды
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { BROWSER_UA, delay };
