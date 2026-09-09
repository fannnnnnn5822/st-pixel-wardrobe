/*
 * ============================================================================
 * 👗 像素衣橱 — 给 {{user}} 换装，换好了一按，AI 就照这身写
 * ----------------------------------------------------------------------------
 * 作者: fannnnnnn × Claude
 * 版本: 0.1.0
 *
 * 它是什么：一个酒馆助手**全局**脚本。右下角一个小人悬浮球（球上就是你现在这身
 * 打扮），点开是衣橱：左边纸娃娃，右边分类挑衣服挑颜色。挑完按「穿好了」，
 * 这身穿搭就以一句话注入进每次生成，AI 写你的时候按这身写。
 *
 * 架构（照 [[悬浮手机技术]] 那套）：
 *   脚本直挂 parent.document 悬浮球 + 面板（不碰聊天消息、不碰 markdown 管线）
 *   素材按分类懒加载（第一次开只下 index + 当前页的清单和图集 ≈ 127 KB）
 *   穿搭存聊天变量（每个聊天一套）+ 全局变量（收藏 / 我的穿搭 / 上次穿的）
 *   injectPrompts 固定 id 注入，再按一次是替换不是叠加
 *
 * 挂到 parent 上的东西必须自己收：pagehide → cleanup（DOM / 事件 / 定时器 / 注入）
 * ============================================================================
 */
