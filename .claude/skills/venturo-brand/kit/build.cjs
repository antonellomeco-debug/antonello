// Kit grafico di Venturo: node .claude/skills/venturo-brand/kit/build.cjs <cartella>  → <cartella>/out
const fs = require('fs'); const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const W = require('./wordmark.json') /* la scritta «venturo» in forme */;
const OUT = path.join(process.argv[2] ?? __dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const C = { navy: '#0A1F44', deep: '#06142E', blue: '#2F5BFF', blueL: '#7C9BFF', green: '#2BD67B', greenD: '#0B7A45', ink: '#0B1220', grey: '#5B6575', mist: '#EEF2F7', paper: '#F7F9FC' };

// Simbolo: V (braccio destro più alto) + punto verde. Coordinate 0..200.
const symbol = (stroke, dot, k = 1, x = 0, y = 0) =>
  `<g transform="translate(${x} ${y}) scale(${k})"><path d="M36 70 L92 152 L148 54" fill="none" stroke="${stroke}" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><circle cx="170" cy="25" r="20" fill="${dot}"/></g>`;
// Scritta: dimensione = corpo del carattere in px, baseline a y.
const word = (fill, size, x, y) => `<path transform="translate(${x} ${y}) scale(${size / 1000})" d="${W.d}" fill="${fill}"/>`;
// Logo orizzontale: corpo 100 → larghezza ~ 500, altezza ~ 78 (punto in cima → base della V).
function lockup(stroke, dot, text, fs = 100, x = 0, y = 0) {
  const k = fs * 0.005; // tratto della V spesso come le lettere, braccio sinistro alto come le minuscole
  const symW = (190 - 21) * k, gap = fs * 0.22;
  const base = y + (167 - 5) * k; // base della scritta = base della V
  return { svg: `${symbol(stroke, dot, k, x - 21 * k, y - 5 * k)}${word(text, fs, x + symW + gap - 12 * fs / 1000, base)}`, w: symW + gap + (W.width - 12) * fs / 1000, h: (167 - 5) * k };
}
const svgDoc = (w, h, body, bg) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${body}</svg>`;

const files = {};
// Simboli
files['venturo-simbolo-bianco.svg'] = svgDoc(200, 200, symbol('#FFFFFF', C.green));
files['venturo-simbolo-navy.svg'] = svgDoc(200, 200, symbol(C.navy, C.greenD));
files['venturo-simbolo-su-navy.svg'] = svgDoc(200, 200, symbol('#FFFFFF', C.green), C.navy);
// Logo orizzontale (margini = altezza del punto)
{
  const L = lockup('#FFFFFF', C.green, '#FFFFFF', 100, 40, 40);
  const w = Math.ceil(L.w + 80), h = Math.ceil(L.h + 80);
  files['venturo-logo-bianco.svg'] = svgDoc(w, h, L.svg);
  files['venturo-logo-su-navy.svg'] = svgDoc(w, h, L.svg, C.navy);
  const D = lockup(C.navy, C.greenD, C.navy, 100, 40, 40);
  files['venturo-logo-navy.svg'] = svgDoc(w, h, D.svg);
  files['venturo-logo-su-chiaro.svg'] = svgDoc(w, h, D.svg, C.paper);
}
for (const [n, s] of Object.entries(files)) fs.writeFileSync(path.join(OUT, n), s);

const b64 = (f) => fs.readFileSync(f).toString('base64');
const FONTS = path.join(__dirname, '../../../../assets/fonts');
const fonts = `@font-face{font-family:Sora;src:url(data:font/woff2;base64,${b64(path.join(FONTS, 'Sora-latin.woff2'))}) format("woff2");font-weight:100 800}
@font-face{font-family:Inter;src:url(data:font/ttf;base64,${b64(path.join(FONTS, 'Inter.ttf'))});font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}html,body{background:transparent}`;

// Sfondo di marca: navy profondo, griglia leggera, luce blu, linea che sale verso il punto verde.
function backdrop(w, h, { glowX = 0.78, glowY = 0.35, line = true, lineFrom = 0.45, lineTo = 0.97, grid = 64, lo = 0.86, hi = 0.24 } = {}) {
  const pts = [];
  const n = 9; const x0 = w * lineFrom, x1 = w * lineTo;
  const ys = [0.86, 0.80, 0.83, 0.70, 0.73, 0.58, 0.61, 0.42, 0.24];
  for (let i = 0; i < n; i++) pts.push([x0 + (x1 - x0) * i / (n - 1), h * (lo + (ys[i] - 0.86) / (0.24 - 0.86) * (hi - lo))]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const last = pts[n - 1]; const u = Math.min(w, h);
  const area = `${d} L${x1} ${h} L${x0} ${h} Z`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;inset:0">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.navy}"/><stop offset="1" stop-color="${C.deep}"/></linearGradient>
    <radialGradient id="glow" cx="${glowX}" cy="${glowY}" r="0.6" gradientTransform="translate(${glowX} ${glowY}) scale(${h / w > 1 ? 1 : h / w * 1.6} 1) translate(${-glowX} ${-glowY})"><stop offset="0" stop-color="${C.blue}" stop-opacity="0.42"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="${grid}" height="${grid}" patternUnits="userSpaceOnUse"><path d="M${grid} 0 L0 0 0 ${grid}" fill="none" stroke="#FFFFFF" stroke-opacity="0.05" stroke-width="1"/></pattern>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="1"/></linearGradient>
    <mask id="m"><rect width="${w}" height="${h}" fill="url(#fade)"/></mask>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.blue}" stop-opacity="0.22"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0"/></linearGradient>
    <linearGradient id="ln" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.blueL}" stop-opacity="0"/><stop offset="0.35" stop-color="${C.blueL}"/><stop offset="1" stop-color="${C.green}"/></linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  <rect width="${w}" height="${h}" fill="url(#grid)" mask="url(#m)"/>
  ${line ? `  <path d="${d}" fill="none" stroke="url(#ln)" stroke-width="${Math.max(3, u * 0.012)}" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${last[0]}" cy="${last[1]}" r="${u * 0.06}" fill="${C.green}" opacity="0.18"/>
  <circle cx="${last[0]}" cy="${last[1]}" r="${u * 0.028}" fill="${C.green}"/>` : ''}
</svg>`;
}
const logoInline = (fs, color = '#FFFFFF') => { const L = lockup(color, C.green, color, fs, 0, 0); return `<svg width="${Math.ceil(L.w)}" height="${Math.ceil(L.h + 2)}" viewBox="0 0 ${Math.ceil(L.w)} ${Math.ceil(L.h + 2)}" style="display:block;overflow:visible">${L.svg}</svg>`; };

