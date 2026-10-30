# 小米之家（香港）門市一覽

把小米香港官網的店舖位置頁，做成可自由篩選、每日自動更新的靜態網站。

- 線上頁面：`index.html`
- 資料檔：`xiaomi-stores.json`
- 產生器：`build-xiaomi-html.js`
- 每日自動更新：`.github/workflows/update.yml`

## 資料來源

小米香港官網店舖頁 <https://www.mi.com/hk/store/xiaomi-store> 是 React SPA，**不是** 豐澤／屈臣氏酒窖所用的 SAP Commerce（Hybris）OCC 架構，所以 `watStores` 那套路徑完全不適用。

實際資料由頁面 `store-map` 元件以 XHR 取得：

```
GET https://go.buy.mi.com/hk/authorizedstore/getdata
```

必要標頭：`Referer: https://www.mi.com/hk/store/xiaomi-store`。
回傳 `{ errno, errmsg, data: { storeList[], storeTypeInfo, title, desc, … } }`，目前 41 間門市。

> 注意：`www.mi.com` 受 Akamai WAF 保護，無頭瀏覽器會被 403 Access Denied；
> 必須用 Node `fetch`（或 curl）搭配完整瀏覽器標頭。Windows PowerShell 的
> `Invoke-WebRequest` 會因 TLS 交握失敗（`HTTP 000`），請改用 Node。

### 欄位對應

| 本頁欄位 | API 來源 | 說明 |
|---|---|---|
| 店號 | `id` | 英數格式 `SQHK00047` / `MIHK00001`，前綴即店舖類型 |
| 店名 | `name` | 全部共用前綴「小米之家中國（香港）」，卡片只顯示後半段 |
| 類型 | `storeType` + `storeTypeInfo` | `2` = 直營店（MIHK）、`3` = 授權店（SQHK） |
| 地區 | `city` | 香港島 / 九龍 / 新界 |
| 分區 | `address` 倒數第三段 | 以「，」分隔，例如 `…，沙田區，新界，香港` |
| 地址 | `address` 去掉後三段 | 完整地址保留在 `fullAddress`，卡片可一鍵複製 |
| 營業時間 | `weekend` | `星期一 10:30-20:30、星期二 …` 逐日字串 |
| 電話 | `mobileArr` / `mobile` | 卡片為 `tel:` 連結 |
| 座標 | `longitude` / `latitude` | 供 Google Maps 連結 |

API **沒有英文語系**（`?lang=en` 仍回中文），因此本頁不做中英雙語卡片。

## 相對前兩個品牌的調整

1. **店號不再是 4 位數字**：`SQHK00047` / `MIHK00001` 為英數，排序改為「前綴 → 數字後綴」，
   不再使用 `Number(storeNo)`（會得到 `NaN`）；徽章與索引也加大寬度。
2. **分類軸改用官方欄位**：`storeTypeInfo` 直接給出直營店／授權店，不必像豐澤那樣靠店號尾數猜。
3. **營業時間壓縮**：逐日字串（7 段）合併為「星期一至日 11:00-21:00」／「星期一至五 11:00-21:00」；
   缺漏的日子明確標示「（星期六至日未提供）」，不假裝全天候營業。
4. **店名去重**：41 間店名都以「小米之家中國（香港）」開頭（其中一間還用簡體「中国」），
   卡片只顯示區分用的後半段，全名保留在 `title`。
5. **主頁只分港九新界**：16 個分區切成子標題會碎成大量 1–2 間店的塊，掃讀成本高。
   版面固定三段（香港島 → 九龍 → 新界），分區只保留在卡片地址前的標籤與「分區」篩選選項；
   排序仍是「分區 → 店號」，所以同一分區的店自然排在一起，只是沒有標題把版面切開。
6. **前端「營業中」標記**：以香港時區計算當下是否在營業時間內，並顯示「尚未開門／已休息／今日休息」。
7. **HTML 不含時間戳**：用內容雜湊決定是否更新，資料沒變時重跑輸出逐位元相同，
   避免每日自動更新產生無意義 commit。載入時間由前端 JS 產生。

## 使用

```bash
node build-xiaomi-html.js            # 輸出到本目錄
node build-xiaomi-html.js ./dist     # 輸出到指定目錄
```

需要 Node 18+（全域 `fetch`）。

測試用：設 `STORE_FIXTURE=<本機 JSON>` 可跳過抓 API，直接以指定檔案模擬官方資料
（用來驗證「某店被下架」的情境）。

