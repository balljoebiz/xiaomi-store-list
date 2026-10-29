#!/usr/bin/env node
/**
 * 小米之家（香港）門市資料抓取 + 靜態頁生成器
 *
 * 資料來源: https://go.buy.mi.com/hk/authorizedstore/getdata
 *   （由 mi.com 店舖頁 store-map 元件的 XHR 反查而得，非 SAP Commerce 架構）
 *
 * 用法: node build-xiaomi-html.js [輸出目錄]
 *
 * 與豐澤／屈臣氏酒窖版的差異（已針對小米資料形態調整）:
 *   1. 店號為英數格式 SQHK00047 / MIHK00001，前綴即店舖類型 → 不再用 Number() 排序
 *   2. 分類軸改用 storeTypeInfo（直營店／授權店），而非名稱關鍵字猜測
 *   3. 資料僅有中文（API 無英文語系），故不做中英雙語卡
 *   4. 店名共用前綴「小米之家中國（香港）」→ 卡片精簡顯示，全名保留於 title
 *   5. 營業時間為「星期一 10:30-20:30、星期二 …」逐日字串 → 壓縮成「星期一至五」區間
 *   6. 分區（沙田區／觀塘區…）藏在地址倒數第三段 → 解析出來只當卡片標示與篩選選項，
 *      主頁版面**只分香港島／九龍／新界**，不按分區切子標題（16 個分區會碎成 1–2 間一組）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_URL = 'https://go.buy.mi.com/hk/authorizedstore/getdata';
const WWW = 'https://www.mi.com/hk';
const OUT_DIR = process.argv[2] || __dirname;
const OUT_HTML = path.join(OUT_DIR, 'index.html');
const OUT_JSON = path.join(OUT_DIR, 'xiaomi-stores.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQ_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-HK,zh;q=0.9',
  'Referer': 'https://www.mi.com/hk/store/xiaomi-store',
  'Origin': 'https://www.mi.com',
};

const REGION_ORDER = ['香港島', '九龍', '新界'];
const DAY_NAMES = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const DAY_LABEL = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };

/** 「星期一 10:30-20:30、星期二 10:30-20:30…」→ [{days:[1,2,3,4,5], open:'10:30', close:'20:30'}…] */
function parseDailyHours(raw) {
  const out = [];
  const seen = new Map();
  for (const seg of String(raw || '').split(/[、,;；]/)) {
    const m = seg.trim().match(/^星期([一二三四五六日天])\s*(\d{1,2}:\d{2})\s*[-–~至]\s*(\d{1,2}:\d{2})$/);
    if (!m) continue;
    const d = DAY_NAMES[m[1]];
    if (!d || seen.has(d)) continue;
    seen.set(d, true);
    out.push({ d, open: m[2].padStart(5, '0'), close: m[3].padStart(5, '0') });
  }
  out.sort((a, b) => a.d - b.d);
  // 合併連續且時間相同的日子
  const groups = [];
  for (const item of out) {
    const last = groups[groups.length - 1];
    if (last && last.open === item.open && last.close === item.close && item.d === last.days[last.days.length - 1] + 1) {
      last.days.push(item.d);
    } else {
      groups.push({ days: [item.d], open: item.open, close: item.close });
    }
  }
  return groups;
}

/** 壓縮後的營業時間文字；缺漏的日子明確標示，不假裝全天候營業 */
function hoursText(groups) {
  if (!groups.length) return '資料從缺';
  const text = groups.map((g) => {
    const a = g.days[0], b = g.days[g.days.length - 1];
    const label = g.days.length === 1 ? `星期${DAY_LABEL[a]}` : `星期${DAY_LABEL[a]}至${g.days.length === 7 ? '日' : DAY_LABEL[b]}`;
    return `${label} ${g.open}-${g.close}`;
  }).join('、');
  const covered = new Set(groups.flatMap((g) => g.days));
  const missing = [1, 2, 3, 4, 5, 6, 7].filter((d) => !covered.has(d));
  if (!missing.length) return text;
  const range = (arr) => (arr.length > 1 && arr[arr.length - 1] - arr[0] === arr.length - 1
    ? `星期${DAY_LABEL[arr[0]]}至${DAY_LABEL[arr[arr.length - 1]]}`
    : arr.map((d) => `星期${DAY_LABEL[d]}`).join('、'));
  return `${text}（${range(missing)}未提供）`;
}

