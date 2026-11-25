# LP-007 Green 實作紀錄

目前完成程式實作，尚未取得 Green 執行通過證據；交由外層執行器驗證。

## 行為與變更

- 輸入：不填時間建立「整理研究筆記」，之後編輯為 10:00–11:00，再由另一個獨立工作階段勾選完成。
- 預期：先出現在未排程區，指定時間後排在 09:00 與 11:00 行程之間；兩端重新整理後完成狀態相同。資料庫保留同一個 tasks.id，events 不增加待辦副本。
- `app/shared.ts`：前後端共用 TaskInput、TaskPatch、PlannerTask。
- `app/server.ts`：啟動時建立 tasks 表；登入保護的待辦讀取、新增、部分更新；驗證名稱、成對時間與完成型別；所有查詢依登入帳號限制。排程與行程共用帳號交易鎖並互查重疊，隱藏行程仍參與；完成狀態更新保留最新名稱及時間。
- `app/task-editor.tsx`：正式 React 待辦表單、編輯及完成操作。聚焦待辦名稱展開待辦欄位；聚焦行程名稱切回行程欄位，保留各自草稿。
- `app/client.tsx`：首頁載入真實 API，串接未排程區、編輯、儲存與完成。
- `app/event-list.tsx`：排程待辦與行程共用日週日期分組及排序，跨日與其他日期仍可找到並編輯；完成項目保留在清單。
- `app/acceptance/LP-007-api.test.ts`：補上匿名拒絕、跨帳號隔離、非法輸入不寫入，以及完成更新保留其他欄位的實際 API 斷言，不使用 mock。
- `README.md`：待辦操作、API 與單獨測試方式。既有 package.json、package-lock.json、PostgreSQL compose 與 CI 已包含必要依賴及測試入口，無需修改。

## 原失敗與本次驗證

既有 `evidence/LP-007/red.json` 記錄「待辦編輯」region 不存在，實際 false、預期 true；本次僅讀取該證據，未執行 red 或改寫證據。

- `npm.cmd run typecheck` 通過，涵蓋前後端及新增測試。
- `npm.cmd exec -- vitest run app/acceptance/LP-007.test.ts` 在載入設定時遭遇 esbuild `spawn EPERM`，未執行產品斷言。
- `npm.cmd test`：兩項既有 Node 領域測試通過；Vitest 同樣於啟動時被 `spawn EPERM` 阻擋，未執行 LP-003 至 LP-007 的 API／瀏覽器回歸。新增 API 測試亦尚未執行。
- 固定 LP-007 原測試保留；SHA-256 與 red.json 記錄一致：`08849f42c8827c881622756cb567956843dc8818ac076fbf5dc0cd43ef1d0bff`。

## 核對及剩餘工作

外層環境須能啟動 esbuild、Vitest worker 與 Chromium 子程序，再執行固定 LP-007、新增 API 測試及完整 npm test，取得 Green 證據。目前不能將型別檢查視為 UI、資料庫或跨工作階段驗收通過。

人工核對可依上述輸入，以同帳號兩個獨立工作階段操作首頁，逐次重新整理核對未排程區、日週順序及完成狀態；Windows／Android 實機結果另記。後續案例仍由外層按 acceptance.json 選擇，本次未進入下一案例或 refactor 階段。

本目錄沒有 Git 儲存庫，無法建立實際 commit 或 PR；未捏造 Issue／PR 連結。未執行 tdd／迴圈、未變更 scripts、acceptance.json、固定測試與既有證據，未推送或部署。

## Green 重試診斷（2026-11-23）

- 重跑固定 LP-007 測試，包含沿用 `.runtime` 測試資料庫及 Chromium 設定，仍在 Vitest 載入設定的 esbuild 子程序啟動處遇到 `spawn EPERM`，沒有執行產品斷言。
- 另以命令列選項 `--configLoader native --pool threads` 診斷，仍在 Vite 的 Windows 路徑解析子程序遇到相同錯誤；未修改 Vitest 設定。
- 最小環境重現：Node `spawn(process.execPath, ['--version'])` 使用預設管線時拋出 `EPERM`；指定 `{ stdio: 'inherit' }` 則成功輸出 `v24.22.3`。問題可以在不載入產品程式及測試的情況下重現，範圍縮小至此環境的子程序管線啟動；尚未確認更底層原因。
- `npm.cmd run typecheck` 通過；`npm.cmd test` 的兩項 Node 領域測試通過，Vitest 啟動失敗。不能將此結果解讀為 LP-007 或 API／瀏覽器回歸通過。
- 固定測試 SHA-256 仍為 `08849f42c8827c881622756cb567956843dc8818ac076fbf5dc0cd43ef1d0bff`。本次只補充開發紀錄，未依環境錯誤推測修改產品或驗收測試。
- 待能正常啟動管線子程序的外層環境重跑固定測試及完整回歸後，才能定位可能的產品失敗並取得 Green 結果；本次沒有進入 refactor 或下一案例。
