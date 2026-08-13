# 倉點 Stockcheck

手機優先的多人共享庫存盤點網站。GitHub Pages 負責靜態介面，Supabase 負責登入及共享資料庫。

## 日常使用

- 每日盤點：按種類展開產品，輸入實際現存數量。
- 現有產品入貨：選擇產品，輸入新增箱／包數。
- 新產品：在「入貨」按「新增產品」，填種類、品牌、味道、規格及首次數量。
- PDF 入貨：檔案只在使用者裝置辨認，確認後才寫入結構化入貨記錄。
- 所有獲授權裝置共用同一個 Supabase Database。

## 管理設定

網站部署由 GitHub Actions 自動處理。Repository Variables 需要設定：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_ADSENSE_PUBLISHER_ID`（完成 AdSense 審批後填寫）

資料庫結構在 `supabase/schema.sql`。Supabase Auth 建議由管理員邀請使用者，網站不開放自行註冊。

Google AdSense 使用官方底部 regular anchor 格式。未設定有效 `ca-pub-…` 或尚未通過 Google 審批時，不會顯示廣告。