/** 地址「置富第一城G02號舖，沙田區，新界，香港」→ { street, district, region } */
function splitAddress(address, cityFallback) {
  const parts = String(address || '').split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  const region = (cityFallback || '').trim();
  const idx = parts.lastIndexOf(region);
  if (idx > 0) {
    return {
      street: parts.slice(0, idx - 1).join('，'),
      district: parts[idx - 1],
      region,
    };
  }
  return { street: parts.join('，'), district: '其他', region: region || '其他' };
}

/** 店名去掉共用前綴「小米之家中國（香港）」；中國/中国 混用一併正規化 */
function shortName(name) {
  const full = String(name || '').replace(/中国/g, '中國').trim();
  const s = full.replace(/^小米之家中國（香港）/, '').trim();
  return s || full;
}

function typeInfo(storeType, storeTypeInfo, id) {
  const map = storeTypeInfo || {};
  const label = map[String(storeType)] || '';
  const prefix = String(id || '').slice(0, 4).toUpperCase();
  if (label) return { key: String(storeType) === '2' ? 'direct' : 'authorized', label };
  return prefix === 'MIHK'
    ? { key: 'direct', label: '直營店' }
    : { key: 'authorized', label: '授權店' };
}

/** 店號排序：先依前綴（MIHK 直營 → SQHK 授權），再依數字後綴 */
function compareStoreNo(a, b) {
  const pa = String(a).match(/^([A-Za-z]*)(\d*)$/) || [];
  const pb = String(b).match(/^([A-Za-z]*)(\d*)$/) || [];
  const prefA = pa[1] || '', prefB = pb[1] || '';
  if (prefA !== prefB) return prefA.localeCompare(prefB);
  return Number(pa[2] || 0) - Number(pb[2] || 0);
}

