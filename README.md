# Life Planner｜TDD 開發流程

## 從對話操作

傳送「繼續開發」，主代理會從第一個缺少證據的階段接續；傳送「目前進度」，會回報案例、階段和驗證結果。子代理可協助檢查程式與測試。日常操作在對話中完成。

本機沿用同一組 TDD 驗收命令和執行鎖。若需使用 GitHub 的 PostgreSQL 與 Chromium，先指定並授權專案儲存庫。Planner regression 可針對指定 commit 所在 ref 執行單一案例階段，成功時產出驗收 JSON 和來源資訊。主代理核對結果後接續開發。既有 Windows 終端機迴圈仍可獨立使用。

主代理可在已授權的 repo 推送階段分支（例如 `tdd/LP-009/refactor`）觸發驗證，也可使用 workflow dispatch。下載該成功執行的 artifact 至工作區外，在同一 commit 的乾淨 checkout 執行 `node scripts/chat-stage.mjs import <artifact目錄> <owner/repo> <run-ID> <attempt>` 來核對並匯入證據，再在開發分支提交。這些操作由對話端處理。

## 開發時如何驗證

| 時機 | Windows 命令 | 執行內容 |
| --- | --- | --- |
| 快速修改純邏輯 | `npm.cmd run test:unit` | Node 單元測試 |
| 檢查單一需求 | `npm.cmd run test:case -- LP-009` | 依 acceptance.json 跑指定檔案，不寫階段證據 |
| 驗證提醒時鐘 | `npm.cmd exec -- vitest run app/reminder-clock.test.ts` | Chromium 操作實際提醒元件，不需資料庫 |
| 驗證重疊性質 | `npm.cmd run test:properties` | fast-check 每個性質產生 500 組輸入 |
| 階段交付或送 PR | `npm.cmd run check` | 型別檢查、Node、性質測試和 Vitest 各執行一次 |
| 檢查斷言強度 | `npm.cmd run test:mutation` | 用 StrykerJS 對 src/overlaps.ts 產生變異，輸出 reports/mutation/ |

使用 Node.js 24，在專案目錄執行 `npm.cmd ci` 安裝鎖定的依賴。完整回歸、API 與端到端案例使用下方的獨立測試資料庫與 Chromium。fast-check 若找到反例，輸出會提供 seed 與縮減路徑；以 `FC_SEED`、`FC_PATH` 環境變數搭配 Node 的 `--test-name-pattern` 重跑該性質。StrykerJS 首次執行會下載指定版本，適合在時段規則變更後執行。GitHub Actions 手動執行 Planner regression 也會產生變異報告。

瀏覽器案例失敗且已建立 context 時，trace 保存在 `test-results/traces/`，檔名包含裝置與最後一次行程或待辦寫入。用 `npm.cmd exec -- playwright show-trace <trace.zip>` 開啟。成功案例會清理自己的檔案。CI 的失敗 trace 保留七天，完整回歸耗時可在該次執行摘要查看。

LP-010 提供行程與待辦各自的應用內提醒時間，依台北時間輸入。未排程待辦也能設定提醒。修改提醒時間後依新時間觸發，清空欄位可取消；隱藏行程仍照常提醒。提醒時間獨立於行程起訖。開著頁面時會在到期時顯示，重新開啟或回到頁面也會檢查已到期資料。

## 應用程式入口

應用程式使用 Node.js 24。安裝後執行以下命令，開啟 `http://127.0.0.1:3000/register` 註冊；`/login` 登入，`/` 使用日／週行事曆及自己的行程清單。啟動時會在指定資料庫的目前 schema 建立缺少的資料表及索引，保留既有資料。前端由 esbuild 編譯 React TSX，透過同一個 Express 來源呼叫 API，執行期間不需要 AI 服務。

