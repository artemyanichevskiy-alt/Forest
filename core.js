const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const AdmZip = require('adm-zip');
const os = require('os');
const { shell, Notification, dialog, app, clipboard } = require('electron');

let ROOT, BASE, send, CFG;
const UA = { 'User-Agent': 'ForestCraftLauncher/1.0' };
const P = (...a) => path.join(ROOT, ...a);
const DEF = { accounts: [], selected: null, ram: 2048, cfKey: '', version: null, loader: 'vanilla', packs: [], pack: null, dataDir: null, aiKey: '', aiProvider: 'auto', aiModel: '', aiBase: '', visuals: true, vtKey: '', visualsPaid: false };

function init(appData, sendFn) {
  BASE = path.join(appData, '.forestcraft'); send = sendFn;
  fs.mkdirSync(BASE, { recursive: true });
  try { CFG = { ...DEF, ...JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8')) }; } catch { CFG = { ...DEF }; }
  ROOT = CFG.dataDir || BASE;
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch { ROOT = BASE; }
  CFG.visualsPaid = true; // визуалы бесплатны
}
const saveCfg = () => fs.writeFileSync(path.join(BASE, 'config.json'), JSON.stringify(CFG, null, 1));
const progress = (text, pct) => send('progress', { text, pct });
const notify = (t, b) => { try { if (Notification.isSupported()) new Notification({ title: t, body: b }).show(); } catch {} };

/* ---------- network ---------- */
async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}
async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  fs.writeFileSync(dest + '.tmp', Buffer.from(await r.arrayBuffer()));
  fs.renameSync(dest + '.tmp', dest);
}
async function downloadBig(url, dest, label) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  const total = +r.headers.get('content-length') || 0;
  const chunks = []; let got = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length;
    if (total) progress(`${label} ${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} МБ`, got / total * 100);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.concat(chunks));
}
async function downloadAny(l) {
  let err;
  for (const u of [l.url, ...(l.alt || [])]) { try { return await download(u, l.path); } catch (e) { err = e; } }
  throw err;
}
async function pool(items, n, fn, label) {
  let i = 0, done = 0; const total = items.length;
  await Promise.all(Array.from({ length: Math.min(n, total) }, async () => {
    while (i < total) {
      const it = items[i++];
      for (let t = 0; ; t++) { try { await fn(it); break; } catch (e) { if (t >= 2) throw e; } }
      done++; if (done % 15 === 0 || done === total) progress(`${label} ${done}/${total}`, done / total * 100);
    }
  }));
}

/* ---------- versions ---------- */
async function manifest() {
  const f = P('manifest.json');
  const urls = ['https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'];
  let last;
  for (const u of urls) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
      let r; try { r = await fetch(u, { headers: UA, signal: ctl.signal }); } finally { clearTimeout(t); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const m = await r.json(); if (!m.versions || !m.versions.length) throw new Error('пустой список');
      fs.writeFileSync(f, JSON.stringify(m)); return m;
    } catch (e) { last = e; }
  }
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  throw last;
}
async function versions() { return (await manifest()).versions.map(v => ({ id: v.id, type: v.type })); }

function ruleOk(rules) {
  if (!rules) return true;
  let ok = false;
  for (const r of rules) {
    let m = true;
    if (r.features) m = false;
    if (r.os) {
      if (r.os.name && r.os.name !== 'windows') m = false;
      if (r.os.arch && r.os.arch !== 'x64') m = false;
    }
    if (m) ok = r.action === 'allow';
  }
  return ok;
}
const libKey = n => { const p = n.split(':'); return p[0] + ':' + p[1] + ':' + (p[3] || ''); };
function mergeLoader(b, f) {
  const keys = new Set(f.libraries.map(l => libKey(l.name)));
  const A = (x, k) => ((x.arguments || {})[k]) || [];
  return {
    ...b, ...f, id: f.id, mainClass: f.mainClass,
    libraries: [...f.libraries, ...b.libraries.filter(l => !keys.has(libKey(l.name)))],
    arguments: (b.arguments || f.arguments) ? { game: [...A(b, 'game'), ...A(f, 'game')], jvm: [...A(b, 'jvm'), ...A(f, 'jvm')] } : undefined,
    minecraftArguments: f.minecraftArguments || b.minecraftArguments, assetIndex: b.assetIndex, assets: b.assets, downloads: b.downloads, javaVersion: b.javaVersion, type: b.type
  };
}
async function loadVersion(id, loader) {
  const man = await manifest(); const v = man.versions.find(x => x.id === id);
  if (!v) throw new Error('Версия не найдена: ' + id);
  const vf = P('versions', id, id + '.json'); let base;
  if (fs.existsSync(vf)) base = JSON.parse(fs.readFileSync(vf, 'utf8'));
  else { base = await getJSON(v.url); fs.mkdirSync(path.dirname(vf), { recursive: true }); fs.writeFileSync(vf, JSON.stringify(base)); }
  if (loader === 'vanilla') return base;
  let f;
  if (loader !== 'fabric') {
    const idf = P('versions', `${loader}-${id}.id`);
    if (!fs.existsSync(idf)) throw new Error('Загрузчик не установлен');
    const lid = fs.readFileSync(idf, 'utf8');
    return mergeLoader(base, JSON.parse(fs.readFileSync(P('versions', lid, lid + '.json'), 'utf8')));
  }
  const ff = P('versions', `fabric-${id}.json`);
  if (fs.existsSync(ff)) f = JSON.parse(fs.readFileSync(ff, 'utf8'));
  else {
    const list = await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${id}`);
    if (!list.length) throw new Error(`Fabric не поддерживает версию ${id}`);
    const lv = list.find(x => x.loader.stable) || list[0];
    f = await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${id}/${lv.loader.version}/profile/json`);
    fs.writeFileSync(ff, JSON.stringify(f));
  }
  return mergeLoader(base, f);
}

/* ---------- libraries / assets / java ---------- */
function libFiles(vj) {
  const out = [];
  for (const l of vj.libraries) {
    if (!ruleOk(l.rules) || l.clientreq === false) continue;
    if (l.downloads && l.downloads.artifact) out.push({ path: P('libraries', l.downloads.artifact.path), url: l.downloads.artifact.url });
    else if (!l.downloads) {
      const [g, a, v] = l.name.split(':'); const rel = `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}.jar`;
      out.push({ path: P('libraries', rel), url: (l.url || 'https://libraries.minecraft.net/').replace('http://files.minecraftforge.net/maven/', 'https://maven.minecraftforge.net/') + rel, alt: ['https://maven.minecraftforge.net/' + rel, 'https://repo1.maven.org/maven2/' + rel] });
    }
    if (l.natives && l.natives.windows) {
      const k = l.natives.windows.replace('${arch}', '64'); const c = l.downloads && l.downloads.classifiers && l.downloads.classifiers[k];
      if (c) out.push({ path: P('libraries', c.path), url: c.url, native: true });
    }
  }
  return out;
}
async function ensureAssets(vj, gameDir) {
  const ai = vj.assetIndex, ip = P('assets', 'indexes', ai.id + '.json');
  await download(ai.url, ip);
  const idx = JSON.parse(fs.readFileSync(ip, 'utf8'));
  const objs = Object.entries(idx.objects);
  await pool(objs, 24, async ([, o]) => { const d = o.hash.slice(0, 2); await download(`https://resources.download.minecraft.net/${d}/${o.hash}`, P('assets', 'objects', d, o.hash)); }, 'Ресурсы игры');
  let gameAssets = P('assets');
  if (idx.virtual || idx.map_to_resources) {
    gameAssets = idx.map_to_resources ? path.join(gameDir, 'resources') : P('assets', 'virtual', ai.id);
    for (const [name, o] of objs) {
      const t = path.join(gameAssets, name);
      if (!fs.existsSync(t)) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(P('assets', 'objects', o.hash.slice(0, 2), o.hash), t); }
    }
  }
  return gameAssets;
}
function findJava(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const d of fs.readdirSync(dir)) { const e = path.join(dir, d, 'bin', 'java.exe'); if (fs.existsSync(e)) return e; }
  return null;
}
async function ensureJava(major) {
  const dir = P('java', String(major)); let exe = findJava(dir);
  if (exe) return exe;
  const zp = P('java', major + '.zip');
  await downloadBig(`https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse`, zp, `Скачиваю Java ${major}`);
  progress(`Распаковываю Java ${major}…`, 100);
  new AdmZip(zp).extractAllTo(dir, true); fs.unlinkSync(zp);
  exe = findJava(dir); if (!exe) throw new Error('Не удалось установить Java ' + major);
  return exe;
}

