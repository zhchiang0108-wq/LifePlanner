# Life Planner 實作規格

Windows 與 Android 使用同一套 React + TypeScript 響應式網頁。UI 元件使用 TSX，後端使用 Node.js 24、TypeScript 與 Express。兩端共用 API 請求與回應的型別，Express 驗證收到的資料與登入身分。

兩台裝置用同帳號連到同一組 API。PostgreSQL 是行程、待辦、提醒與支出的持久化資料來源。後端在寫入前檢查最新的時段衝突，允許使用者明確確認重疊；首尾相接可直接儲存。隱藏只影響日／週行事曆的排版，清單、提醒及衝突檢查仍使用同一筆資料。

以 Vitest 跑應用邏輯與 API 整合測試，以 Playwright 操作瀏覽器。資料庫整合測試透過 TEST_DATABASE_URL 使用獨立的 PostgreSQL 測試資料庫。跨裝置案例使用兩個獨立工作階段，寫入後在另一端重新整理驗證。Windows 與 Android 實機驗收另記結果。

LP-003 Green 起，根 package.json 在 dependencies 宣告 react、react-dom 與 express；實際執行的資料庫用戶端也列於 dependencies。在專案安裝 typescript、vitest 與 Playwright，提交相應的 package-lock.json。根 tsconfig.json 涵蓋前後端產品程式碼；TypeScript 型別檢查與既有回歸必須通過。AI 僅參與開發與測試，產品執行可獨立於 AI 服務。
