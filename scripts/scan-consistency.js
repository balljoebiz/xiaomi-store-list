#!/usr/bin/env node
/**
 * 小米之家門市頁 — 一致性掃描（store-page-lifecycle skill 的 A–I 檢查，已改為小米資料形態）
 *
 * 用法：
 *   node scripts/scan-consistency.js [專案目錄]
 *
 * 檢查項目：
 *   A. git 歷史曾出現、但歷史檔漏記錄
 *   B. 官方現有、但歷史檔沒有（新店未入帳）
 *   C. 歷史檔有、官方已無（列出狀態與天數）
 *   D. 官方已無、但 removedAt 為 null（計時未啟動）
 *   E. 同店號出現多個名稱（可能改名）
 *   F. 官方現有、但歷史檔標記 removedAt（應復活）
 *   G. 欄位缺漏（hours / geo / url / district…）
 *   H. 店號格式異常（小米為 MIHK/SQHK + 5 位數字）
 *   I. removedAt < lastSeen（邏輯異常）
 *   J. HTML 與 JSON 對帳（在架卡數、已閉店卡是否只在頁底、已閉店是否誤入左側索引）
 *
 * 全部為 0 才視為健康；有任何異常 exit code 2。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_URL = process.env.STORE_API || 'https://go.buy.mi.com/hk/authorizedstore/getdata';
const HISTORY_FILE = 'store-history.json';
const DATA_FILE = process.env.STORE_DATA_FILE || 'xiaomi-stores.json';
const HTML_FILE = 'index.html';
const CLOSED_DAYS = Number(process.env.STORE_CLOSED_DAYS || 30);
const STORE_NO_RE = /^(MIHK|SQHK)\d{5}$/;

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const histPath = path.join(dir, HISTORY_FILE);
const dataPath = path.join(dir, DATA_FILE);
const htmlPath = path.join(dir, HTML_FILE);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

(async () => {
  // ── 官方現況 ──
  const resp = await fetch(API_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      accept: 'application/json, text/plain, */*',
      referer: 'https://www.mi.com/hk/store/xiaomi-store',
      origin: 'https://www.mi.com',
    },
  });
  if (!resp.ok) throw new Error(`官方 API HTTP ${resp.status}`);
  const live = new Map((await resp.json()).data.storeList.map((s) => [String(s.id), String(s.name || '').trim()]));
  console.log(`① 官方 API 現況：${live.size} 間`);

  if (!fs.existsSync(histPath)) {
    console.error(`✗ 找不到 ${histPath}（歷史檔是漏記錄的根源，請先建立）`);
    process.exit(1);
  }
  const hist = readJson(histPath);
  const histMap = new Map(Object.entries(hist.stores || {}));
  console.log(`② ${HISTORY_FILE}：${histMap.size} 筆`);

  // ── git 全歷史 ──
  const everSeen = new Map();
  let commitCount = 0;
  try {
    // 注意：execSync 在 Windows 經 cmd.exe，--format 的值必須加引號，否則 `|` 會被當成管線
    const log = execSync(`git log --all --format="%H|%ad" --date="format:%Y-%m-%dT%H:%M:%S" -- ${DATA_FILE}`, {
      cwd: dir, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const commits = log.split('\n').filter(Boolean)
      .map((l) => { const [sha, date] = l.split('|'); return { sha, date }; })
      .sort((a, b) => a.date.localeCompare(b.date));
    commitCount = commits.length;
    for (const c of commits) {
      try {
        const j = JSON.parse(execSync(`git show ${c.sha}:${DATA_FILE}`, {
          cwd: dir, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }));
        for (const s of (j.stores || [])) {
          const no = String(s.id || s.storeNo || '');
          if (!no) continue;
          const name = String(s.name || '').trim();
          const prev = everSeen.get(no);
          if (!prev) everSeen.set(no, { lastSeen: c.date, names: new Set([name]) });
          else { prev.lastSeen = c.date; prev.names.add(name); }
        }
      } catch { /* 略過讀不到的 commit */ }
    }
  } catch { /* 不是 git repo */ }
  console.log(`③ git 歷史：${commitCount} commit，曾出現店號 ${everSeen.size}`);

  const p = { missing: [], newStore: [], noRemovedAt: [], revived: [], renamed: [], incomplete: [], badNo: [], logic: [], html: [] };

  // A. 曾出現但歷史檔沒有
  for (const [no, e] of everSeen) {
    if (!histMap.has(no)) p.missing.push(`${no}｜最後出現 ${e.lastSeen.slice(0, 10)}｜官方現有:${live.has(no)}`);
  }

  // B. 官方有但歷史檔沒有
  for (const [no, name] of live) if (!histMap.has(no)) p.newStore.push(`${no} ${name}`);

  for (const [no, h] of histMap) {
    const isLive = live.has(no);
    // D. 官方已無但未開始計時
    if (!isLive && !h.removedAt) p.noRemovedAt.push(`${no} ${h.name}`);
    // F. 官方有卻被標記已移除
    if (isLive && h.removedAt) p.revived.push(`${no} ${live.get(no)}`);
    // G. 欄位完整性
    const miss = ['name', 'address', 'fullAddress', 'district', 'region', 'type', 'typeKey'].filter((k) => !h[k]);
    if (!h.hours) miss.push('hours');
    if (!Array.isArray(h.hoursGroups) || !h.hoursGroups.length) miss.push('hoursGroups');
    if (!Array.isArray(h.phones) || !h.phones.length) miss.push('phones');
    if (!h.geo || h.geo.lat == null) miss.push('geo');
    if (!h.detailUrl) miss.push('detailUrl');
    if (miss.length) p.incomplete.push(`${no} 缺 ${miss.join(',')}`);
    // H. 店號格式
    if (!STORE_NO_RE.test(no)) p.badNo.push(no);
    // I. 邏輯
    if (h.removedAt && h.lastSeen && new Date(h.removedAt) < new Date(h.lastSeen)) {
      p.logic.push(`${no}: removedAt(${h.removedAt.slice(0, 10)}) < lastSeen(${h.lastSeen.slice(0, 10)})`);
    }
  }

  // E. 店名變更
  for (const [no, e] of everSeen) if (e.names.size > 1) p.renamed.push(`${no}: ${[...e.names].join(' → ')}`);

  // ── C. 官方已無（列出狀態） ──
  const now = Date.now();
  const removedList = [...histMap.entries()].filter(([no]) => !live.has(no)).map(([no, h]) => {
    const days = h.removedAt ? Math.floor((now - new Date(h.removedAt).getTime()) / 86400000) : null;
    const state = days == null ? '未標記' : days > CLOSED_DAYS ? '已閉店' : `已移除（${days} 天）`;
    return `  ${no} | ${h.name} | removedAt ${h.removedAt ? h.removedAt.slice(0, 10) : 'null'} | ${state}`;
  });
  console.log('\n=== C. 歷史檔有、官方已無 ===');
  console.log(removedList.length ? removedList.join('\n') : '  無');

  // ── 產出檔對帳 ──
  if (fs.existsSync(dataPath)) {
    const prod = readJson(dataPath);
    const arr = prod.stores || [];
    console.log(`\n=== 產出檔 ${DATA_FILE} ===`);
    console.log(`  count=${prod.count} active=${prod.activeCount} removed=${prod.removedCount} closed=${prod.closedCount}`);

    const prodActive = arr.filter((s) => s.state === 'active').map((s) => s.id);
    const liveOnly = [...live.keys()].filter((no) => !prodActive.includes(no));
    const prodOnly = prodActive.filter((no) => !live.has(no));
    if (liveOnly.length) p.html.push(`官方有但產出缺：${liveOnly.join(',')}`);
    if (prodOnly.length) p.html.push(`產出標 active 但官方無：${prodOnly.join(',')}`);

    // J. HTML 對帳
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      const cards = (html.match(/class="store-card/g) || []).length;
      if (cards !== arr.length) p.html.push(`HTML 卡片數 ${cards} ≠ JSON ${arr.length}`);

      const closedIdx = html.indexOf('class="closed-zone"');
      const closedCards = arr.filter((s) => s.state === 'closed');
      let closedOutside = 0, closedInSidebar = 0;
      for (const s of closedCards) {
        const i = html.indexOf(`id="store-${s.id}"`);
        if (i < 0) { closedOutside++; continue; }
        const inZone = closedIdx >= 0 && i > closedIdx;
        if (!inZone) closedOutside++;
        if (html.includes(`href="#store-${s.id}"`)) closedInSidebar++;
      }
      if (closedCards.length && closedIdx < 0) p.html.push('有已閉店但沒有 closed-zone 區塊');
      if (closedOutside) p.html.push(`${closedOutside} 間已閉店不在頁底區塊`);
      if (closedInSidebar) p.html.push(`${closedInSidebar} 間已閉店誤入左側索引`);

      const removedCards = arr.filter((s) => s.state === 'removed').length;
      // 只數徽章元素，避免頁尾說明文字「會保留 30 天並標示…」被誤計
      const badges = (html.match(/class="badge-removed"/g) || []).length;
      if (badges !== removedCards) p.html.push(`「原網頁已移除」徽章 ${badges} ≠ 已移除 ${removedCards}`);

      const closedBadges = (html.match(/class="badge-closed"/g) || []).length;
      if (closedBadges !== closedCards.length) p.html.push(`「已閉店」徽章 ${closedBadges} ≠ 已閉店 ${closedCards.length}`);
    } else {
      p.html.push(`找不到 ${HTML_FILE}`);
    }
  } else {
    p.html.push(`找不到 ${DATA_FILE}`);
  }

  // ── 輸出 ──
  const sections = [
    ['A. 曾出現但歷史檔漏記錄', p.missing],
    ['B. 官方有但歷史檔沒有（新店）', p.newStore],
    ['D. 官方已無但 removedAt 未設定', p.noRemovedAt],
    ['F. 官方有但標記已移除（需復活）', p.revived],
    ['E. 店名變更', p.renamed],
    ['G. 欄位不完整', p.incomplete],
    ['H. 店號格式異常', p.badNo],
    ['I. removedAt < lastSeen', p.logic],
    ['J. HTML／JSON 對帳', p.html],
  ];
  let total = 0;
  for (const [title, list] of sections) {
    console.log(`\n=== ${title} ===`);
    if (list.length) { list.forEach((x) => console.log('  ⚠️ ' + x)); total += list.length; }
    else console.log('  無 ✅');
  }

  const active = [...histMap.values()].filter((h) => !h.removedAt).length;
  const removed = [...histMap.values()].filter((h) => h.removedAt && Math.floor((now - new Date(h.removedAt).getTime()) / 86400000) <= CLOSED_DAYS).length;
  const closed = [...histMap.values()].filter((h) => h.removedAt && Math.floor((now - new Date(h.removedAt).getTime()) / 86400000) > CLOSED_DAYS).length;
  console.log('\n=== 統計 ===');
  console.log(`  歷史檔總筆數 ${histMap.size}｜在架 ${active}｜已移除 ≤${CLOSED_DAYS} 天 ${removed}｜已閉店 ${closed}`);

  console.log('\n=== 總結 ===');
  console.log(total === 0 ? '✅ 全部檢查通過，無異常' : `⚠️ 共 ${total} 項異常，請修正`);
  process.exit(total === 0 ? 0 : 2);
})().catch((e) => {
  console.error('掃描失敗:', e.message);
  process.exit(1);
});