async function ensureForge(mc, loader, java) {
  const idf = P('versions', `${loader}-${mc}.id`);
  if (fs.existsSync(idf)) { const id = fs.readFileSync(idf, 'utf8'); if (fs.existsSync(P('versions', id, id + '.json'))) return; }
  const name = loader === 'neoforge' ? 'NeoForge' : 'Forge'; let url;
  progress(`Ищу ${name} для ${mc}…`, 0);
  if (loader === 'neoforge') {
    const r = await getJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
    const sp = mc.split('.'); const pre = mc.startsWith('1.') ? `${sp[1]}.${sp[2] || 0}.` : mc + '.';
    const all = r.versions.filter(v => v.startsWith(pre)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
    const v = all.find(x => !/alpha|beta/.test(x)) || all[0];
    if (!v) throw new Error(`NeoForge недоступен для ${mc} (он есть для 1.20.2 и новее)`);
    url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`;
  } else {
    const pr = (await getJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
    const v = pr[`${mc}-recommended`] || pr[`${mc}-latest`];
    if (!v) throw new Error(`Forge недоступен для ${mc}`);
    url = [`https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${v}/forge-${mc}-${v}-installer.jar`, `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${v}-${mc}/forge-${mc}-${v}-${mc}-installer.jar`];
  }
  const jar = P('installers', `${loader}-${mc}.jar`);
  const urls = [].concat(url);
  for (const u of urls) { try { await downloadBig(u, jar, `Скачиваю ${name}`); break; } catch (e) { if (u === urls[urls.length - 1]) throw e; } }
  const zi = new AdmZip(jar), ipe = zi.getEntry('install_profile.json'), ipj = ipe ? JSON.parse(zi.readAsText(ipe)) : null;
  if (ipj && ipj.versionInfo && ipj.install) { // старый формат установщика (Forge 1.5–1.12)
    const vi = ipj.versionInfo; vi.inheritsFrom = mc;
    fs.mkdirSync(P('versions', vi.id), { recursive: true }); fs.writeFileSync(P('versions', vi.id, vi.id + '.json'), JSON.stringify(vi));
    const [g, a, v2] = ipj.install.path.split(':'), rel = `${g.replace(/\./g, '/')}/${a}/${v2}/${a}-${v2}.jar`;
    const ent = zi.getEntry(ipj.install.filePath); if (!ent) throw new Error('В установщике нет файла Forge');
    fs.mkdirSync(path.dirname(P('libraries', rel)), { recursive: true }); fs.writeFileSync(P('libraries', rel), ent.getData());
    fs.writeFileSync(idf, vi.id); return;
  }
  const lp = P('launcher_profiles.json');
  if (!fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ profiles: {}, selectedProfile: 'x', version: 3 }));
  progress(`Устанавливаю ${name} (1–3 минуты)…`, 100);
  await new Promise((res, rej) => {
    const c = cp.spawn(java, ['-jar', jar, '--installClient', ROOT], { cwd: ROOT, windowsHide: true }); let out = '';
    const f = d => { out += d; }; c.stdout.on('data', f); c.stderr.on('data', f); c.on('error', rej);
    c.on('exit', code => code === 0 ? res() : rej(new Error(`Установщик ${name} упал:\n` + out.slice(-600))));
  });
  const ids = fs.readdirSync(P('versions')).filter(d => {
    try {
      const j = JSON.parse(fs.readFileSync(P('versions', d, d + '.json'), 'utf8')), n = d.toLowerCase();
      return j.inheritsFrom === mc && (loader === 'neoforge' ? n.includes('neoforge') : n.includes('forge') && !n.includes('neoforge'));
    } catch { return false; }
  }).sort((a, b) => fs.statSync(P('versions', b)).mtimeMs - fs.statSync(P('versions', a)).mtimeMs);
  if (!ids.length) throw new Error(`Не нашёл установленный ${name}`);
  fs.writeFileSync(idf, ids[0]);
}

/* ---------- accounts / skin ---------- */
function offlineUUID(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex'); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
// у каждого аккаунта свой скин; старый общий skin.png работает для тех, у кого своего ещё нет
const skinPathFor = id => P('skins', String(id) + '.png');
const currentSkin = (id = CFG.selected) => { const f = skinPathFor(id); if (fs.existsSync(f)) return f; return fs.existsSync(P('skin.png')) ? P('skin.png') : null; };
const skinUrl = f => f ? 'data:image/png;base64,' + fs.readFileSync(f).toString('base64') : null;
function buildSkinPack(dest) {
  const skin = currentSkin(); if (!skin) return false;
  const png = fs.readFileSync(skin), z = new AdmZip();
  z.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, supported_formats: { min_inclusive: 1, max_inclusive: 999 }, description: 'ForestCraft skin' } })));
  for (const n of ['steve', 'alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'sunny', 'zuri']) {
    z.addFile(`assets/minecraft/textures/entity/player/wide/${n}.png`, png);
    z.addFile(`assets/minecraft/textures/entity/player/slim/${n}.png`, png);
  }
  z.addFile('assets/minecraft/textures/entity/steve.png', png);
  z.addFile('assets/minecraft/textures/entity/alex.png', png);
  fs.mkdirSync(path.dirname(dest), { recursive: true }); z.writeZip(dest); return true;
}
function enablePack(gameDir, name) {
  const f = path.join(gameDir, 'options.txt'); let t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const e = `"file/${name}"`; if (t.includes(e)) return;
  if (/^resourcePacks:\[.*\]\s*$/m.test(t)) t = t.replace(/^resourcePacks:\[(.*)\]\s*$/m, (m, i) => `resourcePacks:[${i ? i + ',' : ''}${e}]`);
  else t += (t && !t.endsWith('\n') ? '\n' : '') + `resourcePacks:["vanilla",${e}]\n`;
  fs.writeFileSync(f, t);
}
const instDir = (v, l) => P('instances', l === 'vanilla' ? v : v + '-' + l);
const uid = () => crypto.randomBytes(4).toString('hex');
const packDir = id => P('instances', 'pack-' + id);
function cur() {
  const p = CFG.packs.find(x => x.id === CFG.pack);
  return p ? { version: p.version, loader: p.loader, dir: packDir(p.id) } : { version: CFG.version, loader: CFG.loader, dir: instDir(CFG.version, CFG.loader) };
}
function safeJoin(dir, rel) { const t = path.resolve(dir, rel); if (!t.startsWith(path.resolve(dir) + path.sep)) throw new Error('Небезопасный путь в сборке'); return t; }

/* ---------- launch ---------- */
const subst = (s, vars) => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
function flat(list, vars) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') out.push(subst(a, vars));
    else if (ruleOk(a.rules)) (Array.isArray(a.value) ? a.value : [a.value]).forEach(x => out.push(subst(x, vars)));
  }
  return out;
}
let running = false;
const marker = () => { const c = cur(); return P('installed', (c.version || 'x') + '-' + c.loader + '.ok'); };
async function play(installOnly) {
  if (running) throw new Error('Игра уже запущена');
  const acc = CFG.accounts.find(a => a.id === CFG.selected);
  if (!acc && !installOnly) throw new Error('Добавь аккаунт во вкладке «Аккаунты»');
  if (!cur().version) throw new Error('Выбери версию');
  const { version, loader, dir } = cur();
  progress('Получаю данные версии…', 0);
  const base = await loadVersion(version, 'vanilla');
  const gameDir = dir; fs.mkdirSync(gameDir, { recursive: true });
  let clientJar = P('versions', version, version + '.jar');
  progress('Скачиваю игру…', 0); await download(base.downloads.client.url, clientJar);
  const java = await ensureJava((base.javaVersion && base.javaVersion.majorVersion) || 8);
  const isF = loader === 'forge' || loader === 'neoforge';
  if (isF) await ensureForge(version, loader, java);
  const vj = await loadVersion(version, loader);
  if (isF) { const c = P('versions', vj.id, vj.id + '.jar'); if (!fs.existsSync(c)) fs.copyFileSync(clientJar, c); clientJar = c; }
  const libs = libFiles(vj);
  await pool(libs, 12, l => l.url && downloadAny(l), 'Библиотеки');
  const natives = P('natives', vj.id); fs.mkdirSync(natives, { recursive: true });
  for (const l of libs.filter(x => x.native)) {
    new AdmZip(l.path).getEntries().filter(e => !e.isDirectory && !e.entryName.startsWith('META-INF')).forEach(e => fs.writeFileSync(path.join(natives, path.basename(e.entryName)), e.getData()));
  }
  const gameAssets = await ensureAssets(vj, gameDir);
  fs.mkdirSync(path.dirname(marker()), { recursive: true }); fs.writeFileSync(marker(), JSON.stringify({ version, loader, at: Date.now() }));
  if (installOnly) { progress('Установлено — можно играть', 0); return true; }

  const pk = CFG.packs.find(x => x.id === CFG.pack), wantNotify = !pk || pk.notify !== false, packZip = path.join(gameDir, 'resourcepacks', 'ForestCraftSkin.zip');
  if (!pk || pk.skin !== false) { if (buildSkinPack(packZip)) enablePack(gameDir, 'ForestCraftSkin.zip'); } else fs.rmSync(packZip, { force: true });
  if (pk && pk.skinMod && loader !== 'vanilla') {
    try { await ensureSkinMod(gameDir); } catch (e) { send('toast', { text: 'Мод скинов не поставился: ' + e.message, err: true }); }
    const sk = currentSkin(acc.id);
    if (sk) {
      const t = path.join(gameDir, 'CustomSkinLoader', 'LocalSkin', 'skins', acc.name + '.png');
      fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(sk, t);
    }
  }

  const cpath = [...libs.filter(l => !l.native).map(l => l.path), clientJar].join(';');
  const vars = {
    auth_player_name: acc.name, version_name: vj.id, game_directory: gameDir, assets_root: P('assets'), assets_index_name: vj.assetIndex.id,
    auth_uuid: acc.uuid.replace(/-/g, ''), auth_access_token: '0', auth_session: '0', clientid: '0', auth_xuid: '0', user_type: 'legacy',
    version_type: 'ForestCraft', user_properties: '{}', game_assets: gameAssets, natives_directory: natives, launcher_name: 'ForestCraft',
    launcher_version: '1.0', library_directory: P('libraries'), classpath_separator: ';', classpath: cpath, resolution_width: '925', resolution_height: '530'
  };
  let jvm, game;
  if (vj.arguments) { jvm = flat(vj.arguments.jvm, vars); game = flat(vj.arguments.game, vars); }
  else { jvm = [`-Djava.library.path=${natives}`, '-cp', cpath]; game = subst(vj.minecraftArguments, vars).split(' '); }
  const args = [`-Xmx${CFG.ram}M`, '-Xms512M', ...jvm, vj.mainClass, ...game];

  progress('Запускаю Minecraft…', 100);
  const child = cp.spawn(java, args, { cwd: gameDir, windowsHide: true });
  const log = []; const onD = d => { log.push(d.toString()); if (log.length > 150) log.shift(); };
  child.stdout.on('data', onD); child.stderr.on('data', onD);
  running = true; send('state', { running: true });
  if (wantNotify) notify('ForestCraft', `Minecraft запущен${pk ? ': ' + pk.name : ''}`);
  child.on('error', e => { running = false; send('state', { running: false, code: 1, log: String(e) }); });
  child.on('exit', code => { running = false; if (code && wantNotify) notify('ForestCraft', 'Игра закрылась с ошибкой'); send('state', { running: false, code, log: code ? log.join('').slice(-1500) : '' }); });
  return true;
}

/* ---------- content: Modrinth / CurseForge ---------- */
const MR_TYPE = { modpack: 'modpack', mod: 'mod', shader: 'shader', resourcepack: 'resourcepack' };
const FOLDER = { mod: 'mods', shader: 'shaderpacks', resourcepack: 'resourcepacks', map: 'saves' };
const CF_CLASS = { mod: 6, shader: 6552, resourcepack: 12, map: 17 };
const LD = () => (cur().loader === 'vanilla' ? 'fabric' : cur().loader);
const CF_LOADER = { forge: 1, fabric: 4, neoforge: 6 };
const cf = (url) => { if (!CFG.cfKey) throw new Error('Вставь ключ CurseForge в «Настройках»'); return getJSON('https://api.curseforge.com/v1' + url, { 'x-api-key': CFG.cfKey }); };

async function search({ type, query = '', source = 'modrinth', offset = 0 }) {
  const { version } = cur();
  if (source === 'curseforge') {
    let u = `/mods/search?gameId=432&classId=${CF_CLASS[type]}&searchFilter=${encodeURIComponent(query)}&sortField=2&sortOrder=desc&pageSize=20&index=${offset}`;
    if (type !== 'map' && version) u += `&gameVersion=${encodeURIComponent(version)}`;
    if (type === 'mod') u += `&modLoaderType=${CF_LOADER[LD()]}`;
    const r = await cf(u);
    return r.data.map(m => ({ id: String(m.id), title: m.name, desc: m.summary, icon: m.logo && m.logo.thumbnailUrl, downloads: m.downloadCount, author: (m.authors[0] || {}).name || '' }));
  }
  if (type === 'map') throw new Error('Карты есть только в CurseForge — переключи источник');
  const facets = [[`project_type:${MR_TYPE[type]}`]];
  if (version && type !== 'modpack') facets.push([`versions:${version}`]);
  if (type === 'mod') facets.push([`categories:${LD()}`]);
  const r = await getJSON(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=20&offset=${offset}&index=${query ? 'relevance' : 'downloads'}`);
  return r.hits.map(h => ({ id: h.project_id, title: h.title, desc: h.description, icon: h.icon_url, downloads: h.downloads, author: h.author }));
}

async function mrInstall(id, type, dir, seen) {
  if (seen.has(id)) return; seen.add(id);
  let u = `https://api.modrinth.com/v2/project/${id}/version?game_versions=${encodeURIComponent(JSON.stringify([cur().version]))}`;
  if (type === 'mod') u += `&loaders=${encodeURIComponent(JSON.stringify([LD()]))}`;
  const vs = await getJSON(u);
  if (!vs.length) throw new Error(`Нет файла под ${cur().version}${type === 'mod' ? ' + ' + LD() : ''}`);
  const f = vs[0].files.find(x => x.primary) || vs[0].files[0];
  await downloadScanned(f.url, path.join(dir, FOLDER[type], f.filename), f.filename);
  for (const d of vs[0].dependencies || []) if (d.dependency_type === 'required' && d.project_id) { try { await mrInstall(d.project_id, type, dir, seen); } catch {} }
  return f.filename;
}
async function installRaw({ type, id, source = 'modrinth' }) {
  if (type === 'modpack') return installPack(id);
  const dir = cur().dir;
  if (source === 'modrinth') return await mrInstall(id, type, dir, new Set());
  let u = `/mods/${id}/files?pageSize=1`;
  if (type !== 'map') u += `&gameVersion=${encodeURIComponent(cur().version)}`;
  if (type === 'mod') u += `&modLoaderType=${CF_LOADER[LD()]}`;
  const r = await cf(u); const f = r.data[0];
  if (!f) throw new Error('Нет файла под эту версию');
  if (!f.downloadUrl) throw new Error('Автор запретил скачивание вне сайта CurseForge');
  const folder = path.join(dir, FOLDER[type]);
  if (type === 'map') {
    const res = await fetch(f.downloadUrl, { headers: UA }); if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (CFG.vtKey) { const tmp = P('quarantine', Date.now() + '-' + f.fileName); fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, buf); await verify(tmp, f.fileName); fs.rmSync(tmp, { force: true }); }
    const z = new AdmZip(buf);
    const root = z.getEntries().some(e => e.entryName === 'level.dat');
    z.extractAllTo(root ? path.join(folder, f.fileName.replace(/\.zip$/i, '')) : folder, true);
  } else { await downloadScanned(f.downloadUrl, path.join(folder, f.fileName), f.fileName); return f.fileName; }
  return true;
}


