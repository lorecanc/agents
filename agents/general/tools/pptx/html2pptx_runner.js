#!/usr/bin/env node
// html2pptx_runner — CLI wrapper to convert HTML slides to PPTX
// Usage: node html2pptx_runner.js --output out.pptx --layout LAYOUT_16x9_1280 [--tmp-dir /tmp] -- slide1.html slide2.html ...

const path = require('path');
const fs = require('fs');

// Layout name → PPTX dimensions (inches). Maps layout names to valid pptxgenjs
// dimensions via defineLayout() so custom names like LAYOUT_16x9_1280 work.
const LAYOUTS = {
  'LAYOUT_16x9_1280': { width: 13.333, height: 7.5 },
  'LAYOUT_16x9_1920': { width: 20.0,   height: 11.25 },
  'LAYOUT_16x9':      { width: 10.0,   height: 5.625 },
  'LAYOUT_4x3':       { width: 10.0,   height: 7.5 },
  'LAYOUT_16x10':     { width: 10.0,   height: 6.25 },
  'LAYOUT_WIDE':      { width: 13.333, height: 7.5 },
};

function parseArgs(argv) {
  const args = { layout: 'LAYOUT_16x9_1280', tmpDir: path.join(process.cwd(), '.tmp') };
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === '--output') { args.output = argv[++i]; }
    else if (argv[i] === '--layout') { args.layout = argv[++i]; }
    else if (argv[i] === '--tmp-dir') { args.tmpDir = argv[++i]; }
    else if (argv[i] === '--') { args.slides = argv.slice(i + 1); break; }
    else { args.slides = args.slides || []; args.slides.push(argv[i]); }
    i++;
  }
  return args;
}

function autoVersion(outputPath) {
  if (!fs.existsSync(outputPath)) return outputPath;
  const dir = path.dirname(outputPath);
  const ext = path.extname(outputPath);
  const stem = path.basename(outputPath, ext);
  let n = 2;
  while (true) {
    const candidate = path.join(dir, `${stem}_v${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    n++;
  }
}

async function run() {
  const args = parseArgs(process.argv);
  if (!args.output || !args.slides || args.slides.length === 0) {
    console.error('Usage: node html2pptx_runner.js --output out.pptx --layout LAYOUT_16x9_1280 [--tmp-dir /tmp] -- slide1.html ...');
    process.exit(1);
  }

  // Find html2pptx.js relative to the runner's location
  const html2pptxPath = path.resolve(__dirname, 'html2pptx.js');
  if (!fs.existsSync(html2pptxPath)) {
    console.error(`html2pptx.js not found at: ${html2pptxPath}`);
    process.exit(1);
  }

  // Resolve .opencode/ root (walks up from cwd, falls back to ~/.config/opencode/)
  let opencodeRoot = null;
  {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const c = path.join(dir, '.opencode');
      if (fs.existsSync(c)) { opencodeRoot = c; break; }
      const p = path.dirname(dir); if (p === dir) break; dir = p;
    }
    if (!opencodeRoot) {
      const home = path.join(require('os').homedir(), '.config', 'opencode');
      if (fs.existsSync(home)) opencodeRoot = home;
    }
  }

  // Resolve modules from the custom-implementations + .opencode directories
  const customDir = path.resolve(__dirname, '..', '..');
  const searchPaths = [customDir];
  if (opencodeRoot) searchPaths.push(opencodeRoot);

  let pptxgen, html2pptx;
  try {
    const pptxgenPath = require.resolve('pptxgenjs', { paths: searchPaths });
    pptxgen = require(pptxgenPath);
  } catch {
    pptxgen = require('pptxgenjs');
  }
  
  html2pptx = require(html2pptxPath);

  const pptx = new pptxgen();

  // Resolve layout: support custom names (LAYOUT_16x9_1280, LAYOUT_16x9_1920)
  const layoutDef = LAYOUTS[args.layout];
  if (layoutDef) {
    pptx.defineLayout({ name: args.layout, width: layoutDef.width, height: layoutDef.height });
    pptx.layout = args.layout;
  } else {
    // Fallback: try as a pptxgenjs built-in (LAYOUT_WIDE, LAYOUT_16x9, etc.)
    pptx.layout = args.layout;
  }

  // Convert slides
  let errorCount = 0;
  for (let i = 0; i < args.slides.length; i++) {
    const slidePath = path.resolve(args.slides[i]);
    if (!fs.existsSync(slidePath)) {
      console.error(`Slide not found: ${slidePath}`);
      process.exit(1);
    }
    try {
      process.stdout.write(`Converting slide ${i + 1}/${args.slides.length}: ${path.basename(slidePath)}... `);
      await html2pptx(slidePath, pptx, { tmpDir: args.tmpDir });
      process.stdout.write('✓\n');
    } catch (err) {
      errorCount++;
      process.stderr.write(`\nError converting ${path.basename(slidePath)}: ${err.message}\n`);
    }
  }

  if (errorCount > 0) {
    console.error(`\n${errorCount} slide(s) failed conversion.`);
    process.exit(1);
  }

  const outputPath = autoVersion(path.resolve(args.output));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await pptx.writeFile({ fileName: outputPath });

  // Save HTML snapshots
  const snapshotDir = outputPath + '.slides';
  fs.mkdirSync(snapshotDir, { recursive: true });
  for (let i = 0; i < args.slides.length; i++) {
    const src = path.resolve(args.slides[i]);
    const dest = path.join(snapshotDir, `${i + 1}.html`);
    fs.copyFileSync(src, dest);
  }

  console.log(`\nPresentation saved to: ${outputPath}`);
  console.log(`Snapshot saved to: ${snapshotDir}`);
  console.log(`Converted ${args.slides.length} slide(s)`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
