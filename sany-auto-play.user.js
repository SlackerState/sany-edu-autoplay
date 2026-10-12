// ==UserScript==
// @name         三一在线学院 - 自动连播
// @namespace    https://github.com/SlackerState/sany-edu-autoplay
// @version      1.6.0
// @description  edu.sany.com.cn（云学堂）学习项目页：视频自动播放、文档自动挂满学时并随机翻页、完成后自动切到下一个未完成项，防挂机验证时声音+通知提醒本人确认，页面右下角带控制面板。正常倍速，不跳进度，不碰考试。
// @author       SlackerState
// @license      MIT
// @homepageURL  https://github.com/SlackerState/sany-edu-autoplay
// @supportURL   https://github.com/SlackerState/sany-edu-autoplay/issues
// @updateURL    https://raw.githubusercontent.com/SlackerState/sany-edu-autoplay/main/sany-auto-play.user.js
// @downloadURL  https://raw.githubusercontent.com/SlackerState/sany-edu-autoplay/main/sany-auto-play.user.js
// @match        https://edu.sany.com.cn/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// ==/UserScript==

/* ==UserConfig==
play:
  enabled:
    title: 进入课程页时自动开始
    description: 关闭后需在页面面板里点「开始」
    type: checkbox
    default: true
  volume:
    title: 音量
    description: 0~100。用音量 0 而不是静音，避免 Chrome 暂停后台的静音视频
    type: number
    default: 0
    min: 0
    max: 100
    unit: '%'
  rate:
    title: 播放倍速
    description: 建议保持 1，加速可能不计学时
    type: select
    default: '1'
    values: ['1', '1.25', '1.5', '2']
advanced:
  tickSec:
    title: 检查间隔
    type: number
    default: 3
    min: 1
    max: 30
    unit: 秒
  nextWaitSec:
    title: 一项完成后等待页面自动跳转的时间
    description: 超时后脚本自己点大纲里的下一个未完成项
    type: number
    default: 15
    min: 5
    max: 120
    unit: 秒
  stuckSec:
    title: 卡住判定时间
    description: 当前项未完成、又没有视频或倒计时在走，超过这个时间就跳过它
    type: number
    default: 60
    min: 20
    max: 600
    unit: 秒
  notify:
    title: 完成或需要手动处理时弹出系统通知
    type: checkbox
    default: true
afk:
  sound:
    title: 防挂机验证时响铃提醒
    description: 平台弹出防挂机验证后需在 60 秒内由本人点「继续学习」，脚本不会代点
    type: checkbox
    default: true
doc:
  flip:
    title: 阅读文档时自动翻页
    type: checkbox
    default: true
  flipMinSec:
    title: 翻页间隔下限
    type: number
    default: 15
    min: 3
    max: 600
    unit: 秒
  flipMaxSec:
    title: 翻页间隔上限
    description: 每次在上下限之间随机取一个间隔
    type: number
    default: 45
    min: 5
    max: 900
    unit: 秒
  flipPace:
    title: 按剩余时间加快翻页
    description: 页数多、时间不够时自动缩短间隔，尽量在计时结束前翻到最后一页
    type: checkbox
    default: true
 ==/UserConfig== */

