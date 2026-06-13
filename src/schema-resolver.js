'use strict';

/**
 * SchemaResolver
 *
 * Загрузка CSFloat schema и резолв имён стикеров в ID.
 * API: GET https://csfloat.com/api/v1/schema
 */

const https = require('https');

/**
 * Загружает schema с CSFloat API.
 * @returns {Promise<Object>} schema object
 */
function fetchSchema() {
    return new Promise((resolve, reject) => {
        https.get('https://csfloat.com/api/v1/schema', (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(new Error(`Failed to parse schema JSON: ${err.message}`));
                }
            });
        }).on('error', err => {
            reject(new Error(`Failed to fetch schema: ${err.message}`));
        });
    });
}

/**
 * Резолвит массив имён стикеров в ID через schema.
 *
 * @param {string[]} names - массив market_hash_name стикеров
 * @param {Object} stickers - schema.stickers (ключ=id, значение={market_hash_name, ...})
 * @returns {Array<{name: string, stickerId: number}>}
 * @throws {Error} если имя не найдено в schema
 */
function resolveStickers(names, stickers) {
    // Построить обратный индекс: market_hash_name -> id
    const nameToId = {};
    for (const [id, info] of Object.entries(stickers)) {
        if (info && info.market_hash_name) {
            nameToId[info.market_hash_name] = Number(id);
        }
    }

    const resolved = [];
    const notFound = [];

    for (const name of names) {
        const id = nameToId[name];
        if (id !== undefined) {
            resolved.push({ name, stickerId: id });
        } else {
            notFound.push(name);
        }
    }

    if (notFound.length > 0) {
        throw new Error(`Stickers not found in schema:\n  ${notFound.join('\n  ')}`);
    }

    return resolved;
}

module.exports = { fetchSchema, resolveStickers };