/* ---------- Проверка файлов через VirusTotal ---------- */
const VT = 'https://www.virustotal.com/api/v3', VT_GAP = +process.env.FC_VT_GAP || 16000; // бесплатный ключ: 4 запроса в минуту
let vtLast = 0;
async function vtReq(u, opts = {}) {
  const wait = vtLast + VT_GAP - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  vtLast = Date.now();
  const r = await fetch(u.startsWith('http') ? u : VT + u, { ...opts, headers: { 'x-apikey': CFG.vtKey, ...UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(180000) });
  if (r.status === 401 || r.status === 403) throw new Error('VirusTotal: неверный ключ API (проверь его в Настройках)');
  if (r.status === 429) throw new Error('VirusTotal: превышен лимит бесплатного ключа, подожди минуту и повтори');
  return r;
}
const vtCacheFile = () => P('vt-cache.json');
const vtCacheLoad = () => { try { return JSON.parse(fs.readFileSync(vtCacheFile(), 'utf8')); } catch { return {}; } };
function sha256File(file) { return new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); }); }
async function scanFile(file, label) {
  const hash = await sha256File(file), cache = vtCacheLoad(), hit = cache[hash];
  if (hit && Date.now() - hit.at < 7 * 864e5) return hit;
  progress(`Проверяю через VirusTotal: ${label}…`, 0);
  let stats, r = await vtReq('/files/' + hash);
  if (r.ok) stats = (await r.json()).data.attributes.last_analysis_stats;
  else if (r.status === 404) {
    const size = fs.statSync(file).size; let url = VT + '/files';
    if (size > 32 * 1048576) { const u = await vtReq('/files/upload_url'); if (!u.ok) throw new Error('VirusTotal: не удалось начать загрузку большого файла'); url = (await u.json()).data; }
    const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    const up = await vtReq(url, { method: 'POST', body: fd });
    if (!up.ok) throw new Error('VirusTotal: не удалось отправить файл на проверку (HTTP ' + up.status + ')');
    const id = (await up.json()).data.id;
    for (let i = 0; i < 14 && !stats; i++) {
      progress(`VirusTotal анализирует: ${label}…`, 0);
      const a = await vtReq('/analyses/' + id); if (!a.ok) continue;
      const at = (await a.json()).data.attributes; if (at.status === 'completed') stats = at.stats;
    }
    if (!stats) throw new Error('VirusTotal не успел закончить проверку «' + label + '». Файл не установлен, попробуй позже.');
  } else throw new Error('VirusTotal: ошибка ' + r.status);
  const v = { hash, malicious: stats.malicious || 0, suspicious: stats.suspicious || 0, at: Date.now() };
  v.blocked = v.malicious >= 2 || v.malicious + v.suspicious >= 3;
  cache[hash] = v; try { fs.writeFileSync(vtCacheFile(), JSON.stringify(cache)); } catch {}
  return v;
}
async function verify(tmp, label) {
  let v; try { v = await scanFile(tmp, label); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  if (v.blocked) { fs.rmSync(tmp, { force: true }); throw new Error(`Заблокировано: «${label}» помечен вредоносным (${v.malicious + v.suspicious} движков VirusTotal). Файл удалён и не установлен.`); }
  if (v.malicious || v.suspicious) send('toast', { text: `«${label}»: ${v.malicious + v.suspicious} движок(ов) VirusTotal сомневается в файле. Ставь, только если доверяешь источнику.`, err: true });
  return v;
}
function placeFile(tmp, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(tmp, dest); } catch { fs.copyFileSync(tmp, dest); fs.rmSync(tmp, { force: true }); }
}
async function downloadScanned(url, dest, label) {
  if (!CFG.vtKey) return download(url, dest);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  const tmp = P('quarantine', Date.now() + '-' + path.basename(dest));
  await download(url, tmp); await verify(tmp, label || path.basename(dest)); placeFile(tmp, dest);
}
const IMPORT_EXT = { mod: ['.jar'], shader: ['.zip'], resourcepack: ['.zip'], map: ['.zip'] };
function placeImported(type, tmp, name) {
  const folder = path.join(cur().dir, FOLDER[type]);
  if (type === 'map') {
    const z = new AdmZip(tmp), root = z.getEntries().some(e => e.entryName === 'level.dat');
    z.extractAllTo(root ? path.join(folder, name.replace(/\.zip$/i, '')) : folder, true); fs.rmSync(tmp, { force: true });
  } else placeFile(tmp, path.join(folder, name));
}
async function importFrom(type, src, name) {
  const ext = path.extname(name).toLowerCase();
  if (!(IMPORT_EXT[type] || []).includes(ext)) throw new Error(`В этот раздел можно добавить только файлы ${(IMPORT_EXT[type] || []).join(' / ')}`);
  name = name.replace(/[^\w.\-()\[\]+ ]/g, '_');
  const tmp = P('quarantine', Date.now() + '-' + name); fs.mkdirSync(path.dirname(tmp), { recursive: true });
  if (/^https:\/\//i.test(src)) await download(src, tmp); else fs.copyFileSync(src, tmp);
  if (CFG.vtKey) await verify(tmp, name);
  placeImported(type, tmp, name);
  return { name, scanned: !!CFG.vtKey };
}
async function importFile(type) {
  const exts = IMPORT_EXT[type]; if (!exts) throw new Error('В этот раздел нельзя добавлять файлы');
  const r = await dialog.showOpenDialog({ title: 'Выбери скачанный файл', filters: [{ name: exts.join(', '), extensions: exts.map(e => e.slice(1)) }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null; return importFrom(type, r.filePaths[0], path.basename(r.filePaths[0]));
}
async function importUrl(type, url) {
  if (!/^https:\/\/[^\s]+$/i.test(url)) throw new Error('Нужна ссылка, которая начинается с https://');
  let name; try { name = decodeURIComponent(path.basename(new URL(url).pathname)); } catch { name = ''; }
  if (!name) throw new Error('Не удалось понять имя файла по ссылке — скачай файл в браузере и выбери его кнопкой «Добавить файл»');
  return importFrom(type, url, name);
}

/* ---------- запоминаем, что уже установлено ---------- */
const regFile = () => P('installed-ids.json');
const regLoad = () => { try { return JSON.parse(fs.readFileSync(regFile(), 'utf8')); } catch { return {}; } };
const regScope = type => { if (type === 'modpack') return 'global'; const p = CFG.packs.find(x => x.id === CFG.pack); return p ? p.id : CFG.version + '-' + CFG.loader; };
function regAdd(type, id, rec) {
  const r = regLoad(), s = regScope(type); r[s] = r[s] || {}; r[s][type] = r[s][type] || {}; r[s][type][String(id)] = rec;
  fs.mkdirSync(path.dirname(regFile()), { recursive: true }); fs.writeFileSync(regFile(), JSON.stringify(r));
}
async function install(a) {
  const { type, id } = a;
  if (type === 'modpack') { const pack = await installRaw(a); try { regAdd('modpack', id, { packId: pack && pack.id }); } catch {} return pack; }
  const folder = path.join(cur().dir, FOLDER[type]); let before = []; try { before = fs.readdirSync(folder); } catch {}
  const res = await installRaw(a);
  try {
    let files = []; try { files = fs.readdirSync(folder).filter(n => !before.includes(n)); } catch {}
    if (typeof res === 'string') files = [res];
    if (files.length) regAdd(type, id, { files, at: Date.now() });
  } catch {}
  return true;
}
async function installedIds(type, deep) {
  const out = new Set(), r = regLoad();
  if (type === 'modpack') { for (const [id, rec] of Object.entries(((r.global || {}).modpack) || {})) if (CFG.packs.some(p => p.id === rec.packId)) out.add(id); return [...out]; }
  let dir; try { dir = contentDir(type); } catch { return []; }
  for (const [id, rec] of Object.entries(((r[regScope(type)] || {})[type]) || {})) if ((rec.files || []).some(f => fs.existsSync(path.join(dir, f)) || fs.existsSync(path.join(dir, f + '.disabled')))) out.add(id);
  if (deep && type !== 'map') { try { for (const v of Object.values(await identify(type))) if (v && v.id) out.add(String(v.id)); } catch {} }
  return [...out];
}

async function installPack(id) {
  const vs = await getJSON(`https://api.modrinth.com/v2/project/${id}/version`);
  if (!vs.length) throw new Error('У сборки нет файлов');
  const f = vs[0].files.find(x => x.primary) || vs[0].files[0], mp = P('packs', f.filename);
  await downloadScanned(f.url, mp, f.filename);
  const z = new AdmZip(mp), idx = JSON.parse(z.readAsText('modrinth.index.json')), d = idx.dependencies || {};
  const loader = d['fabric-loader'] ? 'fabric' : d.neoforge ? 'neoforge' : d.forge ? 'forge' : null;
  if (!loader) throw new Error('Эта сборка для другого загрузчика (Quilt и т.п.) — не поддерживается');
  const pack = { id: uid(), name: idx.name, version: d.minecraft, loader, notify: true, skin: true, skinMod: false }, dir = packDir(pack.id);
  await pool(idx.files.filter(x => !x.env || x.env.client !== 'unsupported'), 8, x => download(x.downloads[0], safeJoin(dir, x.path)), 'Файлы сборки');
  for (const e of z.getEntries()) {
    if (e.isDirectory) continue;
    for (const pre of ['overrides/', 'client-overrides/']) if (e.entryName.startsWith(pre)) {
      const t = safeJoin(dir, e.entryName.slice(pre.length)); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, e.getData());
    }
  }
  CFG.packs.push(pack); CFG.pack = pack.id; saveCfg(); notify('ForestCraft', `Сборка «${pack.name}» установлена`); return pack;
}
async function ensureSkinMod(dir) {
  const md = path.join(dir, 'mods');
  if (fs.existsSync(md) && fs.readdirSync(md).some(f => /customskinloader/i.test(f))) return;
  await mrInstall('customskinloader', 'mod', dir, new Set());
}
const LV = {};
async function loaderVersions(l) {
  if (LV[l]) return LV[l];
  let r = [];
  if (l === 'fabric') r = (await getJSON('https://meta.fabricmc.net/v2/versions/game')).map(x => x.version);
  else if (l === 'forge') r = [...new Set(Object.keys((await getJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos).map(k => k.replace(/-(latest|recommended)$/, '')))];
  else if (l === 'neoforge') {
    const vs = (await getJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions;
    r = [...new Set(vs.map(v => { const [a, b] = v.split('.'); return +a >= 26 ? `${a}.${b}` : `1.${a}` + (+b ? '.' + b : ''); }))];
  }
  return (LV[l] = r);
}

const CONTENT = ['mod', 'resourcepack', 'shader'];
const contentDir = kind => { if (!CONTENT.includes(kind)) throw new Error('Неизвестный тип'); return path.join(cur().dir, FOLDER[kind]); };
function listContent(kind) {
  const d = contentDir(kind); if (!fs.existsSync(d)) return [];
  const out = [];
  for (const n of fs.readdirSync(d)) {
    let st; try { st = fs.statSync(path.join(d, n)); } catch { continue; }
    if (kind === 'mod' ? !/\.jar(\.disabled)?$/.test(n) : (n === 'ForestCraftSkin.zip' || (!st.isDirectory() && !/\.zip$/i.test(n)))) continue;
    out.push({ name: n, size: st.isDirectory() ? 0 : st.size, isDir: st.isDirectory(), enabled: !n.endsWith('.disabled') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}



/* ---------- описание и опознание модов ---------- */
const plain = t => String(t || '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/<br\s*\/?>|<\/(p|div|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/^\s{0,3}#{1,6}\s*/gm, '').replace(/(\*\*|__)/g, '').replace(/^\s*[-*]\s+/gm, '• ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3500);
const infoCache = new Map();
async function projectInfo({ id, source = 'modrinth' }) {
  const key = source + ':' + id; if (infoCache.has(key)) return infoCache.get(key);
  let r;
  if (source === 'curseforge') {
    const m = (await cf('/mods/' + encodeURIComponent(id))).data; let body = '';
    try { body = (await cf(`/mods/${encodeURIComponent(id)}/description`)).data || ''; } catch {}
    r = { id, source, title: m.name, summary: m.summary, body: plain(body), icon: m.logo && m.logo.thumbnailUrl, downloads: m.downloadCount, author: (m.authors && m.authors[0] || {}).name || '',
      categories: (m.categories || []).map(c => c.name), loaders: [], versions: [...new Set((m.latestFilesIndexes || []).map(x => x.gameVersion))].slice(0, 12), url: m.links && m.links.websiteUrl };
  } else {
    const m = await getJSON('https://api.modrinth.com/v2/project/' + encodeURIComponent(id));
    r = { id, source, title: m.title, summary: m.description, body: plain(m.body), icon: m.icon_url, downloads: m.downloads, author: '', categories: m.categories || [], loaders: m.loaders || [],
      versions: (m.game_versions || []).slice(-12).reverse(), url: `https://modrinth.com/${m.project_type}/${m.slug}` };
    try { const t = await getJSON(`https://api.modrinth.com/v2/project/${encodeURIComponent(id)}/members`); const o = t.find(x => x.role === 'Owner') || t[0]; r.author = (o && o.user && o.user.username) || ''; } catch {}
  }
  infoCache.set(key, r); return r;
}
const idCache = new Map();
function cfHash(buf) { // Murmur2 (seed 1) без пробельных байтов — так CurseForge опознаёт файлы
  const b = Buffer.from(buf.filter(x => x !== 9 && x !== 10 && x !== 13 && x !== 32)), m = 0x5bd1e995;
  let len = b.length, h = (1 ^ len) >>> 0, i = 0;
  while (len >= 4) { let k = b.readUInt32LE(i); k = Math.imul(k, m) >>> 0; k = (k ^ (k >>> 24)) >>> 0; k = Math.imul(k, m) >>> 0; h = Math.imul(h, m) >>> 0; h = (h ^ k) >>> 0; i += 4; len -= 4; }
  if (len === 3) h = (h ^ (b[i + 2] << 16)) >>> 0;
  if (len >= 2) h = (h ^ (b[i + 1] << 8)) >>> 0;
  if (len >= 1) { h = (h ^ b[i]) >>> 0; h = Math.imul(h, m) >>> 0; }
  h = (h ^ (h >>> 13)) >>> 0; h = Math.imul(h, m) >>> 0; h = (h ^ (h >>> 15)) >>> 0; return h;
}
async function postJSON(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...UA, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
}
async function identify(kind) {
  const d = contentDir(kind), out = {}, todo = [], hasCf = !!CFG.cfKey, tag = hasCf ? '|cf' : '';
  for (const f of listContent(kind)) {
    if (f.isDir) continue; const k = kind + '|' + f.name + '|' + f.size + tag;
    if (idCache.has(k)) { out[f.name] = idCache.get(k); continue; }
    try { const buf = fs.readFileSync(path.join(d, f.name)); todo.push({ name: f.name, k, h: crypto.createHash('sha1').update(buf).digest('hex'), fp: hasCf ? cfHash(buf) : 0 }); } catch {}
  }
  if (!todo.length) return out;
  let ok = false;
  try { // Modrinth
    const vers = await postJSON('https://api.modrinth.com/v2/version_files', { hashes: todo.map(t => t.h), algorithm: 'sha1' }), projs = {};
    const ids = [...new Set(Object.values(vers).map(v => v.project_id))];
    if (ids.length) (await getJSON('https://api.modrinth.com/v2/projects?ids=' + encodeURIComponent(JSON.stringify(ids)))).forEach(p => { projs[p.id] = p; });
    for (const t of todo) { const v = vers[t.h], p = v && projs[v.project_id]; if (p) t.val = { id: p.id, source: 'modrinth', title: p.title, icon: p.icon_url, desc: p.description }; }
    ok = true;
  } catch {}
  if (hasCf) { // CurseForge: то, что не нашлось на Modrinth
    const rest = todo.filter(t => !t.val && t.fp);
    if (rest.length) try {
      const hdr = { 'x-api-key': CFG.cfKey };
      const fr = await postJSON('https://api.curseforge.com/v1/fingerprints', { fingerprints: rest.map(t => t.fp) }, hdr), byFp = {};
      (fr.data.exactMatches || []).forEach(m => { byFp[m.file.fileFingerprint] = m.file.modId; });
      const mids = [...new Set(Object.values(byFp))], mods = {};
      if (mids.length) (await postJSON('https://api.curseforge.com/v1/mods', { modIds: mids }, hdr)).data.forEach(m => { mods[m.id] = m; });
      for (const t of rest) { const m = mods[byFp[t.fp]]; if (m) t.val = { id: String(m.id), source: 'curseforge', title: m.name, icon: m.logo && (m.logo.thumbnailUrl || m.logo.url), desc: m.summary }; }
      ok = true;
    } catch {}
  }
  for (const t of todo) { out[t.name] = t.val || null; if (ok) idCache.set(t.k, t.val || null); }
  return out;
}

/* ---------- AI: рекомендации модов ---------- */
const AI_DEF = { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-5-5', gemini: 'gemini-2.5-flash', custom: '' };
function aiProvider() {
  const k = (CFG.aiKey || '').trim(); let p = CFG.aiProvider || 'auto';
  if (p === 'auto') p = k.startsWith('sk-ant-') ? 'anthropic' : k.startsWith('AIza') ? 'gemini' : 'openai';
  return p;
}
async function aiPost(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...UA, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok) { const m = j && (j.error && (j.error.message || j.error) || j.message); throw new Error(`ИИ вернул ошибку ${r.status}: ${typeof m === 'string' ? m : t.slice(0, 200)}`); }
  return j;
}
async function aiComplete(system, history) {
  const key = (CFG.aiKey || '').trim(); if (!key) throw new Error('Вставь ключ ИИ во вкладке «ИИ» → Настройки ключа');
  const p = aiProvider(), model = (CFG.aiModel || '').trim() || AI_DEF[p];
  if (!model) throw new Error('Укажи название модели');
  if (p === 'anthropic') {
    const j = await aiPost('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, { model, max_tokens: 2000, system, messages: history });
    return (j.content || []).map(x => x.text || '').join('');
  }
  if (p === 'gemini') {
    const j = await aiPost(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key },
      { systemInstruction: { parts: [{ text: system }] }, contents: history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) });
    return ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(x => x.text || '').join('');
  }
  let base = (p === 'custom' ? (CFG.aiBase || '').trim() : 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!base) throw new Error('Для своего сервиса укажи адрес API (например https://openrouter.ai/api/v1)');
  const j = await aiPost(base + '/chat/completions', { Authorization: 'Bearer ' + key }, { model, messages: [{ role: 'system', content: system }, ...history] });
  return (((j.choices || [])[0] || {}).message || {}).content || '';
}
function aiJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (j && typeof j === 'object') return j; } catch {} }
  return { reply: String(text).trim(), mods: [] };
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9а-я]+/g, '');
async function aiRecommend(history) {
  const c = cur(), ld = LD();
  let have = []; try { have = (await listContent('mod')).map(x => x.name.replace(/\.(jar|disabled)+$/g, '')); } catch {}
  const system = `Ты помощник в Minecraft-лаунчере. Игрок хочет собрать моды. Версия игры: ${c.version}, загрузчик: ${ld}. ` +
    `Уже установлены: ${have.length ? have.join(', ').slice(0, 1500) : 'ничего'}. ` +
    `Предлагай только реальные известные моды, которые есть на Modrinth для этой версии и загрузчика; не придумывай названий, не предлагай уже установленные. ` +
    `Обычно 5–10 модов, совместимых друг с другом. Отвечай по-русски. Ответ строго в JSON без markdown: ` +
    `{"reply":"короткий ответ игроку","mods":[{"name":"точное название мода на Modrinth","why":"зачем он, одно предложение"}]}. ` +
    `Если вопрос не про моды, отвечай в reply, а mods оставь пустым.`;
  const clean = history.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }));
  const out = aiJson(await aiComplete(system, clean));
  const mods = [];
  for (const m of (Array.isArray(out.mods) ? out.mods : []).slice(0, 12)) {
    const name = String((m && m.name) || '').trim(); if (!name) continue;
    let hit = null;
    try { const r = await search({ type: 'mod', query: name, source: 'modrinth', offset: 0 }); hit = r.find(x => norm(x.title) === norm(name)) || r.find(x => norm(x.title).includes(norm(name)) || norm(name).includes(norm(x.title))) || null; } catch {}
    let source = 'modrinth';
    if (!hit && CFG.cfKey) { try { const r = await search({ type: 'mod', query: name, source: 'curseforge', offset: 0 }); hit = r.find(x => norm(x.title) === norm(name)) || r.find(x => norm(x.title).includes(norm(name)) || norm(name).includes(norm(x.title))) || null; if (hit) source = 'curseforge'; } catch {} }
    mods.push({ name, why: String((m && m.why) || ''), id: hit && hit.id, title: hit && hit.title, icon: hit && hit.icon, source, found: !!hit });
  }
  return { reply: String(out.reply || ''), mods, version: c.version, loader: ld };
}