日／週按鈕切換時間格，日期欄選擇日期；週曆從週一開始，可使用上一日／週、下一日／週及今天導覽。點選空白時間格會預填開始時間與一小時後的結束時間，在下方表單儲存。點選日曆中的行程或清單行程可修改名稱、起訖時間，或確認刪除。所有時間以台北時區輸入與顯示；週曆在窄螢幕可水平捲動。新增、修改與刪除呼叫同一組登入保護的 API 並寫入 PostgreSQL；重新整理時重新讀取資料庫。修改遇到重疊時，可調整時間或勾選確認允許時段重疊後重送。

```powershell
npm.cmd install
$env:DATABASE_URL = 'postgresql://planner:YOUR_PASSWORD@127.0.0.1:5432/planner'
npm.cmd start
```

`PORT` 預設為 3000，`HOST` 預設為 `127.0.0.1`。同一區網的 Android 要連線時，設 `HOST=0.0.0.0`，使用電腦的區網 IP 連線。正式 HTTPS 環境設 `NODE_ENV=production`，工作階段 Cookie 會啟用 Secure。密碼使用加鹽 scrypt，資料庫僅儲存工作階段權杖的 SHA-256 雜湊；工作階段七天到期，登出會撤銷目前權杖。

### 獨立測試資料庫與回歸

若本機有 Docker，可使用以下獨立服務（55433 埠，避免與外層執行器的 55432 衝突）。這組密碼僅用於本機測試，請勿將 `TEST_DATABASE_URL` 指向正式資料庫。

```powershell
docker compose -f compose.test.yml up -d --wait
$env:TEST_DATABASE_URL = 'postgresql://planner:local_test_only@127.0.0.1:55433/planner_test'
npm.cmd exec -- playwright install chromium
npm.cmd run check
# 結束測試資料庫服務
docker compose -f compose.test.yml down
```

若使用外層執行器已準備的資料庫與 Chromium，沿用它提供的 `TEST_DATABASE_URL` 及 `PLAYWRIGHT_BROWSERS_PATH` 即可，不需要執行迴圈。LP-003 固定測試使用隨機 schema 隔離資料，測完會清理該 schema；測試帳號需要建立及刪除 schema 的權限。

Linux CI 使用既有 PostgreSQL service，依序執行 `npm ci`、`npx --no-install playwright install --with-deps chromium`、`npm run check`。LP-003 的 Playwright 測試會操作真實 React 畫面，檢查 PostgreSQL 資料列、重啟伺服器後的獨立工作階段，以及另一帳號和匿名請求的存取限制。Windows／Android 實機結果須另外驗收。

LP-004 固定測試 `app/acceptance/LP-004.test.ts` 也包含於 `npm test`：分別操作日、週時間格新增行程、修改時間（週曆另跨日期）、刪除，逐次重新整理並直接核對 PostgreSQL。只執行此案例可用 `npm.cmd exec -- vitest run app/acceptance/LP-004.test.ts`，沿用相同測試資料庫與 Chromium 設定。測試程序須能啟動 esbuild、Vitest worker 與 Chromium 子程序。

LP-005 日／週行程清單共用上方的日期及導覽按鈕，列出名稱與台北起訖時間；全天置頂，其餘依開始時間排序，週清單按週一至週日分組。跨日行程列於涵蓋的各日，午夜結束不計入次日。表單可勾選「全天」，開始及結束皆輸入台北時間午夜，結束日期為不包含的邊界（單日行程填次日午夜）。全天狀態由 API 驗證並儲存在 PostgreSQL，舊資料於啟動時補上預設非全天欄位。固定測試 `app/acceptance/LP-005.test.ts` 包含於 `npm test`；單獨執行使用 `npm.cmd exec -- vitest run app/acceptance/LP-005.test.ts`，沿用上述獨立測試資料庫設定。

選定日／週之外的行程列於獨立的「其他日期行程」，可直接點選修改。重新登入或在另一個工作階段重新整理後，也能找到已儲存的未來行程；這些行程不混入日／週清單的日期分組。

