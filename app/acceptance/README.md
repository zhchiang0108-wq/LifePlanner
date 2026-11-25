# LP-003 整合驗收契約

目前由 Express 提供 React/TypeScript 介面，帳號、工作階段與行程儲存在 PostgreSQL。
固定驗收檔為 `LP-003.test.ts`；`LP-003-auth.test.ts` 補充資料驗證、
新增行程的擁有者綁定與登出撤銷測試。產品啟動步驟見根目錄 README。
外層執行器負責執行 TDD 階段及保存證據；可直接重跑測試診斷環境。

## 必要環境

- Node.js 24；由專案根目錄安裝 package.json 的開發依賴。
- 真實 PostgreSQL，透過 `TEST_DATABASE_URL` 指向專用測試資料庫。
  帳號須可建立 schema；測試只建立及刪除自己的隨機 schema，不清空其他資料。
- Playwright 1.65.1 的 Chromium。既有啟動器設定
  `PLAYWRIGHT_BROWSERS_PATH=.runtime/browsers`；獨立環境須提供同版瀏覽器。
- Vitest 設定只納入 `app/**/*.test.ts`；npm test 同時保留原有 Node 單元測試。

重試目標命令：`npx.cmd --no-install vitest run app/acceptance/LP-003.test.ts`。
Windows PowerShell 使用 `.cmd` 避免執行原則阻擋 `npx.ps1`。

## Green 階段的公開介面

- `startApp({ databaseUrl })` 啟動真正 Express/React TypeScript 應用，
  使用指定資料庫及 URL options 中的 search_path 執行遷移；回傳 url 和 close。
  close 須釋放 listener、資料庫連線等資源，重啟不得重設資料。
- `/register`、`/login`：具「電子郵件」「密碼」標籤，及「註冊」「登入」按鈕。
  呼叫 `POST /api/auth/register`（201）與 `POST /api/auth/login`（200），
  回應 `{ user: { id, email } }`，使用瀏覽器的安全工作階段 cookie 驗證。
- `/`：具「行程名稱」「開始時間」「結束時間」欄位及「儲存行程」按鈕。
  datetime-local 以 Asia/Taipei 解讀。每筆真實行程有 `data-testid="event-<id>"`。
- `POST /api/events`：201，回傳建立的行程（含 id、title）。
- `GET /api/events`：200，回傳目前帳號的行程陣列；不得信任 userId 查詢參數。
- `GET /api/events/:id`：自己的行程 200；其他帳號 403 或 404，且不洩漏名稱。
- `PATCH`、`DELETE /api/events/:id`：其他帳號 403 或 404，資料不得改變。
- 未登入讀取或新增行程：401。
- PostgreSQL 契約：`users(id, email)`、
  `events(id, user_id, title, starts_at, ends_at)`；id 以 JSON 字串表示，
  時間欄位保留絕對時間（例如 timestamptz）。

以上是為可重現整合驗收訂定的介面，未以 mock 或測試端 SQL 建立產品資料。
測試經 UI 註冊、登入、新增後直接查詢 PostgreSQL，再關閉第一個 context、
重啟後端，由全新 context 登入及重新整理。B 帳號另外檢查清單、指定 ID、
偽造擁有者查詢及修改與刪除，每次攻擊後核對原始資料仍完整。
兩個 context 證明工作階段隔離；實際 Windows/Android 裝置驗收仍屬後續項目。
