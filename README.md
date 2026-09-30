# Naira Luck Casino — функциональный MVP

## Публичная демо-сборка Render

В репозитории подготовлен `render.yaml`: он создаёт Render Web Service `naira-luck-demo`, проверяет `/healthz` и направляет приложение в отдельную MongoDB database `naira_luck_demo`. Значение `JWT_SECRET` генерируется Render; `MONGODB_URI` вводится только в настройках Render, не в файлах.

**Демо-ограничения:** `ENABLE_DEPOSITS=false` задан и в коде по умолчанию, и в Render Blueprint; endpoint реальных депозитов отвечает 404. Переменные TronGrid/TRON в Render не нужны; вывода средств нет. Crash и два слота используют только виртуальный баланс. Crash payout/коэффициенты не менялись. Production slot API отвечает только если `ENABLE_SLOTS=true` и `MONGODB_DB=naira_luck_demo` — держите эту базу и DB-пользователя отдельно от любых боевых данных.

### Публикация

1. Поместите файлы проекта в приватный или публичный GitHub-репозиторий. **Не загружайте `.env`, `uploads/`, `node_modules/` или `.auth-debug.log`** — они исключены через `.gitignore`.
2. В MongoDB Atlas создайте отдельного пользователя БД с доступом только к `naira_luck_demo`. Используйте новую длинную парольную фразу; разрешите сетевой доступ Render согласно настройкам вашего Atlas-кластера.
3. В Render подключите GitHub, создайте Blueprint из `render.yaml` и введите `MONGODB_URI` для этого ограниченного пользователя. Для вручную созданного Web Service задайте `MONGODB_DB=naira_luck_demo`, `ENABLE_DEPOSITS=false` и `ENABLE_SLOTS=true`; никогда не добавляйте Tron/API-ключи в demo service.
4. После успешного deploy Render выдаёт публичный адрес, например `https://naira-luck-demo.onrender.com`. Путь `/healthz` должен вернуть `200` и `status: ok`.

Рабочая копия в Arena не связана с вашим Git remote: изменения из неё нужно загрузить в репозиторий `cass` в папку `naira-luck-render-demo`. Root Directory Render оставьте `naira-luck-render-demo`. Бесплатный Render service может засыпать при простое и медленнее отвечать на первом открытии; публичный адрес при этом не меняется.

**Безопасность:** ранее использовавшиеся пароли/ключи из локального `.env` не переносите. Если действующие MongoDB/TRON credentials ранее попадали в переписку или репозиторий, сначала отзовите/смените их; в демо используйте только новый MongoDB user с правами на отдельную demo database. Реальные платежи и вывод средств не публикуйте.

## Nature & Safari v10

- The Crash runner now has a more pronounced stride/bounce and lane motion. A first cut-out limb rig was rejected because it introduced visible seams; independent joint-level leg animation remains a known limitation rather than being passed off as complete.
- Slot reels now use staggered reel stops, continuous cosmetic symbol changes while waiting for the authoritative server result, and a CSS depth/rotation treatment. The decorative spin never predicts the result; server math and payout handling are unchanged.
- Added original synthesized match motifs for symbol families, with distinct 3/4/5-match pitch variation, feature cues, and a persistent sound mixer for master/SFX levels with a mute switch.
- Existing v9 theme, scenes, virtual balances, and reduced-motion/low-bandwidth behavior remain.

## Nature & Safari v9

- Добавлен переключатель светлой/тёмной темы с сохранением выбора.
- В Crash — пейзаж нигерийской саванны, акации и антилопы; персонаж меняет выражение лица: сосредоточен во время бега, радуется успешному cash-out и расстраивается, если игрок не успел забрать ставку. Crash math и серверные выигрыши не менялись.
- `Canopy Kick`: 5 барабанов, 5 линий; джунгли и вымышленный взрослый футболист, три свистка запускают серию пенальти.
- `Nigeria Savanna`: 5 барабанов, 5 линий; саванна Нигерии, три скарабея превращают выбранный барабан в Wild.
- Подсветка премиальных символов при вращении — только анимация, не прогноз результата. Сами результаты создаёт сервер.
- Изображения WebP загружаются локально; тяжёлые эффекты отключаются при Save-Data/slow-2G и `prefers-reduced-motion`. Результат каждого слота записывается транзакционно с idempotency key; игры используют только демо-баланс.

## Уже добавлено

- Регистрация и вход по email/паролю; пароли хранятся как bcrypt-хэши. Для HTTPS-preview выставляется Secure/SameSite=None cookie; дополнительно короткоживущий bearer-токен (12 часов) используется для API/Socket.IO, если iframe блокирует cookies. В production перед публичным запуском нужно отдельно оценить хранение токена в памяти вкладки/sessionStorage и включить CSP.
- Личный кабинет: общий виртуальный баланс, Crash/Slots-статистика, недавние операции и реферальные показатели.
- Ежедневный бонус один раз за календарный день по времени `Africa/Lagos`; серия до 7 дней. Значения по умолчанию: `50, 75, 100, 150, 200, 300, 500 ₦`.
- Реферальная ссылка `/?ref=КОД`; код сохраняется при регистрации. После первого подтверждённого депозита по умолчанию пригласившему начисляется `100 ₦`, новому пользователю — `50 ₦`.
- Заявка контент-мейкера с ручной проверкой; creator-профиль назначается администратором.
- История ставок/выигрышей, daily bonus, промокодов и депозитов.
- Проверка сессии на Socket.IO, поэтому клиент не может выдать себя за другой `userId`.

**Crash payout / win-point / коэффициенты не менялись.** Добавлены только проверка личности сессии и отдельный журнал/статистика.

## Запуск локально

1. Установить Node.js 20+ и запустить MongoDB.
2. `cp .env.example .env`, затем задать `JWT_SECRET` и параметры окружения.
3. `npm install`
4. При желании задайте `DEMO_EMAIL` и `DEMO_PASSWORD` для входа в seeded-инвесторский аккаунт с тестовым балансом 1000 ₦ (пароль минимум 10 символов).
5. `npm start` и открыть `http://localhost:3000`.

В MongoDB появится промокод `NAIRA500`. Балансы в этом MVP — тестовые числовые единицы; не подключайте реальные депозиты/выводы для публичного запуска без отдельного аудита и проверки требований лицензирования.

## Важные ограничения перед публичным доступом

- Проценты 5%/15% пока **не выплачиваются автоматически**: нужно определить базу (например, net gaming revenue), окно атрибуции, правила исключения фрода и согласовать экономику creator-программы. До этого действует только фиксированный тестовый бонус.
- Заявки creator рассматриваются вручную; администратор пока назначает `role: "creator"` в базе.
- Для production обязательны постоянный `JWT_SECRET`, HTTPS, отдельный управляемый MongoDB, резервные копии, аудит балансов/начислений, защита и восстановление аккаунтов, лимиты/мониторинг и юридическая проверка для целевых рынков.
- Daily bonus, промокоды, депозиты и фиксированные referral credits теперь записываются атомарно с балансом через MongoDB transactions; для этих операций MongoDB должна работать как replica set (включая Atlas). Crash ставки/выигрыши сохраняют прежнюю механику и их журнал остаётся best-effort. До реальных денег нужен отдельный финансовый аудит, тесты восстановления/повторных запросов и админ-сверка ledger.
- Условия легальности онлайн-гемблинга и рекламы казино в странах запуска следует проверить отдельно до выдачи публичной ссылки.

Суммы и серия бонуса настраиваются через `.env.example` параметры; фактические значения не меняйте без подтверждения бизнес-правил.
