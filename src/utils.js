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

/**
 * Форматирует длительность в человекочитаемый вид (Чч Мм Сс).
 * @param {number} ms - миллисекунды
 * @returns {string}
 */
function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}ч ${m}м ${s}с`;
    if (m > 0) return `${m}м ${s}с`;
    return `${s}с`;
}

module.exports = { BROWSER_UA, delay, formatDuration };
