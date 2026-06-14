'use strict';

/**
 * CSFloat FloatDB Parser
 *
 * Поиск скинов в FloatDB по стикерам, float range, def_index/paint_index.
 *
 * Требования:
 * 1. BotsForge/CloudFlare Turnstile solver запущен (python app.py → http://127.0.0.1:5033)
 * 2. account.json с данными Steam аккаунта
 *
 * Использование:
 *   node index.js --url "https://csfloat.com/db?..."  — поиск по ссылке CSFloat
 *   node index.js                                     — демо-поиск (стикер B1ad3 Boston 2018)
 *   node index.js --stickers 2711,2711                — поиск по sticker IDs
 *   node index.js --stickers 2711 --parse             — информация о скинах (без скачивания)
 *   node index.js --file stickers.txt --count         — подсчёт общего кол-ва наклеенных стикеров (5x/4x/3x/2x/1x)
 *   node index.js --file stickers.txt --parse         — информация о скинах для каждого стикера
 *   node index.js --file urls.txt --parse             — batch-информация по списку URL
 *   node index.js --file urls.txt --parse --delay 2000 -o report.json
 *
 * Многостраничная выкачка (с чекпоинтами и докачкой):
 *   node index.js --url "..." --all -o out.json       — выкачать ВСЕ уникальные
 *                                                        (курсорная пагинация по float, дедуп по float_id)
 *   node index.js --url "..." --pages 20              — первые 20 страниц (offset-режим, для тестов)
 *   node index.js --url "..." --all --resume -o out.json — докачать прерванный out.json
 *   node index.js --url "..." --start 4100 -o out.json   — offset-режим с offset 4100
 */

const fs = require('fs');
const path = require('path');

const CSFloatSession = require('./src/csfloat-session');
const TurnstileSolver = require('./src/turnstile-solver');
const FloatDBClient = require('./src/floatdb-client');
const { parseCSFloatUrl, readInputFile } = require('./src/file-reader');
const BatchProcessor = require('./src/batch-processor');
const { fetchSchema, resolveStickers } = require('./src/schema-resolver');

