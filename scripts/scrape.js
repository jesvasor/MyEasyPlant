#!/usr/bin/env node
/**
 * MyEasyPlant scraper — fetches an easyplant.com product page and saves
 * everything the dashboard needs locally, so the record survives even after
 * easyplant removes the product URL.
 *
 * Usage:
 *   node scripts/scrape.js <easyplant-product-url> [--last-watered YYYY-MM-DD]
 *
 * Writes/updates data/plants.json and downloads the exact configured product
 * image (pot + color from the URL query params) to data/images/<id>.jpg.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'plants.json');
const IMAGES_DIR = path.join(ROOT, 'data', 'images');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { url: null, lastWatered: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--last-watered') args.lastWatered = argv[++i];
    else if (!args.url) args.url = argv[i];
  }
  if (!args.url) fail('usage: node scripts/scrape.js <url> [--last-watered YYYY-MM-DD]');
  let u;
  try {
    u = new URL(args.url);
  } catch {
    fail('not a valid URL: ' + args.url);
  }
  if (u.hostname !== 'easyplant.com' && u.hostname !== 'www.easyplant.com')
    fail('only easyplant.com product URLs are supported, got host: ' + u.hostname);
  if (args.lastWatered && !/^\d{4}-\d{2}-\d{2}$/.test(args.lastWatered))
    fail('--last-watered must be YYYY-MM-DD, got: ' + args.lastWatered);
  return args;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// "1 Month" / "2 Months" / "every 3 months" -> 1 / 2 / 3
function parseWaterMonths(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
  });
  if (!res.ok) fail(`fetch ${url} -> HTTP ${res.status}`);
  return res.text();
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) fail('no __NEXT_DATA__ found — page layout may have changed, or the URL is not a product page');
  return JSON.parse(m[1]);
}

function extractJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      /* ignore malformed blocks */
    }
  }
  return out;
}

// The "<Name> at a Glance" collapse section, tag-stripped. Class names on the
// page are hashed/unstable, so anchor on the heading text instead.
function extractGlanceText(html) {
  const start = html.search(/at a Glance<\/h\d>/i);
  if (start < 0) return null;
  let end = html.indexOf('you-might-also-like', start);
  if (end < 0) end = start + 20000;
  const text = stripTags(html.slice(start, end));
  // Drop the heading itself ("Marxii Calathea at a Glance ...")
  return text.replace(/^.*?at a Glance\s*/i, '').slice(0, 3000) || null;
}

function loadStore() {
  if (!fs.existsSync(DATA_FILE))
    return { settings: { reminderEveryDays: 3, lastReminderSent: null }, plants: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function uniqueId(store, base) {
  let id = base;
  let n = 2;
  while (store.plants.some((p) => p.id === id)) id = `${base}-${n++}`;
  return id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('Fetching', args.url);
  const html = await fetchText(args.url);

  const next = extractNextData(html);
  const pp = next?.props?.pageProps;
  if (!pp?.plantData) fail('page has no plantData — is this a product page?');

  const plantData = pp.plantData; // light, waterPeriod, care, faq, areaOfGrowth
  const seo = pp.productSEOData?.data || {};
  const model = seo.plant?.value?.data || {}; // full care model

  const ld = extractJsonLd(html);
  const product = ld.find((j) => j['@type'] === 'Product') || {};

  const urlObj = new URL(args.url);
  const pot = urlObj.searchParams.get('pot') || null;
  const potColor = urlObj.searchParams.get('variant') || null;

  const name = product.name || model.plantName || seo.name || pp.productHandle;
  const sizeMatch = (seo.name || pp.productHandle || '').match(/small|medium|large|huge/i);
  const size = sizeMatch ? sizeMatch[0][0].toUpperCase() + sizeMatch[0].slice(1).toLowerCase() : null;

  const waterPeriod = plantData.waterPeriod || model.water?.periodicity || null;
  const waterEveryMonths = parseWaterMonths(waterPeriod);
  if (!waterEveryMonths)
    console.warn('WARNING: could not parse watering period from', JSON.stringify(waterPeriod));

  const store = loadStore();
  const skuBase = (product.sku || pp.productHandle || 'plant')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const id = uniqueId(store, 'plt-' + skuBase);

  // Image: the JSON-LD image is the exact configured pot+color photo.
  let imagePath = null;
  const imageUrl = product.image || model.mainImage || null;
  if (imageUrl) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    const sized = imageUrl + (imageUrl.includes('?') ? '&' : '?') + 'width=900';
    console.log('Downloading image', sized);
    const res = await fetch(sized, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      imagePath = `data/images/${id}.jpg`;
      fs.writeFileSync(path.join(ROOT, imagePath), buf);
      console.log(`Saved image (${(buf.length / 1024).toFixed(0)} KB) -> ${imagePath}`);
    } else {
      console.warn('WARNING: image download failed, HTTP', res.status);
    }
  }

  const record = {
    id,
    name,
    size,
    pot,
    potColor,
    sku: product.sku || null,
    price: product.offers?.[0]?.price ? Number(product.offers[0].price) : null,
    url: args.url,
    image: imagePath,
    waterPeriod,
    waterEveryMonths,
    lastWatered: args.lastWatered || todayISO(),
    addedAt: todayISO(),
    care: {
      light: plantData.light || model.light || null, // { title, text, traits: [{trait}] }
      water: model.water || null, // { title, text, text2, periodicity }
      careText: plantData.care?.text || model.care?.text || null,
      humidity: model.humidity || null,
      growth: model.growth || null,
      growthPotential: seo.growthPotential || null,
      toxicity: model.toxicity || null,
      petFriendly: />\s*Pet Friendly\s*</i.test(html),
      troubleshooting: model.troubleshooting || null,
      bloomingSeason: model.bloomingSeason || null,
      about: model.about || null, // { title, text, areaOfGrowth, commonNames }
      areaOfGrowth: plantData.areaOfGrowth || model.about?.areaOfGrowth || null,
      glanceText: null, // filled below
      height: null,
      faq: plantData.faq || model.faq || [],
    },
  };

  record.care.glanceText = extractGlanceText(html);
  if (record.care.glanceText) {
    const h = record.care.glanceText.match(/(\S+\s*-\s*\S+\s+tall \(including pot\))/);
    record.care.height = h ? h[1] : null;
  }

  store.plants.push(record);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2) + '\n');

  console.log('\nAdded plant:');
  console.log(`  ${name}${size ? ' (' + size + ')' : ''}${pot ? ' — ' + pot : ''}${potColor ? ' / ' + potColor : ''}`);
  console.log(`  water every ${waterEveryMonths} month(s), last watered ${record.lastWatered}`);
  console.log(`  id: ${id}`);
}

main().catch((e) => fail(e.stack || e.message));
