import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = fileURLToPath(new URL('../site', import.meta.url));
if (!fs.existsSync(siteDir)) {
  console.error(`Error: site directory not found at ${siteDir}`);
  process.exit(1);
}

const htmlFiles = fs.readdirSync(siteDir)
  .filter(file => file.endsWith('.html'))
  .map(file => path.join(siteDir, file));

const errors = [];
const idCache = new Map();

function getIds(filePath) {
  if (!idCache.has(filePath)) {
    const ids = new Set();
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const idRegex = /\bid=["']([^"']+)["']/gi;
      let match;
      while ((match = idRegex.exec(content)) !== null) {
        ids.add(match[1]);
      }
    }
    idCache.set(filePath, ids);
  }
  return idCache.get(filePath);
}

function getAttr(tagStr, name) {
  const match = tagStr.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'));
  return match ? match[1] : null;
}

const tagRegex = /<([a-zA-Z0-9-]+)\b([^>]*)>/g;

for (const htmlFile of htmlFiles) {
  const relFile = path.relative(process.cwd(), htmlFile).replace(/\\/g, '/');
  const content = fs.readFileSync(htmlFile, 'utf-8');
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrs = match[2];

    const src = getAttr(attrs, 'src');
    const href = getAttr(attrs, 'href');
    const rel = getAttr(attrs, 'rel') || '';

    // Check external script, stylesheet, or img
    if (tagName === 'script' && src && /^(https?:)?\/\//i.test(src)) {
      errors.push(`${relFile}: external <script src="${src}"> is not allowed`);
    }
    if (tagName === 'link' && /stylesheet/i.test(rel) && href && /^(https?:)?\/\//i.test(href)) {
      errors.push(`${relFile}: external <link rel="stylesheet" href="${href}"> is not allowed`);
    }
    if (tagName === 'img' && src && /^(https?:)?\/\//i.test(src)) {
      errors.push(`${relFile}: external <img src="${src}"> is not allowed`);
    }

    const targets = [];
    if (src !== null) targets.push({ attr: 'src', val: src });
    if (href !== null) targets.push({ attr: 'href', val: href });

    for (const { attr, val } of targets) {
      if (!val) continue;

      // Check for ../
      if (val.includes('../')) {
        errors.push(`${relFile}: path contains "../" in ${attr}="${val}"`);
      }

      // Skip external links or inline/blob data schemes in <a> or resource tags
      if (/^(https?:|mailto:|tel:|javascript:|data:|blob:)/i.test(val)) {
        continue;
      }

      // Local link / resource check
      const [rawPath, fragment] = val.split('#');
      let targetFile = htmlFile;

      if (rawPath) {
        targetFile = path.resolve(path.dirname(htmlFile), rawPath);
        if (!fs.existsSync(targetFile)) {
          errors.push(`${relFile}: local ${attr}="${val}" does not resolve to an existing file`);
          continue;
        }
      }

      // Check fragment
      if (fragment !== undefined && fragment !== '') {
        if (targetFile.endsWith('.html')) {
          const ids = getIds(targetFile);
          if (!ids.has(fragment)) {
            const targetRel = path.relative(process.cwd(), targetFile).replace(/\\/g, '/');
            errors.push(`${relFile}: #${fragment} has no matching id on target page "${targetRel}" in ${attr}="${val}"`);
          }
        }
      }
    }
  }
}

const cssFiles = fs.readdirSync(siteDir)
  .filter(file => file.endsWith('.css'))
  .map(file => path.join(siteDir, file));

for (const cssFile of cssFiles) {
  const relFile = path.relative(process.cwd(), cssFile).replace(/\\/g, '/');
  const content = fs.readFileSync(cssFile, 'utf-8');

  // Match third-party @import (e.g. @import url('https://...'), @import 'http://...', etc.)
  const importRegex = /@import\s+(?:url\s*\(\s*['"]?|['"])(?:https?:)?\/\/[^'")]+['"]?\s*\)?/gi;
  let importMatch;
  while ((importMatch = importRegex.exec(content)) !== null) {
    errors.push(`${relFile}: external @import "${importMatch[0]}" is not allowed`);
  }

  // Match external url(http...) or url(//...)
  const urlRegex = /url\s*\(\s*['"]?(?:https?:)?\/\/[^'")]+['"]?\s*\)/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(content)) !== null) {
    errors.push(`${relFile}: external url "${urlMatch[0]}" is not allowed`);
  }
}

const INSTALLER_URL = 'https://github.com/samirsawarkar/uniview/releases/download/v1.0.0/UniView-Setup-1.0.0.exe';

// Deploy-blocking content checks
for (const htmlFile of htmlFiles) {
  const relFile = path.relative(process.cwd(), htmlFile).replace(/\\/g, '/');
  const content = fs.readFileSync(htmlFile, 'utf-8');
  if (/devices\.png/i.test(content)) {
    errors.push(`${relFile}: references the removed devices.png`);
  }
  if (/not published yet/i.test(content)) {
    errors.push(`${relFile}: contains "not published yet"`);
  }
}
const indexFile = path.join(siteDir, 'index.html');
if (!fs.readFileSync(indexFile, 'utf-8').includes(INSTALLER_URL)) {
  errors.push('site/index.html: missing the exact installer URL');
}

if (errors.length > 0) {
  console.error(`check-site failed with ${errors.length} error(s):`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
} else {
  console.log(`check-site passed: all links and resources in ${htmlFiles.length} HTML files are valid.`);
  process.exit(0);
}
