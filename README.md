# 倉點 Stockcheck

手機優先的多人共享庫存盤點網站。GitHub Pages 負責靜態介面，Supabase 負責登入及共享資料庫。

## 日常使用

- 每日盤點：按主分類及子分類展開產品，輸入實際現存數量。
- 現有產品入貨：選擇產品，輸入新增箱／包數。
- 新產品：在「入貨」按「新增產品」，填種類、品牌、味道、規格及首次數量。
- PDF／圖片入貨：支援 PDF、JPG、JPEG、PNG；檔案只在使用者裝置進行 OCR 辨認，完成資料核對及確認後才寫入結構化入貨記錄。
- 每間店舖／倉庫是獨立 Workspace，只有成員可以查看。
- 店主可在「管理店舖」輸入同事電郵；對方用相同電郵登入後會自動加入。
- 同一帳戶可建立及切換多間店舖，各自保留獨立產品、庫存和記錄。
- 記錄頁可更正入錯的產品、數量及單位，並保留原資料與更正人；庫存頁可編輯產品名稱、主分類、子分類及包裝資料。
- 管理員可在「庫存 → 分類設定」查看兩層分類，並將原有主分類批量搬入現有或新建主分類之下；產品、庫存及歷史記錄不受影響。

## 管理設定

網站部署由 GitHub Actions 自動處理。Repository Variables 需要設定：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_ADSENSE_PUBLISHER_ID`（完成 AdSense 審批後填寫）

資料庫基礎結構在 `supabase/schema.sql`，Workspace 升級及 RLS 資料隔離在 `supabase/workspace-migration.sql`；現有系統的兩層分類升級在 `supabase/subcategory-migration.sql`，安全批量分類搬移在 `supabase/category-manager-migration.sql`。使用者以電郵 Magic Link 登入，新使用者可建立自己的獨立店舖。

Google AdSense 使用官方底部 regular anchor 格式。未設定有效 `ca-pub-…` 或尚未通過 Google 審批時，不會顯示廣告。