async function fetchStores() {
  console.log('抓取中:', API_URL);
  const resp = await fetch(API_URL, { headers: REQ_HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const payload = await resp.json();
  if (payload.errno !== 0) throw new Error(`API errno ${payload.errno}: ${payload.errmsg}`);
  const data = payload.data || {};
  const list = data.storeList || [];
  if (!list.length) throw new Error('API 回傳 0 間店舖，中止以免覆蓋既有資料');

  const records = list.map((s) => {
    const { street, district, region } = splitAddress(s.address, s.city);
    const t = typeInfo(s.storeType, data.storeTypeInfo, s.id);
    const groups = parseDailyHours(s.weekend);
    const phones = (s.mobileArr && s.mobileArr.length ? s.mobileArr : [s.mobile]).map((x) => String(x || '').trim()).filter(Boolean);
    const lat = Number(s.latitude), lng = Number(s.longitude);
    const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 1000 && lng !== 1000;
    const name = String(s.name || '').replace(/中国/g, '中國').trim();
    return {
      id: String(s.id || '').trim(),
      name,
      shortName: shortName(s.name),
      type: t.label,
      typeKey: t.key,
      region: REGION_ORDER.includes(region) ? region : '其他',
      district,
      address: street,
      fullAddress: String(s.address || '').trim(),
      phones,
      hours: hoursText(groups),
      hoursGroups: groups.map((g) => ({ days: g.days, open: g.open, close: g.close })),
      hoursNote: groups.length ? '' : String(s.weekend || '').trim(),
      geo: hasGeo ? { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) } : null,
      mapUrl: hasGeo ? `https://www.google.com/maps?q=${lat},${lng}` : '',
      detailUrl: s.id ? `${WWW}/store/xiaomi-store/detail/${encodeURIComponent(s.id)}` : '',
    };
  }).filter((r) => r.id);

  records.sort((a, b) => {
    const ra = REGION_ORDER.indexOf(a.region), rb = REGION_ORDER.indexOf(b.region);
    if (ra !== rb) return ra - rb;
    if (a.district !== b.district) return a.district.localeCompare(b.district, 'zh-HK');
    return compareStoreNo(a.id, b.id);
  });

  return { records, storeTypeInfo: data.storeTypeInfo || {}, raw: list.length };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readPreviousMeta() {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
    return { contentHash: prev.contentHash || '', updatedAt: prev.updatedAt || '' };
  } catch { return { contentHash: '', updatedAt: '' }; }
}

async function main() {
  const { records, storeTypeInfo } = await fetchStores();
  console.log(`共 ${records.length} 間店舖`);

  // 資料本體沒變就不更新「資料更新日」，讓 HTML 逐位元一致 → 不會每天產生無意義 commit
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 16);
  const prev = readPreviousMeta();
  const unchanged = prev.contentHash === contentHash && !!prev.updatedAt;
  const updatedAt = unchanged ? prev.updatedAt : new Date().toISOString();
  const dateStr = new Date(updatedAt).toLocaleDateString('zh-HK', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Hong_Kong',
  });

  // ── 分組：地區 → 分區 → 店 ────────────────────────────────────────────
  const regions = [];
  for (const region of REGION_ORDER.concat('其他')) {
    const inRegion = records.filter((r) => r.region === region);
    if (!inRegion.length) continue;
    const districts = new Map();
    for (const r of inRegion) {
      if (!districts.has(r.district)) districts.set(r.district, []);
      districts.get(r.district).push(r);
    }
    const dOrder = [...districts.keys()].sort((a, b) => a.localeCompare(b, 'zh-HK'));
    regions.push({ region, total: inRegion.length, districts: dOrder.map((d) => ({ district: d, stores: districts.get(d) })) });
  }

  const typeSummary = {};
  for (const r of records) typeSummary[r.type] = (typeSummary[r.type] || 0) + 1;

  const searchBlob = (r) => [
    r.id, r.name, r.shortName, r.type, r.region, r.district, r.address, r.fullAddress, r.phones.join(' '), r.hours,
  ].join(' ').toLowerCase();

  const card = (r) => {
    const short = r.shortName !== r.name ? r.shortName : '';
    const phoneLinks = r.phones.map((p) => {
      const tel = p.replace(/[^\d+]/g, '');
      return `<a href="tel:${esc(tel)}" title="致電 ${esc(p)}">${esc(p)}</a>`;
    }).join('');
    const isDirect = r.typeKey === 'direct';
    return `<article class="store-card${isDirect ? ' is-direct' : ''}" id="store-${esc(r.id)}" data-id="${esc(r.id)}" data-region="${esc(r.region)}" data-district="${esc(r.district)}" data-type="${esc(r.typeKey)}" data-search="${esc(searchBlob(r))}">
  <div class="card-top">
    <span class="store-no" title="店號 ${esc(r.id)}">${esc(r.id)}</span>
    <span class="type-tag${isDirect ? ' direct' : ''}">${esc(r.type)}</span>
    <span class="open-badge" data-hours="${esc(JSON.stringify(r.hoursGroups))}" aria-live="polite"></span>
  </div>
  <h4 class="store-name" title="${esc(r.name)}">${esc(short || r.shortName)}</h4>
  <div class="store-addr" title="${esc(r.fullAddress)}"><span class="district">${esc(r.district)}</span>${esc(r.address)}</div>
  <div class="store-hours"><span class="k">營業時間</span>${esc(r.hours)}</div>
  <div class="store-foot">
    <span class="store-phone">${phoneLinks}</span>
    ${r.mapUrl ? `<a class="mini" href="${esc(r.mapUrl)}" target="_blank" rel="noopener">地圖</a>` : ''}
    ${r.detailUrl ? `<a class="mini" href="${esc(r.detailUrl)}" target="_blank" rel="noopener">官方頁</a>` : ''}
    <button type="button" class="mini copy" data-addr="${esc(r.fullAddress)}" title="複製完整地址">複製地址</button>
  </div>
</article>`;
  };

  const regionBlocks = regions.map((rg) => {
    // 主頁只按「香港島 / 九龍 / 新界」三段呈現，不再往下切成 16 個分區子標題。
    // 分區資訊保留在卡片地址前的標籤與「分區」篩選選項，不作為版面的分組層級。
    const stores = rg.districts.flatMap((d) => d.stores);
    return `<section class="region" id="region-${esc(rg.region)}" data-region-section="${esc(rg.region)}">
  <h2>${esc(rg.region)} <span class="count">${rg.total}</span></h2>
  <div class="stores">${stores.map(card).join('\n')}</div>
</section>`;
  }).join('\n');

  // ── 篩選列選項 ──────────────────────────────────────────────────────
  const ALL_TYPES = [{ key: 'direct', label: storeTypeInfo['2'] || '直營店' }, { key: 'authorized', label: storeTypeInfo['3'] || '授權店' }];
  const typeOptions = ALL_TYPES.filter((t) => typeSummary[t.label]).map((t) => `<option value="${t.key}">${esc(t.label)}（${typeSummary[t.label]}）</option>`).join('\n      ');
  const regionOptions = regions.map((rg) => `<option value="${esc(rg.region)}">${esc(rg.region)}（${rg.total}）</option>`).join('\n      ');
  const districtList = [...new Set(records.map((r) => r.district))].sort((a, b) => a.localeCompare(b, 'zh-HK'));
  const districtOptions = districtList.map((d) => `<option value="${esc(d)}">${esc(d)}（${records.filter((r) => r.district === d).length}）</option>`).join('\n      ');
  const storeNoOptions = [
    { key: 'direct', label: storeTypeInfo['2'] || '直營店' },
    { key: 'authorized', label: storeTypeInfo['3'] || '授權店' },
  ].map((t) => {
    const list = records.filter((r) => r.typeKey === t.key).sort((a, b) => compareStoreNo(a.id, b.id));
    if (!list.length) return '';
    const opts = list.map((r) => `          <option value="${esc(r.id)}">${esc(r.id)}　${esc(r.shortName)}</option>`).join('\n');
    return `        <optgroup label="${esc(t.label)}">\n${opts}\n        </optgroup>`;
  }).filter(Boolean).join('\n');

  const sidebarBlocks = [
    { key: 'direct', label: storeTypeInfo['2'] || '直營店' },
    { key: 'authorized', label: storeTypeInfo['3'] || '授權店' },
  ].map((t) => {
    const list = records.filter((r) => r.typeKey === t.key).sort((a, b) => compareStoreNo(a.id, b.id));
    if (!list.length) return '';
    const items = list.map((r) => `        <a class="side-item" href="#store-${esc(r.id)}" data-id="${esc(r.id)}" title="${esc(r.id)}｜${esc(r.name)}｜${esc(r.region)} ${esc(r.district)}"><span class="side-no">${esc(r.id)}</span><span class="side-name">${esc(r.shortName)}</span><span class="side-d">${esc(r.district)}</span></a>`).join('\n');
    return `      <div class="side-group" data-side-type="${t.key}">
        <div class="side-group-title">${esc(t.label)} <span class="count">${list.length}</span></div>
${items}
      </div>`;
  }).filter(Boolean).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-HK">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小米之家 香港門市一覽（${records.length} 間）| Xiaomi Store HK</title>