LP-006：在行程編輯表單勾選「隱藏行程」並儲存，日／週行事曆會移除該區塊，重新計算可見行程的重疊欄寬。清單仍保留名稱、起訖時間及「已隱藏」標記，可從清單編輯或取消勾選後儲存以復原。「顯示隱藏行程」僅暫時切換目前畫面，不變更資料庫狀態。另一個同帳號工作階段重新整理後會讀到相同結果。隱藏事件仍參與後端的時段衝突檢查；既有資料於啟動時補上預設為 false 的 `events.hidden` 欄位，修改請求未提供 hidden 時保留原值。

固定瀏覽器驗收 `app/acceptance/LP-006.test.ts` 包含於 `npm test`，也可執行 `npm.cmd exec -- vitest run app/acceptance/LP-006.test.ts`。沿用上述獨立 PostgreSQL 與 Chromium 設定；案例會操作兩個獨立桌面／手機尺寸工作階段，檢查實際欄寬、日週清單、顯示切換、編輯、復原及資料庫持久化。這些瀏覽器檢查不代表 Windows／Android 實機驗收。

Windows x64 可從本目錄執行 `.\planner.cmd setup`。它檢查 Codex 登入、準備 Node.js 24 與 npm，另於 .runtime 安裝並驗證測試用 PostgreSQL（本機 55432 埠）和 Playwright Chromium。首次設定需要網路。設定完成後用 `.\planner.cmd run` 啟動資料庫與 TDD 迴圈；`.\planner.cmd status` 可離線查看進度。專案工具由啟動檔載入。測試資料與密碼存於 .runtime，請勿提交。正式應用的 npm 依賴仍由各案例依需求安裝；新增 Playwright 依賴時請與 .runtime/tools/package.json 記錄的版本對齊。

LP-007：首頁「新增待辦」輸入名稱後展開待辦編輯欄位（點選行程名稱可切回行程編輯）。起訖皆留空時，儲存在「未排程待辦」；從該列按「編輯待辦」填入起訖後，同一筆待辦移入日／週行程清單，與行程一起依時間排序。全天行程仍置頂，跨日待辦按涵蓋日期顯示；選定期間之外的排程仍可從「其他日期行程」找到。編輯時清空兩個時間可恢復未排程。清單上的「已完成」可勾選或取消，同帳號另一工作階段重新整理後讀取更新結果。

待辦透過需登入的 `GET/POST /api/tasks` 與 `PATCH /api/tasks/:id`，儲存在 PostgreSQL `tasks` 表；指定時段及完成不會另建事件。起訖須皆為 null 或有效且結束晚於開始；未授權帳號無法修改。排程寫入與行程共用帳號鎖，檢查最新行程（含隱藏）及待辦，首尾相接可儲存，重疊可在表單確認。只改完成狀態保留原時間與名稱，不受先前已確認的重疊影響。

固定測試 `app/acceptance/LP-007.test.ts` 已由既有 Vitest include 納入 `npm test`。單獨執行用 `npm.cmd exec -- vitest run app/acceptance/LP-007.test.ts`；測試資料庫啟動及 CI 步驟沿用上節，既有 `package-lock.json` 不需變更依賴。此案例操作兩個獨立桌面／手機尺寸瀏覽器工作階段，核對未排程、日週排序、完成同步與資料庫中同筆待辦，Windows／Android 實機仍須另驗。

LP-008：新增或改期行程／待辦遇到重疊時，畫面保留草稿並列出全部衝突項目的名稱與起訖時間（包含隱藏行程及已排程待辦）。可修改時間後重送、勾選對應的「確認允許時段重疊」後儲存，或按「取消編輯」／「取消待辦編輯」清除草稿與錯誤提示；取消不寫入資料庫。後端在帳號鎖內重新查詢衝突，排除自身與首尾相接時段，未排程待辦不參與衝突判斷。