介面操作：店號／類型／地區／分區下拉 + 關鍵字搜尋（店名、地址、店號皆可，英文亦可，
例如 `the lohas`）；左側店號索引會跟著篩選結果同步隱藏。

## 部署到 GitHub Pages

```bash
git init -b main
git add -A && git commit -m "初始"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

接著由使用者在 GitHub 網頁操作（Fine-grained PAT 無法代勞）：

1. 建立空的 repo（`github.com/new`，不要勾選 README）
2. Settings → Pages → Deploy from a branch → `main` / `(root)`

之後 `.github/workflows/update.yml` 會每天香港時間 13:31 重抓並在有變動時自動 commit。
也可以在 Actions 頁面用 **Run workflow** 手動觸發。

## 店鋪生命週期（官方下架追蹤）

依 `store-page-lifecycle` skill 實作。官方店舖頁會不定時把門市下架，若直接以 API 為準重建頁面，
那些店會**無聲消失**；本頁改為三態保留。

| 狀態 | 判定 | 頁面呈現 |
|---|---|---|
| `active` | 官方 API 仍有回傳 | 正常卡片，位於所在區段 |
| `removed` | 從官方消失 **≤30 天** | 留在原區段；紅虛線框＋斜紋底＋「原網頁已移除」徽章＋移除日期；左側索引灰階刪線 |
| `closed` | 消失 **>30 天** | 移到頁底「已閉店」區塊（灰階）；**不列入左側索引**；永久保留 |

- 30 天自「**首次發現該店從官方 API 消失**」當天起算（不是最後營業日）。
- `removedAt` **只設定一次**，之後每日沿用；若每天重設，計時永遠到不了 30 天。

### 歷史檔 `store-history.json`

**必須 commit**（已納入 workflow 的 `git add`），否則每次 Actions 重建都會從空白開始、計時歸零。
每筆記錄保存完整渲染所需欄位（店名／地址／電話／營業時間分組／座標／連結），
所以卡片在官方下架後仍能完整顯示。

`lastSeen` 只在該店**內容有變化**時才更新，`updatedAt` 只在歷史內容真的變動時才更新 ——
因此資料沒變的日子重跑，三個產出檔都逐位元相同，不會產生無意義 commit。

### 初次建檔的回溯補全（最關鍵陷阱）

第一次建立歷史檔時，若只記錄「當下 API 有的店」，那些**在這個專案出現之前就已下架**的門市
會永遠從缺，且沒有任何人會發現。因此當歷史檔不存在時，產生器會掃描 `git log` 全部
`xiaomi-stores.json` 版本，把所有曾出現過的店號補進歷史檔，`removedAt` 取「最後出現日的隔天」。

實測驗證：模擬「40 天前最後出現」→ 補入為 `closed`；「10 天前最後出現」→ 補入為 `removed`。

### 一致性掃描（交付前必跑）

```bash
node scripts/scan-consistency.js
```

檢查 A–J 共 10 項，全 0 才算健康：

| # | 檢查 |
|---|---|
| A | git 曾出現、但歷史檔漏記錄 |
| B | 官方現有、但歷史檔沒有（新店未入帳） |
| C | 歷史檔有、官方已無（列出狀態與天數） |
| D | 官方已無、但 `removedAt` 為 null（計時未啟動） |
| E | 同店號出現多個名稱（可能改名） |
| F | 官方現有、但被標記 `removedAt`（應復活） |
| G | 欄位缺漏 |
| H | 店號格式異常（應為 `MIHK`/`SQHK` + 5 位數字） |
| I | `removedAt < lastSeen`（邏輯異常） |
| J | HTML 與 JSON 對帳（卡數、已閉店是否只在頁底、是否誤入左側索引、徽章數） |

### 邊界行為（已測試）

| 情境 | 期望 | 結果 |
|---|---|---|
| 消失 5 天 | `removed`，留在原區段 | ✅ |
| 恰好 30 天 | `removed`（`>30` 才轉 `closed`） | ✅ |
| 消失 31 天 | `closed`，移至頁底、脫離左側索引 | ✅ |
| 剛消失、`removedAt` 未設 | 立即開始計時，`removed` | ✅ |
| 官方又重新上架 | 復活 `active`，`removedAt` 清空 | ✅ |
| 同日重跑 | `removedAt` 不變（計時不重置） | ✅ |

## 已知限制

- 資料僅中文。
- 8 間門市的 `weekend` 只填到星期五，週末時段官方未提供，本頁照實標示。
- 店舖詳情頁 `https://www.mi.com/hk/store/xiaomi-store/detail/<店號>` 為 SPA 路由，
  資料由前端載入，直接抓 HTML 看不到內容屬正常。
