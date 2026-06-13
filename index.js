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
 */

const fs = require('fs');
const path = require('path');

const CSFloatSession = require('./src/csfloat-session');
const TurnstileSolver = require('./src/turnstile-solver');
const FloatDBClient = require('./src/floatdb-client');
const { parseCSFloatUrl, readInputFile } = require('./src/file-reader');
const BatchProcessor = require('./src/batch-processor');
const { fetchSchema, resolveStickers } = require('./src/schema-resolver');

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

// --- Parse CLI args ---
function parseArgs() {
    const args = process.argv.slice(2);
    // urlParams: raw query params extracted from --url (keys match API param names)
    const urlParams = {};
    // meta: control params not sent to API (pages, all, output)
    const meta = {};
    // overrides: CLI overrides that will be merged on top of urlParams
    const overrides = {};

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--url':
                Object.assign(urlParams, parseCSFloatUrl(args[++i]));
                break;
            case '--stickers':
                overrides.stickers = JSON.stringify(args[++i].split(',').map(id => ({ i: id.trim() })));
                break;
            case '--keychains':
                overrides.keychains = JSON.stringify(args[++i].split(',').map(id => ({ i: id.trim() })));
                break;
            case '--collection':
                overrides.collection = args[++i];
                break;
            case '--min':
                overrides.min = args[++i];
                break;
            case '--max':
                overrides.max = args[++i];
                break;
            case '--def':
                overrides.def_index = args[++i];
                break;
            case '--paint':
                overrides.paint_index = args[++i];
                break;
            case '--limit':
                overrides.limit = args[++i];
                break;
            case '--category':
                overrides.category = args[++i];
                break;
            case '--rarity':
                overrides.rarity = args[++i];
                break;
            case '--order':
                overrides.order = args[++i];
                break;
            case '--pages':
                meta.maxPages = parseInt(args[++i], 10);
                break;
            case '--all':
                meta.all = true;
                break;
            case '--output':
            case '-o':
                meta.outputFile = args[++i];
                break;
            // Новые флаги
            case '--parse':
                meta.parseMode = true;
                break;
            case '--file':
                meta.inputFile = args[++i];
                break;
            case '--count':
                meta.countMode = true;
                break;
            case '--delay':
                meta.delayMs = parseInt(args[++i], 10);
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

        const outputFile = meta.outputFile || 'results.json';
        fs.writeFileSync(path.join(__dirname, outputFile), JSON.stringify(output, null, 2));
        console.log(`\n[Main] Results saved to ${outputFile}`);
        return;
    }

    // --- Single parse mode: --parse без --file ---
    if (meta.parseMode) {
        // Defaults: min/max if not provided
        if (!searchParams.min) searchParams.min = '0';
        if (!searchParams.max) searchParams.max = '1';

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
    // Defaults: min/max/limit if not provided
    if (!searchParams.min) searchParams.min = '0';
    if (!searchParams.max) searchParams.max = '1';
    if (!searchParams.limit) searchParams.limit = '100';

    // Default demo if no meaningful filter params
    const hasFilter = searchParams.stickers || searchParams.keychains ||
        searchParams.collection || searchParams.def_index || searchParams.paint_index ||
        searchParams.category || searchParams.rarity || searchParams.name;
    if (!hasFilter) {
        console.log('[Main] No search params — running demo search (2× B1ad3 Boston 2018 sticker)');
        searchParams.stickers = JSON.stringify([{ i: '2711' }, { i: '2711' }]);
    }

    console.log('[Main] Search params:', JSON.stringify(searchParams, null, 2));

    try {
        let results;
        const maxPages = meta.all ? Infinity : meta.maxPages;
        if (maxPages && maxPages > 1) {
            results = await client.searchAll(searchParams, maxPages);
            console.log(`\n[Main] Total results: ${results.length}`);
        } else {
            const data = await client.search(searchParams);
            results = data.results;
            console.log(`\n[Main] Total in DB: ${data.count}, returned: ${results.length}`);
        }

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

        for (const item of results) {
            if (item.props !== undefined) {
                const originId = item.props & 0xFF;
                item.origin = ORIGIN_NAMES[originId] || `Unknown (${originId})`;
            }
        }

        const outputFile = meta.outputFile || 'results.json';
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
