<div align="center">

<img src="Logo.png" alt="CSFloat FloatDB Parser" width="420">

# 🎯 CSFloat FloatDB Parser

**Парсер базы [CSFloat FloatDB](https://csfloat.com/db) — поиск скинов CS2 по стикерам, float, паттернам и коллекциям.**

![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/Python-%3E%3D3.10-3776AB?logo=python&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)
![Version](https://img.shields.io/badge/version-1.0.0--beta-orange)

</div>

---

## 📖 Содержание

- [Возможности](#-возможности)
- [Как это работает](#️-как-это-работает)
- [Требования](#-требования)
- [Быстрый старт](#-быстрый-старт)
- [Настройка аккаунта](#-настройка-аккаунта)
- [Использование](#-использование)
  - [Поиск](#поиск)
  - [Полная выкачка `--all`](#полная-выкачка---all)
  - [Parse-режим (только count)](#parse-режим-только-count)
  - [Batch из файла](#batch-из-файла)
  - [Подсчёт наклеенных стикеров `--count`](#подсчёт-наклеенных-стикеров---count)
- [Справочник CLI-флагов](#-справочник-cli-флагов)
- [Фильтрация по категории](#-фильтрация-по-категории---category)
- [Формат вывода](#-формат-вывода)
- [Архитектура](#-архитектура)
- [Лицензия](#-лицензия)

---

## ✨ Возможности

- 🔎 **Поиск скинов** по стикерам, keychain'ам, коллекции, `def_index`/`paint_index`, диапазону float, редкости.
- 🔗 **Парсинг URL** — вставь ссылку из CSFloat DB и забери результаты.
- 📦 **Полная выкачка** всех уникальных предметов через курсорную пагинацию по float (`--all`), с чекпоинтами и докачкой.
- 🧮 **Подсчёт наклеенных стикеров** по уровням 5x/4x/3x/2x/1x (`--count`) с авто-разбиением при больших выборках.
- 📋 **Batch-режим** — пачка стикеров или URL из одного файла; имена стикеров резолвятся в ID автоматически.
- 🛡️ **Устойчивость** — обработка троттлинга (`429`, recaptcha wall), ретраи сетевых сбоев/таймаутов, ротация fingerprint, джиттер задержек.
- 🔁 **Докачка с перепроверкой** — `--resume` отступает назад и перечитывает уже собранную зону, восстанавливая пропущенное при обрыве (с логом `восстановлено N`).

---

## ⚙️ Как это работает

```
Steam-аккаунт ──login+2FA──> CSFloat session (JWT)
                                   │
        Turnstile solver (Python) ─┤ token
                                   ▼
                       FloatDB API  /api/v1/floatdb/search
                                   │
                                   ▼
                       results*.json (уникальные предметы)
```

Запросы к FloatDB требуют валидной Steam-сессии **и** свежего CloudFlare Turnstile токена. Токен выдаёт локальный solver (`http://127.0.0.1:5033`), сессию — авторизация через Steam OpenID.

---

## 📋 Требования

| | |
|---|---|
| **Node.js** | `>= 18.0.0` |
| **Python** | `>= 3.10` (для Turnstile solver) |
| **Git** | для клонирования solver'а |
| **Steam-аккаунт** | с доступом к CSFloat + включённой 2FA (нужен `shared_secret`) |

---

## 🚀 Быстрый старт

### Windows (автоматически)

```bat
install.bat
```

Скрипт проверит Node.js и Python, выполнит `npm install`, склонирует и пропатчит
[BotsForge/CloudFlare](https://github.com/BotsForge/CloudFlare) solver и создаст `account.json` из шаблона.

### Вручную

```bash
npm install
# затем склонировать solver в ./solver и применить патч совместимости:
git clone https://github.com/BotsForge/CloudFlare.git solver
node solver-patch.js
```

После установки:

```bash
# 1. Заполни account.json (см. ниже)
# 2. Запусти solver в ОТДЕЛЬНОМ окне:
start-solver.bat            # или:  cd solver && python app.py
# 3. Запускай парсер:
node index.js --stickers 2711 --parse
```

> Solver должен слушать `http://127.0.0.1:5033` — без него запросы не пройдут.

---

## 🔐 Настройка аккаунта

Скопируй `account.example.json` → `account.json` и заполни:

```json
{
  "account_name": "Мой аккаунт",
  "steam_login": "your_steam_login",
  "steam_password": "your_steam_password",
  "shared_secret": "base32_2fa_secret"
}
```

`shared_secret` — секрет 2FA Steam в base32 (берётся из SDA или `maFile`).

> ⚠️ `account.json` в `.gitignore` — не коммить свои креды.

---

## 🛠 Использование

### Поиск

```bash
# Демо-поиск (2x B1ad3 | Boston 2018)
node index.js

# По URL из CSFloat DB
node index.js --url "https://csfloat.com/db?category=2&stickers=%5B%7B%22i%22:%222711%22%7D%5D"

# По sticker ID (через запятую — несколько копий одного стикера)
node index.js --stickers 2711,2711

# По keychain ID
node index.js --keychains 67,68

# По коллекции
node index.js --collection set_timed_drops_achroma

# По диапазону float
node index.js --min 0 --max 0.01

# Конкретный скин: def_index + paint_index
node index.js --def 13 --paint 939
```

### Полная выкачка (`--all`)

Забирает **все уникальные** предметы курсорной пагинацией по float (обычный offset на больших
выборках упирается в ~10k и начинает отдавать дубли — подробности [ниже](#полная-выкачка-all-курсорная-пагинация-по-float)).

```bash
# Выкачать всё в out.json (чекпоинт каждые 10 страниц)
node index.js --stickers 2711 --all -o out.json

# Докачать прерванный прогон (при resume перепроверяет последние ~500 предметов)
node index.js --stickers 2711 --all --resume -o out.json

# Докачать и перепроверить глубже — последние 2000 предметов
node index.js --stickers 2711 --all --resume -o out.json --backstep 2000

# N страниц offset-режимом (для тестов)
node index.js --stickers 2711 --pages 5
```

### Parse-режим (только count)

Возвращает приблизительное количество (`~`) без скачивания данных:

```bash
node index.js --stickers 2711 --parse
node index.js --url "https://csfloat.com/db?..." --parse
```

### Batch из файла

Один файл — пачка стикеров **или** URL. Формат определяется автоматически.

**Стикеры по именам** (market_hash_name, по строке на каждый — см. [`examples/stickers-example.txt`](examples/stickers-example.txt)):

```
Sticker | B1ad3 (Foil) | Krakow 2017
Sticker | electronic (Foil) | Krakow 2017
```

**Стикеры как JSON** (`{"имя": sticker_id}`):

```json
{ "b1ad3_boston2018": 2711, "kato2019_avangar": 5039 }
```

**Список URL** (текст по строкам, `#` — комментарии, либо JSON-массив):

```
https://csfloat.com/db?category=2&stickers=%5B%7B%22i%22:%222711%22%7D%5D
# комментарий
https://csfloat.com/db?min=0&max=0.01&collection=set_timed_drops_achroma
```

```bash
node index.js --file examples/stickers-example.txt --parse        # count по каждому
node index.js --file urls.txt                                     # полный поиск по каждому URL
node index.js --file stickers.txt --parse --delay 2000 -o out.json
```

> Имена стикеров резолвятся в ID через CSFloat Schema API автоматически.

### Подсчёт наклеенных стикеров (`--count`)

Считает, сколько всего копий стикера наклеено игроками, по уровням 5x/4x/3x/2x/1x:

```bash
node index.js --file stickers.txt --count
node index.js --file stickers.txt --count --category 1,2   # исключить Souvenir
```

---

## 📑 Справочник CLI-флагов

| Флаг | Описание |
|------|----------|
| `--url <url>` | URL CSFloat — параметры поиска извлекаются из ссылки |
| `--stickers <ids>` | Sticker ID через запятую (повтор = несколько копий) |
| `--keychains <ids>` | Keychain ID через запятую |
| `--collection <name>` | Имя коллекции |
| `--min <float>` | Минимальный float (по умолчанию `0`) |
| `--max <float>` | Максимальный float (по умолчанию `1`) |
| `--def <index>` | `def_index` скина |
| `--paint <index>` | `paint_index` скина |
| `--limit <n>` | Результатов на страницу (по умолчанию `100`) |
| `--category <ids>` | Категория предмета (см. [ниже](#-фильтрация-по-категории---category)) |
| `--rarity <id>` | Редкость предмета |
| `--order <type>` | Сортировка |
| `--pages <n>` | N страниц offset-режимом (тесты/частичные прогоны) |
| `--all` | Выкачать **все уникальные** курсорной пагинацией по float |
| `--resume` | Докачать прерванный прогон из файла `-o` |
| `--backstep <n>` | При `--resume` перепроверить последние `n` собранных предметов (по умолчанию `500`, `0` — без перепроверки) |
| `--start <offset>` | Старт offset-пагинации с заданного смещения |
| `--parse` | Только count (без скачивания результатов) |
| `--file <path>` | Входной файл (стикеры/URL, JSON или текст) |
| `--count` | Подсчёт наклеенных стикеров по уровням 5x..1x |
| `--delay <ms>` | Базовая задержка между запросами (по умолчанию `1500` + джиттер) |
| `--output <path>`, `-o` | Выходной файл (по умолчанию `results_<дата>_<время>.json`) |

---

## 🏷 Фильтрация по категории (`--category`)

| Значение | Категория |
|----------|-----------|
| `0` | Все (по умолчанию) |
| `1` | Normal |
| `2` | StatTrak |
| `3` | Souvenir |

Комбинируются через запятую: `--category 1,2` → Normal + StatTrak.

**Зачем:** некоторые Gold-стикеры (турнирные) выпадают уже наклеенными на сувенирных предметах —
это не ручная наклейка игроком. Чтобы посчитать только наклеенные людьми, исключи Souvenir: `--category 1,2`.

---

## 📤 Формат вывода

> 💡 Поле `count` — **приблизительное** (CSFloat и сам рисует `~` в UI). В консоли оно тоже выводится со знаком `~`. В выкачке `--all` поле `fetched` — точное число реально собранных уникальных предметов.

<details>
<summary><b>Полная выкачка (<code>--all</code>)</b></summary>

```json
{
  "count": 49000,
  "completed": true,
  "fetched": 46854,
  "results": [ { "float_value": 0.0000743, "float_id": 51349434905, "paint_seed": 293, "...": "..." } ]
}
```
- `count` — приблизительная оценка из БД; `fetched` — точное число уникальных в `results`.
- Дедуп идёт по `float_id` (уникальный ID предмета), поэтому скины с одинаковым float **не теряются**.
</details>

<details>
<summary><b>Подсчёт стикеров (<code>--count</code>)</b></summary>

```json
{
  "timestamp": "2026-06-09T14:30:00.000Z",
  "task_count": 2,
  "results": {
    "rmr2020_team_vita": {
      "stickerId": 4701,
      "atLeast": { "5": 12, "4": 89, "3": 450, "2": 2100, "1": 8500 },
      "net":     { "5": 12, "4": 77, "3": 361, "2": 1650, "1": 6400 },
      "totalApplied": 12890
    }
  }
}
```
- `atLeast[N]` — скинов с **как минимум** N копиями стикера.
- `net[N]` — скинов с **ровно** N копиями (`atLeast[N] − atLeast[N+1]`).
- `totalApplied` — всего наклеено (`5·net[5] + 4·net[4] + …`).
</details>

<details>
<summary><b>Batch parse (<code>--parse</code>)</b></summary>

```json
{
  "timestamp": "2026-06-09T14:30:00.000Z",
  "task_count": 3,
  "results": {
    "rmr2020_team_vita": { "stickerId": 4701, "count": 8500 },
    "https://csfloat.com/db?...": { "count": 1523 }
  }
}
```
</details>

---

## 🧩 Архитектура

```
index.js                  — Точка входа: CLI-парсинг, маршрутизация режимов
solver-patch.js           — Патч BotsForge solver под CSFloat (идемпотентный)
install.bat               — Установщик (Windows)
start-solver.bat          — Запуск Turnstile solver
examples/                 — Примеры входных файлов
src/
  csfloat-session.js      — Авторизация Steam OpenID → CSFloat JWT
  turnstile-solver.js     — Получение Turnstile токена от локального solver'а
  floatdb-client.js       — HTTP-клиент FloatDB (search / searchAll / searchAllByFloat / searchCount)
  craft-counter.js        — Подсчёт craft-уровней со splitting при count ≥ 40k
  batch-processor.js      — Оркестрация batch-обработки
  file-reader.js          — Чтение входных файлов, авто-определение формата
  schema-resolver.js      — Резолв имён стикеров в ID через Schema API
  utils.js                — Общие утилиты (delay, User-Agent)
```

### Процесс авторизации

1. Логин в Steam через `steamcommunity` + 2FA (TOTP из `shared_secret`).
2. Получение OpenID-параметров со страницы авторизации CSFloat.
3. Подтверждение OpenID через Steam.
4. Получение session JWT от CSFloat.

### Splitting при count ≥ 40 000

API CSFloat отдаёт максимум `count = 40000`. При достижении лимита `CraftCounter`:

1. Разбивает запрос на float sub-ranges: `[0, 0.07]`, `[0.07, 0.15]`, `[0.15, 0.38]`, `[0.38, 0.45]`, `[0.45, 1.0]`.
2. Суммирует count по каждому диапазону.
3. Если sub-range тоже ≥ 40 000 — рекурсивно бисектирует пополам.

### Полная выкачка `--all`: курсорная пагинация по float

Обычная offset-пагинация (`start=0,100,200,…`) на больших выборках FloatDB **не работает**: API
достаёт только первые ~10k результатов окна, дальше отдаёт те же предметы по кругу и возвращает `400`
на глубоком offset. Поэтому `--all` использует **курсорную (keyset) пагинацию по `float_value`**:

1. Внутри окна `[min, max]` идём offset'ом, пока приходят новые уникальные предметы.
2. Страница без новых (offset зациклился) **или** конец окна → берём максимальный float среди собранного
   (`globalMaxFloat`) как новый `min`, offset → 0. Окно ползёт вверх по float.
3. Дедуп на лету по `float_id` (`min` включающий — граница перечитывается, дубли отсеиваются без пропусков).
4. Стоп, когда `globalMaxFloat` перестаёт расти (дошли до `max`).

Дополнительно:

- **Чекпоинты** — частичный результат пишется каждые 10 страниц и при любой ошибке.
- **Докачка с перепроверкой** — `--all --resume -o out.json` подхватывает собранное, отступает назад на
  `--backstep` предметов (по умолчанию 500) и **перечитывает эту зону заново**. Любой ранее пропущенный
  предмет всплывает как новый — их число логируется (`восстановлено N`), так что прерванный прогон
  гарантированно дособирается без пропусков. `--backstep 0` отключает перепроверку.
- **Троттлинг** — при `401 code 116` (recaptcha wall) и `429` процесс не падает, а ждёт с эскалирующим
  бэкоффом (потолок 10 мин) и ретраит, пока стенка не спадёт. В логе паузы видны средняя скорость и ETA.
- **Сетевые сбои** — таймауты и обрывы (`ECONNABORTED`, `ETIMEDOUT`, `ECONNRESET` и др.) не роняют прогон:
  до 5 повторов со свежим токеном и коротким бэкоффом.
- **Анти-детект** — ротация `fid` на каждую страницу + джиттер задержки.

---

## 📄 Лицензия

Private use only. Для образовательных целей и личного использования.
</content>
