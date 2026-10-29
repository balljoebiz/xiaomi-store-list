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

## 已知限制

- 資料僅中文。
- 8 間門市的 `weekend` 只填到星期五，週末時段官方未提供，本頁照實標示。
- 店舖詳情頁 `https://www.mi.com/hk/store/xiaomi-store/detail/<店號>` 為 SPA 路由，
  資料由前端載入，直接抓 HTML 看不到內容屬正常。
