'use strict';
// Render every ```mermaid block in AI_PLANNER_FLOWS.md to a 2x PNG in the
// LaunchDarkly dark-mode palette. Run from the repo root:
//   node scripts/render-ai-planner-flows.js
// Diagram 0 is skipped: public/images/ai-planner/big-picture.svg is the hand-designed export.
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join(process.cwd(), 'node_modules', 'playwright'));

const MD = path.join(process.cwd(), 'AI_PLANNER_FLOWS.md');
const OUT_DIR = path.join(process.cwd(), 'public', 'images', 'ai-planner');

// LaunchDarkly brand palette (internal brand guidelines): dark-mode base with
// LD Main Blue / Powder Blue and bright accents.
const THEME = {
  theme: 'base',
  themeVariables: {
    darkMode: true,
    background: '#191919',
    fontFamily: 'Inter, -apple-system, Helvetica, Arial, sans-serif',
    fontSize: '16px',
    primaryColor: '#282828',
    primaryTextColor: '#F8F8F8',
    primaryBorderColor: '#405BFF',
    secondaryColor: '#212121',
    secondaryTextColor: '#F8F8F8',
    secondaryBorderColor: '#7084FF',
    tertiaryColor: '#1F1F1F',
    tertiaryTextColor: '#F8F8F8',
    tertiaryBorderColor: '#414042',
    lineColor: '#D1D3D4',
    textColor: '#F8F8F8',
    mainBkg: '#282828',
    nodeBorder: '#405BFF',
    clusterBkg: '#1F1F1F',
    clusterBorder: '#414042',
    titleColor: '#F8F8F8',
    edgeLabelBackground: '#191919',
    // sequence diagrams
    actorBkg: '#282828',
    actorBorder: '#405BFF',
    actorTextColor: '#F8F8F8',
    actorLineColor: '#414042',
    signalColor: '#F8F8F8',
    signalTextColor: '#F8F8F8',
    labelBoxBkgColor: '#282828',
    labelBoxBorderColor: '#405BFF',
    labelTextColor: '#F8F8F8',
    loopTextColor: '#F8F8F8',
    noteBkgColor: '#2A2A40',
    noteBorderColor: '#7084FF',
    noteTextColor: '#F8F8F8',
    activationBkgColor: '#405BFF',
    activationBorderColor: '#7084FF',
    sequenceNumberColor: '#191919',
  },
  flowchart: { htmlLabels: true, curve: 'basis', padding: 16, nodeSpacing: 40, rankSpacing: 56 },
  sequence: { actorMargin: 36, messageMargin: 44, mirrorActors: false, width: 170 },
};

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function extract(md) {
  const out = [];
  const re = /## (\d+)\. ([^\n]+)\n[\s\S]*?```mermaid\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    out.push({ index: Number(m[1]), title: m[2].trim(), code: m[3] });
  }
  return out;
}

(async () => {
  const md = fs.readFileSync(MD, 'utf8');
  const diagrams = extract(md);
  if (!diagrams.length) throw new Error('no mermaid blocks found');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>
      html,body{margin:0;background:#191919;font-family:Inter,-apple-system,Helvetica,Arial,sans-serif}
      #frame{display:inline-block;background:#191919;padding:40px 48px 36px;min-width:900px}
      #title{color:#F8F8F8;font-size:26px;font-weight:800;margin:0 0 6px}
      #bar{width:180px;height:4px;border-radius:2px;background:linear-gradient(90deg,#7084FF,#405BFF);margin:0 0 28px}
      #host svg{display:block;max-width:none}
      #host .edgeLabel, #host .edgeLabel p, #host .edgeLabel span{background:#191919 !important;color:#D1D3D4 !important}
      #host .cluster-label, #host .cluster-label p{color:#7084FF !important}
      #host .node .label, #host .nodeLabel{color:#F8F8F8 !important}
      #host .messageText, #host text.actor{fill:#F8F8F8 !important}
      #foot{color:#6D6E71;font-size:12px;text-align:right;margin-top:22px}
    </style></head>
    <body><div id="frame"><h1 id="title"></h1><div id="bar"></div><div id="host"></div><div id="foot">Toggle Travel · LaunchDarkly AI Configs demo</div></div>
    <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
      window.mermaid = mermaid;
      mermaid.initialize(Object.assign({ startOnLoad: false, securityLevel: 'loose' }, ${JSON.stringify(THEME)}));
      window.__ready = true;
    </script></body></html>`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => document.fonts.ready);

  const results = [];
  for (const d of diagrams.filter((x) => x.index !== 0)) {
    const file = `flow-${d.index}-${slugify(d.title)}.png`;
    const outPath = path.join(OUT_DIR, file);
    const ok = await page.evaluate(async ({ code, title, id }) => {
      document.getElementById('title').textContent = title;
      const host = document.getElementById('host');
      host.innerHTML = '';
      try {
        const { svg } = await window.mermaid.render('m' + id, code);
        host.innerHTML = svg;
        // Let the SVG size itself; drop the responsive max-width Mermaid adds.
        const el = host.querySelector('svg');
        el.style.maxWidth = 'none';
        const vb = el.getAttribute('viewBox');
        if (vb) {
          const [, , w, h] = vb.split(/\s+/).map(Number);
          const scale = w < 1100 ? 1100 / w : 1;
          el.setAttribute('width', Math.round(w * scale));
          el.setAttribute('height', Math.round(h * scale));
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, { code: d.code, title: `${d.index}. ${d.title}`, id: d.index });
    if (!ok.ok) { results.push({ file, error: ok.error }); continue; }
    await page.waitForTimeout(150);
    await page.locator('#frame').screenshot({ path: outPath });
    const kb = Math.round(fs.statSync(outPath).size / 1024);
    results.push({ file, kb });
  }
  await browser.close();
  for (const r of results) console.log(r.error ? `ERROR ${r.file}: ${r.error}` : `wrote ${r.file} (${r.kb} KB)`);
  if (results.some((r) => r.error)) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
