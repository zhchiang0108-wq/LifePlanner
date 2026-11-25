# LP-003 refactor 檢視紀錄

本次未修改產品程式與測試。註冊、登入與行程頁已透過 React 呼叫 Express，
資料由 PostgreSQL 保存；事件儲存共用 `saveEvent`，沒有本階段必要的重複或命名重構。

驗收覆蓋核對：

- `app/acceptance/LP-003.test.ts`：UI 註冊與登入、建立行程、直接核對 PostgreSQL、
  重啟後端及另一個獨立工作階段登入重新整理、其他帳號的清單與指定 ID 讀寫限制、匿名限制。
- `app/acceptance/LP-003-auth.test.ts`：無效憑證、重複註冊、錯誤密碼、
  新增時忽略偽造擁有者，以及登出後重播原 Cookie 的拒絕行為。
- 正常入口：`npm start` 啟動 `app/main.ts`，Express 提供 `/register`、`/login` 與 `/`。
  此項為程式檢視結論，本次未完成瀏覽器執行驗證。

本次重跑結果：

- `npm.cmd run typecheck` 通過。
- `node --test --test-isolation=none "tests/*.test.ts"`：2 項通過。
- `npm.cmd exec -- vitest run app/acceptance/LP-003.test.ts`：載入設定時 esbuild 子程序
  遭 `spawn EPERM` 阻擋，尚未執行產品斷言。
- 加上 `--configLoader native` 後，Vitest worker 仍遇到 `spawn EPERM`；
  再加上 `--pool threads`，Vite 的 Windows 路徑解析子程序同樣遭阻擋。
  未透過修改產品或降低測試要求規避環境限制，不能視為整合驗收通過。

後續需由允許測試工具啟動子程序的環境重跑固定測試及全套回歸。
Windows／Android 實機驗收仍須另記。未執行外層 TDD 指令、推送或部署，
未修改 scripts、acceptance.json、固定測試或既有證據。