const css = (s) => `<style>${fonts}${s}</style>`;
const T = { head: `font-family:Sora;font-weight:800;color:#fff;letter-spacing:-0.015em;line-height:1.05`, sub: `font-family:Inter;font-weight:500;color:#B9C5DA`, pill: `display:inline-flex;align-items:center;gap:.5em;font-family:Inter;font-weight:600;color:${C.navy};background:${C.green};border-radius:999px` };

const pages = [];
// Foto profilo (cerchio): simbolo al centro, dentro il cerchio con margine.
pages.push({ name: 'venturo-foto-profilo-navy.png', w: 1080, h: 1080, html: `${css('')}<div style="position:relative;width:1080px;height:1080px">${backdrop(1080, 1080, { line: false, glowX: .5, glowY: .45 })}<svg viewBox="0 0 1080 1080" width="1080" height="1080" style="position:absolute;inset:0">${symbol('#FFFFFF', C.green, 3.1, 540 - 105.5 * 3.1, 540 - 86 * 3.1)}</svg></div>` });
pages.push({ name: 'venturo-foto-profilo-chiara.png', w: 1080, h: 1080, html: `${css('')}<div style="position:relative;width:1080px;height:1080px;background:${C.paper}"><svg viewBox="0 0 1080 1080" width="1080" height="1080" style="position:absolute;inset:0">${symbol(C.navy, C.greenD, 3.1, 540 - 105.5 * 3.1, 540 - 86 * 3.1)}</svg></div>` });
// Loghi PNG (trasparenti e su fondo)
for (const [n, s] of Object.entries(files)) {
  const m = s.match(/width="(\d+)" height="(\d+)"/); const w = +m[1], h = +m[2];
  const scale = n.includes('simbolo') ? 1024 / w : 2400 / w;
  pages.push({ name: n.replace('.svg', '.png'), w: Math.round(w * scale), h: Math.round(h * scale), transparent: !/su-/.test(n), html: `${css('')}<img src="data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}" style="width:${Math.round(w * scale)}px;height:${Math.round(h * scale)}px;display:block">` });
}

