# CSFloat FloatDB Parser

Парсер базы данных CSFloat FloatDB. Поиск скинов CS2 по стикерам, float range, коллекциям, def/paint index. Поддерживает batch-обработку, подсчёт общего количества наклеенных стикеров и parse-режим.

## Требования

- **Node.js** >= 18.0.0
- **Python** >= 3.10 (для Turnstile solver)
- **Steam-аккаунт** с доступом к CSFloat

## Установка

### Автоматическая (Windows)

```bash
install.bat
```

Скрипт выполнит:
1. Проверку Node.js и Python
2. `npm install`
3. Клонирование и настройку [BotsForge CloudFlare Solver](https://github.com/BotsForge/CloudFlare-Solver) для решения Turnstile captcha
4. Создание `account.json` из шаблона

### Ручная

```bash
npm install
```

Затем клонировать CloudFlare Solver в папку `solver/` и установить его зависимости (см. `install.bat`).

## Настройка

Скопируйте `account.example.json` в `account.json` и заполните данные Steam-аккаунта:

```json
{
  "account_name": "Мой аккаунт",
  "steam_login": "your_steam_login",
  "steam_password": "your_steam_password",
  "shared_secret": "base32_2fa_secret"
}
```

`shared_secret` — секрет двухфакторной аутентификации Steam (base32). Можно получить через SDA или maFile.

## Перед запуском

Запустите Turnstile solver в отдельном терминале:

```bash
start-solver.bat
```

Или вручную:

```bash
cd solver && python app.py
```

Solver должен быть доступен по адресу `http://127.0.0.1:5033`.

## Использование

### Базовый поиск

```bash
# Демо-поиск (2x B1ad3 Boston 2018)
node index.js

# Поиск по URL CSFloat
node index.js --url "https://csfloat.com/db?category=2&stickers=%5B%7B%22i%22:%222711%22%7D%5D"

# Поиск по sticker IDs (через запятую)
node index.js --stickers 2711,2711

# Поиск по keychain IDs
node index.js --keychains 67,68

# Поиск по коллекции
node index.js --collection set_timed_drops_achroma

# Поиск по float range
node index.js --min 0 --max 0.01

# Поиск конкретного скина (def_index + paint_index)
node index.js --def 13 --paint 939

# Все уникальные результаты (курсорная выкачка по float, см. ниже)
node index.js --stickers 2711 --all -o out.json

# Докачать прерванный прогон
node index.js --stickers 2711 --all --resume -o out.json

# Определённое количество страниц (offset-режим, для тестов)
node index.js --stickers 2711 --pages 5
```

### Parse-режим

Возвращает только количество результатов без скачивания данных:

```bash
# Count скинов для одного запроса
node index.js --stickers 2711 --parse

# Count скинов по URL
node index.js --url "https://csfloat.com/db?..." --parse
```

### Batch-обработка из файла

#### Файл стикеров (JSON-объект или текстовый)

JSON-формат: `{"имя": sticker_id, ...}` — аналогично `checker.py`.

```json
{
  "rmr2020_team_vita": 4701,
  "kato2019_avangar": 5039,
  "b1ad3_boston2018": 2711
}
```

Текстовый формат — имена стикеров (market_hash_name), по одному на строку:

```
Sticker | B1ad3 (Foil) | Krakow 2017
Sticker | B1ad3 | Krakow 2017
Sticker | electronic (Foil) | Krakow 2017
```

ID стикеров автоматически резолвятся через CSFloat Schema API.

```bash
# Подсчёт общего кол-ва наклеенных стикеров (5x/4x/3x/2x/1x)
node index.js --file stickers.txt --count

# Информация о скинах для каждого стикера
node index.js --file stickers.txt --parse

# С кастомной задержкой и выходным файлом
node index.js --file stickers.txt --count --delay 2000 -o report.json
```

#### Файл URL (JSON-массив или текст)

JSON-массив:

```json
[
  "https://csfloat.com/db?category=2&stickers=%5B%7B%22i%22:%222711%22%7D%5D",
  "https://csfloat.com/db?min=0&max=0.01&collection=set_timed_drops_achroma"
]
```

Текстовый файл (по строкам, `#` — комментарии):

```
https://csfloat.com/db?category=2&stickers=%5B%7B%22i%22:%222711%22%7D%5D
https://csfloat.com/db?min=0&max=0.01&collection=set_timed_drops_achroma
# это комментарий
```

```bash
# Count по списку URL
node index.js --file urls.txt --parse

# Полный поиск по каждому URL (с результатами)
node index.js --file urls.txt
```

## CLI-флаги

| Флаг | Описание |
|------|----------|
| `--url <url>` | URL CSFloat для парсинга параметров поиска |
| `--stickers <ids>` | Sticker IDs через запятую |
| `--keychains <ids>` | Keychain IDs через запятую |
| `--collection <name>` | Имя коллекции |
| `--min <float>` | Минимальный float (по умолчанию 0) |
| `--max <float>` | Максимальный float (по умолчанию 1) |
| `--def <index>` | def_index скина |
| `--paint <index>` | paint_index скина |
| `--limit <n>` | Лимит результатов на страницу (по умолчанию 100) |
| `--category <ids>` | Категория предмета (см. ниже). Применяется ко всем запросам, включая batch и count |
| `--rarity <id>` | Редкость предмета |
| `--order <type>` | Сортировка |
| `--pages <n>` | Количество страниц (offset-режим, для частичных/тестовых прогонов) |
| `--all` | Выкачать **все уникальные** результаты курсорной пагинацией по float (см. ниже) |
| `--resume` | Докачать прерванный прогон из выходного файла (`-o`) |
| `--start <offset>` | Начать offset-пагинацию с указанного смещения |
| `--parse` | Только подсчёт скинов (без скачивания результатов) |
| `--file <path>` | Входной файл (JSON стикеров, текст имён стикеров, JSON-массив URL или текст URL) |
| `--count` | Подсчёт общего кол-ва наклеенных стикеров (5x/4x/3x/2x/1x) |
| `--delay <ms>` | Базовая задержка между запросами в мс (по умолчанию 1500, +джиттер) |
| `--output <path>`, `-o` | Путь к выходному файлу (по умолчанию `results_<дата>_<время>.json`) |

### Фильтрация по категории (`--category`)

Параметр `--category` фильтрует предметы по типу. Значения:

| Значение | Категория |
|----------|-----------|
| `0` | Все (по умолчанию, если не указан) |
| `1` | Normal (обычные) |
| `2` | StatTrak |
| `3` | Souvenir |

Можно комбинировать через запятую: `--category 1,2` выведет Normal + StatTrak.

**Зачем нужно:** некоторые Gold-стикеры (например турнирные) выпадают уже наклеенными на сувенирных предметах из сувенирных наборов. Такие наклейки не были применены игроком вручную. Чтобы посчитать только стикеры, наклеенные людьми (из капсул), нужно исключить Souvenir-предметы — для этого используйте `--category 1,2`.

Если Gold-стикер не выпадает на сувенирных предметах (только из капсул), параметр `--category` указывать не нужно.

```bash
# Подсчёт для Gold-стикера, который выпадает на сувенирах — исключаем Souvenir
node index.js --file stickers.txt --count --category 1,2

# Обычный стикер без сувенирных версий — без фильтра
node index.js --file stickers.txt --count
```

## Формат вывода

### Count (`--count`)

```json
{
  "timestamp": "2026-06-09T14:30:00.000Z",
  "task_count": 2,
  "results": {
    "rmr2020_team_vita": {
      "stickerId": 4701,
      "atLeast": { "5": 12, "4": 89, "3": 450, "2": 2100, "1": 8500 },
      "net": { "5": 12, "4": 77, "3": 361, "2": 1650, "1": 6400 },
      "totalApplied": 12890
    }
  }
}
```

- `atLeast[N]` — количество скинов с *как минимум* N копиями стикера
- `net[N]` — количество скинов с *ровно* N копиями (`atLeast[N] - atLeast[N+1]`)
- `totalApplied` — общее число наклеенных стикеров (`5*net[5] + 4*net[4] + ...`)

### Batch parse (`--parse`)

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

### Обычный поиск

```json
{
  "count": 42,
  "results": [
    {
      "float_value": 0.0001234567,
      "paint_seed": 661,
      "s": "76561198012345678",
      "stickers": [{ "i": 2711, "name": "B1ad3 | Boston 2018" }],
      "origin": "Found in Crate"
    }
  ]
}
```

## Архитектура

```
index.js                    — Точка входа, CLI-парсинг, маршрутизация
solver-patch.js             — Патч BotsForge solver для совместимости с CSFloat
src/
  csfloat-session.js        — Авторизация через Steam OpenID → CSFloat JWT
  turnstile-solver.js       — Решение CloudFlare Turnstile через локальный solver
  floatdb-client.js         — HTTP-клиент FloatDB API (search, searchAll, searchAllByFloat, searchCount)
  utils.js                  — Общие утилиты (delay, User-Agent)
  file-reader.js            — Чтение входных файлов, авто-определение формата
  schema-resolver.js        — Резолв имён стикеров в ID через CSFloat Schema API
  craft-counter.js          — Подсчёт craft-уровней с splitting при >40k
  batch-processor.js        — Оркестрация batch-обработки
```

### Процесс авторизации

1. Логин в Steam через `steamcommunity` + 2FA (TOTP)
2. Получение OpenID параметров со страницы авторизации CSFloat
3. Подтверждение OpenID через Steam
4. Получение session JWT от CSFloat

### Splitting при count >= 40000

API CSFloat возвращает максимум `count=40000`. Если результат достигает этого лимита, `CraftCounter` автоматически:

1. Разбивает запрос на float sub-ranges: `[0, 0.07]`, `[0.07, 0.15]`, `[0.15, 0.38]`, `[0.38, 0.45]`, `[0.45, 1.0]`
2. Суммирует count по каждому диапазону
3. Если sub-range тоже >= 40000 — рекурсивно бисектирует пополам

## Полная выкачка (`--all`): курсорная пагинация по float

Обычная offset-пагинация (`start=0,100,200,...`) на больших выборках FloatDB **не работает**: API достаёт только первые ~10k результатов окна, дальше отдаёт те же предметы по кругу (дубли) и возвращает `400` на глубоком offset. Поэтому одним проходом `min=0/max=1` нельзя забрать всю выборку — выгребается только нижний диапазон float.

`--all` использует **курсорную (keyset) пагинацию по `float_value`** (выдача отсортирована по float):

1. Внутри окна `[min, max]` идём обычным offset'ом, пока приходят новые уникальные предметы.
2. Как только страница не приносит новых (offset зациклился) **или** окно кончилось — берём **максимальный float среди всего собранного** (`globalMaxFloat`) и ставим его новым `min`, offset сбрасываем в 0. Окно ползёт вверх по float.
3. Дедуп на лету по `float_id` (`min` включающий — граничные предметы перечитываются, но дубли отсеиваются без риска пропуска).
4. Стоп, когда `globalMaxFloat` перестаёт расти (дошли до `max`).

Дополнительно при выкачке:

- **Чекпоинты** — частичный результат пишется в выходной файл каждые 10 страниц и при любой ошибке, так что прогресс не теряется.
- **Докачка** — `--all --resume -o out.json` подхватывает уже собранное, восстанавливает фронтир (`globalMaxFloat`) и продолжает.
- **Троттлинг** — при `401 code 116` («recaptcha wall») и `429` процесс не падает, а ждёт с эскалирующим бэкоффом (потолок 10 мин) и ретраит, пока стенка не спадёт.
- **Анти-детект** — ротация `fid` на каждую страницу + джиттер задержки.

Формат выходного файла: `{ count, completed, fetched, results }`, где `results` — уникальные предметы.

## Лицензия

Private use only.