/* ---------- Оплата визуалов ---------- */
const PAY = { amount: 238, card: '2204321060364130', bank: 'Ozon Банк', url: 'https://online.sberbank.ru/' };
const VISUALS_CODE_HASHES = [
  '9e454ed3de325dc9807c5cbc9a6eeb630b18ea33f13acf19fef6e2123dde447b',
  '20d9d12eba040d73ce7be57790ee42ca4c4a2382788f420e03ee0a563bfdabe7',
  '147de4791e92b170c12c94acac2389b5059380c4245cbf087a3006a7b3dd4c4e',
  '7b254f2794c22a3932706f1095b60526a78e02399a94a886e269af7f8a44e6e2',
  '1d12e99c3adcaa04998d8177a7366f94323a386670434734adccefac274222f1',
  '80f7b6541379ed6cf7195fe9629f8b19dca72fe6c345275e841671a572d85942',
  '58677bbc1c4f664fb8def0565db3035d4d23814be1c7b0c96f7a15cf4b1c9042',
  '37bb3e62d1753cb43b27d11fb5fc446520326d2161c7a91108b9df8a71ceb5e8',
  'c1da6bcda50748148989d17a9ce85b8e21837bf6983c5167a55d06d639646135',
  'a2e582aaee206705c2b7fd53c97da19caf63d9a6cc0f48439f5db87a360cba06',
  '315478a7fb87d985541b62dd3d2bd42a17acdf8be1b7bcb9a37c0e8879b3b647',
  'a25d46d49142d6101679128a89e58f76dde7c03a7257f1590bf2ae5dba5a62e4',
  'd7ad4cb796f8735b5d0829dff71f3995303d5300b604e19b598c20779acc1cbc',
  '4b37f209adebc38ded22ee2e79518a6047552af0cc0fdef2452745771b0bcd85',
  '54b7be86cc503bc5bce22375ec9d2bb3e03130a5f2933b76b4d9bad9b777a338',
  'd6e2b26e32dafd5aeb3775893bdfe8d8224f10867fc7bd62a50dd777a7dce52a',
  '1f097a715881955af0625bb4fdd51e5334208cee24925a9e4cf54ea8308543c7',
  '3a48e1a266c4fc42c3af9242898288e00481346536a39ffefeaf690e6d51511b',
  '5eb16e5f226e1bd9a585e25b94c11858cfdfd64964b498b14b4e3e2853bc93f8',
  '29ab53e894c93665161a52fffa95d63689d5c2469e46d313554010823e2df28a'
]; // SHA-256 хэши кодов. Новые коды ДОБАВЛЯЙ в конец (node make-codes.js), старые НЕ удаляй — иначе у прежних покупателей пропадёт доступ.
const normCode = c => String(c || '').replace(/[\s-]/g, '').toUpperCase();
function payInfo() { return { amount: PAY.amount, bank: PAY.bank, card: PAY.card.replace(/(\d{4})(?=\d)/g, '$1 ') }; }
async function openPay() { clipboard.writeText(PAY.card); await shell.openExternal(PAY.url); return payInfo(); }
// Лицензия лежит в двух местах ВНЕ папки установки: рядом с настройками и в домашней папке пользователя.
// Обновление и переустановка лаунчера её не трогают, а если одну копию удалят, вторая её восстановит.
const licPaths = () => [path.join(BASE, 'license.dat'), path.join(os.homedir(), '.fortress-launcher', 'license.dat')];
function loadLicense() {
  let ok = false;
  for (const f of licPaths()) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && VISUALS_CODE_HASHES.includes(j.hash)) { ok = j; break; } } catch {} }
  if (ok) for (const f of licPaths()) { try { if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(ok)); } } catch {} }
  return !!ok;
}
function unlockVisuals(code) {
  const h = crypto.createHash('sha256').update(normCode(code)).digest('hex');
  if (!normCode(code) || !VISUALS_CODE_HASHES.includes(h)) throw new Error('Неверный код доступа');
  const rec = JSON.stringify({ v: 1, hash: h, at: Date.now() }); let saved = 0;
  for (const f of licPaths()) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rec); saved++; } catch {} }
  if (!saved) throw new Error('Не удалось сохранить лицензию на диск');
  CFG.visualsPaid = true; saveCfg(); return CFG;
}