(function () {
  'use strict';

  // ======================= 配置 =======================
  const CFG = {
    enabled: GM_getValue('play.enabled', true),
    volume: clamp(Number(GM_getValue('play.volume', 0)) || 0, 0, 100) / 100,
    rate: Number(GM_getValue('play.rate', '1')) || 1,
    tickMs: (Number(GM_getValue('advanced.tickSec', 3)) || 3) * 1000,
    nextWaitMs: (Number(GM_getValue('advanced.nextWaitSec', 15)) || 15) * 1000,
    stuckMs: (Number(GM_getValue('advanced.stuckSec', 60)) || 60) * 1000,
    notify: GM_getValue('advanced.notify', true),
    afkSound: GM_getValue('afk.sound', true),
    flip: GM_getValue('doc.flip', true),
    flipMinMs: (Number(GM_getValue('doc.flipMinSec', 15)) || 15) * 1000,
    flipMaxMs: (Number(GM_getValue('doc.flipMaxSec', 45)) || 45) * 1000,
    flipPace: GM_getValue('doc.flipPace', true),
  };
  if (CFG.flipMaxMs < CFG.flipMinMs) CFG.flipMaxMs = CFG.flipMinMs;

  // 脚本会自动处理的类型；其余（考试、作业、调查、外链课等）只提示，不进入
  const AUTO_TYPES = ['视频', '音频', '文档', '课程', '微课'];
  const DONE_COLOR = '#52C41A';

  let timer = null;
  let waitSince = 0;          // 进入"空闲/等待切换"状态的时间
  const skipped = new Set();  // 卡住而跳过的项（本次运行内）
  const logs = [];

  function clamp(n, a, b) { return Math.min(Math.max(n, a), b); }

  function log(...a) {
    const msg = a.join(' ');
    console.log('%c[自动连播]', 'color:#52c41a;font-weight:bold', msg);
    const d = new Date();
    logs.push(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}  ${msg}`);
    if (logs.length > 50) logs.shift();
    UI.renderLog();
  }

  function notify(text) {
    log(text);
    if (CFG.notify) GM_notification({ title: '三一在线学院 自动连播', text, timeout: 10000 });
  }

  // ======================= 页面读取 =======================
  // 状态图标：绿色 #52C41A = 已完成
  function isDone(row) {
    const paths = row?.querySelectorAll('.flex-space-between > svg path, :scope > svg path') || [];
    return [...paths].some(p => (p.getAttribute('fill') || '').toUpperCase() === DONE_COLOR);
  }

  // 第一层：学习项目里的任务（课程 / 文档 / 视频 / 考试 ...）
  function tasks() {
    return [...document.querySelectorAll('.task-content, .task-content-active')].map(el => {
      const name = el.querySelector('.group-title')?.innerText.trim() || '';
      const type = el.querySelector('.task-content-tag')?.innerText.trim() || '';
      return {
        key: 't:' + name, el, name, type, level: 0,
        done: isDone(el),
        active: el.classList.contains('task-content-active'),
      };
    }).filter(i => i.name);
  }

  // 第二层：当前"课程"任务里的章节内容（文档 | xxx、视频 | xxx）
  function lessons() {
    return [...document.querySelectorAll('.ulcdsdk-coursetitle')].map(el => {
      const text = el.innerText.trim();
      const m = text.match(/^(\S+)\s*\|\s*([\s\S]*)$/);
      return {
        key: 'l:' + text, el, name: m ? m[2].trim() : text, type: m ? m[1] : '', level: 1,
        done: isDone(el.closest('.layout-flex')),
        active: el.classList.contains('ulcdsdk-coursetitle__active'),
      };
    }).filter(i => i.type); // 去掉章节标题
  }

  // 合并成一个列表：任务，当前课程任务下面插入它的章节内容
  function outline() {
    const t = tasks(), l = lessons();
    if (!t.length) return l;
    const out = [];
    for (const task of t) {
      out.push(task);
      if (task.active && task.type === '课程') out.push(...l);
    }
    if (!t.some(x => x.active && x.type === '课程')) out.push(...l);
    return out;
  }

  // 当前打开的项：优先取章节内容，其次取任务
  function current(items = outline()) {
    return items.find(i => i.active && i.level === 1) || items.find(i => i.active) || null;
  }

  const canAuto = i => AUTO_TYPES.includes(i.type) && !skipped.has(i.key);

  function nextTodo(items = outline()) {
    // 先把当前课程里的章节学完，再去下一个任务
    return items.find(i => i.level === 1 && !i.done && canAuto(i)) ||
           items.find(i => i.level === 0 && !i.done && canAuto(i)) || null;
  }

  function mainVideo() {
    return [...document.querySelectorAll('.yxt-biz-video-container video, .yxtbiz-video-player video')]
      .find(v => v.duration > 0) || null;
  }

  // 顶部"还需 xx分钟 xx秒 可完成本课程学习"倒计时，返回剩余秒数；没有则 null
  function remainSec() {
    const el = [...document.querySelectorAll('.yxt-color-warning')]
      .find(e => e.offsetParent && /还需/.test(e.parentElement?.innerText || ''));
    if (!el) return null;
    const t = el.innerText;
    const n = re => Number((t.match(re) || [])[1] || 0);
    const s = n(/(\d+)\s*小时/) * 3600 + n(/(\d+)\s*分/) * 60 + n(/(\d+)\s*秒/);
    return /\d/.test(t) ? s : null;
  }

  function isDocPage() {
    return !!document.querySelector('.yxtbiz-doc-player');
  }

  // 文档底部翻页栏：[夜间][放大][缩小][全屏][上一页][页码 / 总页数][下一页]
  function docPager() {
    const pg = document.querySelector('.yxtbiz-doc-player .is-page');
    if (!pg) return null;
    const cur = Number(pg.querySelector('input')?.value) || 0;
    const total = Number((pg.innerText.match(/\/\s*(\d+)/) || [])[1]) || 0;
    const next = pg.nextElementSibling;
    const atEnd = !next || next.classList.contains('is-disabled') || (total > 0 && cur >= total);
    return { cur, total, next, atEnd };
  }

  // ======================= 文档自动翻页 =======================
  let nextFlipAt = 0;

  function flipDelay(p, remain) {
    let lo = CFG.flipMinMs, hi = CFG.flipMaxMs;
    const left = p.total ? p.total - p.cur : 0;
    if (CFG.flipPace && remain > 0 && left > 0) {
      const pace = (remain * 1000) / left; // 刚好翻完需要的平均间隔
      if (pace < lo) {
        lo = Math.max(3000, pace * 0.7);
        hi = Math.max(lo + 1000, pace * 1.2);
      }
    }
    return lo + Math.random() * (hi - lo);
  }

  function maybeFlip(remain) {
    const p = CFG.flip && docPager();
    if (!p || p.atEnd) { nextFlipAt = 0; return; }
    const now = Date.now();
    if (!nextFlipAt) { nextFlipAt = now + flipDelay(p, remain); return; }
    if (now < nextFlipAt) return;
    p.next.click();
    if (p.cur + 1 === p.total) log(`已翻到最后一页（${p.total}）`);
    nextFlipAt = now + flipDelay({ ...p, cur: p.cur + 1 }, remain);
  }

  // ======================= 动作 =======================
  async function ensurePlaying(v) {
    if (v.playbackRate !== CFG.rate) v.playbackRate = CFG.rate;
    if (v.volume !== CFG.volume) v.volume = CFG.volume;
    if (!v.paused || v.ended) return;
    try {
      v.muted = false;
      await v.play();
    } catch {
      // 未经用户交互时浏览器可能禁止有声自动播放，退回静音播放
      v.muted = true;
      await v.play().catch(() => {});
    }
    log('开始播放', fmt(v.currentTime), '/', fmt(v.duration));
  }

  // 课程封面上的「开始学习 / 继续学习」按钮
  function clickStartButton() {
    const area = document.querySelector('.yxtulcdsdk-course-player__inner-left') || document;
    const btn = [...area.querySelectorAll('button')]
      .find(b => b.offsetParent && /^(开始学习|继续学习)$/.test(b.innerText.trim()));
    if (btn) {
      log('点击「' + btn.innerText.trim() + '」');
      btn.click();
      return true;
    }
    return false;
  }

  // ---------- 防挂机验证：只提醒，不代点 ----------
  // 这个弹窗是平台确认"本人在场"的，必须由本人点击；脚本只负责让你注意到它。
  const AFK_RE = /防挂机|挂机验证|是否还在/;
  const DIALOG_SEL = '[class*="dialog"], [class*="message-box"], [class*="msgbox"], [class*="modal"]';

  function afkDialog() {
    const box = [...document.querySelectorAll(DIALOG_SEL)]
      .find(b => b.offsetParent && AFK_RE.test(b.innerText));
    if (!box) return null;
    return { box, expired: /倒计时结束|重新学习/.test(box.innerText) };
  }

  const afk = { since: 0, expiredNotified: false, titleTimer: null, title: '' };

  function onAfk(d) {
    if (!afk.since) {
      afk.since = Date.now();
      afk.expiredNotified = false;
      log('⚠️ 防挂机验证弹出，等待本人点击「继续学习」');
      if (!d.expired) {
        GM_notification({
          title: '⚠️ 防挂机验证',
          text: '请在 60 秒内回到页面，按空格/回车或点击「继续学习」，否则本次学时会被清零',
          timeout: 60000,
          onclick: () => window.focus(),
        });
        beep();
      }
      flashTitle(true);
    }
    if (d.expired && !afk.expiredNotified) {
      afk.expiredNotified = true;
      notify('防挂机验证已超时，本次学时被清零。请回到页面点「重新学习」');
    } else if (!d.expired && CFG.afkSound && (Date.now() - afk.since) % 15000 < CFG.tickMs) {
      beep(); // 每 15 秒再响一次
    }
  }

  // 本人按空格/回车即可确认：只响应真实键盘事件（isTrusted），脚本自己不会触发
  document.addEventListener('keydown', e => {
    if (!e.isTrusted || !['Space', 'Enter', 'NumpadEnter'].includes(e.code)) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    const d = afkDialog();
    if (!d || d.expired) return;
    const btn = [...d.box.querySelectorAll('button')]
      .find(b => b.offsetParent && /继续学习/.test(b.innerText));
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    btn.click();
    log('已按键确认防挂机验证');
  }, true);

  function onAfkGone() {
    if (!afk.since) return;
    log('防挂机验证已处理，继续');
    afk.since = 0;
    flashTitle(false);
    waitSince = 0;
  }

  function beep() {
    if (!CFG.afkSound) return;
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.35, 0.7].forEach(t => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.25, ac.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.25);
        o.connect(g).connect(ac.destination);
        o.start(ac.currentTime + t);
        o.stop(ac.currentTime + t + 0.25);
      });
      setTimeout(() => ac.close(), 1500);
    } catch { /* 浏览器不允许发声时忽略 */ }
  }

  function flashTitle(on) {
    clearInterval(afk.titleTimer);
    afk.titleTimer = null;
    if (on) {
      afk.title = document.title;
      let flip = false;
      afk.titleTimer = setInterval(() => {
        flip = !flip;
        document.title = flip ? '⚠️ 请点「继续学习」' : afk.title;
      }, 1000);
    } else if (afk.title) {
      document.title = afk.title;
    }
  }

  // ---------- 普通提示弹窗 ----------
  const OK_TEXTS = ['我知道了', '知道了', '确定', '确认'];
  function handleDialogs() {
    const boxes = document.querySelectorAll(DIALOG_SEL);
    for (const box of boxes) {
      if (!box.offsetParent) continue;
      if (AFK_RE.test(box.innerText)) continue;                 // 防挂机验证留给本人
      if (/考试|交卷|提交|验证/.test(box.innerText)) continue;   // 不碰考试和任何验证类弹窗
      const btn = [...box.querySelectorAll('button, .yxt-button, [role="button"]')]
        .find(b => b.offsetParent && OK_TEXTS.includes(b.innerText.trim()));
      if (btn) {
        log('关闭弹窗:', box.innerText.trim().slice(0, 30));
        btn.click();
        return true;
      }
    }
    return false;
  }

  // ======================= 主循环 =======================
  async function tick() {
    // 防挂机验证期间脚本什么都不做，只提醒
    const d = afkDialog();
    if (d) { onAfk(d); return; }
    onAfkGone();

    handleDialogs();
    if (clickStartButton()) { waitSince = 0; return; }

    const items = outline();
    const cur = current(items);
    const v = mainVideo();
    const remain = remainSec();

    // 1. 视频：播到结束为止
    if (v && !v.ended) {
      waitSince = 0;
      await ensurePlaying(v);
      return;
    }

    // 2. 文档/其他按时长计的内容：倒计时还在走，就等着（文档顺便翻页）
    if (cur && !cur.done && remain > 0) {
      waitSince = 0;
      if (isDocPage()) maybeFlip(remain);
      return;
    }
    nextFlipAt = 0;

    // 3. 当前项已完成（或视频已播完）：等页面自动跳转，超时则自己切
    if (!waitSince) waitSince = Date.now();
    const waited = Date.now() - waitSince;
    if (waited < CFG.nextWaitMs) return;

    const todo = nextTodo(items);

    // 当前项没完成，又没视频、没倒计时：可能还在加载，或需要手动操作
    if (todo && cur && todo.key === cur.key) {
      if (waited < CFG.stuckMs) return;
      skipped.add(cur.key);
      notify(`「${cur.name}」长时间没有进度，已跳过，请稍后手动检查`);
      waitSince = Date.now();
      return;
    }

    if (!todo) {
      const manual = items.filter(i => !i.done && (!AUTO_TYPES.includes(i.type) || skipped.has(i.key)));
      notify(manual.length
        ? `可自动学习的内容已完成 ✅ 还需手动处理：${manual.map(i => i.name).join('、')}`
        : '全部完成 ✅');
      stop();
      return;
    }

    log(`切换到: [${todo.type}] ${todo.name}`);
    todo.el.click();
    waitSince = Date.now();
  }

  function fmt(s) {
    s = Math.floor(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }

  // ======================= 启停 & 菜单 =======================
  let menuId = null;
  function refreshMenu() {
    if (menuId !== null) GM_unregisterMenuCommand(menuId);
    menuId = timer
      ? GM_registerMenuCommand('⏸ 停止自动连播', stop)
      : GM_registerMenuCommand('▶️ 开始自动连播', start);
  }

  function start() {
    if (!timer) {
      waitSince = 0;
      skipped.clear();
      timer = setInterval(tick, CFG.tickMs);
      log('已开始');
      tick();
    }
    refreshMenu();
    UI.render();
  }

  function stop() {
    if (timer) log('已停止');
    clearInterval(timer);
    timer = null;
    afk.since = 0;
    flashTitle(false);
    refreshMenu();
    UI.render();
  }

  // ======================= 页面面板 =======================
  const UI = (() => {
    let host, root, $ = () => null;
    const state = {
      min: GM_getValue('ui.min', false),
      showList: GM_getValue('ui.showList', true),
      pos: GM_getValue('ui.pos', null), // {right, bottom}
    };

    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .panel {
        position: fixed; z-index: 2147483000; width: 320px;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #262626; background: #fff; border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.16), 0 0 0 1px rgba(0,0,0,.06);
        overflow: hidden; user-select: none;
      }
      .hd {
        display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        background: #436BFF; color: #fff; cursor: move;
      }
      .hd .dot { width: 8px; height: 8px; border-radius: 50%; background: #BFBFBF; flex: none; }
      .hd .dot.on { background: #52C41A; box-shadow: 0 0 0 3px rgba(82,196,26,.35); animation: pulse 1.6s infinite; }
      @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(82,196,26,0); } }
      .hd .title { font-weight: 600; flex: 1; white-space: nowrap; }
      .hd .count { font-size: 12px; opacity: .9; }
      .hd button { all: unset; cursor: pointer; width: 22px; height: 22px; text-align: center; border-radius: 4px; font-size: 14px; line-height: 22px; }
      .hd button:hover { background: rgba(255,255,255,.2); }
      .bd { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
      .min .bd { display: none; }
      .min { width: auto; }

      .bar { height: 6px; background: #F0F0F0; border-radius: 3px; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: #52C41A; border-radius: 3px; transition: width .4s; }
      .bar.blue > i { background: #436BFF; }
      .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .muted { color: #8c8c8c; font-size: 12px; }
      .now { background: #F5F7FF; border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
      .now .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .tag { display: inline-block; font-size: 11px; line-height: 16px; padding: 0 5px; border-radius: 4px; background: #E6ECFF; color: #436BFF; margin-right: 4px; font-weight: 400; vertical-align: 1px; }

      .ctrl { display: flex; gap: 8px; align-items: center; }
      .btn {
        all: unset; cursor: pointer; padding: 6px 14px; border-radius: 6px; font-weight: 500;
        background: #436BFF; color: #fff; text-align: center;
      }
      .btn:hover { filter: brightness(1.08); }
      .btn.stop { background: #FF4D4F; }
      .btn.ghost { background: #F0F0F0; color: #595959; padding: 6px 10px; }
      select, input[type=range] { font: inherit; }
      select { border: 1px solid #D9D9D9; border-radius: 6px; padding: 4px 6px; background: #fff; color: #262626; }
      .vol { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
      .vol input { flex: 1; min-width: 0; accent-color: #436BFF; }
      .chk { display: flex; align-items: center; gap: 4px; cursor: pointer; }
      .chk input { margin: 0; accent-color: #436BFF; }

      .list { max-height: clamp(90px, calc(100vh - 420px), 210px); overflow: auto; border: 1px solid #F0F0F0; border-radius: 8px; }
      .list.hide { display: none; }
      .it { display: flex; gap: 6px; padding: 6px 8px; font-size: 12px; cursor: pointer; align-items: flex-start; }
      .it + .it { border-top: 1px solid #FAFAFA; }
      .it:hover { background: #FAFAFA; }
      .it.sub { padding-left: 24px; }
      .it.active { background: #F0F4FF; color: #436BFF; }
      .it .ic { flex: none; width: 16px; text-align: center; }
      .it .tp { flex: none; color: #8c8c8c; }
      .it .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .it.lvl0 .nm { font-weight: 500; }
      .it.done .nm { color: #8c8c8c; font-weight: 400; }
      .it.manual .tp { color: #FA8C16; }

      .log { background: #FAFAFA; border-radius: 8px; padding: 6px 8px; font: 11px/1.6 ui-monospace, Menlo, monospace; color: #595959; max-height: 92px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
      .warn { background: #FFFBE6; border: 1px solid #FFE58F; color: #874D00; border-radius: 8px; padding: 6px 10px; font-size: 12px; }
      .warn.danger { background: #FFF1F0; border-color: #FFA39E; color: #A8071A; font-weight: 500; font-size: 13px; }
      .panel.alert .hd { background: #FF4D4F; animation: blink 1s infinite; }
      @keyframes blink { 50% { background: #CF1322; } }
    `;

    const HTML = `
      <div class="panel">
        <div class="hd" id="hd">
          <span class="dot" id="dot"></span>
          <span class="title">自动连播</span>
          <span class="count" id="count"></span>
          <button id="toggleMin" title="收起/展开">–</button>
        </div>
        <div class="bd">
          <div>
            <div class="row"><span>学习进度</span><span class="muted" id="pct"></span></div>
            <div class="bar"><i id="totalBar"></i></div>
          </div>

          <div class="now">
            <div class="row"><span class="muted" id="nowLabel">当前</span><span class="muted" id="time"></span></div>
            <div class="name" id="curName">—</div>
            <div class="bar blue"><i id="curBar"></i></div>
            <div class="row pager" id="pagerRow" hidden>
              <span class="muted" id="pageInfo"></span>
              <label class="muted chk"><input type="checkbox" id="flip"> 自动翻页</label>
            </div>
          </div>

          <div class="warn" id="warn" hidden></div>

          <div class="ctrl">
            <button class="btn" id="startBtn">开始</button>
            <select id="rate" title="视频倍速">
              <option value="1">1×</option><option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option><option value="2">2×</option>
            </select>
            <label class="vol" title="视频音量"><span>🔈</span><input type="range" id="vol" min="0" max="100" step="5"></label>
          </div>

          <div class="row">
            <span>大纲</span>
            <button class="btn ghost" id="toggleList">收起</button>
          </div>
          <div class="list" id="list"></div>

          <div class="log" id="log"></div>
        </div>
      </div>`;

    function mount() {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.id = 'sany-auto-play-ui';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style>${HTML}`;
      document.documentElement.appendChild(host);
      $ = id => root.getElementById(id);

      applyPos();
      bind();
      render();
      renderLog();
    }

    function unmount() { host?.remove(); host = null; }

    function applyPos() {
      const p = root.querySelector('.panel');
      const pos = state.pos || { right: 20, bottom: 20 };
      p.style.right = pos.right + 'px';
      p.style.bottom = pos.bottom + 'px';
      p.classList.toggle('min', state.min);
      $('toggleMin').textContent = state.min ? '+' : '–';
    }

    function bind() {
      $('startBtn').onclick = () => (timer ? stop() : start());

      $('rate').value = String(CFG.rate);
      $('rate').onchange = e => {
        CFG.rate = Number(e.target.value);
        GM_setValue('play.rate', e.target.value);
        const v = mainVideo(); if (v) v.playbackRate = CFG.rate;
        render();
      };

      $('vol').value = Math.round(CFG.volume * 100);
      $('flip').checked = CFG.flip;
      $('flip').onchange = e => {
        CFG.flip = e.target.checked;
        GM_setValue('doc.flip', CFG.flip);
        nextFlipAt = 0;
        log(CFG.flip ? '已开启文档自动翻页' : '已关闭文档自动翻页');
      };

      $('vol').oninput = e => {
        CFG.volume = Number(e.target.value) / 100;
        GM_setValue('play.volume', Number(e.target.value));
        const v = mainVideo(); if (v) { v.volume = CFG.volume; if (CFG.volume > 0) v.muted = false; }
      };

      $('toggleMin').onclick = e => {
        e.stopPropagation();
        state.min = !state.min;
        GM_setValue('ui.min', state.min);
        applyPos();
      };

      $('toggleList').onclick = () => {
        state.showList = !state.showList;
        GM_setValue('ui.showList', state.showList);
        render();
      };

      $('list').onclick = e => {
        const it = e.target.closest('.it');
        if (!it) return;
        const item = outline().find(i => i.key === it.dataset.key);
        if (item) {
          log(`手动切换到: [${item.type}] ${item.name}`);
          skipped.delete(item.key);
          item.el.click();
          waitSince = 0;
        }
      };

      // 拖动
      $('hd').addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        const p = root.querySelector('.panel');
        const r = p.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY;
        const right0 = innerWidth - r.right, bottom0 = innerHeight - r.bottom;
        const move = ev => {
          state.pos = {
            right: clamp(right0 - (ev.clientX - sx), 0, innerWidth - r.width),
            bottom: clamp(bottom0 - (ev.clientY - sy), 0, innerHeight - 40),
          };
          applyPos();
        };
        const up = () => {
          removeEventListener('mousemove', move);
          removeEventListener('mouseup', up);
          GM_setValue('ui.pos', state.pos);
        };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
        e.preventDefault();
      });
    }

    let listSig = '';
    let remainMax = 0, remainKey = '';
    function render() {
      if (!host?.isConnected) return;
      const items = outline();
      // 进度只统计"叶子"：有章节时统计章节，课程任务本身不重复计
      const leaves = items.filter(i => !(i.level === 0 && i.type === '课程' && i.active && items.some(x => x.level === 1)));
      const done = leaves.filter(i => i.done).length;
      const total = leaves.length;
      const pct = total ? Math.round((done / total) * 100) : 0;

      $('dot').classList.toggle('on', !!timer);
      $('count').textContent = total ? `${done}/${total}` : '';
      $('pct').textContent = total ? `${done}/${total} · ${pct}%` : '读取中…';
      $('totalBar').style.width = pct + '%';

      const btn = $('startBtn');
      btn.textContent = timer ? '停止' : '开始';
      btn.classList.toggle('stop', !!timer);

      // 当前项
      const cur = current(items);
      const v = mainVideo();
      const remain = remainSec();
      $('curName').innerHTML = cur ? `<span class="tag">${esc(cur.type)}</span>${esc(cur.name)}` : '—';
      if (v) {
        $('nowLabel').textContent = v.paused ? '视频 · 暂停' : '视频 · 播放中';
        $('time').textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
        $('curBar').style.width = (v.currentTime / v.duration) * 100 + '%';
      } else if (remain !== null) {
        // 文档等按时长计：用首次看到的剩余时间当总量画进度条
        const key = cur?.key || '';
        if (key !== remainKey || remain > remainMax) { remainKey = key; remainMax = remain; }
        $('nowLabel').textContent = cur?.done ? '已完成' : '阅读计时中';
        $('time').textContent = `还需 ${fmt(remain)}`;
        $('curBar').style.width = remainMax ? ((remainMax - remain) / remainMax) * 100 + '%' : '0%';
      } else {
        $('nowLabel').textContent = cur?.done ? '已完成' : '当前';
        $('time').textContent = '';
        $('curBar').style.width = cur?.done ? '100%' : '0%';
      }

      // 文档页码 + 下次翻页倒计时
      const p = !v && docPager();
      $('pagerRow').hidden = !p;
      if (p) {
        let info = `第 ${p.cur}${p.total ? ' / ' + p.total : ''} 页`;
        if (p.atEnd) info += ' · 已到末页';
        else if (CFG.flip && timer && nextFlipAt) info += ` · ${Math.max(0, Math.ceil((nextFlipAt - Date.now()) / 1000))} 秒后翻页`;
        $('pageInfo').textContent = info;
      }

      const warn = $('warn');
      const d = afkDialog();
      root.querySelector('.panel').classList.toggle('alert', !!d);
      warn.classList.toggle('danger', !!d);
      if (d) {
        const left = afk.since ? Math.max(0, 60 - Math.floor((Date.now() - afk.since) / 1000)) : 60;
        warn.hidden = false;
        warn.textContent = d.expired
          ? '⚠️ 防挂机验证已超时，本次学时被清零。请点页面上的「重新学习」'
          : `⚠️ 防挂机验证：约 ${left} 秒内按空格/回车或点「继续学习」确认`;
      } else {
        const tips = [];
        if (CFG.rate !== 1) tips.push(`当前 ${CFG.rate}× 倍速，平台可能不计学时，建议用 1×`);
        if (timer && isDocPage() && !v) tips.push('文档按停留时长计时，请保持此页面可见，不要最小化窗口');
        warn.hidden = !tips.length;
        warn.textContent = tips.join('；');
      }

      // 大纲
      const list = $('list');
      list.classList.toggle('hide', !state.showList);
      $('toggleList').textContent = state.showList ? '收起' : '展开';
      const sig = items.map(i => `${i.key}${i.done}${i.active}${skipped.has(i.key)}`).join('|');
      if (sig !== listSig) {
        listSig = sig;
        list.innerHTML = items.map(i => {
          const manual = !i.done && !canAuto(i);
          const cls = ['it', 'lvl' + i.level, i.level ? 'sub' : '', i.done ? 'done' : '', i.active ? 'active' : '', manual ? 'manual' : ''].join(' ');
          const icon = i.done ? '✅' : i.active ? '▶' : manual ? '✋' : '⬜';
          return `<div class="${cls}" data-key="${esc(i.key)}" title="${esc(i.type + ' | ' + i.name)}${manual ? '（需手动）' : ''}">
            <span class="ic">${icon}</span>
            <span class="tp">${esc(i.type)}</span>
            <span class="nm">${esc(i.name)}</span>
          </div>`;
        }).join('');
        list.querySelector('.active.sub, .active')?.scrollIntoView({ block: 'nearest' });
      }
    }

    function renderLog() {
      if (!host?.isConnected) return;
      const el = $('log');
      el.textContent = logs.slice(-20).join('\n') || '暂无日志';
      el.scrollTop = el.scrollHeight;
    }

    function esc(s) {
      return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    return { mount, unmount, render, renderLog };
  })();

  // ======================= 入口 =======================
  window.__sanyAuto = { start, stop, CFG, outline };

  // 只在课程播放页运行（单页应用，监听 hash 变化）
  const onPlayPage = () => location.hash.startsWith('#/playinfo');
  function sync() {
    if (onPlayPage()) {
      UI.mount();
      if (CFG.enabled && !timer) start();
    } else {
      if (timer) stop();
      UI.unmount();
    }
  }
  window.addEventListener('hashchange', sync);
  setInterval(() => onPlayPage() && UI.render(), 1000);
  sync();
  refreshMenu();
})();
