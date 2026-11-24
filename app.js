const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const call = async (n, ...a) => { const r = await L.call(n, ...a); if (!r.ok) throw new Error(r.error); return r.data; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let S, versions = [], filter = 'release', tab = 'play', offset = 0, busy = false;
const TITLES = { mod: 'Моды', shader: 'Шейдеры', resourcepack: 'Ресурспаки', map: 'Карты' };
const FILTERS = [['release', 'Релизы'], ['snapshot', 'Снапшоты'], ['old_beta', 'Бета'], ['old_alpha', 'Альфа']];

let tt; function toast(t, err) { const e = $('#toast'); e.textContent = t; e.className = 'show' + (err ? ' err' : ''); clearTimeout(tt); tt = setTimeout(() => e.className = '', err ? 6000 : 3000); }

/* tabs */
$$('nav button').forEach(b => b.onclick = () => {
  $$('nav button').forEach(x => x.classList.toggle('on', x === b)); tab = b.dataset.tab;
  $$('.tab').forEach(x => x.classList.remove('on'));
  if (TITLES[tab]) { $('#tab-content').classList.add('on'); openContent(); if (tab !== 'map') setSide(tab); } else { $('#tab-' + tab).classList.add('on'); if (tab === 'packs') openPacks(); if (tab === 'ai') aiInfo(); if (tab === 'visuals') visUI(); }
});

/* versions */
function renderChips() {
  $('#chips').innerHTML = FILTERS.map(([k, n]) => `<button data-k="${k}" class="${k === filter ? 'on' : ''}">${n}</button>`).join('');
  $$('#chips button').forEach(b => b.onclick = () => { filter = b.dataset.k; renderChips(); renderVersions(); });
}
const sup = {};
async function supported(l) {
  if (l === 'vanilla') return null;
  if (!sup[l]) { try { sup[l] = new Set(await call('loaderVersions', l)); } catch { return null; } }
  return sup[l];
}
async function fill(sel, type, loader, want) {
  let s = await supported(loader); if (s && !s.size) s = null;
  let list = versions.filter(v => v.type === type && (!s || s.has(v.id)));
  if (!list.length) list = versions.filter(v => v.type === type);
  sel.innerHTML = list.map(v => `<option>${esc(v.id)}</option>`).join('') || '<option value="">нет версий</option>';
  if (want && list.some(v => v.id === want)) sel.value = want;
  return list;
}
async function renderVersions() {
  const list = await fill($('#ver'), filter, S.cfg.loader, S.cfg.version);
  if (list.length && $('#ver').value !== S.cfg.version) await setCfg({ version: $('#ver').value });
}
const active = () => { const p = S.cfg.packs.find(x => x.id === S.cfg.pack); return p ? { name: p.name, version: p.version, loader: p.loader } : { version: S.cfg.version, loader: S.cfg.loader }; };
async function syncPlay() {
  const p = S.cfg.packs.find(x => x.id === S.cfg.pack);
  $('#pack').value = p ? p.id : ''; $('#ver').disabled = $('#loader').disabled = !!p;
  if (p) { $('#ver').innerHTML = `<option>${esc(p.version)}</option>`; $('#loader').value = p.loader; }
  else { $('#loader').value = S.cfg.loader; await renderVersions(); }
  refreshSide();
}
function renderPackSel() {
  $('#pack').innerHTML = '<option value="">Без сборки (быстрый запуск)</option>' + S.cfg.packs.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#pack').value = S.cfg.pack || '';
}
$('#pack').onchange = async e => { await setCfg({ pack: e.target.value || null }); syncPlay(); };
async function setCfg(p) { S.cfg = await call('saveCfg', p); }
$('#ver').onchange = async e => { await setCfg({ version: e.target.value }); refreshSide(); };
$('#loader').onchange = async e => { await setCfg({ loader: e.target.value }); await renderVersions(); refreshSide(); };

/* play */
let installed = false;
async function updateBtn() {
  try { installed = await call('isInstalled'); } catch { installed = false; }
  if (!busy) $('#play').textContent = installed ? 'Играть' : 'Установить';
}
$('#play').onclick = async () => {
  if (busy) return; busy = true; $('#play').disabled = true;
  const inst = !installed;
  $('#play').textContent = inst ? 'Установка…' : 'Подготовка…';
  try {
    if (inst) { await call('installGame'); $('#pbar').style.width = '0'; resetPlay(); refreshSide(); toast('Версия установлена'); }
    else { await call('play'); $('#play').textContent = 'Игра запущена'; }
  } catch (e) { toast(e.message, 1); resetPlay(); }
};
function resetPlay() { busy = false; $('#play').disabled = false; updateBtn(); }
L.on('toast', t => toast(t.text, t.err));
L.on('progress', p => { $('#ptext').textContent = p.text; $('#pbar').style.width = (p.pct || 0) + '%'; $('#ptext2').textContent = p.text; if (/VirusTotal/.test(p.text)) $('#cstatus').textContent = p.text; });
let gameRunning = false;
L.on('state', s => {
  gameRunning = !!s.running;
  if (s.running) { $('#ptext').textContent = 'Minecraft работает'; refreshSide(); return; }
  resetPlay(); $('#pbar').style.width = '0';
  $('#ptext').textContent = s.code ? 'Игра закрылась с ошибкой' : 'Всё готово к запуску';
  if (s.code && s.log) toast('Ошибка запуска:\n' + s.log.slice(-600), 1);
});

/* content */
let st;
function openContent() {
  const A = active();
  $('#ctitle').textContent = TITLES[tab]; $('#q').value = '';
  if (tab === 'map') $('#src').value = 'curseforge';
  $('#chint').textContent = (A.name ? `Сборка «${A.name}». ` : '') + `Версия: ${A.version || '—'} · ${({ vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' })[A.loader]}. ` +
    (tab === 'mod' && A.loader === 'vanilla' ? 'Для модов выбери Fabric, Forge или NeoForge на вкладке «Играть» (пока показаны моды Fabric). ' : '') +
    (tab === 'shader' ? 'Шейдеры работают с Iris (поставь мод Iris). ' : '') + (tab === 'map' ? 'Нужен ключ CurseForge (Настройки). ' : '') + 'Скачал файл в браузере? Нажми «Добавить файл» — он проверится и встанет в нужную папку.';
  doSearch(true);
}
async function doSearch(reset) {
  if (reset) { offset = 0; $('#list').innerHTML = ''; }
  $('#more').style.display = 'none';
  try {
    const t0 = tab;
    if (reset) { try { instSet = new Set(await call('installedIds', t0)); } catch { instSet = new Set(); } }
    const r = await call('search', { type: tab, query: $('#q').value.trim(), source: $('#src').value, offset });
    if (reset && !r.length) $('#list').innerHTML = '<p class="muted">Ничего не найдено для этой версии.</p>';
    r.forEach(m => addItem(m)); offset += r.length; $('#more').style.display = r.length >= 20 ? '' : 'none';
    if (reset) call('installedIds', t0, true).then(ids => { if (tab === t0) { instSet = new Set(ids); markAll('#list'); } }).catch(() => {});
  } catch (e) { $('#list').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
let instSet = new Set();
const markBtn = b => { b.textContent = 'Установлено ✓'; b.disabled = true; };
function markAll(host) { $$(host + ' .item').forEach(d => { const b = d.querySelector('button'); if (b && d.dataset.id && instSet.has(d.dataset.id) && b.textContent === 'Установить') markBtn(b); }); }
/* добавить файл / ссылку + проверка VirusTotal */
let impBusy = false;
async function runImport(fn) {
  if (impBusy) return false; impBusy = true; $('#addfile').disabled = $('#urlgo').disabled = true; $('#cstatus').textContent = 'Добавляю…';
  let ok = false;
  try { const r = await fn(); if (r) { ok = true; toast(`«${r.name}» добавлен` + (r.scanned ? ' · проверен через VirusTotal' : ' (без проверки: ключ VirusTotal не задан)')); refreshSide(); } }
  catch (e) { toast(e.message, 1); }
  impBusy = false; $('#addfile').disabled = $('#urlgo').disabled = false; $('#cstatus').textContent = ''; return ok;
}
$('#addfile').onclick = () => runImport(() => call('importFile', tab));
$('#urlgo').onclick = async () => { const u = $('#urlin').value.trim(); if (u && await runImport(() => call('importUrl', tab, u))) $('#urlin').value = ''; };
$('#urlin').onkeydown = e => { if (e.key === 'Enter') $('#urlgo').click(); };
function addItem(m, host = $('#list'), kind = tab) {
  const d = document.createElement('div'); d.className = 'item'; d.dataset.id = String(m.id);
  d.innerHTML = `${m.icon ? `<img src="${esc(m.icon)}" loading="lazy">` : '<div class="ph"></div>'}<div class="t"><b>${esc(m.title)}</b><div class="d">${esc(m.desc)}</div><div class="m">${esc(m.author)} · ${Number(m.downloads).toLocaleString('ru')} скачиваний</div></div><button>Установить</button>`;
  const b = d.querySelector('button'); d.classList.add('click'); if (instSet.has(String(m.id))) markBtn(b);
  const src = kind === 'modpack' ? 'modrinth' : $('#src').value;
  d.onclick = e => { if (!e.target.closest('button')) openInfo({ id: m.id, source: src, title: m.title, icon: m.icon, kind, onInstall: bt => b.click() }); };
  b.onclick = async () => {
    b.disabled = true; b.textContent = 'Качаю…';
    try { await call('install', { type: kind, id: m.id, source: kind === 'modpack' ? 'modrinth' : $('#src').value }); instSet.add(String(m.id)); $('#cstatus').textContent = ''; b.textContent = 'Установлено ✓';
      if (kind === 'modpack') { S = await call('getState'); renderPackSel(); renderPacks(); syncPlay(); }
      refreshSide(); }
    catch (e) { toast(e.message, 1); b.disabled = false; b.textContent = 'Установить'; }
  };
  host.appendChild(d);
}
$('#q').oninput = () => { clearTimeout(st); st = setTimeout(() => doSearch(true), 450); };
$('#src').onchange = () => doSearch(true);
$('#more').onclick = () => doSearch(false);
$('#opendir').onclick = () => call('openDir', tab);
$('#gamedir').onclick = () => call('openDir', 'game');

/* modal: описание мода */
let mCtx = null;
function closeModal() { $('#modal').classList.add('closed'); mCtx = null; }
$('#mclose').onclick = closeModal;
$('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
async function openInfo({ id, source = 'modrinth', title = '', icon = '', kind = 'mod', onInstall }) {
  if (!id) return;
  const ctx = mCtx = { id };
  $('#mtitle').textContent = title; $('#micon').src = icon || ''; $('#micon').style.visibility = icon ? '' : 'hidden';
  $('#mmeta').textContent = ''; $('#msum').textContent = ''; $('#mchips').innerHTML = ''; $('#mbody').textContent = 'Загружаю описание…';
  $('#mweb').style.display = 'none'; const bi = $('#minstall'); bi.style.display = onInstall ? '' : 'none'; bi.disabled = false; bi.textContent = 'Установить';
  $('#modal').classList.remove('closed');
  try {
    const r = await call('projectInfo', { id, source }); if (mCtx !== ctx) return;
    $('#mtitle').textContent = r.title || title; if (r.icon) { $('#micon').src = r.icon; $('#micon').style.visibility = ''; }
    $('#mmeta').textContent = [r.author, r.downloads != null ? Number(r.downloads).toLocaleString('ru') + ' скачиваний' : ''].filter(Boolean).join(' · ');
    $('#msum').textContent = r.summary || '';
    $('#mchips').innerHTML = [...r.loaders, ...r.categories, ...r.versions.slice(0, 8)].map(x => `<span>${esc(x)}</span>`).join('');
    $('#mbody').textContent = r.body || 'Подробного описания нет.';
    if (r.url) { $('#mweb').style.display = ''; $('#mweb').onclick = () => call('openUrl', r.url).catch(e => toast(e.message, 1)); }
  } catch (e) { if (mCtx === ctx) $('#mbody').textContent = 'Не удалось загрузить описание: ' + e.message; }
  if (onInstall) bi.onclick = () => { closeModal(); onInstall(); };
}

function visUI() {
  const paid = true; // визуалы бесплатны
  $('#vislocked').style.display = paid ? 'none' : ''; $('#visunlocked').style.display = paid ? '' : 'none'; $('#visprice').style.display = paid ? 'none' : '';
  const on = S.cfg.visuals !== false; $('#visswitch').checked = on;
  $('#vistext').textContent = on ? 'Визуалы включены. Скоро здесь появятся эффекты и украшения.' : 'Визуалы выключены.';
  $('.soon svg').style.opacity = on ? 1 : .35;
}
$('#paybtn').onclick = async () => {
  try { const r = await call('openPay'); $('#paycard').textContent = r.card; $('#paybank').textContent = r.bank; $('#paybox').style.display = ''; toast('Номер карты скопирован'); }
  catch (e) { toast(e.message, 1); }
};
$('#paycopy').onclick = () => call('openPay').then(() => toast('Номер карты скопирован')).catch(e => toast(e.message, 1));
$('#visunlock').onclick = async () => {
  try { S.cfg = await call('unlockVisuals', $('#viscode').value); $('#viscode').value = ''; visUI(); toast('Визуалы разблокированы'); }
  catch (e) { toast(e.message, 1); }
};
$('#visswitch').onchange = async e => { await setCfg({ visuals: e.target.checked }); visUI(); };

/* AI */
const AI_CHIPS = ['Оптимизация и FPS', 'Выживание+', 'Приключения и данжи', 'Магия', 'Строительство и декор', 'Красивая графика'];
let aiHist = [], aiBusy = false;
function aiInfo() {
  const A = active(); $('#aihint').textContent = `Версия: ${A.version || '—'} · ${A.loader}. ИИ предложит моды под неё; потом их можно установить одной кнопкой.`;
  const c = S.cfg; $('#aiprov').value = c.aiProvider || 'auto'; $('#aimodel').value = c.aiModel || ''; $('#aikey').value = c.aiKey || ''; $('#aibase').value = c.aiBase || '';
  $('#aibaserow').style.display = $('#aiprov').value === 'custom' ? '' : 'none';
  if (!c.aiKey) $('#aikeypanel').classList.add('open');
}
$('#aiprov').onchange = () => { $('#aibaserow').style.display = $('#aiprov').value === 'custom' ? '' : 'none'; };
$('#aikeybtn').onclick = () => $('#aikeypanel').classList.toggle('open');
$('#aisave').onclick = async () => {
  await setCfg({ aiProvider: $('#aiprov').value, aiModel: $('#aimodel').value.trim(), aiKey: $('#aikey').value.trim(), aiBase: $('#aibase').value.trim() });
  $('#aikeypanel').classList.remove('open'); toast('Настройки ИИ сохранены');
};
$('#aichips').innerHTML = AI_CHIPS.map(t => `<button>${t}</button>`).join('');
$$('#aichips button').forEach(b => b.onclick = () => { $('#aiq').value = 'Собери моды: ' + b.textContent; askAI(); });
function aiMsg(cls, html) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html; $('#aimsgs').appendChild(d); d.scrollIntoView({ block: 'end', behavior: 'smooth' }); return d; }
async function installMod(m, btn) {
  btn.disabled = true; btn.textContent = 'Ставлю…';
  try { await call('install', { type: 'mod', id: m.id, source: m.source || 'modrinth' }); btn.textContent = 'Установлено'; refreshSide(); return true; }
  catch (e) { btn.disabled = false; btn.textContent = 'Установить'; toast(m.title + ': ' + e.message, 1); return false; }
}
async function askAI() {
  const q = $('#aiq').value.trim(); if (!q || aiBusy) return;
  if (!S.cfg.aiKey) { $('#aikeypanel').classList.add('open'); return toast('Сначала вставь ключ ИИ', 1); }
  aiBusy = true; $('#aisend').disabled = true; $('#aiq').value = '';
  aiHist.push({ role: 'user', content: q }); aiMsg('me', esc(q));
  const wait = aiMsg('bot muted', 'Думаю и ищу моды на Modrinth…');
  try {
    const r = await call('aiRecommend', aiHist);
    aiHist.push({ role: 'assistant', content: r.reply + (r.mods.length ? ' Предложены: ' + r.mods.map(m => m.name).join(', ') : '') });
    wait.className = 'msg bot'; wait.innerHTML = esc(r.reply || 'Готово.');
    const ok = [];
    r.mods.forEach(m => {
      const d = document.createElement('div'); d.className = 'item' + (m.found ? '' : ' nf');
      d.innerHTML = (m.icon ? `<img src="${esc(m.icon)}" alt="">` : '<div class="ph"></div>') +
        `<div class="t"><b>${esc(m.title || m.name)}</b><div class="d">${esc(m.why)}</div>${m.found ? '' : `<div class="m">Не нашёл под ${esc(r.version)} · ${esc(r.loader)}</div>`}</div>` + (m.found ? '<button>Установить</button>' : '');
      const b = d.querySelector('button'); if (b) { b.onclick = () => installMod(m, b); ok.push([m, b]); d.classList.add('click'); d.onclick = e => { if (!e.target.closest('button')) openInfo({ id: m.id, source: m.source || 'modrinth', title: m.title, icon: m.icon, onInstall: () => b.click() }); }; }
      wait.appendChild(d);
    });
    if (ok.length > 1) {
      const all = document.createElement('button'); all.className = 'allbtn'; all.textContent = `Установить все (${ok.length})`;
      all.onclick = async () => { all.disabled = true; let n = 0; for (const [m, b] of ok) if (!b.disabled && await installMod(m, b)) n++; all.textContent = `Установлено: ${n}`; };
      wait.appendChild(all);
    }
    wait.scrollIntoView({ block: 'end', behavior: 'smooth' });
  } catch (e) { wait.className = 'msg bot'; wait.textContent = e.message; aiHist.pop(); }
  aiBusy = false; $('#aisend').disabled = false;
}
$('#aisend').onclick = askAI;
$('#aiq').onkeydown = e => { if (e.key === 'Enter') askAI(); };

/* accounts */
function renderAcc() {
  loadAccInfo().then(drawPill);
  const a = S.cfg.accounts; $('#whoname').textContent = (a.find(x => x.id === S.cfg.selected) || {}).name || 'Нет аккаунта'; drawAvatar();
  $('#acclist').innerHTML = a.map(x => `<div class="acc ${x.id === S.cfg.selected ? 'sel' : ''}"><span data-s="${x.id}">${esc(x.name)}</span><button class="ghost" data-d="${x.id}">Удалить</button></div>`).join('') || '<p class="muted">Аккаунтов пока нет — добавь ник.</p>';
  $$('[data-s]').forEach(e => e.onclick = async () => { await setCfg({ selected: e.dataset.s }); renderAcc(); });
  $$('[data-d]').forEach(e => e.onclick = async () => { S.cfg = await call('removeAccount', e.dataset.d); renderAcc(); });
}
$('#addacc').onclick = async () => { try { S.cfg = await call('addAccount', $('#nick').value); $('#nick').value = ''; renderAcc(); } catch (e) { toast(e.message, 1); } };

/* быстрая смена аккаунта и скина */
let accInfo = [], popAnchor = null;
async function loadAccInfo() { try { accInfo = await call('accountsInfo'); } catch { accInfo = []; } }
function paintHead(cv, skin, name) {
  const c = cv.getContext('2d'), n = cv.width; c.imageSmoothingEnabled = false; c.clearRect(0, 0, n, n);
  const letter = () => { c.fillStyle = 'rgba(143,209,106,.22)'; c.fillRect(0, 0, n, n); c.fillStyle = '#eef5ea'; c.font = `700 ${Math.round(n * .45)}px Montserrat, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(name ? name[0].toUpperCase() : '?', n / 2, n / 2 + 1); };
  if (!skin) return letter();
  const im = new Image(); im.onload = () => { c.clearRect(0, 0, n, n); c.drawImage(im, 8, 8, 8, 8, 0, 0, n, n); c.drawImage(im, 40, 8, 8, 8, 0, 0, n, n); }; im.onerror = letter; im.src = skin;
}
function drawPill() {
  const me = accInfo.find(x => x.id === S.cfg.selected);
  $('#pillname').textContent = me ? me.name : 'Нет аккаунта'; paintHead($('#pillav'), me && me.skin, me && me.name);
  if (!$('#accpop').classList.contains('closed')) buildPop();
}
async function pickAcc(id) {
  if (id === S.cfg.selected) return closePop();
  await setCfg({ selected: id }); const st2 = await call('getState'); S.skin = st2.skin; renderAcc(); drawHead(); closePop();
  toast('Аккаунт: ' + (S.cfg.accounts.find(x => x.id === id) || {}).name + (gameRunning ? ' · применится при следующем запуске игры' : ''));
}
function buildPop() {
  const pop = $('#accpop');
  pop.innerHTML = '<h4>Аккаунт</h4>' + (accInfo.map(x => `<div class="prow ${x.id === S.cfg.selected ? 'sel' : ''}" data-id="${esc(x.id)}"><canvas width="34" height="34"></canvas><span class="n">${esc(x.name)}</span>${x.id === S.cfg.selected ? '<span class="ck">✓</span>' : ''}</div>`).join('') || '<p class="muted small" style="margin:6px">Аккаунтов нет — добавь ник ниже.</p>') +
    '<div class="add"><input id="popnick" placeholder="Новый ник" maxlength="16"><button id="popadd">+</button></div>' +
    '<button class="ghost act" id="popskin">Сменить скин для этого аккаунта…</button>' +
    (gameRunning ? '<div class="note">Игра запущена: смена применится при следующем запуске.</div>' : '');
  $$('#accpop .prow').forEach((r, i) => { paintHead(r.querySelector('canvas'), accInfo[i].skin, accInfo[i].name); r.onclick = () => pickAcc(r.dataset.id); });
  $('#popadd').onclick = async () => { try { S.cfg = await call('addAccount', $('#popnick').value); const st2 = await call('getState'); S.skin = st2.skin; renderAcc(); drawHead(); } catch (e) { toast(e.message, 1); } };
  $('#popnick').onkeydown = e => { if (e.key === 'Enter') $('#popadd').click(); };
  $('#popskin').onclick = () => { closePop(); $('#file').click(); };
}
function openPop(anchor) {
  const pop = $('#accpop'); popAnchor = anchor; buildPop(); pop.classList.remove('closed');
  const r = anchor.getBoundingClientRect(), h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 298)) + 'px';
  pop.style.top = (r.top > innerHeight / 2 ? Math.max(8, r.top - h - 8) : r.bottom + 8) + 'px';
}
function closePop() { $('#accpop').classList.add('closed'); popAnchor = null; }
$('#accpill').onclick = e => { e.stopPropagation(); popAnchor === $('#accpill') ? closePop() : openPop($('#accpill')); };
$('#who').onclick = e => { e.stopPropagation(); popAnchor === $('#who') ? closePop() : openPop($('#who')); };
document.addEventListener('click', e => { if (!e.target.closest('#accpop')) closePop(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });

/* skin */
function drawAvatar() {
  const c = $('#avatar').getContext('2d'), nm = (S.cfg.accounts.find(x => x.id === S.cfg.selected) || {}).name;
  c.imageSmoothingEnabled = false; c.clearRect(0, 0, 44, 44);
  const letter = () => { c.fillStyle = 'rgba(143,209,106,.22)'; c.fillRect(0, 0, 44, 44); c.fillStyle = '#eef5ea'; c.font = '700 20px Montserrat, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(nm ? nm[0].toUpperCase() : '?', 22, 23); };
  if (!S.skin) return letter();
  const im = new Image(); im.onload = () => { c.clearRect(0, 0, 44, 44); c.drawImage(im, 8, 8, 8, 8, 0, 0, 44, 44); c.drawImage(im, 40, 8, 8, 8, 0, 0, 44, 44); }; im.onerror = letter; im.src = S.skin;
}
function drawHead() {
  drawAvatar();
  const c = $('#head').getContext('2d'); c.imageSmoothingEnabled = false; c.clearRect(0, 0, 96, 96);
  if (!S.skin) return;
  const im = new Image(); im.onload = () => { c.drawImage(im, 8, 8, 8, 8, 0, 0, 96, 96); c.drawImage(im, 40, 8, 8, 8, 0, 0, 96, 96); }; im.src = S.skin;
}
$('#pickskin').onclick = () => $('#file').click();
$('#file').onchange = e => {
  const f = e.target.files[0]; if (!f) return; const fr = new FileReader();
  fr.onload = () => {
    const im = new Image(); im.onload = async () => {
      if (im.width !== 64 || (im.height !== 64 && im.height !== 32)) return toast('Нужен PNG 64×64 или 64×32', 1);
      await call('setSkin', fr.result); S.skin = fr.result; drawHead(); loadAccInfo().then(drawPill); toast('Скин сохранён для этого аккаунта' + (gameRunning ? ', применится при следующем запуске' : ', он применится при запуске'));
    }; im.src = fr.result;
  }; fr.readAsDataURL(f); e.target.value = '';
};
$('#rmskin').onclick = async () => { await call('removeSkin'); S.skin = null; drawHead(); loadAccInfo().then(drawPill); };

/* settings */
const gb = r => (r / 1024).toFixed(1).replace('.0', '') + ' ГБ';
function showRam() {
  const r = S.cfg.ram; $('#ram').value = r; $('#ramn').value = r; $('#ramv').textContent = gb(r);
  $('#ramhint').textContent = `Всего памяти в ПК: ${gb(S.mem)}. ` + (r > S.mem * 0.75 ? 'Выделено слишком много, системе может не хватить памяти.' : 'Для лёгких сборок хватит 2–4 ГБ, для больших 6–8 ГБ.');
}
async function setRam(v) { await setCfg({ ram: +v }); showRam(); }
$('#ram').oninput = e => { $('#ramv').textContent = gb(e.target.value); $('#ramn').value = e.target.value; };
$('#ram').onchange = e => setRam(e.target.value);
$('#ramn').onchange = e => setRam(e.target.value);
$$('[data-ram]').forEach(b => b.onclick = () => setRam(b.dataset.ram));
/* подстройка под устройство */
let optFps = 60, optBusy = false;
const SH_NAMES = { none: 'Без шейдеров' };
async function optRefresh() {
  const r = await call('deviceProfile', { fps: optFps }), d = r.device, p = r.plan;
  $('#optinfo').textContent = `Процессор: ${d.cpu} (${d.cores} потоков)\nПамять: ${gb(d.ramMB)}\nВидеокарта: ${d.gpu}\nУровень устройства: ${d.tierName}`;
  $('#optinfo').style.whiteSpace = 'pre-wrap';
  const sel = $('#optshader'), keep = sel.value;
  sel.innerHTML = `<option value="auto">Авто — ${p.shader ? esc(p.shader) : 'без шейдеров'}</option><option value="none">Без шейдеров</option>` + r.shaders.map(s => `<option>${esc(s)}</option>`).join('');
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  const o = p.options;
  $('#optplan').textContent = `Будет применено: память ${gb(p.ram)}, дальность прорисовки ${o.renderDistance}, FPS до ${p.fps}, частицы ${['все', 'меньше', 'минимум'][o.particles]}.`;
}
$('#optscan').onclick = async () => {
  $('#optscan').disabled = true; $('#optscan').textContent = 'Определяю устройство…';
  try { await optRefresh(); $('#optbox').style.display = ''; } catch (e) { toast(e.message, 1); }
  $('#optscan').disabled = false; $('#optscan').textContent = 'Определить заново';
};
$$('#optfps button').forEach(b => b.onclick = async () => { $$('#optfps button').forEach(x => x.classList.toggle('on', x === b)); optFps = +b.dataset.f; try { await optRefresh(); } catch {} });
$('#optapply').onclick = async () => {
  if (optBusy) return; optBusy = true; $('#optapply').disabled = true; $('#optapply').textContent = 'Применяю…'; $('#optres').textContent = 'Подбираю настройки и качаю моды, это может занять пару минут…';
  try {
    const r = await call('applyOptimization', { fps: optFps, shader: $('#optshader').value, mods: $('#optmods').checked });
    S = await call('getState'); showRam(); refreshSide();
    const okm = r.mods.filter(m => m.ok).map(m => m.id), bad = r.mods.filter(m => !m.ok);
    $('#optres').textContent = `Готово. Уровень: ${r.tier}. Память ${gb(r.ram)}, настроек игры изменено: ${r.options}.` +
      (r.mods.length ? `\nМоды: ${okm.join(', ') || 'ничего'}${bad.length ? `\nНе поставились: ${bad.map(m => m.id + ' (' + m.error + ')').join('; ')}` : ''}` : '') +
      (r.shader ? `\nШейдеры «${r.shader.name}»: ${r.shader.ok ? 'установлены и включены' : 'не поставились (' + r.shader.error + ')'}` : '') +
      (r.notes.length ? '\n' + r.notes.join('\n') : '');
    toast('Оптимизация применена');
  } catch (e) { $('#optres').textContent = e.message; toast(e.message, 1); }
  optBusy = false; $('#optapply').disabled = false; $('#optapply').textContent = 'Применить';
};
async function changeDir(target) {
  const move = confirm('Перенести уже скачанные файлы в новую папку?\n\nОК — перенести (может занять время)\nОтмена — начать с чистого листа (всё скачается заново)');
  try { toast('Переношу, подожди…'); S.root = await call('setDataDir', target, move); $('#dpath').value = S.root; toast('Папка данных изменена'); }
  catch (e) { toast(e.message, 1); }
}
$('#pickdir').onclick = async () => { const d = await call('pickDir'); if (d) changeDir(d); };
$('#defdir').onclick = () => changeDir(null);
$('#opendata').onclick = () => call('openDir', 'root');
$('#savekey').onclick = async () => { await setCfg({ cfKey: $('#cfkey').value.trim() }); toast('Ключ сохранён'); };
const vtUI = () => { $('#vtstate').textContent = S.cfg.vtKey ? 'Проверка включена: файлы проверяются перед установкой.' : 'Проверка выключена.'; };
$('#savevt').onclick = async () => { await setCfg({ vtKey: $('#vtkey').value.trim() }); vtUI(); toast($('#vtkey').value.trim() ? 'Проверка VirusTotal включена' : 'Проверка выключена'); };
$('#openroot').onclick = () => call('openDir', 'root');

/* side panel */
let sideKind = 'ver', sideData = [], sideInfo = {};
const fmt = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ';
async function refreshSide() {
  updateBtn();
  const A = active();
  $('#sidetitle').textContent = A.name || `${A.version || '—'} · ${A.loader}`;
  const k = sideKind;
  try { sideData = k === 'ver' ? await call('listInstalled') : await call('listContent', k); } catch { sideData = []; }
  sideInfo = {}; renderSide();
  if (k !== 'ver' && sideData.length) { try { const inf = await call('identify', k); if (sideKind === k && Object.keys(inf).length) { sideInfo = inf; renderSide(); } } catch {} }
}
function setSide(k) { sideKind = k; $$('.stabs button').forEach(b => b.classList.toggle('on', b.dataset.k === k)); refreshSide(); }
function renderSide() {
  const f = $('#sidef').value.toLowerCase(), el = $('#sidelist'); el.innerHTML = '';
  const list = sideData.filter(x => x.name.toLowerCase().includes(f));
  if (!list.length) el.innerHTML = `<p class="muted small">${sideData.length ? 'Ничего не найдено.' : 'Пока пусто. ' + (sideKind === 'ver' ? 'Нажми «Установить» на главной.' : 'Установи что-нибудь на соседних вкладках.') + ''}</p>`;
  if (sideKind === 'ver') {
    const A = active(), noPack = !S.cfg.pack;
    list.forEach(x => {
      const isCur = noPack && x.version === A.version && x.loader === A.loader;
      const d = document.createElement('div'); d.className = 'si' + (isCur ? ' cur' : '');
      d.innerHTML = `<div class="sn"><b>${esc(x.version)}</b><span class="muted small">${esc(x.loader)}</span></div><button class="ghost pick">${isCur ? 'Выбрана' : 'Выбрать'}</button>`;
      d.querySelector('.pick').onclick = async () => {
        if (isCur || busy) return;
        try { S.cfg = await call('selectVersion', x.version, x.loader); renderPackSel(); await syncPlay(); } catch (e) { toast(e.message, 1); }
      };
      el.appendChild(d);
    });
    $('#sidecount').textContent = `${sideData.length} шт`; return;
  }
  list.forEach(x => {
    const d = document.createElement('div'); d.className = 'si' + (x.enabled ? '' : ' off');
    const info = sideInfo[x.name], plainName = x.name.replace(/\.disabled$/, '');
    d.innerHTML = (info && info.icon ? `<img class="sav" src="${esc(info.icon)}" alt="">` : `<div class="sav">${esc((info ? info.title : plainName)[0].toUpperCase())}</div>`) +
      `<div class="sn${info ? ' click' : ''}"><b title="${esc(plainName)}">${esc(info ? info.title : plainName)}</b><span class="muted small">${x.isDir ? 'папка' : fmt(x.size)}</span></div>` +
      (sideKind === 'mod' ? `<label class="sw"><input type="checkbox" ${x.enabled ? 'checked' : ''}><span></span></label>` : '') + '<button class="del" title="Удалить">✕</button>';
    const info2 = sideInfo[x.name]; if (info2) d.querySelector('.sn').onclick = () => openInfo({ id: info2.id, source: info2.source || 'modrinth', title: info2.title, icon: info2.icon });
    const sw = d.querySelector('input'); if (sw) sw.onchange = async () => { try { await call('toggleMod', x.name); } catch (e) { toast(e.message, 1); } refreshSide(); };
    const del = d.querySelector('.del');
    del.onclick = async () => {
      if (!del.dataset.arm) { del.dataset.arm = '1'; del.textContent = 'Точно?'; del.classList.add('arm'); setTimeout(() => { del.dataset.arm = ''; del.textContent = '✕'; del.classList.remove('arm'); }, 3000); return; }
      try { await call('removeContent', sideKind, x.name); } catch (e) { toast(e.message, 1); } refreshSide();
    };
    el.appendChild(d);
  });
  const total = sideData.reduce((a, x) => a + x.size, 0);
  $('#sidecount').textContent = `${sideData.length} шт · ${fmt(total)}`;
}
$$('.stabs button').forEach(b => b.onclick = () => setSide(b.dataset.k));
$('#sidef').oninput = renderSide;
$('#sidedir').onclick = () => call('openDir', sideKind);
$('#sideclose').onclick = $('#sidetoggle').onclick = () => { const c = $('#side').classList.toggle('closed'); document.body.classList.toggle('sideclosed', c); };
window.addEventListener('focus', refreshSide);

/* packs */
const fillNew = () => fill($('#pver'), $('#ptype').value, $('#ploader').value);
$('#ptype').onchange = fillNew;
$('#ploader').onchange = () => { fillNew(); const v = $('#ploader').value === 'vanilla'; $('#pskinmod').disabled = v; if (v) $('#pskinmod').checked = false; };
$('#newpack').onclick = () => {
  const o = $('#newpanel').classList.toggle('open'); $('#newpack').textContent = o ? 'Закрыть' : '+ Новая сборка'; if (o) fillNew();
};
$('#mkpack').onclick = async () => {
  const b = $('#mkpack'); b.disabled = true; b.textContent = 'Создаю…';
  try {
    S.cfg = await call('createPack', { name: $('#pname').value, version: $('#pver').value, loader: $('#ploader').value, notify: $('#pnotify').checked, skin: $('#pskin').checked, skinMod: $('#pskinmod').checked });
    $('#pname').value = ''; $('#newpanel').classList.remove('open'); $('#newpack').textContent = '+ Новая сборка';
    renderPackSel(); renderPacks(); syncPlay(); toast('Сборка создана и выбрана');
  } catch (e) { toast(e.message, 1); }
  b.disabled = false; b.textContent = 'Создать';
};
async function showMods(p, pm) {
  const m = await call('packMods', p.id);
  pm.innerHTML = m.length ? m.map(n => `<div><span class="small">${esc(n)}</span><button class="ghost" data-r="${esc(n)}">Удалить</button></div>`).join('') : '<p class="muted small">Модов пока нет — добавь их на вкладке «Моды».</p>';
  pm.querySelectorAll('[data-r]').forEach(b => b.onclick = async () => { await call('removeMod', p.id, b.dataset.r); showMods(p, pm); });
}
const swk = (k, label, on, dis) => `<label class="sw"><input type="checkbox" data-k="${k}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}><span></span>${label}</label>`;
function renderPacks() {
  const el = $('#packlist'); el.innerHTML = S.cfg.packs.length ? '' : '<p class="muted">Сборок пока нет. Создай свою или установи готовую ниже.</p>';
  S.cfg.packs.forEach(p => {
    const d = document.createElement('div'); d.className = 'acc' + (p.id === S.cfg.pack ? ' sel' : ''); d.style.flexWrap = 'wrap';
    d.innerHTML = `<span>${esc(p.name)}<small class="muted">${esc(p.version)} · ${esc(p.loader)}</small></span><button class="ghost" data-a="s">Выбрать</button><button class="ghost" data-a="c">Настройки</button><button class="ghost" data-a="m">Моды</button><button class="ghost" data-a="d">Папка</button><button class="ghost" data-a="x">Удалить</button><div class="collapse" style="width:100%"><div class="inner"><div class="cfg">${swk('notify', 'Уведомления', p.notify !== false)}${swk('skin', 'Мой скин через ресурспак', p.skin !== false)}${swk('skinMod', 'Мод скинов: скин виден в игре', !!p.skinMod, p.loader === 'vanilla')}</div></div></div><div class="pm" style="width:100%"></div>`;
    const pm = d.querySelector('.pm'), on = (a, f) => d.querySelector(`[data-a=${a}]`).onclick = f;
    on('s', async () => { await setCfg({ pack: p.id }); renderPackSel(); syncPlay(); renderPacks(); });
    on('c', () => d.querySelector('.collapse').classList.toggle('open'));
    on('m', () => pm.innerHTML ? (pm.innerHTML = '') : showMods(p, pm));
    on('d', () => call('openPack', p.id));
    on('x', async () => { if (!confirm(`Удалить сборку «${p.name}» вместе с модами и мирами?`)) return; S.cfg = await call('removePack', p.id); renderPackSel(); syncPlay(); renderPacks(); });
    d.querySelectorAll('[data-k]').forEach(i => i.onchange = async () => {
      try { await call('setPack', p.id, { [i.dataset.k]: i.checked }); p[i.dataset.k] = i.checked; if (i.dataset.k === 'skinMod' && i.checked) toast('Мод скинов поставится при запуске'); }
      catch (e) { toast(e.message, 1); }
    });
    el.appendChild(d);
  });
}
let mt;
async function searchPacks() {
  $('#mlist').innerHTML = '';
  try { try { instSet = new Set(await call('installedIds', 'modpack')); } catch { instSet = new Set(); }
    (await call('search', { type: 'modpack', query: $('#mq').value.trim(), source: 'modrinth' })).forEach(m => addItem(m, $('#mlist'), 'modpack')); }
  catch (e) { $('#mlist').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
$('#mq').oninput = () => { clearTimeout(mt); mt = setTimeout(searchPacks, 450); };
function openPacks() { renderPacks(); fillNew(); searchPacks(); }

(async function init() {
  S = await call('getState');
  renderChips(); renderAcc(); drawHead(); renderPackSel();
  $('#loader').value = S.cfg.loader; $('#ram').max = Math.max(1024, Math.floor(S.mem / 512) * 512); $('#ramn').max = S.mem; $('#dpath').value = S.root; showRam(); $('#cfkey').value = S.cfg.cfKey; $('#vtkey').value = S.cfg.vtKey || ''; vtUI();
  try { versions = await call('versions'); await syncPlay(); } catch (e) { toast('Не удалось загрузить список версий: ' + (e.message || 'нет сети') + '. Проверь интернет/VPN и перезапусти лаунчер.', 1); }
  refreshSide();
})();