// Copertina LinkedIn (profilo) 1584×396: la foto copre il basso a sinistra → testo a destra.
pages.push({ name: 'venturo-copertina-linkedin-profilo.png', w: 1584, h: 396, html: `${css('')}<div style="position:relative;width:1584px;height:396px;overflow:hidden">${backdrop(1584, 396, { lineFrom: .04, lineTo: .33, glowX: .3, glowY: .2, grid: 44 })}
<div style="position:absolute;left:640px;right:72px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:22px">
  ${logoInline(46)}
  <div style="${T.head};font-size:52px">Capitali, soci e opportunità<br>per chi fa <span style="color:${C.green}">impresa in Italia</span>.</div>
  <div style="${T.sub};font-size:22px;letter-spacing:.01em">Bandi e agevolazioni · Aziende in vendita · Soci · Numeri veri</div>
</div></div>` });
// Copertina pagina aziendale LinkedIn 1128×191: il logo della pagina copre il basso a sinistra.
pages.push({ name: 'venturo-copertina-linkedin-pagina.png', w: 1128, h: 191, html: `${css('')}<div style="position:relative;width:1128px;height:191px;overflow:hidden">${backdrop(1128, 191, { lineFrom: .02, lineTo: .29, glowX: .25, glowY: .1, grid: 32 })}
<div style="position:absolute;left:400px;right:48px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:12px">
  <div style="${T.head};font-size:31px">Capitali, soci e opportunità per chi fa <span style="color:${C.green}">impresa in Italia</span>.</div>
  <div style="${T.sub};font-size:15px">Bandi e agevolazioni · Aziende in vendita · Soci · Professionisti · Numeri veri</div>
</div></div>` });
// Copertina X 1500×500: foto profilo in basso a sinistra; sul telefono si tagliano alto e basso → centro verticale.
pages.push({ name: 'venturo-copertina-x.png', w: 1500, h: 500, html: `${css('')}<div style="position:relative;width:1500px;height:500px;overflow:hidden">${backdrop(1500, 500, { lineFrom: .03, lineTo: .32, glowX: .28, glowY: .25, grid: 50 })}
<div style="position:absolute;left:600px;right:80px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:24px">
  ${logoInline(50)}
  <div style="${T.head};font-size:56px">Capitali, soci e opportunità<br>per chi fa <span style="color:${C.green}">impresa in Italia</span>.</div>
  <div style="${T.sub};font-size:23px">Bandi · Aziende in vendita · Soci · Numeri veri, con le fonti</div>
</div></div>` });
// Copertina YouTube 2560×1440: tutto dentro l'area sicura 1546×423 al centro.
pages.push({ name: 'venturo-copertina-youtube.png', w: 2560, h: 1440, html: `${css('')}<div style="position:relative;width:2560px;height:1440px;overflow:hidden">${backdrop(2560, 1440, { lineFrom: .0, lineTo: .93, lo: .97, hi: .70, glowX: .5, glowY: .5, grid: 80 })}
<div style="position:absolute;left:507px;width:1546px;top:508px;height:423px;display:flex;align-items:center;gap:70px">
  <svg viewBox="0 0 200 200" width="300" height="300" style="flex:none">${symbol('#FFFFFF', C.green)}</svg>
  <div style="display:flex;flex-direction:column;gap:22px">
    <div style="${T.head};font-size:76px">Capitali, soci e opportunità<br>per chi fa <span style="color:${C.green}">impresa in Italia</span>.</div>
    <div style="${T.sub};font-size:32px">Bandi · Aziende in vendita · Casi studio · Numeri veri</div>
  </div>
</div></div>` });

// Copertine dei «In evidenza» di Instagram 1080×1920: icona al centro (si vede solo il cerchio centrale).
const icons = {
  bandi: `<path d="M-90 -130 H50 L110 -70 V130 H-90 Z" /><path d="M50 -130 V-70 H110"/><path d="M-45 -10 H65 M-45 40 H65 M-45 90 H25"/>`,
  numeri: `<path d="M-110 120 H120"/><path d="M-80 120 V40 M-20 120 V-10 M40 120 V20 M100 120 V-80"/>`,
  casi: `<rect x="-120" y="-60" width="240" height="180" rx="22"/><path d="M-45 -60 V-100 Q-45 -115 -30 -115 H30 Q45 -115 45 -100 V-60"/><path d="M-120 10 H120"/>`,
  newsletter: `<rect x="-125" y="-85" width="250" height="180" rx="22"/><path d="M-118 -72 L0 20 L118 -72"/>`,
  chisiamo: null,
};
const dots = { bandi: [110, -130], numeri: [100, -140], casi: [120, -95], newsletter: [125, -95] };
for (const [k, g] of Object.entries(icons)) {
  const inner = g
    ? `<g transform="translate(540 960) scale(1.55)" fill="none" stroke="#FFFFFF" stroke-width="24" stroke-linecap="round" stroke-linejoin="round">${g}</g><circle cx="${540 + dots[k][0] * 1.55}" cy="${960 + dots[k][1] * 1.55}" r="44" fill="${C.green}" stroke="#102A63" stroke-width="20"/>`
    : symbol('#FFFFFF', C.green, 2.4, 540 - 105.5 * 2.4, 960 - 86 * 2.4);
  pages.push({ name: `venturo-evidenza-${k}.png`, w: 1080, h: 1920, html: `${css('')}<div style="position:relative;width:1080px;height:1920px;overflow:hidden">${backdrop(1080, 1920, { line: false, glowX: .5, glowY: .5, grid: 72 })}<svg viewBox="0 0 1080 1920" width="1080" height="1920" style="position:absolute;inset:0">${inner}</svg></div>` });
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  for (const p of pages) {
    const pg = await b.newPage({ viewport: { width: p.w, height: p.h }, deviceScaleFactor: 1 });
    await pg.setContent(`<!doctype html><html><body>${p.html}</body></html>`, { waitUntil: 'load' });
    await pg.evaluate(() => document.fonts.ready);
    await pg.screenshot({ path: path.join(OUT, p.name), omitBackground: !!p.transparent, clip: { x: 0, y: 0, width: p.w, height: p.h } });
    await pg.close();
  }
  await b.close();
  console.log(pages.length, 'immagini');
})();