/* ---------- Подстройка под устройство ---------- */
const SHADER_LIST = ['Complementary Reimagined', 'Complementary Unbound', 'BSL Shaders', 'MakeUp - Ultra Fast'];
const OPT_MODS = { fabric: ['sodium', 'lithium', 'ferrite-core', 'modernfix', 'entityculling', 'iris'], quilt: ['sodium', 'lithium', 'ferrite-core', 'modernfix', 'entityculling', 'iris'],
  neoforge: ['sodium', 'ferrite-core', 'modernfix', 'entityculling', 'iris'], forge: ['embeddium', 'ferrite-core', 'modernfix', 'entityculling', 'oculus'] };
const TIER_NAME = { 1: 'Слабый', 2: 'Средний', 3: 'Мощный' };
function gpuTier(name) {
  const n = String(name || '').toLowerCase(); let m;
  if (!n) return 0;
  if ((m = n.match(/rtx\s*(\d)0?(\d)0\b|rtx\s*(\d{4})/))) { const num = +((n.match(/rtx\s*(\d{4})/) || [])[1] || 0); if (num >= 4070 || (num >= 3070 && num < 4000) || num === 2080 || num === 2070 || num >= 5070) return 3; return 2; }
  if ((m = n.match(/gtx\s*(\d{3,4})/))) { const num = +m[1]; return num >= 1060 ? 2 : 1; }
  if (/\bmx\s*\d{3}|geforce\s*gt\s|quadro\s*(p|k)\d/.test(n)) return 1;
  if ((m = n.match(/rx\s*(\d{3,4})/))) { const num = +m[1]; if (num >= 6700 || num >= 7700 || (num >= 9000)) return 3; if (num >= 5500 || num === 580 || num === 570 || num === 590 || num >= 6500) return 2; return 1; }
  if (/arc.*(a7\d\d|b5\d\d)|arc.*b580/.test(n)) return 2;
  if (/intel|uhd|iris|hd graphics|vega|radeon\(tm\) graphics|radeon graphics|microsoft basic|llvmpipe|swiftshader/.test(n)) return 1;
  if (/nvidia|geforce|radeon|amd/.test(n)) return 2;
  return 0;
}
let devCache = null;
async function detectDevice() {
  if (devCache) return devCache;
  const cpus = os.cpus(), info = { cpu: ((cpus[0] || {}).model || 'Неизвестно').replace(/\s+/g, ' ').trim(), cores: cpus.length, ramMB: Math.round(os.totalmem() / 1048576), gpus: [], platform: process.platform };
  if (process.platform === 'win32') {
    try {
      const out = await new Promise((res, rej) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'], { timeout: 12000, windowsHide: true }, (e, so) => e ? rej(e) : res(so)));
      info.gpus = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch {}
  }
  if (!info.gpus.length && app && app.getGPUInfo) { try { const g = await app.getGPUInfo('complete'); const r = g.auxAttributes && g.auxAttributes.glRenderer; if (r) info.gpus = [String(r)]; } catch {} }
  let best = 0, bestName = info.gpus[0] || '';
  for (const g of info.gpus) { const t = gpuTier(g); if (t > best || (t === best && /nvidia|geforce|rtx|gtx|rx\s*\d/i.test(g))) { best = t; bestName = g; } }
  info.gpu = bestName || 'Не удалось определить';
  let t = best || (info.cores >= 6 && info.ramMB >= 12000 ? 2 : 1);
  if (info.ramMB < 6000) t = 1; else if (info.ramMB < 10000) t = Math.min(t, 2);
  if (info.cores < 4) t = 1; else if (info.cores < 6) t = Math.min(t, 2);
  info.tier = t; info.tierName = TIER_NAME[t];
  return (devCache = info);
}
function optPlan(dev, fps) {
  fps = [60, 90, 120].includes(+fps) ? +fps : 60; const t = dev.tier, hi = fps >= 120, mid = fps >= 90;
  const rd = t === 1 ? (hi ? 6 : 8) : t === 2 ? (hi ? 10 : mid ? 11 : 12) : (hi ? 14 : mid ? 16 : 20);
  let ram = Math.round(dev.ramMB * 0.4 / 512) * 512; ram = Math.max(2048, Math.min(ram, 8192, dev.ramMB - 3072)); if (t === 1) ram = Math.min(ram, 3072);
  ram = Math.max(1024, ram);
  const shader = t === 1 ? null : t === 2 ? (hi ? null : mid ? 'MakeUp - Ultra Fast' : 'Complementary Reimagined') : (hi ? 'MakeUp - Ultra Fast' : mid ? 'Complementary Reimagined' : 'Complementary Unbound');
  return { fps, ram, shader, options: {
    renderDistance: rd, simulationDistance: Math.max(5, Math.min(rd, t === 3 ? 12 : 8)), maxFps: fps, enableVsync: 'false',
    particles: t === 1 ? 2 : t === 2 ? 1 : 0, fancyGraphics: t === 1 || (t === 2 && hi) ? 'false' : 'true', graphicsMode: t === 1 || (t === 2 && hi) ? 0 : 1,
    entityShadows: t === 1 ? 'false' : 'true', biomeBlendRadius: t === 1 ? 1 : t === 2 ? 3 : 5, renderClouds: t === 1 ? '"false"' : t === 2 ? '"fast"' : '"true"', mipmapLevels: t === 1 ? 2 : 4 } };
}
async function deviceProfile({ fps = 60 } = {}) { const device = await detectDevice(); return { device, plan: optPlan(device, fps), shaders: SHADER_LIST }; }
function writeOptions(dir, opts) {
  fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'options.txt');
  const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/) : []; const left = { ...opts };
  const out = lines.filter(l => l !== '').map(l => { const k = l.split(':')[0]; if (k in left) { const v = left[k]; delete left[k]; return `${k}:${v}`; } return l; });
  for (const k of Object.keys(left)) out.push(`${k}:${left[k]}`);
  fs.writeFileSync(f, out.join('\n') + '\n');
}
async function applyOptimization({ fps = 60, shader = 'auto', mods = true } = {}) {
  if (running) throw new Error('Закрой игру перед оптимизацией, иначе она перезапишет настройки');
  const dev = await detectDevice(), plan = optPlan(dev, fps), c = cur(), rep = { tier: dev.tierName, ram: plan.ram, options: Object.keys(plan.options).length, mods: [], shader: null, notes: [] };
  CFG.ram = plan.ram; saveCfg();
  writeOptions(c.dir, plan.options);
  const list = OPT_MODS[c.loader];
  if (mods) {
    if (!list) rep.notes.push('Для оптимизации модами выбери загрузчик Fabric (или Forge/NeoForge) — на «чистой» игре моды не работают.');
    else for (const id of list) { try { await mrInstall(id, 'mod', c.dir, new Set()); rep.mods.push({ id, ok: true }); } catch (e) { rep.mods.push({ id, ok: false, error: e.message }); } }
  }
  const want = shader === 'none' ? null : shader === 'auto' ? plan.shader : shader;
  if (want) {
    const shaderMod = c.loader === 'forge' ? 'oculus' : 'iris', hasLoader = list && (rep.mods.some(m => m.id === shaderMod && m.ok) || (() => { try { return listContent('mod').some(x => /iris|oculus/i.test(x.name)); } catch { return false; } })());
    if (!hasLoader) rep.notes.push(`Шейдеры «${want}» не поставлены: нужен мод ${shaderMod === 'oculus' ? 'Oculus' : 'Iris'} (включи «моды оптимизации» и Fabric).`);
    else {
      try {
        const before = Date.now();
        const hits = await search({ type: 'shader', query: want, source: 'modrinth', offset: 0 });
        const hit = hits.find(x => norm(x.title) === norm(want)) || hits[0]; if (!hit) throw new Error('не найден на Modrinth');
        await mrInstall(hit.id, 'shader', c.dir, new Set());
        const sd = path.join(c.dir, 'shaderpacks'); const f = fs.readdirSync(sd).map(n => ({ n, t: fs.statSync(path.join(sd, n)).mtimeMs })).filter(x => x.t >= before - 2000).sort((a, b) => b.t - a.t)[0];
        if (f) { const cfgDir = path.join(c.dir, 'config'); fs.mkdirSync(cfgDir, { recursive: true }); fs.writeFileSync(path.join(cfgDir, shaderMod + '.properties'), `enableShaders=true\nshaderPack=${f.n}\n`); }
        rep.shader = { name: want, ok: true };
      } catch (e) { rep.shader = { name: want, ok: false, error: e.message }; }
    }
  }
  return rep;
}

