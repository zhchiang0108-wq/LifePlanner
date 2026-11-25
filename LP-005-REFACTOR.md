# LP-005 refactor 檢視紀錄

本次將日曆與日／週清單重複的日期範圍計算抽成 `app/calendar.tsx`
的 `datesForView`，由 Calendar 及 EventList 共用，保持週一起算、日視圖
僅含選定日期的行為一致。修改產品檔為 `app/calendar.tsx` 與
`app/event-list.tsx`；未變更排序、時間邊界、清單列或導覽操作。

## 驗收覆蓋與正常入口

固定測試 `app/acceptance/LP-005.test.ts` 保持原樣，SHA-256 為
`335b752f5ad7395f0b4ffb9f5f2aaf39b6ae0d9d6c674c9f366de5d5c3fcae06`，
與既有 green 紀錄一致。未發現本項必要驗收點缺漏，無須新增測試。

- 名稱與起訖時間：每個預期清單列都核對名稱、台北開始及結束時間。
- 全天置頂及日內排序：故意打亂新增順序，以完整 ID 順序斷言全天、
  午夜定時行程、上午及下午行程，並確認全天標記。
- 週按日分組：核對週一跨月到週日的分組日期、各組內容與整週列順序，
  排除前週日及次週一；午夜結束的全天行程不會出現在次日。
- 前後切換及今天：日、週各自斷言上一期、下一期與今天的日期及內容；
  固定時鐘跨越 UTC／台北日期邊界，今天應為台北 2026-12-02。
- 測試由註冊畫面建立帳號，透過首頁表單及真實 POST 新增，直接核對
  PostgreSQL 的擁有者、名稱與起訖，重新整理後驗收清單。
- 正常入口的原始碼路徑為 `npm start` → `app/main.ts` → `startApp` →
  `/` 的 React App → EventList。清單與 Calendar 共用日期及導覽狀態，
  並讀取登入保護的 `/api/events`；未使用測試專用頁面或模擬資料。
  此入口核對屬原始碼檢視，本次未完成執行驗收。

## 本次驗證與限制

- `npm.cmd run typecheck` 通過。
- `npm.cmd test` 的 2 項 Node 領域測試通過；Vitest 載入設定時 esbuild
  啟動子程序發生 `spawn EPERM`，未進入 API／瀏覽器測試斷言。
- 既有 `evidence/LP-005/green.json` 記錄固定案例通過，但該結果屬重構前；
  重構後固定案例及全套回歸仍須由外層執行器在可啟動子程序的環境驗證。
- 人工核對可從首頁新增全天、午夜、上午、下午行程，再切換日／週與
  日期，核對名稱、起訖、排序及分組。Windows／Android 實機結果另記。

本目錄沒有 Git 儲存庫，無法取得既有 diff、建立階段 commit 或連結實際 PR。
未執行 TDD 或迴圈指令，未修改 scripts、acceptance.json、固定測試與既有證據，
未推送或部署。外層執行器仍負責 refactor 驗證、證據與後續選案。