<meta name="description" content="小米之家香港全部 ${records.length} 間門市（直營店及授權店）的店號、地址、營業時間、電話，按地區與分區整理，可直接篩選及搜尋。">
<meta name="robots" content="index,follow">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23ff6900'/%3E%3Ctext x='16' y='22' font-family='Arial,sans-serif' font-size='14' font-weight='bold' fill='%23fff' text-anchor='middle'%3Emi%3C/text%3E%3C/svg%3E">
<style>
:root { --primary:#ff6900; --bg:#fff; --fg:#1f2430; --muted:#6b7280; --card:#fff; --border:#e5e7eb; --chip:#f3f4f6; --ok:#16a34a; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1216; --fg:#e5e7eb; --muted:#9ca3af; --card:#181d24; --border:#2a313c; --chip:#222932; --ok:#22c55e; }
}
* { box-sizing:border-box; margin:0; padding:0; }
/* 卡片/索引項是 display:flex，會蓋掉 UA 的 [hidden]{display:none}，必須強制 */
[hidden] { display:none !important; }
html { scroll-padding-top:132px; scroll-behavior:smooth; }
body { font-family:"Segoe UI","PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif; background:var(--bg); color:var(--fg); line-height:1.6; padding:1rem; }
a { color:var(--primary); }
header { max-width:1440px; margin:0 auto 1rem; }
h1 { font-size:1.55rem; color:var(--primary); display:flex; align-items:center; gap:.55rem; flex-wrap:wrap; }
h1 .logo { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; border-radius:8px; background:var(--primary); color:#fff; font-size:1.05rem; font-weight:800; letter-spacing:-.5px; }
.sub { color:var(--muted); font-size:.84rem; margin-top:.35rem; }
.sub b { color:var(--fg); font-weight:600; }
/* ── 篩選列 ── */
.filters { position:sticky; top:0; z-index:30; background:var(--bg); border:1px solid var(--border); border-radius:.55rem; padding:.7rem .85rem; margin:0 auto 1rem; max-width:1440px; display:flex; flex-wrap:wrap; gap:.6rem .8rem; align-items:flex-end; box-shadow:0 2px 10px rgba(0,0,0,.06); }
.filters label { display:flex; flex-direction:column; gap:.15rem; font-size:.74rem; color:var(--muted); }
.filters select, .filters input { background:var(--card); color:var(--fg); border:1px solid var(--border); border-radius:.35rem; padding:.36rem .5rem; font-size:.88rem; font-family:inherit; }
.filters select:focus, .filters input:focus { outline:2px solid var(--primary); outline-offset:1px; }
.filters select#f-storeno { min-width:250px; max-width:290px; }
.filters input#f-q { min-width:210px; }
.btn { background:transparent; color:var(--primary); border:1px solid var(--primary); border-radius:.35rem; padding:.38rem .7rem; font-size:.82rem; cursor:pointer; font-family:inherit; }
.btn:hover { background:var(--primary); color:#fff; }
.filter-count { font-size:.82rem; color:var(--muted); margin-left:auto; align-self:center; white-space:nowrap; }
.type-summary { display:flex; gap:.4rem; flex-wrap:wrap; }
.type-pill { font-size:.76rem; border:1px solid var(--border); border-radius:999px; padding:.15rem .55rem; color:var(--muted); background:var(--chip); }
.type-pill.direct { border-color:var(--primary); color:var(--primary); background:rgba(255,105,0,.08); }
/* ── 版面：左側店號索引 + 右側內容 ── */
.layout { display:flex; gap:1.1rem; max-width:1440px; margin:0 auto; align-items:flex-start; }
.sidebar { position:sticky; top:118px; flex:0 0 286px; width:286px; max-height:calc(100vh - 140px); overflow-y:auto; border:1px solid var(--border); border-radius:.55rem; background:var(--card); }
.sidebar-head { position:sticky; top:0; z-index:1; font-weight:700; font-size:.88rem; padding:.55rem .7rem; border-bottom:1px solid var(--border); background:var(--card); display:flex; justify-content:space-between; gap:.5rem; }
.sidebar-head .count { font-weight:400; }
.sidebar-nav { padding:.2rem .3rem .5rem; }
.side-group-title { font-size:.71rem; font-weight:800; color:var(--primary); letter-spacing:.03em; padding:.55rem .5rem .2rem; }
.side-item { display:flex; gap:.4rem; align-items:baseline; padding:.2rem .5rem; text-decoration:none; color:var(--fg); font-size:.75rem; border-radius:.28rem; }
.side-item:hover, .side-item:focus-visible { background:rgba(255,105,0,.13); }
.side-no { flex:0 0 auto; font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; font-size:.7rem; font-weight:700; color:var(--primary); }
.side-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.side-d { flex:0 0 auto; color:var(--muted); font-size:.66rem; }
main { flex:1 1 auto; min-width:0; }
.region { margin-bottom:2.4rem; }
.region > h2 { font-size:1.3rem; border-bottom:2px solid var(--primary); padding-bottom:.3rem; margin-bottom:.5rem; }
.count { color:var(--muted); font-weight:400; font-size:.86rem; }
.stores { display:grid; grid-template-columns:repeat(auto-fill,minmax(332px,1fr)); gap:.7rem; margin-top:.7rem; }
/* ── 卡片 ── */
.store-card { background:var(--card); border:1px solid var(--border); border-radius:.55rem; padding:.7rem .8rem; display:flex; flex-direction:column; gap:.32rem; scroll-margin-top:132px; }
.store-card.is-direct { border-color:var(--primary); box-shadow:inset 3px 0 0 var(--primary); }
.store-card:target { outline:2px solid var(--primary); outline-offset:2px; }
.card-top { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
.store-no { font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; font-size:.72rem; font-weight:700; background:var(--primary); color:#fff; border-radius:.28rem; padding:.1rem .38rem; letter-spacing:.02em; }
.type-tag { font-size:.7rem; border:1px solid var(--border); color:var(--muted); border-radius:.28rem; padding:.06rem .35rem; background:var(--chip); }
.type-tag.direct { border-color:var(--primary); color:var(--primary); background:rgba(255,105,0,.08); font-weight:700; }
.open-badge { margin-left:auto; font-size:.7rem; border-radius:999px; padding:.08rem .45rem; border:1px solid var(--border); color:var(--muted); }
.open-badge.on { color:#fff; background:var(--ok); border-color:var(--ok); }
.store-name { font-size:.95rem; font-weight:700; line-height:1.35; }
.store-addr { color:var(--muted); font-size:.84rem; }
.store-addr .district { display:inline-block; border:1px solid var(--border); border-radius:.22rem; padding:0 .26rem; margin-right:.35rem; font-size:.74rem; }
.store-hours { font-size:.84rem; }
.store-hours .k { color:var(--muted); font-size:.72rem; margin-right:.35rem; }
.store-foot { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; margin-top:.1rem; font-size:.8rem; }
.store-phone a { text-decoration:none; font-variant-numeric:tabular-nums; }
.store-phone a + a::before { content:" / "; color:var(--muted); }
.mini { font-size:.75rem; border:1px solid var(--border); border-radius:.28rem; padding:.08rem .4rem; text-decoration:none; color:var(--muted); background:transparent; font-family:inherit; cursor:pointer; }
.mini:hover { border-color:var(--primary); color:var(--primary); }
.copy.copied { border-color:var(--ok); color:var(--ok); }
.empty { border:1px dashed var(--border); border-radius:.55rem; padding:2rem 1rem; text-align:center; color:var(--muted); display:none; }
footer { max-width:1440px; margin:2rem auto 0; color:var(--muted); font-size:.78rem; border-top:1px solid var(--border); padding-top:.7rem; }
footer p + p { margin-top:.25rem; }
@media (max-width:960px) {
  .layout { flex-direction:column; }
  .sidebar { position:static; flex:0 0 auto; width:100%; max-height:280px; }
  .sidebar-head { position:static; }
  html { scroll-padding-top:110px; }
}
@media (max-width:640px) {
  body { padding:.7rem; }
  .stores { grid-template-columns:1fr; }
  .filters { padding:.6rem; }
  .filters label { flex:1 1 46%; }
  .filters select, .filters input { width:100%; }
  .filters select#f-storeno, .filters input#f-q { min-width:0; max-width:none; }
  .filter-count { margin-left:0; }
  h1 { font-size:1.3rem; }
}
</style>
</head>
<body>
<header>
  <h1><span class="logo">mi</span>小米之家 香港門市一覽</h1>
  <div class="sub">全港 <b>${records.length}</b> 間門市・<button type="button" class="mini" id="toggle-types" style="border:none;background:none;padding:0;color:var(--primary);cursor:pointer">${ALL_TYPES.map((t) => `${esc(t.label)} ${typeSummary[t.label] || 0}`).join(' ・ ')}</button>・資料來源：小米香港官網店舖頁</div>
</header>

<div class="filters">
  <label>店號
    <select id="f-storeno">
      <option value="">全部店號</option>
${storeNoOptions}
    </select>
  </label>
  <label>類型
    <select id="f-type">
      <option value="">全部類型</option>
      ${typeOptions}
    </select>
  </label>
  <label>地區
    <select id="f-region">
      <option value="">全部地區</option>
      ${regionOptions}
    </select>
  </label>
  <label>分區
    <select id="f-district">
      <option value="">全部</option>
      ${districtOptions}
    </select>
  </label>
  <label>搜尋
    <input id="f-q" type="search" placeholder="店名／地址／店號，中英皆可" autocomplete="off">
  </label>
  <button type="button" class="btn" id="f-reset">清除</button>
  <span class="filter-count" id="f-count">顯示 ${records.length} / ${records.length} 間</span>
</div>

<div class="layout">
  <aside class="sidebar" aria-label="店號索引">
    <div class="sidebar-head"><span>店號索引</span><span class="count">${records.length}</span></div>
    <nav class="sidebar-nav">
${sidebarBlocks}
    </nav>
  </aside>
  <main>
${regionBlocks}
    <div class="empty" id="empty">沒有符合條件的門市，請調整篩選。</div>
  </main>
</div>

<footer>
  <p>小米之家（香港）門市資料自動抓取自小米香港官網店舖位置頁（go.buy.mi.com／authorizedstore）。資料更新：${esc(dateStr)}・共 ${records.length} 間。</p>
  <p>店號前綴：<b>MIHK</b> = 直營店、<b>SQHK</b> = 授權店。營業時間與電話以官方門市公告為準。本頁載入時間：<span id="load-time">—</span></p>
</footer>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var storeNoSel = $('f-storeno'), typeSel = $('f-type'), regionSel = $('f-region'), districtSel = $('f-district'), qInput = $('f-q');
  var resetBtn = $('f-reset'), countEl = $('f-count'), emptyEl = $('empty');
  var cards = [].slice.call(document.querySelectorAll('.store-card'));
  var sections = [].slice.call(document.querySelectorAll('.region'));
  var sideItems = [].slice.call(document.querySelectorAll('.side-item'));
  var sideGroups = [].slice.call(document.querySelectorAll('.side-group'));
  var total = cards.length;

  /* ── 依香港時區計算「現在是否營業」 ── */
  function hkNow() {
    var parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Hong_Kong', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date());
    } catch (e) { return null; }
    var map = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }, out = {};
    parts.forEach(function (p) { out[p.type] = p.value; });
    var hh = out.hour === '24' ? '00' : out.hour;
    return { day: map[out.weekday], minutes: parseInt(hh, 10) * 60 + parseInt(out.minute, 10), label: hh + ':' + out.minute };
  }
  function toMin(t) { var p = String(t).split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }

  function markOpen() {
    var now = hkNow();
    if (!now) return;
    cards.forEach(function (card) {
      var badge = card.querySelector('.open-badge');
      if (!badge) return;
      var groups;
      try { groups = JSON.parse(badge.getAttribute('data-hours') || '[]'); } catch (e) { groups = []; }
      var todayGroups = groups.filter(function (g) { return g.days.indexOf(now.day) !== -1; });
      if (!todayGroups.length) {
        badge.textContent = '今日休息';
        badge.className = 'open-badge';
        return;
      }
      var hit = todayGroups.some(function (g) { return now.minutes >= toMin(g.open) && now.minutes < toMin(g.close); });
      if (hit) {
        badge.textContent = '營業中';
        badge.className = 'open-badge on';
      } else {
        var next = todayGroups.map(function (g) { return toMin(g.open); }).filter(function (m) { return m > now.minutes; }).sort(function (a, b) { return a - b; })[0];
        badge.textContent = next ? '尚未開門' : '已休息';
        badge.className = 'open-badge';
      }
    });
  }

  /* ── 篩選 ── */
  function apply() {
    var vNo = storeNoSel.value, vType = typeSel.value, vRegion = regionSel.value, vDistrict = districtSel.value;
    var q = qInput.value.trim().toLowerCase();
    var shown = 0, visible = {};
    cards.forEach(function (card) {
      var ok = (!vNo || card.getAttribute('data-id') === vNo) &&
               (!vType || card.getAttribute('data-type') === vType) &&
               (!vRegion || card.getAttribute('data-region') === vRegion) &&
               (!vDistrict || card.getAttribute('data-district') === vDistrict) &&
               (!q || card.getAttribute('data-search').indexOf(q) !== -1);
      card.hidden = !ok;
      if (ok) { shown++; visible[card.getAttribute('data-id')] = true; }
    });
    sections.forEach(function (s) {
      s.hidden = !s.querySelector('.store-card:not([hidden])');
    });
    sideItems.forEach(function (it) {
      it.hidden = !visible[it.getAttribute('data-id')];
    });
    sideGroups.forEach(function (g) {
      g.hidden = !g.querySelector('.side-item:not([hidden])');
    });
    countEl.textContent = '顯示 ' + shown + ' / ' + total + ' 間';
    emptyEl.style.display = shown ? 'none' : 'block';
  }

  [storeNoSel, typeSel, regionSel, districtSel].forEach(function (el) { el.addEventListener('change', apply); });
  qInput.addEventListener('input', apply);
  resetBtn.addEventListener('click', function () {
    storeNoSel.value = ''; typeSel.value = ''; regionSel.value = ''; districtSel.value = ''; qInput.value = '';
    apply();
  });

  /* ── 複製完整地址 ── */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy');
    if (!btn) return;
    var text = btn.getAttribute('data-addr') || '';
    var done = function () {
      btn.classList.add('copied');
      var old = btn.textContent;
      btn.textContent = '已複製';
      setTimeout(function () { btn.classList.remove('copied'); btn.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else { fallback(text, done); }
  });
  function fallback(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ── 載入時間（前端產生，避免時間戳污染 HTML） ── */
  $('load-time').textContent = new Date().toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });

  markOpen();
  apply();
})();
</script>
</body>
</html>`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    source: API_URL,
    sourcePage: 'https://www.mi.com/hk/store/xiaomi-store',
    fetchedAt: new Date().toISOString(),
    updatedAt,
    contentHash,
    count: records.length,
    storeTypeInfo,
    stores: records,
  }, null, 2), 'utf8');
  fs.writeFileSync(OUT_HTML, html, 'utf8');

  console.log('已寫入:', OUT_JSON);
  console.log('已寫入:', OUT_HTML, `(${html.length} bytes)`);
  console.log(unchanged ? '資料未變 → 沿用既有更新日 ' + dateStr : '資料已更新 → ' + dateStr);
}

main().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
