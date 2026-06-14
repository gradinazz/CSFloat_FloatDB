'use strict';

/**
 * SchemaResolver
 *
 * Загрузка CSFloat schema и резолв имён стикеров в ID.
 * API: GET https://csfloat.com/api/v1/schema
 */

const axios = require('axios');

const SCHEMA_URL = 'https://csfloat.com/api/v1/schema';

/**
 * Загружает schema с CSFloat API.
 * @returns {Promise<Object>} schema object
 */
async function fetchSchema() {
    try {
        const resp = await axios.get(SCHEMA_URL, { timeout: 30000 });
        return resp.data;
    } catch (err) {
        throw new Error(`Failed to fetch schema: ${err.message}`);
    }
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