固定測試 `app/acceptance/LP-008.test.ts` 已由 Vitest include 納入 `npm test`；單獨執行用 `npm.cmd exec -- vitest run app/acceptance/LP-008.test.ts`。沿用上述 PostgreSQL、Chromium 及 CI 設定；測試操作正式首頁、驗證行程與待辦新增／改期的取消、改時段及明確確認流程，並以 API 和 SQL 快照核對拒絕及取消皆未寫入資料。Windows／Android 實機仍須另驗。

LP-009：行程／待辦新增與改期的重疊確認，綁定登入工作階段、寫入操作、草稿起訖與已顯示衝突的名稱、ID 及起訖。另一工作階段在確認前插入新衝突時，後端在帳號交易鎖內重查，拒絕舊確認並回傳 HTTP 409；畫面保留草稿、顯示最新全部衝突、取消確認勾選，必須再次明確確認才能寫入。單純重送不會視為確認。首次儲存前先勾確認時，由需登入的唯讀 `POST /api/conflicts` 提供衝突快照，實際寫入仍重新核對；單獨傳 `confirmOverlap=true` 不足以授權重疊。確認權杖不寫入行程或待辦資料，伺服器重啟後須重新取得。

固定測試 `app/acceptance/LP-009.test.ts` 已由 Vitest include 納入 `npm test`；單獨執行用 `npm.cmd exec -- vitest run app/acceptance/LP-009.test.ts`。測試資料庫啟動、Chromium 安裝及 Linux CI 步驟沿用上節，不需新增依賴或變更鎖定檔。測試以兩個獨立工作階段驗證四種寫入操作，拒絕後以完整 API／SQL 快照核對未寫入，再於重新確認後刷新另一端核對同步；Windows／Android 實機仍須另驗。

## 一次啟動，連續開發

在解壓後含有本 README 的目錄執行下列命令。使用 Node.js 24、已登入的 Codex CLI。第一個案例之後需要 npm 與可用的專案依賴來源；進入資料庫與瀏覽器案例時須提供可用的測試用 PostgreSQL 和 Playwright 瀏覽器。Windows 預設呼叫 codex.exe，也可用環境變數 CODEX_BIN 指定可直接執行的 CLI 二進位檔路徑。

```powershell
node scripts/loop.mjs
```

迴圈從 acceptance.json 的第一個未完成案例開始，每階段透過 codex exec 在專案內開發，再由外層腳本執行測試。進度顯示可使用 `node scripts/loop.mjs --status`。保留 evidence/ 及工作檔後，重跑啟動命令即可續跑。若已有上一版 LP-001 的紀錄，請在原專案合併新版腳本與設定，保留既有測試、實作及證據。

階段測試失敗最多嘗試三次。CLI 登入、額度或其他執行錯誤會顯示並暫停，排除後可續跑。若程序遭強制終止而留下 evidence/.loop.lock，先確認其中 PID 與其 Codex 子程序均已結束，再刪除該鎖檔。各次 CLI 呼叫使用本機帳戶額度。請在專題專用目錄執行。

### 在 ChatGPT 回覆暫停中的迴圈

每次派出 Codex 工作（含重試）前，主控會查詢目前帳號的五小時剩餘額度。剩餘 10% 以下（含 10%）會停在原階段，最多每分鐘重查一次。如果服務提供的重設時間更早，就在該時間重查；成功讀到高於 10% 才續跑。查不到額度也會暫停派工。正在執行的單次工作可繼續到結束，因此其間額度可能降到 10% 以下。保留主控視窗，以 `.\planner.cmd status` 查看上次查詢時間、階段與結果。

使用 `.\planner.cmd run` 啟動並保留 PowerShell 視窗。驗證失敗時，下一次 Codex 修復會收到外層測試輸出。若 Codex 提出需要決定的問題、修復次數用完或啟動失敗，主控將案例、階段及問題編號寫入 `.runtime/workflow/pending.json`，接著等待回覆。使用 `.\planner.cmd status` 也能看到問題。

