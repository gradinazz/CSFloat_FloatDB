'use strict';

/**
 * FileReader
 *
 * Чтение входного файла и авто-определение формата:
 * - JSON объект {"name": id, ...} -> стикеры
 * - JSON массив ["url1", "url2"] -> список URL
 * - Текстовый файл (по строкам) -> список URL
 *
 * Также содержит parseCSFloatUrl() — парсинг URL CSFloat в query-параметры.
 */

const fs = require('fs');

/**
 * Парсит URL CSFloat в объект query-параметров для API.
 * @param {string} urlString - URL вида https://csfloat.com/db?...
 * @returns {Object} raw query params
 */
function parseCSFloatUrl(urlString) {
    const url = new URL(urlString);
    const raw = {};
    for (const [key, value] of url.searchParams.entries()) {
        raw[key] = value;
    }
    return raw;
}

/**
 * Читает входной файл и возвращает массив задач.
 *
 * @param {string} filePath - Путь к файлу
 * @returns {Array<{name: string, type: string, stickerId?: number, url?: string}>}
 */
function readInputFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8').trim();

    // Попытка распарсить как JSON
    if (content.startsWith('{') || content.startsWith('[')) {
        try {
            const parsed = JSON.parse(content);

            // JSON массив -> список URL
            if (Array.isArray(parsed)) {
                return parsed.map(url => ({
                    name: String(url),
                    type: 'url',
                    url: String(url)
                }));
            }

            // JSON объект {"name": id, ...} -> стикеры
            if (typeof parsed === 'object' && parsed !== null) {
                return Object.entries(parsed).map(([name, id]) => ({
                    name,
                    type: 'sticker',
                    stickerId: Number(id)
                }));
            }
        } catch {
            // Не валидный JSON — обрабатываем как текст
        }
    }

    // Текстовый файл — каждая строка это URL или имя стикера
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    return lines.map(line => {
        if (/^https?:\/\//i.test(line)) {
            return { name: line, type: 'url', url: line };
        }
        return { name: line, type: 'sticker_name' };
    });
}

module.exports = { parseCSFloatUrl, readInputFile };
