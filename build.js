#!/usr/bin/env node
// Concatenation build: reads fabled_lands_character_sheet.src.html (the
// editable source template) plus the vendored libraries and the
// dice-physics module, and writes fabled_lands_character_sheet.html — the
// single self-contained file that actually ships. No bundler, no
// transpilation — just string
// concatenation, so the output stays inspectable and the runtime behavior
// stays exactly "plain script tags in a browser."
//
// Why the vendor libraries get rewritten instead of loaded as native ES
// modules: keeping everything in ONE classic <script> block (matching this
// project's existing single-script architecture, see CLAUDE.md) avoids
// needing an <script type="importmap"> or type="module" at runtime, which
// would either require network access (CDN) or awkward blob-URL tricks to
// resolve bare "three"/"cannon-es" specifiers from inlined code. Instead,
// each vendor file's own module syntax (it only has a single trailing
// `export{...}` — these are pre-bundled, self-contained builds with no
// imports of their own) is mechanically rewritten into an IIFE that returns
// the same public API as a plain object, assigned to a const named THREE or
// CANNON — exactly what a classic script needs, and exactly the names
// src/dice-physics.js already expects in scope.

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC_HTML = path.join(ROOT, "fabled_lands_character_sheet.src.html");
const OUT_HTML = path.join(ROOT, "fabled_lands_character_sheet.html");

function wrapVendorModuleAsIIFE(code, constName) {
  // Strip a trailing sourcemap comment, if any, so the export{...} statement
  // is safely anchorable at the end of the remaining source.
  code = code.replace(/\/\/#\s*sourceMappingURL=.*$/m, "").trimEnd();
  const match = code.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!match) {
    throw new Error(`Could not find a trailing export{...} statement in the ${constName} vendor file — is it still a single pre-bundled ES module?`);
  }
  const exportList = match[1];
  const body = code.slice(0, match.index);
  const converted = exportList
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const asMatch = entry.match(/^(\S+)\s+as\s+(\S+)$/);
      return asMatch ? `${asMatch[2]}: ${asMatch[1]}` : entry;
    })
    .join(", ");
  return `const ${constName} = (function(){\n${body}\nreturn { ${converted} };\n})();`;
}

function wrapDiceModule(code) {
  let body = code.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
  body = body.replace(/^\s*import\s+\*\s+as\s+CANNON\s+from\s+["']cannon-es["'];?\s*$/m, "");
  const match = body.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!match) throw new Error("Could not find a trailing export{...} statement in src/dice-physics.js");
  const exportList = match[1];
  const rest = body.slice(0, match.index);
  const converted = exportList
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      const asMatch = entry.match(/^(\S+)\s+as\s+(\S+)$/);
      return asMatch ? `${asMatch[2]}: ${asMatch[1]}` : entry;
    })
    .join(", ");
  return `${rest}\nwindow.DicePhysicsModule = { ${converted} };`;
}

function readVendor(name) {
  return fs.readFileSync(path.join(ROOT, "vendor", name), "utf8");
}

// Unlike three.module.min.js/cannon-es.min.js, Cytoscape.js's own dist build
// (dist/cytoscape.min.js from the `cytoscape` npm package) is a UMD bundle
// that already self-registers `window.cytoscape` when loaded as a plain
// classic <script> (its UMD header falls through to the
// `(this||self).cytoscape = factory()` branch when neither `module.exports`
// nor AMD `define` is in scope). So it needs no export-rewrite IIFE
// treatment at all -- it's inlined verbatim, unlike wrapVendorModuleAsIIFE().

function build() {
  if (!fs.existsSync(SRC_HTML)) {
    throw new Error(`${SRC_HTML} not found — this build reads the .src.html template, not fabled_lands_character_sheet.html directly.`);
  }
  let html = fs.readFileSync(SRC_HTML, "utf8");

  const threeIIFE = wrapVendorModuleAsIIFE(readVendor("three.module.min.js"), "THREE");
  const cannonIIFE = wrapVendorModuleAsIIFE(readVendor("cannon-es.min.js"), "CANNON");
  const diceModule = wrapDiceModule(fs.readFileSync(path.join(ROOT, "src", "dice-physics.js"), "utf8"));

  const cytoscapeVerbatim = readVendor("cytoscape.min.js");

  const injections = {
    "<!-- BUILD:VENDOR three.module.min.js -->": threeIIFE,
    "<!-- BUILD:VENDOR cannon-es.min.js -->": cannonIIFE,
    "<!-- BUILD:MODULE src/dice-physics.js -->": diceModule,
    "<!-- BUILD:VENDOR-VERBATIM cytoscape.min.js -->": cytoscapeVerbatim,
  };

  let missing = [];
  for (const [marker, content] of Object.entries(injections)) {
    if (!html.includes(marker)) { missing.push(marker); continue; }
    html = html.replace(marker, () => content);
  }
  if (missing.length) {
    throw new Error(`Missing marker(s) in ${path.basename(SRC_HTML)}: ${missing.join(", ")}`);
  }

  const banner = `<!-- GENERATED FILE — do not edit directly. Edit fabled_lands_character_sheet.src.html and/or src/dice-physics.js, then run \`node build.js\`. -->\n`;
  html = banner + html;

  fs.writeFileSync(OUT_HTML, html);
  console.log(`Built ${path.relative(ROOT, OUT_HTML)} (${(html.length / 1024).toFixed(0)} KB) from ${path.basename(SRC_HTML)} + vendor + src/dice-physics.js`);
}

build();