(function () {
  'use strict';

  var NS = 'pixel-wardrobe';
  var BTN = '👗 衣橱';
  var VERSION = '0.2.0';
  var GKEY = 'pixel_wardrobe';          // 变量表里的键名（全局 + 聊天都用这个）
  var INJECT_ID = 'pixel_wardrobe';     // 注入 id，固定不变 = 再按一次是替换
  var CELL = 64;

  var DOC, VIEW;
  try { VIEW = window.parent; DOC = VIEW.document; } catch (e) { return; }
  if (!DOC) return;

  // ═══ 顶掉旧实例（脚本重载 / 换卡重跑）═══
  var INSTANCE_KEY = '__pixelWardrobeCleanup__';
  try { if (typeof VIEW[INSTANCE_KEY] === 'function') VIEW[INSTANCE_KEY](); } catch (e) {}

  /* ================================================================
     素材从哪来
     在线版加载器会先设好 window.__PIXEL_WARDROBE_REF__（提交号），
     所以发版切指针 = 素材和脚本一起换新，不吃 CDN 缓存。
     本地测试台会设 window.__PIXEL_WARDROBE_ASSETS__ 直接指向本地目录。
     ================================================================ */
  var REPO = 'fannnnnnn5822/st-pixel-wardrobe';
  var REF = (typeof window.__PIXEL_WARDROBE_REF__ === 'string' && window.__PIXEL_WARDROBE_REF__) || 'main';
  var ASSET_BASE = (typeof window.__PIXEL_WARDROBE_ASSETS__ === 'string' && window.__PIXEL_WARDROBE_ASSETS__)
    || ('https://cdn.jsdelivr.net/gh/' + REPO + '@' + REF + '/assets/');
  if (ASSET_BASE.slice(-1) !== '/') ASSET_BASE += '/';

  /* ================================================================
     分类 / 槽位
     ================================================================ */
  var TABS = [
    { id: 'body',     name: '肤色·脸' },
    { id: 'hair',     name: '发型' },
    { id: 'headwear', name: '头饰配饰' },
    { id: 'torso',    name: '上装' },
    { id: 'legs',     name: '下装' },
    { id: 'feet',     name: '鞋' }
  ];
  var TAB_NAME = {};
  TABS.forEach(function (t) { TAB_NAME[t.id] = t.name; });

  // 单品 id 的头一段决定它属于哪个分类文件
  function catOfId(id) {
    var head = String(id).split('.')[0];
    if (head === 'body' || head === 'head') return 'body';
    if (head === 'hair' || head === 'headwear' || head === 'torso' ||
        head === 'legs' || head === 'feet') return head;
    return null;
  }

  /* ────────────────────────────────────────────────────────────────
     长相 vs 衣服
     脸和身材捏好了就不该再变 —— 所以状态分成两半：
       长相（person）= 肤色 / 头 / 五官 / 耳朵角 / 头发
       衣服（clothes）= 其余全部（含自绘主题装里的猫尾、项圈这些）
     「全脱」只脱衣服；存穿搭 / 套装 / 随机一套也只管衣服。
     自绘的单品 id 长这样：<分类>.homemade.<名字> —— 中间那段就是标记。
     ──────────────────────────────────────────────────────────────── */
  function isPersonId(id) {
    id = String(id);
    if (id.indexOf('.homemade.') >= 0) return false;
    var h = id.split('.')[0];
    return h === 'body' || h === 'head' || h === 'hair';
  }
  // 身体和脸这两格永远不能空（空了娃娃就是一张飘着的脸 / 一堆没人穿的衣服）
  function isSkinId(id) {
    return id === 'body.body' || String(id).indexOf('body.special.') === 0;
  }
  function isHeadId(id) { return String(id).indexOf('head.heads.') === 0; }
  function isCoreId(id) { return isSkinId(id) || isHeadId(id); }
  function splitList(arr) {
    var p = [], c = [];
    (arr || []).forEach(function (o) { if (o && o.id) (isPersonId(o.id) ? p : c).push(o); });
    return { person: p, clothes: c };
  }
  function worn() { return S.person.concat(S.clothes); }
  function listOfId(id) { return isPersonId(id) ? 'person' : 'clothes'; }

  // 同一个槽位一次只能穿一件（换一件 = 脱掉上一件）。
  // 滚边 / 袖子 / 帽饰这类「叠层件」不占槽位，可以和本体一起穿。
  var OVERLAY_RE = /(trim|overlay|sleeves|feather|skull|cockade|stitch|thatch|buckle|knot|rune|second color|buttons|collar|lapel|lace|dots|edge)/i;
  function slotOf(it) {
    if (it.slot) return it.slot;      // 自绘主题装自己写死了槽位，不用靠子分类猜
    var tn = it.tn || '';
    if (/(trim|sleeves)/.test(tn) || OVERLAY_RE.test(it.en || '')) return 'ov:' + it.id;
    // 上游的 type_name 比目录名靠谱：紧身胸衣裙挂在 dresses/ 底下，但它其实是件背心，
    // 当连衣裙处理会把裙子和上衣一起脱掉（真穿出来就是光腿）
    if (tn === 'dress') return 'dress';
    if (tn === 'vest') return 'vest';
    var s = it.sub || '';
    if (/^head\/heads\//.test(s)) return 'head';
    if (/^hair\/beards/.test(s)) return 'beard';
    if (/^hair\/mustaches/.test(s)) return 'stache';
    if (/^hair\/extensions\//.test(s)) return 'hairext';
    if (/^hair\//.test(s)) return 'hair';
    if (/^head\/furry_ears/.test(s) || s === 'head/ears') return 'ears';
    if (/^body\/wings/.test(s)) return 'wings';
    if (/^body\/(tails|lizard)/.test(s)) return 'tail';
    if (/^headwear\/(hats|coverings)/.test(s)) return 'hat';
    if (/^headwear\/accessories\/(glasses|monocle)/.test(s)) return 'glasses';
    if (/^headwear\/neck\/charms/.test(s)) return 'charm';
    if (/^headwear\/neck/.test(s)) return 'neck';
    if (/^torso\/shirts/.test(s)) return 'top';
    if (/^torso\/dresses/.test(s)) return 'dress';
    if (/^torso\/jacket/.test(s)) return 'jacket';
    if (/^torso\/waist/.test(s)) return 'belt';
    if (/^torso\/backpack/.test(s)) return 'back';
    if (/^legs/.test(s)) return 'bottom';
    if (s === 'feet/socks') return 'socks';
    if (/^feet/.test(s)) return 'shoes';
    return s || it.id;
  }

  // 连衣裙盖住上下身：穿裙子把上衣和下装挤掉，反过来也一样
  var EXCLUDES = { dress: ['top', 'bottom'], top: ['dress'], bottom: ['dress'] };

  // 出词的时候按这个分组、这个顺序（肤色/五官不进词）
  var PROMPT_GROUPS = [
    { label: '发型', slots: ['hair', 'hairext', 'beard', 'stache'] },
    { label: '上身', slots: ['dress', 'top', 'vest', 'jacket', 'apron', 'armour', 'cape', 'belt',
                             'gloves', 'cuffs'] },
    { label: '下身', slots: ['bottom', 'garter'] },
    { label: '鞋袜', slots: ['socks', 'stockings', 'shoes'] },
    { label: '配饰', slots: ['hat', 'glasses', 'eyepatch', 'mask', 'neck', 'charm',
                             'headwear/accessories/earrings', 'back'] },
    { label: '别的', slots: ['ears', 'wings', 'tail', 'horns'] }
  ];
  var PROMPT_SKIP = { skin: 1, head: 1, brows: 1, nose: 1, eyes: 1, wrinkles: 1, bodyalt: 1 };
  // 这些子分类不进词（肤色、眉毛、鼻子、皱纹本身不是「穿搭」）
  var SKIP_SUB = /^(body$|head$|head\/eyebrows|head\/nose|head\/eyes|head\/heads|body\/special)/;
  var NO_COLOR_WORD = { 'default': 1, source: 1, base: 1 };

  /* ================================================================
     状态
     ================================================================ */
  var S = {
    pack: 'female',
    tab: 'body',
    tier: 'featured',        // 'featured' | 'all'
    fantasyOpen: false,
    sel: null,               // 颜色条现在在讲哪件
    person: [],              // [{id, v}] 长相：肤色 / 脸 / 五官 / 头发（换衣服不动它）
    clothes: [],             // [{id, v}] 衣服：其余全部
    sets: [],                // 官方套装（素材包带的）
    setPerson: [],           // 上一套套装往「长相」里塞过的东西（换套装时先撤掉）
    prompt: '',
    promptEdited: false,
    injected: false,
    favorites: [],           // [{id, v, pack}]
    outfits: [],             // [{name, pack, items:[{id,v}], ts}]
    ballHidden: false,
    snap: true,              // 手机上球贴边半藏
    pos: null, posNarrow: null, panelPos: null
  };

  /* ================================================================
     变量读写
     ================================================================ */
  function readGlobal() {
    try {
      var v = getVariables({ type: 'global' }) || {};
      return (v && v[GKEY]) || {};
    } catch (e) { return {}; }
  }
  function loadGlobal() {
    var g = readGlobal();
    if (g.pack === 'female' || g.pack === 'male') S.pack = g.pack;
    if (Array.isArray(g.favorites)) S.favorites = g.favorites.slice(0, 300);
    if (Array.isArray(g.outfits)) S.outfits = g.outfits.slice(0, 60);
    if (typeof g.ballHidden === 'boolean') S.ballHidden = g.ballHidden;
    if (typeof g.snap === 'boolean') S.snap = g.snap;
    if (g.pos && typeof g.pos.left === 'number') S.pos = g.pos;
    if (g.posNarrow && typeof g.posNarrow.left === 'number') S.posNarrow = g.posNarrow;
    if (g.panelPos && typeof g.panelPos.left === 'number') S.panelPos = g.panelPos;
    // 上次穿的：两个包各记一套，新聊天默认接着这套穿
    // last = 衣服，face = 长相（分开记，所以换一身衣服不会顺手把脸也换了）
    S.last = { female: [], male: [] };
    S.face = { female: [], male: [] };
    if (g.last && typeof g.last === 'object') {
      if (Array.isArray(g.last.female)) S.last.female = g.last.female;
      if (Array.isArray(g.last.male)) S.last.male = g.last.male;
    }
    if (g.face && typeof g.face === 'object') {
      if (Array.isArray(g.face.female)) S.face.female = g.face.female;
      if (Array.isArray(g.face.male)) S.face.male = g.face.male;
    }
    // 老版本（v0.1）把长相和衣服混在 last 里，这里就地分开
    ['female', 'male'].forEach(function (p) {
      if (!S.face[p].length && S.last[p].length) {
        var s = splitList(S.last[p]);
        if (s.person.length) { S.face[p] = s.person; S.last[p] = s.clothes; }
      }
    });
  }
  // 「上次穿的」得在换包**之前**记进旧包名下，不然一换包就把新包的记录写成旧包那身
  function rememberOutfit() {
    S.last = S.last || { female: [], male: [] };
    S.face = S.face || { female: [], male: [] };
    if (S.clothes.length) S.last[S.pack] = S.clothes.slice();
    if (S.person.length) S.face[S.pack] = S.person.slice();
  }
  function saveGlobal() {
    try {
      S.last = S.last || { female: [], male: [] };
      S.face = S.face || { female: [], male: [] };
      updateVariablesWith(function (v) {
        v = v || {};
        v[GKEY] = {
          pack: S.pack,
          favorites: S.favorites,
          outfits: S.outfits,
          last: S.last,
          face: S.face,
          ballHidden: S.ballHidden,
          snap: S.snap,
          pos: S.pos, posNarrow: S.posNarrow, panelPos: S.panelPos,
          v: VERSION
        };
        return v;
      }, { type: 'global' });
    } catch (e) {
      toast('收藏 / 我的穿搭没存上：' + (e.message || e), 'error');
    }
  }
  function readChatOutfit() {
    try {
      var v = getVariables({ type: 'chat' }) || {};
      var o = v && v[GKEY] && v[GKEY].outfit;
      return (o && Array.isArray(o.items)) ? o : null;
    } catch (e) { return null; }
  }
  function saveChatOutfit() {
    try {
      updateVariablesWith(function (v) {
        v = v || {};
        v[GKEY] = v[GKEY] || {};
        v[GKEY].outfit = {
          pack: S.pack, items: S.clothes, person: S.person,
          prompt: S.promptEdited ? S.prompt : '',
          on: S.injected, ts: Date.now()
        };
        return v;
      }, { type: 'chat' });
    } catch (e) {
      toast('这个聊天的穿搭没存上：' + (e.message || e), 'error');
    }
  }

  /* ================================================================
     Toast（挂 parent；每个失败点都必须出声）
     ================================================================ */
  var toastTimer = null;
  function toast(msg, type) {
    try { console.log('[像素衣橱] ' + (type || 'ok') + ': ' + msg); } catch (e) {}
    try {
      var old = DOC.getElementById(NS + '-toast'); if (old) old.remove();
      var t = DOC.createElement('div'); t.id = NS + '-toast';
      t.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);' +
        'z-index:2147483601;padding:10px 18px;border-radius:10px;font-size:15px;color:#fff;' +
        'box-shadow:0 4px 20px rgba(0,0,0,.35);pointer-events:none;max-width:88vw;' +
        'font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC","Segoe UI",system-ui,sans-serif;background:' +
        (type === 'error' ? 'rgba(196,64,64,.95)' : type === 'warn' ? 'rgba(206,148,40,.95)' : 'rgba(58,140,104,.95)');
      t.textContent = msg;
      DOC.body.appendChild(t);
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { try { t.remove(); } catch (e) {} }, 3000);
    } catch (e) {}
  }

  /* ================================================================
     几何：探针校准 + setClientPos
     手机版 ST 给页面加 transform/zoom → position:fixed 坐标失准。
     不猜环境，量出来。（搬自 SB v4 phone_panel.js / 小狸 Live，真机验证过）
     ================================================================ */
  var mounted = false, vvBound = null, kvTimer = null, ballTimer = null;
  var CAL = { ox: 0, oy: 0, sx: 1, sy: 1 };
  function recalib() {
    try {
      var probe = DOC.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;' +
        'box-sizing:border-box;pointer-events:none;visibility:hidden;';
      DOC.body.appendChild(probe);
      var r = probe.getBoundingClientRect();
      probe.remove();
      CAL = { ox: r.left, oy: r.top, sx: (r.width / 100) || 1, sy: (r.height / 100) || 1 };
    } catch (e) {}
  }
  function vpW() { return (VIEW.visualViewport && VIEW.visualViewport.width) || VIEW.innerWidth; }
  function vpH() { return (VIEW.visualViewport && VIEW.visualViewport.height) || VIEW.innerHeight; }
  function setClientPos(el, cx, cy) {
    var vv = VIEW.visualViewport;
    var ox = (vv && vv.offsetLeft) || 0, oy = (vv && vv.offsetTop) || 0;
    el.style.right = 'auto'; el.style.bottom = 'auto';
    el.style.left = ((cx + ox - CAL.ox) / CAL.sx) + 'px';
    el.style.top = ((cy + oy - CAL.oy) / CAL.sy) + 'px';
  }
  function clampXY(x, y, margin) {
    var m = margin || 64;
    return { x: Math.max(4, Math.min(x, vpW() - m)), y: Math.max(4, Math.min(y, vpH() - m)) };
  }
  function inputTop() {
    try {
      var sf = DOC.getElementById('send_form') || DOC.getElementById('form_sheld');
      if (sf) { var r = sf.getBoundingClientRect(); if (r.top > 100) return r.top; }
    } catch (e) {}
    return vpH();
  }
  function isNarrow() { return vpW() > 0 && vpW() < 500; }
  function keyboardUp() {
    try {
      var vv = VIEW.visualViewport; if (!vv) return false;
      return (VIEW.innerHeight - vv.height - (vv.offsetTop || 0)) > 60;
    } catch (e) { return false; }
  }
  function placeBall() {
    var b = DOC.getElementById(NS + '-ball'); if (!b) return;
    recalib();
    var saved = isNarrow() ? S.posNarrow : S.pos;
    if (saved && typeof saved.left === 'number') {
      var c = clampXY(saved.left, saved.top);
      setClientPos(b, c.x, c.y);
      snapSoon(400);
      return;
    }
    setClientPos(b, vpW() - 74, Math.max(60, (isNarrow() ? inputTop() : vpH()) - 230));
    snapSoon(400);
  }

  /* 贴边半藏（原样搬自 Asu-02 / 小狸 Live，玩家飛鳥提的）：
     手机上球靠着左右边几秒没人碰 → 半藏进边里 + 半透明；点它 / 开窗就出来。电脑不贴。 */
  var snapTimer = null;
  function edgeSide() {
    var b = DOC.getElementById(NS + '-ball'); if (!b) return '';
    var r = b.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    if (cx < 70) return 'l';
    if (cx > vpW() - 70) return 'r';
    return '';
  }
  function snapNow() {
    if (!S.snap || isOpen() || !isNarrow()) return;
    var b = DOC.getElementById(NS + '-ball'); if (!b) return;
    var side = edgeSide(); if (!side) return;
    b.classList.remove('pw-snap-l', 'pw-snap-r');
    b.classList.add('pw-snap-' + side);
  }
  function unsnap() {
    var b = DOC.getElementById(NS + '-ball');
    if (b) b.classList.remove('pw-snap-l', 'pw-snap-r');
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
  }
  function snapSoon(ms) {
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(function () { snapTimer = null; snapNow(); }, ms || 3000);
  }
  function placePanel() {
    var p = DOC.getElementById(NS + '-panel'); if (!p) return;
    recalib();
    if (isNarrow()) {
      var bottom = inputTop();
      var pw = Math.min(430, vpW() - 10);
      setClientPos(p, Math.max(4, (vpW() - pw) / 2), 6);
      p.style.width = (pw / CAL.sx) + 'px';
      p.style.height = (Math.max(340, bottom - 14) / CAL.sy) + 'px';
      p.style.maxHeight = 'none'; p.style.maxWidth = 'none';
    } else {
      var w = Math.min(452, vpW() - 30), h = Math.min(700, vpH() - 80);
      p.style.width = (w / CAL.sx) + 'px';
      p.style.height = (h / CAL.sy) + 'px';
      p.style.maxHeight = ''; p.style.maxWidth = '';
      var bx = vpW() - 74, by = vpH() - 230;
      try { var br = DOC.getElementById(NS + '-ball').getBoundingClientRect(); bx = br.left; by = br.top; } catch (e) {}
      var left, top;
      if (S.panelPos && typeof S.panelPos.left === 'number') {
        left = Math.max(4, Math.min(S.panelPos.left, vpW() - w - 4));
        top = Math.max(4, Math.min(S.panelPos.top, vpH() - h - 4));
      } else {
        left = Math.max(8, Math.min(bx + 60 - w, vpW() - w - 8));
        top = Math.max(8, Math.min(by - h - 12, vpH() - h - 8));
      }
      setClientPos(p, left, top);
    }
  }
  function liftForKeyboard() {
    var p = DOC.getElementById(NS + '-panel'); if (!p) return;
    try {
      var vv = VIEW.visualViewport; if (!vv) return;
      p.style.transform = '';
      var kb = VIEW.innerHeight - vv.height - (vv.offsetTop || 0);
      if (kb < 60) { placePanel(); return; }
      var r = p.getBoundingClientRect();
      var overlap = r.bottom - (vv.offsetTop + vv.height) + 8;
      if (overlap <= 0) return;
      var lift = Math.min(overlap, Math.max(0, r.top - 6));
      if (lift > 0) p.style.transform = 'translateY(-' + lift + 'px)';
    } catch (e) {}
  }
  function typingInPanel() {
    try {
      var a = DOC.activeElement, p = DOC.getElementById(NS + '-panel');
      return !!(a && p && p.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT'));
    } catch (e) { return false; }
  }
  function reflow() {
    if (!mounted) return;
    var typing = typingInPanel();
    if (!typing && !keyboardUp()) placeBall();
    if (isOpen()) { if (typing) liftForKeyboard(); else if (!keyboardUp()) placePanel(); }
  }
  function reflowSoon() { clearTimeout(kvTimer); kvTimer = setTimeout(reflow, 300); }

  /* ================================================================
     素材加载（懒：只下当前这一页要的）
     ================================================================ */
  var IDX = {};        // pack -> index.json
  var CATS = {};       // pack/cat -> {items, byId}
  var IMG = {};        // pack/file -> 已加载好的 Image
  var IMGP = {};       // pack/file -> 正在下的 promise
  var loading = 0;

  function fetchJson(url, key) {
    return fetch(url, { cache: 'default' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (e) {
        // file:// 下 fetch 被浏览器拦（本地测试台就是这种），退回 <script> 读同名 .js
        return loadViaScript(url.replace(/\.json$/, '.js'), key, e);
      });
  }
  function loadViaScript(url, key, prevErr) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () {
        var d = (window.__PW_DATA__ || {})[key];
        if (d) res(d); else rej(prevErr || new Error(url + ' 里没有 ' + key));
      };
      s.onerror = function () { rej(prevErr || new Error('取不到 ' + url)); };
      document.head.appendChild(s);
    });
  }
  function loadIndex(pack) {
    if (IDX[pack]) return Promise.resolve(IDX[pack]);
    return fetchJson(ASSET_BASE + pack + '/index.json', pack + '/index').then(function (d) {
      var byCat = {};
      (d.categories || []).forEach(function (c) { byCat[c.id] = c; });
      d.byCat = byCat;
      IDX[pack] = d;
      return d;
    });
  }
  function loadCat(pack, cat) {
    var k = pack + '/' + cat;
    if (CATS[k]) return Promise.resolve(CATS[k]);
    return fetchJson(ASSET_BASE + pack + '/items/' + cat + '.json', k).then(function (d) {
      var byId = {};
      (d.items || []).forEach(function (it) { it.cat = cat; byId[it.id] = it; });
      d.byId = byId;
      CATS[k] = d;
      return d;
    });
  }
  // 现在就要画，图集还没下 → 返回 null 并在后台下，下完自己重画（渐进出图）
  function img(pack, file) {
    var k = pack + '/' + file;
    if (IMG[k]) return IMG[k];
    if (!IMGP[k]) {
      IMGP[k] = new Promise(function (res, rej) {
        var im = new Image();
        im.onload = function () { IMG[k] = im; res(im); };
        im.onerror = function () { delete IMGP[k]; rej(new Error(file)); };
        im.src = ASSET_BASE + pack + '/' + file;
      });
      IMGP[k].then(function () { redrawSoon(); }, function (e) {
        toast('图集 ' + e.message + ' 没下下来，娃娃会缺一层（网络或素材地址问题）', 'error');
      });
    }
    return null;
  }
  function atlasOf(pack, cat, sfx) {
    var c = IDX[pack] && IDX[pack].byCat[cat];
    if (!c) return null;
    var a = sfx === 'm' ? c.atlasMore : sfx === 'x' ? c.atlasFantasy : c.atlas;
    return a || c.atlas || null;
  }
  function itemById(id) {
    var cat = catOfId(id); if (!cat) return null;
    var c = CATS[S.pack + '/' + cat];
    return (c && c.byId[id]) || null;
  }
  function variantOf(it, name) {
    var i;
    for (i = 0; i < it.v.length; i++) if (it.v[i][0] === name) return it.v[i];
    for (i = 0; i < it.v.length; i++) if (it.v[i][0] === it.def) return it.v[i];
    return it.v[0] || null;
  }
  // 把穿搭里用到的分类都拉下来（画娃娃要用）
  function ensureOutfitData(items) {
    var need = {};
    (items || []).forEach(function (o) { var c = catOfId(o.id); if (c) need[c] = 1; });
    var jobs = Object.keys(need).map(function (c) {
      return loadCat(S.pack, c).catch(function (e) {
        toast('「' + (TAB_NAME[c] || c) + '」清单没下下来：' + (e.message || e), 'error');
        return null;
      });
    });
    if (!jobs.length) return Promise.resolve();
    loading++;
    return Promise.all(jobs).then(function () { loading--; redrawSoon(); },
                                  function () { loading--; });
  }

  /* ================================================================
     合成：把选中单品的所有格子摊平，按 zPos 升序画
     ================================================================ */
  function layersFor(items) {
    var out = [];
    (items || []).forEach(function (o) {
      var it = itemById(o.id); if (!it) return;
      var v = variantOf(it, o.v); if (!v) return;
      var a = atlasOf(S.pack, it.cat, v[3]); if (!a) return;
      v[2].forEach(function (cell, li) {
        if (cell === null || cell === undefined) return;
        out.push({
          z: it.z[li],
          dy: it.dy || 0,
          file: a.file, cols: a.cols, cell: cell
        });
      });
    });
    out.sort(function (a, b) { return a.z - b.z; });
    return out;
  }
  /* 画一格。dy 是这一层的纵向位移（负 = 往上，给身体上新长的脖子让位）。
     位移必须**在格子里裁着画**：源矩形夹在 64×64 的格边界内，超出的几行让目标端
     空着 —— 直接把源矩形挪出格子会把图集里相邻格子的像素蹭进来。 */
  function blitCell(ctx, im, cell, cols, sx, sy, sw, sh, w, h, dy) {
    var cx = (cell % cols) * CELL, cy = ((cell / cols) | 0) * CELL;
    var scale = h / sh;
    var s0 = sy - (dy || 0), s1 = s0 + sh;
    var a = Math.max(0, s0), b = Math.min(CELL, s1);
    if (b - a <= 0) return;
    ctx.drawImage(im, cx + sx, cy + a, sw, b - a, 0, (a - s0) * scale, w, (b - a) * scale);
  }
  function paint(ctx, layers, w, h, sx, sy, sw, sh) {
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    var missing = 0;
    layers.forEach(function (L) {
      var im = img(S.pack, L.file);
      if (!im) { missing++; return; }
      // 只画 (sx,sy,sw,sh) 那块，铺满整张 canvas —— 悬浮球的半身像靠这个
      blitCell(ctx, im, L.cell, L.cols, sx, sy, sw, sh, w, h, L.dy);
    });
    return missing;
  }
  function drawInto(canvas, items, w, h, crop) {
    if (!canvas) return;
    var c = crop || { x: 0, y: 0, w: CELL, h: CELL };
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    paint(ctx, layersFor(items), w, h, c.x, c.y, c.w, c.h);
  }
  // 整只娃娃：64×64 里人只占中间，切掉四周的空白，同样的地方能画大一圈
  var FULL = { x: 8, y: 2, w: 48, h: 62 };
  // 脸 / 头发 / 头饰这些格子里的东西很小，格子里也按半身像裁，不然看不清
  var BUST_TILE = { x: 14, y: 4, w: 36, h: 36 };

  var redrawTimer = null;
  function redrawSoon() {
    if (redrawTimer) return;
    redrawTimer = setTimeout(function () { redrawTimer = null; drawDoll(); drawBall(); }, 40);
  }

  /* ================================================================
     出词 + 注入
     ================================================================ */
  function wornSorted() {
    var rows = [];
    worn().forEach(function (o) {
      var it = itemById(o.id); if (!it) return;
      if (SKIP_SUB.test(it.sub || '')) return;
      var v = variantOf(it, o.v);
      var color = (v && !NO_COLOR_WORD[v[0]]) ? v[1] : '';
      // 单字色名补个「色」：黑女仆连衣裙 → 黑色女仆连衣裙
      if (color.length === 1) color += '色';
      rows.push({ slot: slotOf(it), sub: it.sub, word: color + it.n, it: it });
    });
    return rows;
  }
  function buildPrompt() {
    var rows = wornSorted();
    if (!rows.length) return '';
    var used = {}, parts = [];
    PROMPT_GROUPS.forEach(function (g) {
      var hit = rows.filter(function (r) {
        return !used[r.it.id] &&
          (g.slots.indexOf(r.slot) >= 0 || g.slots.indexOf(r.sub) >= 0);
      });
      hit.forEach(function (r) { used[r.it.id] = 1; });
      if (hit.length) parts.push(g.label + '：' + hit.map(function (r) { return r.word; }).join('、'));
    });
    var rest = rows.filter(function (r) { return !used[r.it.id]; });
    if (rest.length) parts.push('还有：' + rest.map(function (r) { return r.word; }).join('、'));
    if (!parts.length) return '';
    return '[{{user}} 今日穿搭] ' + parts.join('；') +
      '。描写{{user}}时按这套穿搭写，衣物细节可以在动作里自然带出，不必每轮复述。';
  }
  function syncPrompt(force) {
    if (S.promptEdited && !force) return;
    S.prompt = buildPrompt();
    var ta = q('.pw-prompt');
    if (ta && ta.value !== S.prompt) ta.value = S.prompt;
  }
  function doInject(silent) {
    var text = (S.prompt || '').trim();
    if (!text) { if (!silent) toast('身上什么都没穿，没词可插', 'warn'); return false; }
    try {
      uninjectPrompts([INJECT_ID]);
    } catch (e) {}
    try {
      injectPrompts([{
        id: INJECT_ID,
        position: 'in_chat',
        depth: 1,
        role: 'system',
        content: text,
        should_scan: false
      }]);
      S.injected = true;
      if (!silent) toast('已换好，AI 会按这套写你', 'ok');
      return true;
    } catch (e) {
      S.injected = false;
      toast('插进对话失败：' + (e.message || e), 'error');
      return false;
    }
  }
  function doUninject(silent) {
    try { uninjectPrompts([INJECT_ID]); } catch (e) {
      toast('撤注入失败：' + (e.message || e), 'error');
    }
    S.injected = false;
    if (!silent) toast('脱下了 —— 这身不再进对话（衣橱里还留着）', 'ok');
  }

  /* ================================================================
     CSS（全部锚在面板 / 球的 id 下，防污染酒馆本体）
     字体一律黑体，正文 15px —— 这是给人看的工具，不是氛围 UI
     ================================================================ */
  var CSS = [
    '#' + NS + '-ball,#' + NS + '-panel{',
    '  font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC","Segoe UI",system-ui,sans-serif;',
    '  font-size:15px;line-height:1.5;box-sizing:border-box;',
    '  --pw-bg:#1b1e25;--pw-bg2:#242833;--pw-line:#343a47;--pw-ink:#eceff5;',
    '  --pw-dim:#9aa3b4;--pw-acc:#f2a8c4;--pw-acc2:#7fd1c1;',
    '}',
    '#' + NS + '-ball *,#' + NS + '-panel *{box-sizing:border-box}',
    /* ── 悬浮球：球上就是你现在这身打扮的半身像 ── */
    '#' + NS + '-ball{',
    /* 比面板低一层：手机上面板铺满屏幕时，球躲在后面别挡格子 */
    '  position:fixed;z-index:2147483598;width:62px;height:62px;cursor:pointer;',
    '  border-radius:18px;overflow:hidden;touch-action:none;user-select:none;',
    '  background:rgba(126,132,148,.20);',
    '  border:1.5px solid rgba(150,158,178,.55);',
    '  box-shadow:0 3px 12px rgba(0,0,0,.30),0 0 0 1px rgba(255,255,255,.10) inset;',
    '  backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);',
    '  display:flex;align-items:center;justify-content:center;',
    '  transition:transform .15s ease,opacity .2s ease;',
    '}',
    '#' + NS + '-ball:hover{transform:scale(1.06)}',
    /* 贴边半藏（只手机） */
    '#' + NS + '-ball.pw-snap-r{transform:translateX(52%);opacity:.5}',
    '#' + NS + '-ball.pw-snap-l{transform:translateX(-52%);opacity:.5}',
    '#' + NS + '-ball canvas{width:100%;height:100%;display:block;image-rendering:pixelated;image-rendering:crisp-edges}',
    '#' + NS + '-ball .pw-fallback{font-size:28px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}',
    '#' + NS + '-ball.pw-loading{opacity:.7}',
    /* ── 面板 ── */
    '#' + NS + '-panel{',
    '  position:fixed;z-index:2147483599;display:none;flex-direction:column;overflow:hidden;',
    '  background:var(--pw-bg);color:var(--pw-ink);border:1px solid var(--pw-line);',
    '  border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.5);',
    '}',
    '#' + NS + '-panel .pw-head{',
    '  display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:grab;',
    '  border-bottom:1px solid var(--pw-line);background:var(--pw-bg2);flex:0 0 auto;',
    '}',
    '#' + NS + '-panel .pw-title{font-weight:700;font-size:16px;letter-spacing:.02em;margin-right:auto}',
    '#' + NS + '-panel .pw-packs{display:flex;gap:0;border:1px solid var(--pw-line);border-radius:8px;overflow:hidden}',
    '#' + NS + '-panel .pw-packs button{border:0;border-radius:0;padding:5px 11px;font-size:14px}',
    '#' + NS + '-panel button{',
    '  background:#2b3040;color:var(--pw-ink);border:1px solid var(--pw-line);border-radius:8px;',
    '  padding:6px 11px;font:inherit;font-size:14px;cursor:pointer;white-space:nowrap;',
    '}',
    '#' + NS + '-panel button:hover{border-color:var(--pw-acc);color:#fff}',
    '#' + NS + '-panel button.on{background:var(--pw-acc);color:#33131f;border-color:var(--pw-acc);font-weight:700}',
    '#' + NS + '-panel .pw-x,#' + NS + '-panel .pw-gear{padding:4px 9px;font-size:16px}',
    /* 设置条 */
    '#' + NS + '-panel .pw-set{',
    '  display:none;flex-direction:column;gap:7px;padding:10px 12px;flex:0 0 auto;',
    '  border-bottom:1px solid var(--pw-line);background:var(--pw-bg2);',
    '}',
    '#' + NS + '-panel .pw-set label{',
    '  display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:14px;color:var(--pw-ink);',
    '}',
    '#' + NS + '-panel .pw-set .pw-hint{font-size:13px;color:var(--pw-dim);line-height:1.45}',
    '#' + NS + '-panel .pw-pill{border-radius:999px;padding:4px 14px;font-size:13px;min-width:52px}',
    /* 套装 / 我的穿搭 两条 */
    '#' + NS + '-panel .pw-saved,#' + NS + '-panel .pw-sets{',
    '  display:flex;gap:6px;padding:8px 12px;overflow-x:auto;border-bottom:1px solid var(--pw-line);',
    '  flex:0 0 auto;scrollbar-width:thin;align-items:center;',
    '}',
    '#' + NS + '-panel .pw-striplabel{',
    '  font-size:13px;color:var(--pw-dim);align-self:center;flex:0 0 auto;padding-right:2px;',
    '}',
    '#' + NS + '-panel .pw-setchip{',
    '  flex:0 0 auto;border-radius:999px;padding:4px 12px;font-size:14px;',
    '  background:#2f2733;border-color:#4a3a46;color:#f4dfe8;',
    '}',
    '#' + NS + '-panel .pw-setchip:hover{background:var(--pw-acc);color:#33131f;border-color:var(--pw-acc)}',
    '#' + NS + '-panel .pw-saved .pw-chip{',
    '  display:flex;align-items:center;gap:5px;background:var(--pw-bg2);border:1px solid var(--pw-line);',
    '  border-radius:999px;padding:4px 6px 4px 11px;font-size:14px;cursor:pointer;flex:0 0 auto;',
    '}',
    '#' + NS + '-panel .pw-saved .pw-chip:hover{border-color:var(--pw-acc2)}',
    '#' + NS + '-panel .pw-saved .pw-del{',
    '  border:0;background:transparent;color:var(--pw-dim);padding:0 3px;font-size:14px;border-radius:50%;',
    '}',
    '#' + NS + '-panel .pw-saved .pw-del:hover{color:#ff8080;background:transparent;border:0}',
    /* 娃娃区 */
    '#' + NS + '-panel .pw-stage{display:flex;gap:12px;padding:12px;flex:0 0 auto;align-items:flex-start}',
    '#' + NS + '-panel .pw-doll{',
    '  width:140px;height:180px;flex:0 0 auto;border-radius:12px;image-rendering:pixelated;',
    '  image-rendering:crisp-edges;border:1px solid var(--pw-line);',
    '  background:',
    '   linear-gradient(45deg,#2c313d 25%,transparent 25%,transparent 75%,#2c313d 75%),',
    '   linear-gradient(45deg,#2c313d 25%,#252a34 25%,#252a34 75%,#2c313d 75%);',
    '  background-size:24px 24px;background-position:0 0,12px 12px;',
    '}',
    '#' + NS + '-panel .pw-side{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:7px}',
    '#' + NS + '-panel .pw-worn{',
    '  font-size:13px;color:var(--pw-dim);line-height:1.55;max-height:104px;overflow:auto;',
    '  word-break:break-word;',
    '}',
    '#' + NS + '-panel .pw-worn b{color:var(--pw-ink);font-weight:600}',
    '#' + NS + '-panel .pw-acts{display:flex;flex-wrap:wrap;gap:6px}',
    '#' + NS + '-panel .pw-acts button{padding:6px 9px;font-size:14px}',
    /* 标签页 */
    '#' + NS + '-panel .pw-tabs{',
    '  display:flex;gap:4px;padding:0 10px 8px;overflow-x:auto;flex:0 0 auto;scrollbar-width:thin;',
    '}',
    '#' + NS + '-panel .pw-tabs button{padding:6px 10px;font-size:14px}',
    '#' + NS + '-panel .pw-filter{',
    '  display:flex;align-items:center;gap:6px;padding:0 12px 8px;flex:0 0 auto;flex-wrap:wrap;',
    '}',
    '#' + NS + '-panel .pw-filter .pw-count{font-size:13px;color:var(--pw-dim);margin-left:auto}',
    /* 颜色条 */
    '#' + NS + '-panel .pw-colors{',
    '  display:none;align-items:center;gap:6px;padding:8px 12px;flex:0 0 auto;flex-wrap:wrap;',
    '  border-top:1px solid var(--pw-line);border-bottom:1px solid var(--pw-line);background:var(--pw-bg2);',
    /* 展开「更多颜色」时自己滚，别把下面那排按钮顶出面板 */
    '  max-height:104px;overflow-y:auto;align-content:flex-start;',
    '}',
    '#' + NS + '-panel .pw-colors .pw-cname{font-size:13px;color:var(--pw-dim);width:100%}',
    '#' + NS + '-panel .pw-sw{',
    '  width:30px;height:30px;padding:0;border-radius:8px;border:1px solid var(--pw-line);',
    '  overflow:hidden;position:relative;background:#1b1e25;',
    '}',
    '#' + NS + '-panel .pw-sw canvas{width:100%;height:100%;display:block;image-rendering:pixelated}',
    '#' + NS + '-panel .pw-sw.on{border-color:var(--pw-acc);box-shadow:0 0 0 2px var(--pw-acc)}',
    '#' + NS + '-panel .pw-more{font-size:13px;padding:4px 9px}',
    /* 单品格子 */
    '#' + NS + '-panel .pw-grid{',
    '  flex:1 1 auto;min-height:64px;overflow-y:auto;padding:10px 12px 12px;',
    '  display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:8px;align-content:start;',
    '}',
    '#' + NS + '-panel .pw-tile{',
    '  background:var(--pw-bg2);border:1px solid var(--pw-line);border-radius:10px;padding:5px 3px 6px;',
    '  text-align:center;cursor:pointer;position:relative;',
    '}',
    '#' + NS + '-panel .pw-tile:hover{border-color:var(--pw-acc2)}',
    '#' + NS + '-panel .pw-tile.on{border-color:var(--pw-acc);background:#33232c}',
    '#' + NS + '-panel .pw-tile canvas{',
    '  width:56px;height:56px;image-rendering:pixelated;image-rendering:crisp-edges;display:block;margin:0 auto;',
    '}',
    '#' + NS + '-panel .pw-tile .pw-n{font-size:13px;margin-top:3px;line-height:1.25;color:var(--pw-ink);word-break:break-all}',
    '#' + NS + '-panel .pw-fav{',
    '  position:absolute;right:2px;top:2px;font-size:13px;line-height:1;padding:2px 3px;border:0;',
    '  background:transparent;opacity:.35;',
    '}',
    '#' + NS + '-panel .pw-fav:hover{opacity:1;border:0;background:transparent}',
    '#' + NS + '-panel .pw-fav.on{opacity:1}',
    '#' + NS + '-panel .pw-empty{grid-column:1/-1;color:var(--pw-dim);font-size:14px;padding:18px 4px;text-align:center}',
    '#' + NS + '-panel .pw-group{grid-column:1/-1;margin-top:4px}',
    '#' + NS + '-panel .pw-group button{width:100%;text-align:left;font-size:14px;color:var(--pw-dim)}',
    /* 底部 */
    '#' + NS + '-panel .pw-foot{',
    '  flex:0 0 auto;border-top:1px solid var(--pw-line);background:var(--pw-bg2);padding:9px 12px;',
    '  display:flex;flex-direction:column;gap:7px;',
    '}',
    '#' + NS + '-panel .pw-plabel{display:none;font-size:13px;color:var(--pw-dim)}',
    '#' + NS + '-panel .pw-prompt{',
    '  display:none;width:100%;min-height:76px;max-height:150px;resize:vertical;font:inherit;font-size:14px;',
    '  background:var(--pw-bg);color:var(--pw-ink);border:1px solid var(--pw-line);border-radius:8px;padding:8px;',
    '}',
    '#' + NS + '-panel .pw-footrow{display:flex;gap:6px;align-items:center}',
    '#' + NS + '-panel .pw-go{flex:1 1 auto;background:var(--pw-acc);color:#33131f;border-color:var(--pw-acc);font-weight:700;font-size:15px;padding:9px}',
    '#' + NS + '-panel .pw-go:hover{filter:brightness(1.08);color:#33131f}',
    '#' + NS + '-panel .pw-state{font-size:13px;color:var(--pw-dim);text-align:center}',
    '#' + NS + '-panel .pw-state.on{color:var(--pw-acc2)}',
    '@media (max-width:430px){',
    '  #' + NS + '-panel .pw-doll{width:116px;height:150px}',
    '  #' + NS + '-panel .pw-grid{grid-template-columns:repeat(auto-fill,minmax(68px,1fr))}',
    '}'
  ].join('\n');

  /* ================================================================
     挂载
     ================================================================ */
  function q(sel) {
    var p = DOC.getElementById(NS + '-panel');
    return p ? p.querySelector(sel) : null;
  }
  function qa(sel) {
    var p = DOC.getElementById(NS + '-panel');
    return p ? Array.prototype.slice.call(p.querySelectorAll(sel)) : [];
  }
  function isOpen() {
    var p = DOC.getElementById(NS + '-panel');
    return !!p && p.style.display === 'flex';
  }

  function mountStyle() {
    if (DOC.getElementById(NS + '-style')) return;
    var st = DOC.createElement('style');
    st.id = NS + '-style';
    st.textContent = CSS;
    DOC.head.appendChild(st);
  }

  function removeBall() {
    var old = DOC.getElementById(NS + '-ball');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
  }
  // 关掉「显示悬浮球」就是真的不建它 —— 有的手机玩家觉得 QR 栏那个按钮够用了
  function createBall() {
    removeBall();
    if (S.ballHidden) return null;
    var b = DOC.createElement('div');
    b.id = NS + '-ball';
    b.title = '像素衣橱 — 点开换装，拖着能挪';
    b.innerHTML = '<span class="pw-fallback">👗</span>';
    DOC.body.appendChild(b);
    bindDrag(b);
    placeBall();
    drawBall();
    return b;
  }

  // 悬浮球画的是「当前这身」的半身像。裁 64×64 里这一块放大到球那么大。
  var BUST = { x: 14, y: 6, w: 36, h: 36 };
  function drawBall() {
    var b = DOC.getElementById(NS + '-ball'); if (!b) return;
    var L = layersFor(worn());
    if (!L.length) {                       // 素材还没到 / 什么都没穿 → 先挂个 👗
      if (!b.querySelector('.pw-fallback')) b.innerHTML = '<span class="pw-fallback">👗</span>';
      b.classList.toggle('pw-loading', loading > 0);
      return;
    }
    var cv = b.querySelector('canvas');
    if (!cv) { b.innerHTML = ''; cv = DOC.createElement('canvas'); b.appendChild(cv); }
    // 画到 2 倍再由 CSS 缩，边缘干净些
    cv.width = 124; cv.height = 124;
    var ctx = cv.getContext('2d'); if (!ctx) return;
    var missing = paint(ctx, L, 124, 124, BUST.x, BUST.y, BUST.w, BUST.h);
    b.classList.toggle('pw-loading', missing > 0);
  }

  function bindDrag(ball) {
    var sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;
    ball.addEventListener('pointerdown', function (e) {
      unsnap();                       // 碰一下就先出来，别按在半藏状态上乱跑
      dragging = true; moved = false;
      var r = ball.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { ball.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    ball.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      if (!moved) return;
      var c = clampXY(ox + dx, oy + dy, 62);
      setClientPos(ball, c.x, c.y);
    });
    function up(e) {
      if (!dragging) return; dragging = false;
      try { ball.releasePointerCapture(e.pointerId); } catch (err) {}
      if (moved) {
        var r = ball.getBoundingClientRect();
        if (isNarrow()) S.posNarrow = { left: r.left, top: r.top };
        else S.pos = { left: r.left, top: r.top };
        saveGlobal();
        snapSoon(1500);               // 拖到边上放着，一会儿自己藏进去
      } else {
        setOpen(!isOpen());
      }
    }
    ball.addEventListener('pointerup', up);
    ball.addEventListener('pointercancel', function () { dragging = false; snapSoon(1500); });
    ball.addEventListener('click', function (e) { e.preventDefault(); });
  }

  function bindPanelDrag(panel) {
    var head = panel.querySelector('.pw-head'); if (!head) return;
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;
    head.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('button,select,input,textarea')) return;
      if (isNarrow()) return;
      dragging = true; moved = false;
      var r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      var r = panel.getBoundingClientRect();
      var x = Math.max(4, Math.min(ox + dx, vpW() - r.width - 4));
      var y = Math.max(4, Math.min(oy + dy, vpH() - r.height - 4));
      setClientPos(panel, x, y);
    });
    function up(e) {
      if (!dragging) return; dragging = false;
      try { head.releasePointerCapture(e.pointerId); } catch (err) {}
      if (moved) {
        var r = panel.getBoundingClientRect();
        S.panelPos = { left: r.left, top: r.top };
        saveGlobal();
      }
    }
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', function () { dragging = false; });
  }

  function mount() {
    mountStyle();
    createBall();

    var old = DOC.getElementById(NS + '-panel');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var p = DOC.createElement('div');
    p.id = NS + '-panel';
    p.innerHTML =
      '<div class="pw-head">' +
        '<span class="pw-title">👗 像素衣橱</span>' +
        '<span class="pw-packs">' +
          '<button class="pw-pack" data-pack="female">女生</button>' +
          '<button class="pw-pack" data-pack="male">男生</button>' +
        '</span>' +
        '<button class="pw-gear" title="设置">⚙</button>' +
        '<button class="pw-x" title="收起">✕</button>' +
      '</div>' +
      '<div class="pw-set"></div>' +
      '<div class="pw-sets"></div>' +
      '<div class="pw-saved"></div>' +
      '<div class="pw-stage">' +
        '<canvas class="pw-doll"></canvas>' +
        '<div class="pw-side">' +
          '<div class="pw-worn"></div>' +
          '<div class="pw-acts">' +
            '<button class="pw-random">🎲 随机一套</button>' +
            '<button class="pw-face" title="只换长相，衣服不动">🙂 随机长相</button>' +
            '<button class="pw-save">💾 存为一套</button>' +
            '<button class="pw-strip">🧺 全脱</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pw-tabs"></div>' +
      '<div class="pw-filter">' +
        '<button class="pw-tier" data-tier="featured">精选</button>' +
        '<button class="pw-tier" data-tier="all">全部</button>' +
        '<span class="pw-count"></span>' +
      '</div>' +
      '<div class="pw-colors"></div>' +
      '<div class="pw-grid"></div>' +
      '<div class="pw-foot">' +
        '<div class="pw-plabel">AI 会看到的穿搭描述</div>' +
        '<textarea class="pw-prompt" spellcheck="false"></textarea>' +
        '<div class="pw-footrow">' +
          '<button class="pw-edit" title="改一下要插进去的话">✎ 改词</button>' +
          '<button class="pw-go">穿好了</button>' +
          '<button class="pw-off" title="撤掉注入">脱下</button>' +
        '</div>' +
        '<div class="pw-state"></div>' +
      '</div>';
    DOC.body.appendChild(p);
    bindPanelDrag(p);
    wireUp(p);
    mounted = true;

    if (!vvBound) {
      vvBound = function () { setTimeout(reflow, 120); };
      try { if (VIEW.visualViewport) VIEW.visualViewport.addEventListener('resize', vvBound); } catch (e) {}
      try { VIEW.addEventListener('resize', vvBound); } catch (e) {}
      try { VIEW.addEventListener('orientationchange', vvBound); } catch (e) {}
    }
    p.addEventListener('focusout', reflowSoon, true);
  }

  function unmount() {
    ['-ball', '-panel', '-style', '-toast'].forEach(function (s) {
      var el = DOC.getElementById(NS + s);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    mounted = false;
  }

  function setOpen(open) {
    var p = DOC.getElementById(NS + '-panel');
    if (!p) { mount(); p = DOC.getElementById(NS + '-panel'); if (!p) return; }
    if (!open) { p.style.display = 'none'; p.style.transform = ''; snapSoon(2500); return; }
    p.style.display = 'flex';
    unsnap();
    placePanel();
    renderAll();
    openTab(S.tab);
  }

  /* ================================================================
     交互接线
     ================================================================ */
  function wireUp(p) {
    p.querySelector('.pw-x').addEventListener('click', function () { setOpen(false); });
    p.querySelector('.pw-gear').addEventListener('click', function () {
      var s = q('.pw-set');
      var show = s.style.display !== 'flex';
      s.style.display = show ? 'flex' : 'none';
      if (show) renderSettings();
    });
    p.querySelectorAll('.pw-pack').forEach(function (b) {
      b.addEventListener('click', function () { switchPack(b.getAttribute('data-pack')); });
    });
    p.querySelectorAll('.pw-tier').forEach(function (b) {
      b.addEventListener('click', function () {
        S.tier = b.getAttribute('data-tier');
        renderFilter(); renderGrid();
      });
    });
    p.querySelector('.pw-random').addEventListener('click', randomOutfit);
    p.querySelector('.pw-face').addEventListener('click', randomFace);
    p.querySelector('.pw-save').addEventListener('click', saveCurrentOutfit);
    p.querySelector('.pw-strip').addEventListener('click', function () {
      // 只脱衣服。脸和身材捏好了就不该被一个按钮清掉。
      if (!S.clothes.length) { toast('已经什么都没穿了', 'warn'); return; }
      S.clothes = [];
      S.sel = null;
      afterOutfitChange();
      toast('衣服全脱了 —— 肤色、脸、头发都还在', 'warn');
    });
    p.querySelector('.pw-edit').addEventListener('click', function () {
      var ta = q('.pw-prompt'), lab = q('.pw-plabel');
      var show = ta.style.display !== 'block';
      ta.style.display = show ? 'block' : 'none';
      if (lab) lab.style.display = show ? 'block' : 'none';
      if (show) { ta.value = S.prompt; ta.focus(); }
    });
    var ta = p.querySelector('.pw-prompt');
    ta.addEventListener('input', function () {
      S.prompt = ta.value;
      S.promptEdited = true;
      saveChatOutfit();
    });
    p.querySelector('.pw-go').addEventListener('click', function () {
      syncPrompt();
      if (doInject()) { saveChatOutfit(); renderState(); }
    });
    p.querySelector('.pw-off').addEventListener('click', function () {
      doUninject();
      saveChatOutfit();
      renderState();
    });
  }

  function switchPack(pack) {
    if (pack !== 'female' && pack !== 'male') return;
    if (pack === S.pack) return;
    rememberOutfit();            // 先把这身记在旧包名下
    S.pack = pack;
    S.sel = null;
    S.person = [];
    S.clothes = [];
    saveGlobal();
    renderHead();
    boot().then(function () {
      renderAll();
      openTab(S.tab);
      toast(pack === 'female' ? '换成女生版衣橱了' : '换成男生版衣橱了', 'ok');
    });
  }

  /* ================================================================
     渲染
     ================================================================ */
  function renderAll() {
    renderHead();
    renderSets();
    renderSaved();
    renderTabs();
    renderFilter();
    renderWorn();
    renderColors();
    renderGrid();
    renderState();
    drawDoll();
    drawBall();
  }
  function renderHead() {
    qa('.pw-pack').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-pack') === S.pack);
    });
  }
  function renderSettings() {
    var host = q('.pw-set'); if (!host) return;
    var ballOn = !S.ballHidden;
    host.innerHTML =
      '<label>显示悬浮球 ' +
        '<button class="pw-pill pw-set-ball' + (ballOn ? ' on' : '') + '">' +
        (ballOn ? '开' : '关') + '</button></label>' +
      '<div class="pw-hint">关掉就没有球了，从 QR 栏那个「👗 衣橱」进衣橱。' +
        '想要回来就在这儿再点开。</div>' +
      '<label>球贴边半藏（手机） ' +
        '<button class="pw-pill pw-set-snap' + (S.snap ? ' on' : '') + '">' +
        (S.snap ? '开' : '关') + '</button></label>' +
      '<div class="pw-hint">手机上球靠着屏幕边几秒没人碰，就半藏进边里、变淡；' +
        '点它或者开衣橱就出来。电脑上不藏。</div>';
    host.querySelector('.pw-set-ball').addEventListener('click', function () {
      S.ballHidden = !S.ballHidden;
      saveGlobal();
      if (S.ballHidden) { removeBall(); toast('球收起来了 —— 从 QR 栏的「' + BTN + '」开衣橱', 'ok'); }
      else { createBall(); }
      renderSettings();
    });
    host.querySelector('.pw-set-snap').addEventListener('click', function () {
      S.snap = !S.snap;
      saveGlobal();
      if (!S.snap) unsnap(); else snapSoon(500);
      renderSettings();
    });
  }

  // 官方套装：一按换一整套衣服。里头如果带了「长相」件（猫女那对猫耳），
  // 只换掉对应那一格，肤色 / 脸 / 发型一律不动。
  function renderSets() {
    var host = q('.pw-sets'); if (!host) return;
    host.innerHTML = '';
    if (!S.sets.length) { host.style.display = 'none'; return; }
    host.style.display = 'flex';
    var lab = DOC.createElement('span');
    lab.className = 'pw-striplabel';
    lab.textContent = '套装';
    host.appendChild(lab);
    S.sets.forEach(function (s, i) {
      var chip = DOC.createElement('button');
      chip.className = 'pw-setchip';
      chip.textContent = s.name;
      chip.title = '一键换上「' + s.name + '」（' + (s.items || []).length + ' 件，脸和发型不动）';
      chip.addEventListener('click', function () { wearSet(i); });
      host.appendChild(chip);
    });
  }
  function wearSet(i) {
    var s = S.sets[i]; if (!s) return;
    var list = (s.items || []).map(function (o) { return { id: o.item, v: o.variant }; });
    var parts = splitList(list);
    S.clothes = parts.clothes;
    S.sel = null;
    // 上一套套装塞进「长相」里的东西（猫耳这种）先撤掉，换女仆的时候别还顶着猫耳。
    // 玩家自己挑的耳朵不在这张单子里，不会被误伤。
    var prev = S.setPerson || [];
    if (prev.length) {
      S.person = S.person.filter(function (o) {
        return isCoreId(o.id) || prev.indexOf(o.id) < 0;
      });
    }
    S.setPerson = parts.person.map(function (o) { return o.id; });
    ensureOutfitData(list.concat(S.person)).then(function () {
      parts.person.forEach(function (o) {
        var it = itemById(o.id);
        if (!it) { S.person.push(o); return; }
        var sl = slotOf(it);
        S.person = S.person.filter(function (p) {
          var pi = itemById(p.id);
          return !pi || slotOf(pi) !== sl;
        });
        S.person.push(o);
      });
      afterOutfitChange();
      renderGrid();
      toast('换上「' + s.name + '」了', 'ok');
    });
  }

  function renderSaved() {
    var host = q('.pw-saved'); if (!host) return;
    host.innerHTML = '';
    if (!S.outfits.length) { host.style.display = 'none'; return; }
    host.style.display = 'flex';
    var lab = DOC.createElement('span');
    lab.className = 'pw-striplabel';
    lab.textContent = '我的穿搭';
    host.appendChild(lab);
    S.outfits.forEach(function (o, i) {
      var chip = DOC.createElement('span');
      chip.className = 'pw-chip';
      chip.title = (o.pack === 'male' ? '男生版' : '女生版') + ' · ' + (o.items || []).length + ' 件';
      var t = DOC.createElement('span');
      t.textContent = o.name;
      t.addEventListener('click', function () { wearSaved(i); });
      var del = DOC.createElement('button');
      del.className = 'pw-del'; del.textContent = '×'; del.title = '删掉这套';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        S.outfits.splice(i, 1);
        saveGlobal(); renderSaved();
        toast('删了「' + o.name + '」', 'warn');
      });
      chip.appendChild(t); chip.appendChild(del);
      host.appendChild(chip);
    });
  }
  function renderTabs() {
    var host = q('.pw-tabs'); if (!host) return;
    host.innerHTML = '';
    var list = TABS.slice();
    if (S.favorites.length) list.unshift({ id: 'fav', name: '❤️ 收藏' });
    list.forEach(function (t) {
      var b = DOC.createElement('button');
      b.textContent = t.name;
      b.className = (S.tab === t.id ? 'on' : '');
      b.addEventListener('click', function () { openTab(t.id); });
      host.appendChild(b);
    });
  }
  function renderFilter() {
    qa('.pw-tier').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tier') === S.tier);
    });
    var f = q('.pw-filter');
    if (f) f.style.display = (S.tab === 'fav') ? 'none' : 'flex';
  }
  function renderWorn() {
    var host = q('.pw-worn'); if (!host) return;
    var rows = wornSorted();
    if (!rows.length) {
      host.innerHTML = '<span style="color:var(--pw-dim)">还没穿上任何东西 —— 从下面点一件试试，' +
        '或者按 🎲 随机一套。</span>';
      return;
    }
    host.innerHTML = rows.map(function (r) { return '<b>' + esc(r.word) + '</b>'; }).join('、');
  }
  function renderState() {
    var el = q('.pw-state'); if (!el) return;
    el.className = 'pw-state' + (S.injected ? ' on' : '');
    el.textContent = S.injected
      ? '✔ 这身正在进对话（换了衣服记得再按一次「穿好了」）'
      : '还没进对话 —— 按上面那个粉色的按钮';
  }
  function drawDoll() {
    var cv = q('.pw-doll'); if (!cv) return;
    drawInto(cv, worn(), FULL.w * 4, FULL.h * 4, FULL);
  }

  // 颜色条：讲的是「现在选中的这件」，默认只给 10 个色，剩下的收在「更多颜色」里
  var moreColors = false;
  function renderColors() {
    var host = q('.pw-colors'); if (!host) return;
    var it = S.sel ? itemById(S.sel) : null;
    if (!it || it.v.length <= 1) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.style.display = 'flex';
    host.innerHTML = '';
    var worn = wornEntry(it.id);
    var cur = worn ? worn.v : it.def;
    var name = DOC.createElement('span');
    name.className = 'pw-cname';
    name.textContent = it.n + ' 的颜色（' + it.v.length + ' 个）';
    host.appendChild(name);

    var swatch = function (vn) {
      var v = variantOf(it, vn); if (!v) return;
      var b = DOC.createElement('button');
      b.className = 'pw-sw' + (v[0] === cur ? ' on' : '');
      b.title = v[1];
      var cv = DOC.createElement('canvas');
      b.appendChild(cv);
      host.appendChild(b);
      drawSwatch(cv, it, v);
      b.addEventListener('click', function () { setColor(it, v[0]); });
    };
    if (!moreColors) {
      (it.chips || []).forEach(swatch);
    } else {
      // 展开时按配色板分组：莫兰迪 / 婚礼 / 原色，不然 48 个色块糊成一片
      var fams = (IDX[S.pack] && IDX[S.pack].colorFamilies) || [];
      var all = it.v.map(function (v) { return v[0]; });
      var taken = {};
      fams.forEach(function (f) {
        var pre = f.code + '_';
        var mine = all.filter(function (n) { return n.indexOf(pre) === 0; });
        if (!mine.length) return;
        var h = DOC.createElement('span');
        h.className = 'pw-cname';
        h.textContent = f.name_zh;
        host.appendChild(h);
        mine.forEach(function (n) { taken[n] = 1; swatch(n); });
      });
      var rest = all.filter(function (n) { return !taken[n]; });
      if (rest.length && fams.length) {
        var h2 = DOC.createElement('span');
        h2.className = 'pw-cname';
        h2.textContent = '原色';
        host.appendChild(h2);
      }
      rest.forEach(swatch);
    }
    if (it.v.length > (it.chips || []).length) {
      var more = DOC.createElement('button');
      more.className = 'pw-more';
      more.textContent = moreColors ? '收起颜色' : '更多颜色 ▾';
      more.addEventListener('click', function () {
        moreColors = !moreColors;
        renderColors();
      });
      host.appendChild(more);
    }
  }
  // 色块：放大这件东西身上最有料的那一小块（比纯色方块好认，花纹布料也看得出来）
  var SWATCH_CROP = {
    body:     { x: 23, y: 14, w: 18, h: 18 },   // 脸
    hair:     { x: 20, y: 8,  w: 24, h: 20 },
    headwear: { x: 20, y: 8,  w: 24, h: 24 },
    torso:    { x: 23, y: 24, w: 18, h: 18 },   // 前胸
    legs:     { x: 23, y: 38, w: 18, h: 18 },
    feet:     { x: 21, y: 47, w: 22, h: 15 }
  };
  // 有的单品（猫尾、项圈、吊带袜…）不在它那一类的默认取景框里，清单里自带 cr
  function cropOf(it, fallback) {
    if (it.cr && it.cr.length === 4) {
      return { x: it.cr[0], y: it.cr[1], w: it.cr[2], h: it.cr[3] };
    }
    return fallback;
  }
  function drawSwatch(cv, it, v) {
    var a = atlasOf(S.pack, it.cat, v[3]); if (!a) return;
    cv.width = 60; cv.height = 60;
    var ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    var im = img(S.pack, a.file); if (!im) return;
    var c = cropOf(it, SWATCH_CROP[it.cat] || { x: 16, y: 14, w: 32, h: 32 });
    v[2].forEach(function (cell) {
      if (cell === null || cell === undefined) return;
      blitCell(ctx, im, cell, a.cols, c.x, c.y, c.w, c.h, 60, 60, it.dy || 0);
    });
  }

  function listForTab() {
    if (S.tab === 'fav') {
      return S.favorites.filter(function (f) { return (f.pack || 'female') === S.pack; })
        .map(function (f) {
          var it = itemById(f.id);
          return it ? { it: it, v: f.v } : null;
        }).filter(Boolean);
    }
    var c = CATS[S.pack + '/' + S.tab];
    if (!c) return null;                       // 还没下下来
    var out = [];
    c.items.forEach(function (it) {
      if (it.aud !== 'both' && it.aud !== S.pack) return;
      if (it.tier === 'fantasy') { if (S.tier === 'all' && S.fantasyOpen) out.push({ it: it, v: null, fantasy: 1 }); return; }
      if (S.tier === 'featured' && it.tier !== 'featured') return;
      out.push({ it: it, v: null });
    });
    return out;
  }

  function renderGrid() {
    var host = q('.pw-grid'); if (!host) return;
    host.innerHTML = '';
    var rows = listForTab();
    if (rows === null) {
      host.innerHTML = '<div class="pw-empty">正在拿「' + esc(TAB_NAME[S.tab] || S.tab) + '」的素材…</div>';
      return;
    }
    if (!rows.length) {
      host.innerHTML = '<div class="pw-empty">' +
        (S.tab === 'fav' ? '还没有收藏。点单品右上角的 ♡ 就存进来了。'
                         : '这一页在「精选」里是空的，点「全部」看看。') + '</div>';
    }
    var fantasyCount = 0;
    if (S.tab !== 'fav') {
      var c = CATS[S.pack + '/' + S.tab];
      if (c) fantasyCount = c.items.filter(function (i) { return i.tier === 'fantasy'; }).length;
    }
    rows.forEach(function (r) { host.appendChild(tileFor(r.it, r.v)); });

    if (S.tab !== 'fav' && S.tier === 'all' && fantasyCount) {
      var g = DOC.createElement('div');
      g.className = 'pw-group';
      var b = DOC.createElement('button');
      b.textContent = (S.fantasyOpen ? '▾ ' : '▸ ') + '奇幻（兽首 / 翅膀 / 尾巴 / 童款，' + fantasyCount + ' 件）';
      b.addEventListener('click', function () { S.fantasyOpen = !S.fantasyOpen; renderGrid(); });
      g.appendChild(b);
      // 折叠组的按钮放在网格最后
      host.appendChild(g);
    }
    var cnt = q('.pw-count');
    if (cnt) cnt.textContent = rows.length + ' 件';
    redrawSoon();
  }

  function tileFor(it, forceVariant) {
    var tile = DOC.createElement('div');
    tile.className = 'pw-tile';
    var worn = wornEntry(it.id);
    var vname = forceVariant || (worn ? worn.v : it.def);
    var v = variantOf(it, vname);
    if (worn) tile.classList.add('on');

    var cv = DOC.createElement('canvas');
    tile.appendChild(cv);
    var n = DOC.createElement('div');
    n.className = 'pw-n';
    n.textContent = it.n;
    tile.appendChild(n);

    var fav = DOC.createElement('button');
    fav.className = 'pw-fav' + (isFav(it.id, v ? v[0] : null) ? ' on' : '');
    fav.textContent = isFav(it.id, v ? v[0] : null) ? '❤️' : '♡';
    fav.title = '收藏这件 + 这个颜色';
    fav.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleFav(it.id, v ? v[0] : null);
    });
    tile.appendChild(fav);

    tile.addEventListener('click', function () { tapItem(it, vname); });

    // 小预览：这件单品自己（不叠身体，看得清形状）
    if (v) {
      var a = atlasOf(S.pack, it.cat, v[3]);
      if (a) {
        var crop = cropOf(it, (it.cat === 'body' || it.cat === 'hair' || it.cat === 'headwear')
          ? BUST_TILE : { x: 8, y: 2, w: 48, h: 48 });
        cv.width = 112; cv.height = 112;
        var ctx = cv.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          var im = img(S.pack, a.file);
          if (im) {
            v[2].forEach(function (cell) {
              if (cell === null || cell === undefined) return;
              blitCell(ctx, im, cell, a.cols, crop.x, crop.y, crop.w, crop.h, 112, 112, it.dy || 0);
            });
          }
        }
      }
    }
    return tile;
  }

  /* ================================================================
     动作
     ================================================================ */
  function wornEntry(id) {
    var all = worn();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  // 穿一件：把同槽位（以及它挤掉的那些槽位）的先脱了。长相进 person，衣服进 clothes。
  function wear(it, vname) {
    var slot = slotOf(it);
    var kick = [slot].concat(EXCLUDES[slot] || []).concat(it.excl || []);
    var key = listOfId(it.id);
    var keep = function (o) {
      if (o.id === it.id) return false;
      var other = itemById(o.id);
      return !other || kick.indexOf(slotOf(other)) < 0;
    };
    S.person = S.person.filter(keep);
    S.clothes = S.clothes.filter(keep);
    S[key].push({ id: it.id, v: vname || it.def });
  }
  function removeWorn(id) {
    S.person = S.person.filter(function (o) { return o.id !== id; });
    S.clothes = S.clothes.filter(function (o) { return o.id !== id; });
  }
  function tapItem(it, vname) {
    S.sel = it.id;
    moreColors = false;
    if (wornEntry(it.id)) {
      // 身体和脸不给脱 —— 换成别的一件可以，脱光只剩衣服不行
      if (isCoreId(it.id)) {
        toast(isSkinId(it.id) ? '身体不能脱，换个肤色就行' : '脸不能脱，直接点另一张脸就换了', 'warn');
        renderColors();
        return;
      }
      removeWorn(it.id);
    } else wear(it, vname);
    afterOutfitChange();
  }
  function setColor(it, vname) {
    var w = wornEntry(it.id);
    if (w) w.v = vname;
    else wear(it, vname);     // 还没穿就点颜色 = 直接穿上这个色（同槽位的换下来）
    afterOutfitChange();
  }
  function afterOutfitChange() {
    S.promptEdited = false;
    syncPrompt();
    saveChatOutfit();
    rememberOutfit();
    saveGlobal();
    if (S.injected) doInject(true);      // 已经在注入的，换了衣服就地更新
    renderWorn(); renderColors(); renderGrid(); renderState();
    drawDoll(); drawBall();
  }

  function isFav(id, v) {
    if (!v) return false;
    return S.favorites.some(function (f) {
      return f.id === id && f.v === v && (f.pack || 'female') === S.pack;
    });
  }
  function toggleFav(id, v) {
    if (!v) return;
    var had = isFav(id, v);
    if (had) {
      S.favorites = S.favorites.filter(function (f) {
        return !(f.id === id && f.v === v && (f.pack || 'female') === S.pack);
      });
    } else {
      if (S.favorites.length >= 300) { toast('收藏满 300 件了，先删几件', 'warn'); return; }
      S.favorites.push({ id: id, v: v, pack: S.pack });
    }
    saveGlobal();
    renderTabs(); renderGrid();
    toast(had ? '取消收藏' : '收藏了 ❤️（在最左边那个「收藏」页里）', 'ok');
  }

  function saveCurrentOutfit() {
    if (!S.clothes.length) { toast('身上什么衣服都没有，没法存', 'warn'); return; }
    var name;
    try { name = VIEW.prompt('给这套穿搭起个名字（比如 约会装 / 睡衣）', suggestName()); }
    catch (e) { name = null; }
    if (name === null) return;
    name = String(name).trim().slice(0, 16);
    if (!name) { toast('名字空的，没存', 'warn'); return; }
    var idx = -1, i;
    for (i = 0; i < S.outfits.length; i++) if (S.outfits[i].name === name) { idx = i; break; }
    // 存的只有衣服 —— 换一套穿搭不该顺手把脸也换掉
    var rec = { name: name, pack: S.pack, items: S.clothes.slice(), ts: Date.now() };
    if (idx >= 0) S.outfits[idx] = rec;
    else {
      if (S.outfits.length >= 60) { toast('我的穿搭最多 60 套，先删几套', 'warn'); return; }
      S.outfits.push(rec);
    }
    saveGlobal();
    renderSaved();
    toast('存好了：「' + name + '」（点上面那排就能一键换上）', 'ok');
  }
  function suggestName() {
    var rows = wornSorted();
    return rows.length ? rows[0].word : '新穿搭';
  }
  function wearSaved(i) {
    var o = S.outfits[i]; if (!o) return;
    var apply = function () {
      // 老版本存的穿搭里可能混着长相，只取衣服那半
      S.clothes = splitList(o.items || []).clothes;
      S.sel = null;
      ensureOutfitData(worn()).then(function () {
        afterOutfitChange();
        renderGrid();
        toast('换上「' + o.name + '」了（脸没动）', 'ok');
      });
    };
    if (o.pack && o.pack !== S.pack) {
      rememberOutfit();
      S.pack = o.pack;
      S.person = [];
      S.clothes = [];
      saveGlobal();
      renderHead();
      boot().then(apply);
    } else apply();
  }

  // 摇一件：从这一类的精选里挑
  function pickFrom(cat, pred) {
    var c = CATS[S.pack + '/' + cat]; if (!c) return null;
    var pool = c.items.filter(function (it) {
      return it.tier === 'featured' && (it.aud === 'both' || it.aud === S.pack) && pred(it);
    });
    if (!pool.length) return null;
    var it = pool[(Math.random() * pool.length) | 0];
    var chips = (it.chips && it.chips.length) ? it.chips : [it.def];
    return { id: it.id, v: chips[(Math.random() * chips.length) | 0] };
  }
  function isSlot(want) {
    return function (it) { return slotOf(it) === want; };
  }
  function withCats(need, fn, what) {
    loading++;
    Promise.all(need.map(function (c) {
      return loadCat(S.pack, c).catch(function () { return null; });
    })).then(function () { loading--; fn(); }, function () {
      loading--;
      toast((what || '随机') + '失败：素材没下下来', 'error');
    });
  }

  // 🎲 随机一套 —— 只摇衣服，脸和发型原样留着
  function randomOutfit() {
    withCats(['torso', 'legs', 'feet'], function () {
      var out = [];
      [pickFrom('torso', function (it) { return slotOf(it) === 'top' || slotOf(it) === 'dress'; }),
       pickFrom('legs', isSlot('bottom')),
       pickFrom('feet', isSlot('shoes'))].forEach(function (x) { if (x) out.push(x); });
      // 连衣裙就别再套裙子了
      var hasDress = out.some(function (o) {
        var it = itemById(o.id); return it && slotOf(it) === 'dress';
      });
      if (hasDress && Math.random() < 0.6) {
        out = out.filter(function (o) {
          var it = itemById(o.id); return !it || slotOf(it) !== 'bottom';
        });
      }
      if (!out.length) { toast('素材还没到，等一下再摇', 'warn'); return; }
      S.clothes = out;
      S.sel = null;
      afterOutfitChange();
      renderGrid();
    }, '随机一套');
  }

  // 🙂 随机长相 —— 只摇人，衣服不动
  function randomFace() {
    withCats(['body', 'hair'], function () {
      var out = [];
      var skin = pickFrom('body', function (it) { return it.id === 'body.body'; });
      if (skin) out.push(skin);
      var head = pickFrom('body', isSlot('head'));
      if (head && skin) head.v = skin.v;      // 肤色和脸得同色，不然脖子会花
      if (head) out.push(head);
      var hair = pickFrom('hair', isSlot('hair'));
      if (hair) out.push(hair);
      var brows = pickFrom('body', function (it) { return (it.sub || '') === 'head/eyebrows'; });
      if (brows) {
        if (hair) brows.v = hair.v;           // 眉毛跟发色更自然
        out.push(brows);
      }
      var nose = pickFrom('body', function (it) { return (it.sub || '') === 'head/nose'; });
      if (nose && skin) { nose.v = skin.v; out.push(nose); }
      if (!out.length) { toast('素材还没到，等一下再摇', 'warn'); return; }
      S.person = out;
      S.sel = null;
      afterOutfitChange();
      renderGrid();
      toast('换了张脸 —— 衣服没动', 'ok');
    }, '随机长相');
  }

  function openTab(tab) {
    S.tab = tab;
    S.sel = null;            // 换页就收起颜色条：别在「鞋」这页还显示刚才那条裙子的颜色
    moreColors = false;
    renderTabs(); renderFilter(); renderColors();
    if (tab === 'fav') {
      // 收藏里的东西可能横跨好几个分类
      var need = {};
      S.favorites.forEach(function (f) {
        if ((f.pack || 'female') !== S.pack) return;
        var c = catOfId(f.id); if (c) need[c] = 1;
      });
      loading++;
      Promise.all(Object.keys(need).map(function (c) {
        return loadCat(S.pack, c).catch(function () { return null; });
      })).then(function () { loading--; renderGrid(); }, function () { loading--; });
      renderGrid();
      return;
    }
    renderGrid();
    loadCat(S.pack, tab).then(function () {
      if (S.tab === tab) renderGrid();
    }, function (e) {
      toast('「' + (TAB_NAME[tab] || tab) + '」没打开：' + (e.message || e), 'error');
      var host = q('.pw-grid');
      if (host) host.innerHTML = '<div class="pw-empty">素材没下下来。检查网络后重开衣橱。</div>';
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ================================================================
     启动 / 换包：拉 index，定出这个聊天该穿什么，再把要用的分类拉下来
     ================================================================ */
  // 素材包自带的那一套，分成长相 / 衣服两半
  function defaultParts(idx) {
    return splitList((idx.defaultOutfit || []).map(function (o) {
      return { id: o.item, v: o.variant };
    }));
  }
  // 身体和脸这两格永远不能空 —— 老存档、玩家手动删过、或者数据坏了，都在这儿兜住
  function ensurePerson(idx) {
    var d = defaultParts(idx).person;
    var pick = function (test, fallback) {
      if (S.person.some(function (o) { return test(o.id); })) return;
      var got = null;
      d.forEach(function (o) { if (!got && test(o.id)) got = o; });
      S.person.push(got || fallback);
    };
    pick(isSkinId, { id: 'body.body', v: 'light' });
    pick(isHeadId, {
      id: S.pack === 'male' ? 'head.heads.human.heads_human_male'
                            : 'head.heads.human.heads_human_female',
      v: 'light'
    });
  }

  function boot() {
    loading++;
    return loadIndex(S.pack).then(function (idx) {
      loading--;
      S.sets = (idx.sets || []).slice();
      // 这个聊天该穿什么，三选一（一定会命中一条，不留「保持原样」的缝）：
      //   1 这个聊天自己存过一套    2 这个包上次穿的那套    3 素材包自带的默认套
      var chat = readChatOutfit();
      var lastC = (S.last && S.last[S.pack]) || [];
      var lastP = (S.face && S.face[S.pack]) || [];
      S.promptEdited = false;
      if (chat && (chat.pack || 'female') === S.pack &&
          (chat.items.length || (chat.person && chat.person.length))) {
        if (Array.isArray(chat.person)) {          // v0.2 存的：本来就是分开的
          S.person = chat.person.slice();
          S.clothes = chat.items.slice();
        } else {                                   // v0.1 存的：混在一起，分开
          var s0 = splitList(chat.items);
          S.person = s0.person; S.clothes = s0.clothes;
        }
        S.injected = !!chat.on;
        if (chat.prompt) { S.prompt = chat.prompt; S.promptEdited = true; }
      } else if (lastC.length || lastP.length) {
        var s1 = splitList(lastP.concat(lastC));
        S.person = s1.person; S.clothes = s1.clothes;
        S.injected = false;
      } else {
        var d = defaultParts(idx);
        S.person = d.person; S.clothes = d.clothes;
        S.injected = false;
      }
      ensurePerson(idx);
      return ensureOutfitData(worn());
    }, function (e) {
      loading--;
      toast('素材清单没下下来（' + (e.message || e) + '）—— 衣橱还能开，但画不出娃娃', 'error');
    }).then(function () {
      // 出词要等清单到了才有名字可用，所以放在这里而不是上面
      syncPrompt(!S.promptEdited);
      // 换聊天 / 换素材包以后，上一身的注入不能赖在那儿（面板说「还没进对话」，
      // AI 却还按旧衣服写 —— 静默失败地狱）
      if (S.injected) doInject(true); else doUninject(true);
      redrawSoon();
      if (isOpen()) renderAll(); else { renderState(); }
    });
  }

  /* ================================================================
     事件
     ================================================================ */
  var H = {};
  function bindEvents() {
    try {
      // 官方脚本按钮：QR 整合插件认得它，裸 DOM 注入的按钮会被藏掉
      if (typeof appendInexistentScriptButtons === 'function') {
        appendInexistentScriptButtons([{ name: BTN, visible: true }]);
      } else if (typeof replaceScriptButtons === 'function') {
        replaceScriptButtons([{ name: BTN, visible: true }]);
      }
      H.btn = function () {
        // 这个按钮同时是逃生阀：球被别的脚本清掉 / 拖丢了，按它就回来。
        // 但玩家自己在 ⚙ 里关掉了「显示悬浮球」的话，就别硬塞回去 —— 只开面板。
        if (!mounted || !DOC.getElementById(NS + '-panel')) mount();
        if (!S.ballHidden) {
          if (!DOC.getElementById(NS + '-ball')) createBall();
          placeBall();
        }
        setOpen(!isOpen());
      };
      eventOn(getButtonEvent(BTN), H.btn);
    } catch (e) {
      console.log('[像素衣橱] 脚本按钮没注册上：' + (e && e.message));
    }
    try {
      H.chat = function () {
        // 换聊天 = 换一套穿搭；顺手确认球还在（别的脚本可能把它清了）
        S.promptEdited = false;
        S.injected = false;
        boot();
        if (ballTimer) clearTimeout(ballTimer);
        ballTimer = setTimeout(function () {
          if (S.ballHidden) return;
          if (!DOC.getElementById(NS + '-ball')) { mount(); }
          else placeBall();
        }, 700);
      };
      eventOn(tavern_events.CHAT_CHANGED, H.chat);
    } catch (e) {}
    try {
      // 每次生成前兜一次底：注入不会随生成消失，但重开酒馆 / 换聊天后要补上
      H.gen = function () { if (S.injected) doInject(true); };
      eventOn(tavern_events.GENERATION_AFTER_COMMANDS, H.gen);
    } catch (e) {}
    try {
      H.key = function (e) { if (e.key === 'Escape' && isOpen()) setOpen(false); };
      DOC.addEventListener('keydown', H.key);
    } catch (e) {}
  }
  function unbindEvents() {
    try { if (H.btn) eventOff(getButtonEvent(BTN), H.btn); } catch (e) {}
    try { if (H.chat) eventOff(tavern_events.CHAT_CHANGED, H.chat); } catch (e) {}
    try { if (H.gen) eventOff(tavern_events.GENERATION_AFTER_COMMANDS, H.gen); } catch (e) {}
    try { if (H.key) DOC.removeEventListener('keydown', H.key); } catch (e) {}
    H = {};
  }

  /* ================================================================
     清理：挂到 parent 上的东西必须自己收回来
     ================================================================ */
  var cleaned = false;
  function cleanup() {
    if (cleaned) return; cleaned = true;
    unbindEvents();
    unmount();
    if (vvBound) {
      try { if (VIEW.visualViewport) VIEW.visualViewport.removeEventListener('resize', vvBound); } catch (e) {}
      try { VIEW.removeEventListener('resize', vvBound); } catch (e) {}
      try { VIEW.removeEventListener('orientationchange', vvBound); } catch (e) {}
      vvBound = null;
    }
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (kvTimer) { clearTimeout(kvTimer); kvTimer = null; }
    if (ballTimer) { clearTimeout(ballTimer); ballTimer = null; }
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
    if (redrawTimer) { clearTimeout(redrawTimer); redrawTimer = null; }
    try { uninjectPrompts([INJECT_ID]); } catch (e) {}
    if (VIEW[INSTANCE_KEY] === cleanup) VIEW[INSTANCE_KEY] = null;
    console.log('[像素衣橱] 收拾干净走了');
  }
  VIEW[INSTANCE_KEY] = cleanup;
  // 酒馆助手关脚本时，脚本自己的 iframe 会派发 pagehide —— 收东西就靠这一下。
  // （不挂 unload：新版 Chrome 的 Permissions-Policy 直接拦，只会在控制台刷红字）
  window.addEventListener('pagehide', cleanup);

  /* ================================================================
     开工
     ================================================================ */
  loadGlobal();
  bindEvents();
  mount();
  boot();
  setTimeout(placeBall, 600);
  setTimeout(placeBall, 1600);
  console.log('%c👗 像素衣橱 %cv' + VERSION + ' · ' + (S.pack === 'male' ? '男生版' : '女生版') +
    ' · 素材 ' + ASSET_BASE,
    'font-weight:700;color:#33131f;background:#f2a8c4;padding:3px 8px;border-radius:4px 0 0 4px',
    'color:#ddd;background:#1b1e25;padding:3px 8px;border-radius:0 4px 4px 0');

  // 给测试台留的把手（酒馆里没人用）
  try { window.__PIXEL_WARDROBE__ = { S: S, open: setOpen, boot: boot, redraw: redrawSoon }; } catch (e) {}
})();