function generateTimestampedFilename() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `results_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
}

const ORIGIN_NAMES = {
    0: 'Timed Drop', 1: 'Achievement', 2: 'Purchased', 3: 'Traded',
    4: 'Crafted', 5: 'Store Promotion', 6: 'Gifted', 7: 'Support Granted',
    8: 'Found in Crate', 9: 'Earned', 10: 'Third-Party Promotion',
    11: 'Wrapped Gift', 12: 'Halloween Drop', 13: 'Steam Purchase',
    14: 'Foreign Item', 15: 'CD Key', 16: 'Collection Reward',
    17: 'Preview Item', 18: 'Steam Workshop Contribution',
    19: 'Periodic Score Reward', 20: 'Recycling', 21: 'Tournament Drop',
    22: 'Stock Item', 23: 'Quest Reward', 24: 'Level Up Reward'
};

// Проставляет человекочитаемый origin из props (idempotent — для resume/чекпоинтов).
function enrichOrigins(results) {
    for (const item of results) {
        if (item.props !== undefined && item.origin === undefined) {
            const originId = item.props & 0xFF;
            item.origin = ORIGIN_NAMES[originId] || `Unknown (${originId})`;
        }
    }
}

// --- Parse CLI args ---
function parseArgs() {
    const args = process.argv.slice(2);
    // urlParams: raw query params extracted from --url (keys match API param names)
    const urlParams = {};
    // meta: control params not sent to API (pages, all, output)
    const meta = {};
    // overrides: CLI overrides that will be merged on top of urlParams
    const overrides = {};

    let i = 0;
    // Считывает значение следующего аргумента; падает, если оно отсутствует.
    const nextVal = () => {
        const v = args[i + 1];
        if (v === undefined) {
            console.error(`[Main] Missing value for ${args[i]}`);
            process.exit(1);
        }
        i++;
        return v;
    };

    for (i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--url':
                Object.assign(urlParams, parseCSFloatUrl(nextVal()));
                break;
            case '--stickers':
                overrides.stickers = JSON.stringify(nextVal().split(',').map(id => ({ i: id.trim() })));
                break;
            case '--keychains':
                overrides.keychains = JSON.stringify(nextVal().split(',').map(id => ({ i: id.trim() })));
                break;
            case '--collection':
                overrides.collection = nextVal();
                break;
            case '--min':
                overrides.min = nextVal();
                break;
            case '--max':
                overrides.max = nextVal();
                break;
            case '--def':
                overrides.def_index = nextVal();
                break;
            case '--paint':
                overrides.paint_index = nextVal();
                break;
            case '--limit':
                overrides.limit = nextVal();
                break;
            case '--category':
                overrides.category = nextVal();
                break;
            case '--rarity':
                overrides.rarity = nextVal();
                break;
            case '--order':
                overrides.order = nextVal();
                break;
            case '--pages':
                meta.maxPages = parseInt(nextVal(), 10);
                break;
            case '--all':
                meta.all = true;
                break;
            case '--output':
            case '-o':
                meta.outputFile = nextVal();
                break;
            // Новые флаги
            case '--parse':
                meta.parseMode = true;
                break;
            case '--file':
                meta.inputFile = nextVal();
                break;
            case '--count':
                meta.countMode = true;
                break;
            case '--delay':
                meta.delayMs = parseInt(nextVal(), 10);
                break;
            case '--start':
                meta.startOffset = parseInt(nextVal(), 10);
                break;
            case '--resume':
                meta.resume = true;
                break;
        }
    }

    // Merge: URL params as base, CLI overrides on top
    const searchParams = { ...urlParams, ...overrides };
    return { searchParams, meta };
}

async function main() {
    // Load account config
    const accountPath = path.join(__dirname, 'account.json');
    if (!fs.existsSync(accountPath)) {
        console.error('account.json not found! Copy account config to project root.');
        process.exit(1);
    }
    const account = JSON.parse(fs.readFileSync(accountPath, 'utf8'));

    // Init components
    const session = new CSFloatSession(account);
    const solver = new TurnstileSolver();
    const client = new FloatDBClient({ session, solver });

    // Parse search params
    const { searchParams, meta } = parseArgs();
    const delayMs = meta.delayMs || 1500;

    // --- Batch mode: --file ---
    if (meta.inputFile) {
        const filePath = path.resolve(meta.inputFile);
        if (!fs.existsSync(filePath)) {
            console.error(`[Main] Input file not found: ${filePath}`);
            process.exit(1);
        }

        let tasks = readInputFile(filePath);
        console.log(`[Main] Loaded ${tasks.length} tasks from ${meta.inputFile}`);

        // Резолв sticker_name -> sticker через CSFloat Schema API
        const stickerNameTasks = tasks.filter(t => t.type === 'sticker_name');
        if (stickerNameTasks.length > 0) {
            console.log(`[Main] Resolving ${stickerNameTasks.length} sticker names via schema API...`);
            const schema = await fetchSchema();
            const resolved = resolveStickers(stickerNameTasks.map(t => t.name), schema.stickers);
            const resolvedMap = {};
            for (const r of resolved) {
                resolvedMap[r.name] = r.stickerId;
            }
            tasks = tasks.map(t => {
                if (t.type === 'sticker_name') {
                    return { name: t.name, type: 'sticker', stickerId: resolvedMap[t.name] };
                }
                return t;
            });
            console.log(`[Main] Resolved all sticker names to IDs`);
        }

        const category = searchParams.category || null;
        const processor = new BatchProcessor({ client, delayMs, category });
        // Маппинг режимов: --parse → только count (countOnly); --count → craft-уровни 5x..1x (craftLevels).
        const output = await processor.process(tasks, {
            countOnly: meta.parseMode || false,
            craftLevels: meta.countMode || false
        });

        // Вывод результатов в консоль
        if (output.results && Object.keys(output.results).length > 0) {
            console.log('\n--- Results ---');
            for (const [name, data] of Object.entries(output.results)) {
                if (data.totalApplied !== undefined) {
                    // --count mode
                    console.log(`${name}: ${data.totalApplied}`);
                } else if (data.count !== undefined) {
                    // --parse mode
                    console.log(`${name}: ${data.count}`);
                }
            }
        }

        const outputFile = meta.outputFile || generateTimestampedFilename();
        fs.writeFileSync(path.join(__dirname, outputFile), JSON.stringify(output, null, 2));
        console.log(`\n[Main] Results saved to ${outputFile}`);
        return;
    }

    // --- Single parse mode: --parse без --file ---
    if (meta.parseMode) {
        // Дефолты min/max/limit проставляет FloatDBClient.
        const hasFilter = searchParams.stickers || searchParams.keychains ||
            searchParams.collection || searchParams.def_index || searchParams.paint_index ||
            searchParams.category || searchParams.rarity || searchParams.name;
        if (!hasFilter) {
            console.error('[Main] --parse requires search filters (--stickers, --url, etc.)');
            process.exit(1);
        }

        console.log('[Main] Parse mode (count skins)');
        console.log('[Main] Search params:', JSON.stringify(searchParams, null, 2));

        try {
            const data = await client.searchCount(searchParams);
            console.log(`\n[Main] Count: ${data.count}`);
        } catch (err) {
            console.error(`[Main] Error: ${err.message}`);
            process.exit(1);
        }
        return;
    }

    // --- Default search mode ---
    // Дефолты min/max/limit проставляет FloatDBClient.
    // Default demo if no meaningful filter params
    const hasFilter = searchParams.stickers || searchParams.keychains ||
        searchParams.collection || searchParams.def_index || searchParams.paint_index ||
        searchParams.category || searchParams.rarity || searchParams.name;
    if (!hasFilter) {
        console.log('[Main] No search params — running demo search (2× B1ad3 Boston 2018 sticker)');
        searchParams.stickers = JSON.stringify([{ i: '2711' }, { i: '2711' }]);
    }

    console.log('[Main] Search params:', JSON.stringify(searchParams, null, 2));

    // Многостраничная выкачка нужна при --all / --pages>1 / --start / --resume.
    const wantsCrawl = meta.all || (meta.maxPages && meta.maxPages > 1) || meta.startOffset || meta.resume;
    const CHECKPOINT_EVERY = 10; // сохранять частичный результат каждые N страниц

    try {
        if (wantsCrawl) {
            const outputFile = meta.outputFile || generateTimestampedFilename();
            const outputPath = path.join(__dirname, outputFile);

            // Resume: подхватываем уже сохранённые результаты из выходного файла.
            let seedResults = [];
            if (meta.resume && fs.existsSync(outputPath)) {
                const prev = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
                seedResults = prev.results || [];
                console.log(`[Main] Resume: загружено ${seedResults.length} предметов`);
            }

            // --all → курсорная выкачка по float (берёт все уникальные).
            // --pages N → старый offset-режим (для частичных/тестовых прогонов).
            if (meta.all) {
                const save = (results, count, completed) => {
                    enrichOrigins(results); // results уже включают seed (переданы как seedItems)
                    fs.writeFileSync(outputPath, JSON.stringify({
                        count, completed, fetched: results.length, results
                    }, null, 2));
                };

                let sincePage = 0;
                const result = await client.searchAllByFloat(searchParams, {
                    delayMs,
                    seedItems: seedResults,
                    onProgress: async ({ results, totalCount, completed }) => {
                        sincePage++;
                        if (completed || sincePage % CHECKPOINT_EVERY === 0) {
                            save(results, totalCount, completed);
                            console.log(`[Main] Checkpoint: ${results.length} уникальных -> ${outputFile}`);
                        }
                    }
                });

                save(result.results, result.count, result.completed);

                if (result.completed) {
                    console.log(`\n[Main] Готово. Уникальных предметов: ${result.results.length} (count в БД: ${result.count}). Сохранено в ${outputFile}`);
                } else {
                    console.log(`\n[Main] Выкачка прервана (min=${result.nextMin}). Собрано ${result.results.length} уникальных.`);
                    console.log(`[Main] Сохранено в ${outputFile}. Докачать: node index.js <те же фильтры> --all --resume -o ${outputFile}`);
                    process.exitCode = 1;
                }
                return;
            }

            // offset-режим (--pages / --start)
            const maxPages = meta.maxPages || Infinity;
            let startOffset = meta.startOffset || (seedResults.length ? seedResults.length : 0);
            if (seedResults.length) console.log(`[Main] Resume offset: ${startOffset}`);

            const save = (results, count, completed) => {
                const merged = seedResults.concat(results);
                enrichOrigins(merged);
                fs.writeFileSync(outputPath, JSON.stringify({
                    count, completed, fetched: merged.length, results: merged
                }, null, 2));
            };

            let sincePage = 0;
            const result = await client.searchAll(searchParams, {
                maxPages,
                delayMs,
                startOffset,
                onProgress: async ({ results, totalCount, completed }) => {
                    sincePage++;
                    if (completed || sincePage % CHECKPOINT_EVERY === 0) {
                        save(results, totalCount, completed);
                        console.log(`[Main] Checkpoint: ${seedResults.length + results.length} предметов -> ${outputFile}`);
                    }
                }
            });

            // Финальное сохранение — гарантируем последнее состояние на диске.
            save(result.results, result.count, result.completed);

            const totalFetched = seedResults.length + result.results.length;
            if (result.completed) {
                console.log(`\n[Main] Готово. Выкачано ${totalFetched}/${result.count}. Сохранено в ${outputFile}`);
            } else {
                console.log(`\n[Main] Выкачка прервана на offset ${result.nextOffset} (неполная). Выкачано ${totalFetched}/${result.count}.`);
                console.log(`[Main] Сохранено в ${outputFile}. Докачать: node index.js <те же фильтры> --resume -o ${outputFile}`);
                process.exitCode = 1;
            }
            return;
        }

        // --- Одностраничный поиск ---
        const data = await client.search(searchParams);
        const results = data.results || [];
        console.log(`\n[Main] Total in DB: ${data.count}, returned: ${results.length}`);

        // Print summary
        if (results.length > 0) {
            console.log('\n--- Results ---');
            for (const item of results.slice(0, 10)) {
                const stickersStr = (item.stickers || []).map(s => s.name || `#${s.i}`).join(', ');
                console.log(
                    `  float=${item.float_value.toFixed(10)} | ` +
                    `seed=${item.paint_seed} | ` +
                    `owner=${item.s} | ` +
                    `stickers=[${stickersStr}]`
                );
            }
            if (results.length > 10) {
                console.log(`  ... and ${results.length - 10} more`);
            }
        }

        enrichOrigins(results);

        const outputFile = meta.outputFile || generateTimestampedFilename();
        fs.writeFileSync(path.join(__dirname, outputFile), JSON.stringify({ count: results.length, results }, null, 2));
        console.log(`\n[Main] Results saved to ${outputFile}`);

    } catch (err) {
        console.error(`[Main] Error: ${err.message}`);
        if (err.response) {
            console.error(`[Main] Response status: ${err.response.status}`);
            console.error(`[Main] Response data:`, JSON.stringify(err.response.data).slice(0, 500));
        }
        process.exit(1);
    }
}

main();