在專案的 ChatGPT 對話中回覆問題即可。此專案設定的 ChatGPT 監看每小時檢查一次，需能連上這台電腦。主控收到同編號的回覆後會重新啟動工作程序，依既有證據繼續驗證。關閉視窗後可再執行 `.\planner.cmd run` 接續。

若要在本機直接回覆，可另開 PowerShell，在專案目錄執行下列指令。請將範例字串換成你的決定。

```powershell
$issue = Get-Content -Raw -Encoding UTF8 .runtime/workflow/pending.json | ConvertFrom-Json
$OutputEncoding = [Text.UTF8Encoding]::new()
'我的決定或修復說明' | & .\.runtime\node-v24.22.3-win-x64\node.exe scripts/supervise.mjs --reply $issue.id
```

若新測試首次即通過，初始紀錄以 `baseline: true` 註明既有行為，報告中應計入基線案例。完成 17 項後，腳本重新執行每個指定測試檔與全套回歸。自動驗收通過後，請以 Windows 與 Android 實機登入同帳號，檢查隱藏同步、清單、提醒和記帳更新，再記錄裝置與結果。

這是 Group 32 個人專題的開發起點。AI 參與開發與測試，產品執行時不需要 AI。先以完全離線的時段判斷案例走一輪，再逐項串接正式技術棧。

## 在 Windows 開始

需要 Node.js 24。將整個資料夾解壓到專題目錄，在含有本 README 的那一層開啟 PowerShell。第一輪只需要 Node。

```powershell
node --version
node scripts/tdd.mjs red LP-001 tests/adjacent.test.ts
```

此時測試應顯示實際值 true、預期 false。符合預期的紅燈會寫入 evidence/LP-001/red.json，流程指令本身成功結束。請看過失敗原因再讓 Agent 實作。可直接在該資料夾開啟 Codex，輸入：

> 依 AGENTS.md 執行下一個 TDD 循環，從 LP-001 目前的階段繼續。完成後給我測試證據。

手動驗證時，在 src/overlaps.ts 將兩個比較改為嚴格小於，讓相接時段可直接儲存。然後執行：

```powershell
node scripts/tdd.mjs green LP-001 tests/adjacent.test.ts
# 檢視實作，必要時重構
node scripts/tdd.mjs refactor LP-001 tests/adjacent.test.ts
node scripts/tdd.mjs check
```

## 每輪如何運作

一個案例 ID 對應一個新行為。Red 要求目標檔恰有一個斷言失敗。Green 和 Refactor 要求同一測試檔內容不變、原案例通過，再跑全套回歸。各階段成功才寫入獨立 JSON，執行失敗可修正後重試。若需求改變，使用新的案例 ID。證據檔記錄測試內容雜湊、時間、案例名稱與執行結果。請將 evidence 與對應程式碼一起 commit，以利還原。

## 從範例接到產品

- **測試層級**：tests/ 放 Node 原生 TypeScript 單元測試。新增正式應用後，將 Vitest 測試放在其他目錄，例如 app/calendar.test.ts。將相對路徑傳給同一支腳本，就會改用本地 Vitest 的 JSON 結果。
- **正式測試入口**：在根目錄加入 package.json、package-lock.json 和 Vitest，設定 npm test 以非監看模式執行正式回歸。Vitest 設定的 include 只納入正式應用測試。到 API 與瀏覽器階段，把測試資料庫服務、遷移、Playwright 瀏覽器安裝及 E2E 腳本接到 CI；使用隔離的測試資料庫，每次重設測試資料。
- **CI**：把整個目錄作為專題 repo 根目錄，保留 .github。push 或 PR 時，GitHub Actions 會在 Linux 執行 check。加入 package.json 後會先執行 npm ci，並把 npm test 納入回歸。第一輪 Green 前 CI 紅燈是預期結果。
- **每次開工**：從 BACKLOG.md 取下一項，在 GitHub Issue 寫下輸入、預期結果及測試層級。每個 PR 可含數個小循環。核對 AI 的預期結果是否來自需求，記錄採用或拒絕建議的理由，再合併。
