'use strict';

/**
 * Патч BotsForge/CloudFlare solver для совместимости с CSFloat.
 *
 * CSFloat сам встраивает Turnstile на страницу, поэтому:
 * 1. browser.py: не инжектировать свой виджет, дать странице решить самой
 * 2. browser.py: обработать несколько input[name="cf-turnstile-response"]
 * 3. app.py: обернуть print(LOGO) и input() для cp1251/background
 *
 * Скрипт идемпотентный — повторный запуск не ломает файлы.
 */

const fs = require('fs');
const path = require('path');

const SOLVER_DIR = path.join(__dirname, 'solver');

function patchFile(filename, patches) {
    const filePath = path.join(SOLVER_DIR, filename);
    let content = fs.readFileSync(filePath, 'utf8');
    let applied = 0;

    for (const { marker, find, replace, name } of patches) {
        // Если маркер уже есть в файле — патч применён
        if (content.includes(marker)) {
            console.log(`  [SKIP] ${filename}: "${name}" already applied`);
            continue;
        }
        if (!content.includes(find)) {
            console.warn(`  [WARN] ${filename}: "${name}" — pattern not found, skipping`);
            continue;
        }
        content = content.replace(find, replace);
        applied++;
        console.log(`  [OK] ${filename}: "${name}" applied`);
    }

    if (applied > 0) {
        fs.writeFileSync(filePath, content, 'utf8');
    }
}

// --- Патч browser.py ---
patchFile('browser.py', [
    {
        name: 'remove block_rendering and load_captcha from solve_captcha',
        // Уникальный маркер — если в solve_captcha есть wait_until='domcontentloaded', патч уже применён
        marker: "wait_until='domcontentloaded'",
        find: [
            '                await self.block_rendering()',
            '                await self.page.goto(task.websiteURL)',
            '                await self.unblock_rendering()',
            '                await self.load_captcha(websiteKey=task.websiteKey)',
            '                return await self.wait_for_turnstile_token()',
        ].join('\n'),
        replace: [
            "                await self.page.goto(task.websiteURL, wait_until='domcontentloaded')",
            '                return await self.wait_for_turnstile_token()',
        ].join('\n'),
    },
    {
        name: 'fix wait_for_turnstile_token for multiple elements',
        // Уникальный маркер — nth(idx) не существует в оригинале
        marker: 'elements.nth(idx)',
        find: [
            '    async def wait_for_turnstile_token(self) -> str | None:',
            '        locator = self.page.locator(\'input[name="cf-turnstile-response"]\')',
            '',
            '        token = ""',
            '        t = time()',
            '        while not token:',
            '            await asyncio.sleep(0.5)',
            '            try:',
            '                token = await locator.input_value(timeout=500)',
            '                if await self.check_for_checkbox():',
            '                    logger.debug(\'click checkbox\')',
            '            except Exception as er:',
            '                logger.error(er)',
            '                pass',
            '            if token:',
            '                logger.debug(f\'got captcha token: {token}\')',
            '            if t + 15 < time():',
            '                logger.warning(\'token not found\')',
            '                return None',
            '        return token',
        ].join('\n'),
        replace: [
            '    async def wait_for_turnstile_token(self) -> str | None:',
            '        t = time()',
            '        while True:',
            '            await asyncio.sleep(0.5)',
            '            try:',
            '                # Find all cf-turnstile-response inputs, take first with value',
            '                elements = self.page.locator(\'input[name="cf-turnstile-response"]\')',
            '                count = await elements.count()',
            '                for idx in range(count):',
            '                    value = await elements.nth(idx).input_value(timeout=500)',
            '                    if value:',
            '                        logger.debug(f\'got captcha token: {value}\')',
            '                        return value',
            '                if await self.check_for_checkbox():',
            '                    logger.debug(\'click checkbox\')',
            '            except Exception as er:',
            '                logger.error(er)',
            '            if t + 60 < time():',
            '                logger.warning(\'token not found\')',
            '                return None',
        ].join('\n'),
    },
]);

// --- Патч app.py ---
patchFile('app.py', [
    {
        name: 'wrap print(LOGO) for cp1251',
        // Уникальный маркер — UnicodeEncodeError не существует в оригинале
        marker: 'UnicodeEncodeError',
        find: '        print(LOGO)',
        replace: [
            '        try:',
            '            print(LOGO)',
            '        except UnicodeEncodeError:',
            '            print("BotsForge CloudFlare Solver")',
        ].join('\n'),
    },
    {
        name: 'wrap input() for background mode',
        // Уникальный маркер — EOFError не существует в оригинале
        marker: 'EOFError',
        find: "        input('press <Enter> to close...')",
        replace: [
            '        try:',
            "            input('press <Enter> to close...')",
            '        except EOFError:',
            '            pass',
        ].join('\n'),
    },
]);

console.log('  Solver patching complete.');