/* ---------- API ---------- */
const api = {
  versions,
  getState: () => ({ cfg: CFG, root: ROOT, mem: Math.floor(os.totalmem() / 1048576), skin: skinUrl(currentSkin()) }),
  accountsInfo: () => CFG.accounts.map(a => ({ id: a.id, name: a.name, skin: skinUrl(currentSkin(a.id)) })),
  saveCfg: (patch) => {
    if ('ram' in patch) patch.ram = Math.max(512, Math.min(Math.floor(os.totalmem() / 1048576), Math.round(+patch.ram) || 2048));
    for (const k of ['selected', 'ram', 'cfKey', 'version', 'loader', 'pack', 'aiKey', 'aiProvider', 'aiModel', 'aiBase', 'visuals', 'vtKey']) if (k in patch) CFG[k] = patch[k]; saveCfg(); return CFG; },
  addAccount: (name) => {
    name = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Ник: 3–16 символов, латиница, цифры и _');
    if (CFG.accounts.some(a => a.name === name)) throw new Error('Такой аккаунт уже есть');
    const a = { id: crypto.randomUUID(), name, uuid: offlineUUID(name) };
    CFG.accounts.push(a); CFG.selected = a.id; saveCfg(); return CFG;
  },
  removeAccount: (id) => { try { fs.rmSync(skinPathFor(id), { force: true }); } catch {} CFG.accounts = CFG.accounts.filter(a => a.id !== id); if (CFG.selected === id) CFG.selected = (CFG.accounts[0] || {}).id || null; saveCfg(); return CFG; },
  setSkin: (dataUrl) => {
    if (!CFG.selected) throw new Error('Сначала добавь аккаунт');
    const f = skinPathFor(CFG.selected); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(String(dataUrl).split(',')[1], 'base64')); return true;
  },
  removeSkin: () => { const f = skinPathFor(CFG.selected); if (fs.existsSync(f)) fs.unlinkSync(f); else if (fs.existsSync(P('skin.png'))) fs.unlinkSync(P('skin.png')); return true; },
  pickDir: async () => { const r = await dialog.showOpenDialog({ title: 'Куда сохранять данные лаунчера', properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
  setDataDir: async (dir, move) => {
    if (running) throw new Error('Закрой игру перед переносом');
    let nd = BASE;
    if (dir) nd = path.basename(dir).toLowerCase() === 'forestcraft' ? dir : path.join(dir, 'ForestCraft');
    nd = path.resolve(nd); const old = path.resolve(ROOT);
    if (nd === old) return ROOT;
    if (nd.startsWith(old + path.sep) || old.startsWith(nd + path.sep)) throw new Error('Выбери папку вне текущей папки данных');
    fs.mkdirSync(nd, { recursive: true });
    if (move) { progress('Переношу файлы…', 50); await fs.promises.cp(old, nd, { recursive: true }); }
    ROOT = nd; CFG.dataDir = dir ? nd : null; saveCfg();
    if (move) for (const f of fs.readdirSync(old)) if (f !== 'config.json') fs.rmSync(path.join(old, f), { recursive: true, force: true });
    progress('Готово', 0); return ROOT;
  },
  listContent,
  removeContent: (kind, name) => { fs.rmSync(safeJoin(contentDir(kind), name), { recursive: true, force: true }); return true; },
  toggleMod: (name) => {
    const d = contentDir('mod'), to = name.endsWith('.disabled') ? name.slice(0, -9) : name + '.disabled';
    fs.renameSync(safeJoin(d, name), safeJoin(d, to)); return true;
  },
  loaderVersions,
  createPack: async ({ name, version, loader, notify = true, skin = true, skinMod = false }) => {
    name = String(name || '').trim().slice(0, 40);
    if (!name) throw new Error('Введи название сборки'); if (!version) throw new Error('Выбери версию');
    const p = { id: uid(), name, version, loader, notify: !!notify, skin: !!skin, skinMod: !!skinMod && loader !== 'vanilla' };
    CFG.packs.push(p); CFG.pack = p.id; fs.mkdirSync(packDir(p.id), { recursive: true }); saveCfg();
    if (p.skinMod) { try { await ensureSkinMod(packDir(p.id)); } catch (e) { send('toast', { text: 'Мод скинов поставится при запуске: ' + e.message, err: true }); } }
    return CFG;
  },
  setPack: (id, patch) => {
    const p = CFG.packs.find(x => x.id === id); if (!p) throw new Error('Сборка не найдена');
    for (const k of ['notify', 'skin', 'skinMod']) if (k in patch) p[k] = !!patch[k];
    if (p.loader === 'vanilla') p.skinMod = false;
    saveCfg(); return CFG;
  },
  removePack: (id) => { CFG.packs = CFG.packs.filter(p => p.id !== id); if (CFG.pack === id) CFG.pack = null; fs.rmSync(packDir(id), { recursive: true, force: true }); saveCfg(); return CFG; },
  packMods: (id) => { const d = path.join(packDir(id), 'mods'); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /\.jar(\.disabled)?$/.test(f)) : []; },
  removeMod: (id, n) => { fs.rmSync(safeJoin(path.join(packDir(id), 'mods'), n), { force: true }); return true; },
  openPack: (id) => { fs.mkdirSync(packDir(id), { recursive: true }); return shell.openPath(packDir(id)); },
  search, install, play,
  installGame: () => play(true),
  projectInfo, identify, openPay, payInfo, unlockVisuals, installedIds, importFile, importUrl, deviceProfile, applyOptimization,
  openUrl: (u) => { if (!/^https:\/\/(modrinth\.com|www\.curseforge\.com)\//.test(String(u))) throw new Error('Ссылка не разрешена'); return shell.openExternal(u); },
  aiRecommend,
  listInstalled: () => {
    const d = P('installed'); fs.mkdirSync(d, { recursive: true });
    const out = [];
    for (const f of fs.readdirSync(d)) { try { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); if (j && j.version && j.loader) out.push({ name: j.version + ' · ' + j.loader, version: j.version, loader: j.loader, at: j.at || 0 }); } catch {} }
    // восстановление: версии, скачанные раньше (или чьи метки пропали), ищем прямо в папке versions
    try {
      const vd = P('versions');
      for (const id of fs.readdirSync(vd)) {
        const jf = path.join(vd, id, id + '.json'); if (!fs.existsSync(jf)) continue;
        let j; try { j = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch { continue; }
        const n = id.toLowerCase(); let version, loader;
        if (j.inheritsFrom) {
          version = j.inheritsFrom;
          loader = n.includes('neoforge') ? 'neoforge' : n.includes('fabric') ? 'fabric' : n.includes('quilt') ? 'quilt' : n.includes('forge') ? 'forge' : null;
        } else if (fs.existsSync(path.join(vd, id, id + '.jar'))) { version = id; loader = 'vanilla'; }
        if (!version || !loader || out.some(x => x.version === version && x.loader === loader)) continue;
        const at = fs.statSync(jf).mtimeMs;
        out.push({ name: version + ' · ' + loader, version, loader, at });
        try { fs.writeFileSync(P('installed', version + '-' + loader + '.ok'), JSON.stringify({ version, loader, at })); } catch {}
      }
    } catch {}
    return out.sort((a, b) => b.at - a.at);
  },
  selectVersion: (version, loader) => {
    if (!api.listInstalled().some(x => x.version === version && x.loader === loader)) throw new Error('Эта версия не установлена');
    CFG.version = version; CFG.loader = loader; CFG.pack = null; saveCfg(); return CFG;
  },
  isInstalled: () => { if (!cur().version) return false; if (!fs.existsSync(marker())) api.listInstalled(); return fs.existsSync(marker()); },
  openDir: (kind) => { const d = kind === 'root' ? ROOT : kind === 'ver' ? P('versions') : path.join(cur().dir, FOLDER[kind] || ''); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); }
};
module.exports = { init, api };
