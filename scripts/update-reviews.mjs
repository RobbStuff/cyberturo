#!/usr/bin/env node
/**
 * Monthly refresh of reviews.json (and extras.json) from public Turo pages.
 * Node 20+, zero dependencies. Read-only fetches only — never logs in or posts.
 *
 * If fetches fail or return nothing useful, keep existing JSON files and exit 0
 * with a warning so good data is never wiped.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOST_ID = '16034992';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

/** Card display order → listing id + custom name + model line */
const FLEET = [
  { listingId: '2587824', name: 'Merlin', model: '2024 Tesla Cybertruck' },
  { listingId: '2740306', name: 'Maverick', model: '2024 Tesla Cybertruck' },
  { listingId: '3307368', name: 'Casper', model: '2026 Tesla Model Y' },
  { listingId: '3307383', name: 'Storm', model: '2026 Tesla Model Y' },
  { listingId: '3307398', name: 'Ruby', model: '2026 Tesla Model Y' },
  { listingId: '3307415', name: 'Rooster', model: '2026 Tesla Model Y' },
  { listingId: '3506536', name: 'Frosty', model: '2026 Tesla Model Y' },
  { listingId: '3531702', name: 'Goose', model: '2026 Tesla Model Y' },
  { listingId: '3563398', name: 'Blaze', model: '2026 Tesla Model Y' },
  { listingId: '3595182', name: 'Yeti', model: '2026 Tesla Model Y' },
  { listingId: '3619928', name: 'Bandit', model: '2026 Tesla Model Y' },
  { listingId: '3943006', name: 'Cosmo', model: '2027 Tesla Model Y' },
  { listingId: '3959789', name: 'Bubba', model: '2027 Tesla Model Y' },
];

const NAME_BY_ID = Object.fromEntries(FLEET.map((v) => [v.listingId, v.name]));

function emptyExtrasDoc() {
  return {
    placeholder: true,
    message: 'Extras list coming soon',
    note: null,
    updatedAt: null,
    vehicles: FLEET.map((v) => ({
      listingId: v.listingId,
      name: v.name,
      model: v.model,
      photo: `images/${v.listingId}_1.jpg`,
      extras: [],
      extrasNote: null,
    })),
  };
}

function warn(msg) {
  console.warn(`[update-reviews] WARNING: ${msg}`);
}

function info(msg) {
  console.log(`[update-reviews] ${msg}`);
}

function readJsonSafe(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const text = await res.text();
  const blocked =
    res.status === 403 ||
    /waf-block|Access Denied|cf-browser-verification|captcha/i.test(text.slice(0, 2000));
  return { ok: res.ok && !blocked, status: res.status, url, text, blocked };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Pull possible review-like objects from arbitrary JSON / embedded HTML. */
function walkCollect(node, acc, listingHint) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkCollect(item, acc, listingHint);
    return;
  }
  const rating = Number(node.rating ?? node.stars ?? node.starRating ?? node.overallRating);
  const text =
    node.text ??
    node.review ??
    node.comment ??
    node.body ??
    node.message ??
    node.feedback;
  const date = node.date ?? node.createdAt ?? node.created ?? node.publishedAt ?? node.timestamp;
  const author =
    node.author ??
    node.reviewerFirstName ??
    node.firstName ??
    node.reviewer?.firstName ??
    node.renter?.firstName ??
    node.guest?.firstName ??
    node.authorName;
  const listingId = String(
    node.listingId ??
      node.vehicleId ??
      node.vehicle?.id ??
      node.listing?.id ??
      listingHint ??
      '',
  );
  if (text && Number.isFinite(rating)) {
    acc.push({
      listingId,
      reviewerFirstName: author ? String(author).split(/\s+/)[0] : 'Guest',
      date: date ? String(date) : '',
      rating,
      text: String(text).trim(),
      vehicleName: NAME_BY_ID[listingId] || undefined,
    });
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') walkCollect(v, acc, listingHint);
  }
}

function extractEmbeddedJson(html) {
  const blobs = [];
  const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (next) blobs.push(tryParseJson(next[1]));
  const ld = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ld) blobs.push(tryParseJson(m[1]));
  return blobs.filter(Boolean);
}

function normalizeReviews(raw) {
  const byKey = new Map();
  for (const r of raw) {
    if (Number(r.rating) !== 5) continue;
    if (!r.text) continue;
    const id = String(r.listingId || '');
    const key = `${id}|${r.date}|${r.reviewerFirstName}|${r.text}`;
    byKey.set(key, {
      listingId: id,
      reviewerFirstName: r.reviewerFirstName || 'Guest',
      date: r.date || '',
      rating: 5,
      text: r.text,
      vehicleName: NAME_BY_ID[id] || r.vehicleName || undefined,
      photo: id ? `images/${id}_1.jpg` : undefined,
    });
  }
  return [...byKey.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function extractExtrasFromPayload(node, listingId, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) extractExtrasFromPayload(item, listingId, acc);
    return;
  }
  const name = node.name ?? node.title ?? node.extraName ?? node.label;
  const price = node.price ?? node.amount ?? node.fee ?? node.cost ?? node.pricePerUnit;
  const unitRaw = String(node.unit ?? node.priceType ?? node.billing ?? node.frequency ?? '').toLowerCase();
  const description = node.description ?? node.details ?? node.subtitle ?? '';
  const looksLikeExtra =
    name &&
    (price != null || node.isExtra || node.type === 'EXTRA' || node.category === 'extra' || node.extraId);
  if (looksLikeExtra) {
    let unit = 'per trip';
    if (/day|daily/.test(unitRaw)) unit = 'per day';
    if (/trip|rental|booking/.test(unitRaw)) unit = 'per trip';
    const key = String(name).trim().toLowerCase();
    if (!acc.has(key)) {
      acc.set(key, {
        name: String(name).trim(),
        price: typeof price === 'number' ? price : Number(String(price).replace(/[^0-9.]/g, '')) || null,
        unit,
        description: String(description || '').trim(),
        listingIds: new Set(),
      });
    }
    const row = acc.get(key);
    row.listingIds.add(String(listingId));
    if (!row.description && description) row.description = String(description).trim();
    if (row.price == null && price != null) {
      row.price = typeof price === 'number' ? price : Number(String(price).replace(/[^0-9.]/g, '')) || null;
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (/extra/i.test(k) && v && typeof v === 'object') extractExtrasFromPayload(v, listingId, acc);
    else if (v && typeof v === 'object') extractExtrasFromPayload(v, listingId, acc);
  }
}

async function fetchReviews() {
  const found = [];
  const urls = [
    `https://turo.com/us/en/drivers/${HOST_ID}`,
    `https://turo.com/host/${HOST_ID}`,
    `https://turo.com/api/drivers/${HOST_ID}/reviews`,
    `https://turo.com/api/driver/${HOST_ID}/reviews`,
  ];
  for (const v of FLEET) {
    urls.push(
      `https://turo.com/api/vehicle/${v.listingId}/reviews`,
      `https://turo.com/api/vehicles/${v.listingId}/reviews`,
      `https://turo.com/us/en/car-rental/vehicle/${v.listingId}`,
    );
  }

  let anyOk = false;
  for (const url of urls) {
    try {
      const res = await fetchText(url);
      if (!res.ok) {
        warn(`fetch failed ${res.status}${res.blocked ? ' (blocked)' : ''}: ${url}`);
        continue;
      }
      anyOk = true;
      const asJson = tryParseJson(res.text);
      if (asJson) {
        const listingHint = (url.match(/vehicle\/(\d+)/) || [])[1] || '';
        walkCollect(asJson, found, listingHint);
      } else {
        for (const blob of extractEmbeddedJson(res.text)) {
          const listingHint = (url.match(/vehicle\/(\d+)/) || [])[1] || '';
          walkCollect(blob, found, listingHint);
        }
      }
    } catch (err) {
      warn(`error fetching ${url}: ${err.message}`);
    }
  }
  return { anyOk, reviews: normalizeReviews(found) };
}

async function fetchExtras() {
  /** @type {Map<string, Map<string, {name:string,price:any,unit:string,description:string}>>} */
  const byListing = new Map(FLEET.map((v) => [v.listingId, new Map()]));
  let anyOk = false;

  for (const v of FLEET) {
    const urls = [
      `https://turo.com/api/vehicle/${v.listingId}`,
      `https://turo.com/api/vehicles/${v.listingId}`,
      `https://turo.com/us/en/suv-rental/united-states/melbourne-fl/tesla/model-y/${v.listingId}`,
      `https://turo.com/us/en/truck-rental/united-states/melbourne-fl/tesla/cybertruck/${v.listingId}`,
    ];
    const bag = new Map();
    for (const url of urls) {
      try {
        const res = await fetchText(url);
        if (!res.ok) {
          warn(`extras fetch failed ${res.status}${res.blocked ? ' (blocked)' : ''}: ${url}`);
          continue;
        }
        anyOk = true;
        const asJson = tryParseJson(res.text);
        if (asJson) extractExtrasFromPayload(asJson, v.listingId, bag);
        for (const blob of extractEmbeddedJson(res.text)) {
          extractExtrasFromPayload(blob, v.listingId, bag);
        }
      } catch (err) {
        warn(`extras error ${url}: ${err.message}`);
      }
    }
    // bag values use listingIds Sets from extractExtrasFromPayload
    for (const [key, e] of bag) {
      byListing.get(v.listingId).set(key, {
        name: e.name,
        price: e.price,
        unit: e.unit,
        description: e.description,
      });
    }
  }

  // Detect fleet-wide identical lists
  const perCar = FLEET.map((v) => {
    const extras = [...(byListing.get(v.listingId)?.values() || [])];
    return {
      listingId: v.listingId,
      name: v.name,
      model: v.model,
      photo: `images/${v.listingId}_1.jpg`,
      extras,
      extrasNote: null,
    };
  });

  const withExtras = perCar.filter((v) => v.extras.length);
  if (withExtras.length >= 2) {
    const sig = (list) =>
      JSON.stringify(list.map((e) => [e.name, e.price, e.unit]).sort());
    const firstSig = sig(withExtras[0].extras);
    const allSame = withExtras.every((v) => sig(v.extras) === firstSig);
    if (allSame && withExtras.length === FLEET.length) {
      for (const v of perCar) {
        v.extrasNote = 'Fleet-wide extras; confirm on Turo';
      }
    } else if (allSame && withExtras.length < FLEET.length) {
      const shared = withExtras[0].extras;
      for (const v of perCar) {
        if (!v.extras.length) {
          v.extras = shared.map((e) => ({ ...e }));
          v.extrasNote = 'Fleet-wide extras; confirm on Turo';
        }
      }
    }
  }

  const total = perCar.reduce((n, v) => n + v.extras.length, 0);
  return {
    anyOk,
    doc: {
      placeholder: total === 0,
      message: total === 0 ? 'Extras list coming soon' : null,
      note: null,
      updatedAt: total ? new Date().toISOString() : null,
      vehicles: perCar,
    },
    total,
  };
}

function maybeWrite(path, next, label) {
  const prev = readJsonSafe(path, null);
  const nextStr = `${JSON.stringify(next, null, 2)}\n`;
  const prevStr = prev == null ? null : `${JSON.stringify(prev, null, 2)}\n`;
  if (prevStr === nextStr) {
    info(`${label}: unchanged`);
    return false;
  }
  writeJson(path, next);
  info(`${label}: wrote ${Array.isArray(next) ? next.length : 'object'} → ${path}`);
  return true;
}

async function main() {
  const reviewsPath = join(ROOT, 'reviews.json');
  const extrasPath = join(ROOT, 'extras.json');
  mkdirSync(ROOT, { recursive: true });

  const existingReviews = readJsonSafe(reviewsPath, []);
  const existingExtras = readJsonSafe(extrasPath, emptyExtrasDoc());

  info('Fetching public Turo reviews (read-only)…');
  const { anyOk: reviewsOk, reviews } = await fetchReviews();
  if (!reviewsOk || reviews.length === 0) {
    warn(
      reviewsOk
        ? 'No 5-star reviews parsed; keeping existing reviews.json'
        : 'Could not reach public Turo review data; keeping existing reviews.json',
    );
  } else {
    maybeWrite(reviewsPath, reviews, 'reviews.json');
  }

  info('Fetching public Turo extras (read-only)…');
  const { anyOk: extrasOk, doc: extrasDoc, total: extrasTotal } = await fetchExtras();
  if (!extrasOk || extrasTotal === 0) {
    warn(
      extrasOk
        ? 'No extras parsed; keeping existing extras.json'
        : 'Could not reach public Turo extras data; keeping existing extras.json',
    );
    if (!existsSync(extrasPath)) {
      writeJson(extrasPath, emptyExtrasDoc());
      info('extras.json: seeded per-vehicle placeholder');
    }
  } else {
    maybeWrite(extrasPath, extrasDoc, 'extras.json');
  }

  // Ensure files exist for the static site even on first run with blocks.
  if (!existsSync(reviewsPath)) writeJson(reviewsPath, Array.isArray(existingReviews) ? existingReviews : []);
  if (!existsSync(extrasPath)) writeJson(extrasPath, existingExtras && typeof existingExtras === 'object' ? existingExtras : emptyExtrasDoc());

  info('Done.');
  process.exit(0);
}

main().catch((err) => {
  warn(`fatal: ${err.message}; leaving JSON files untouched`);
  process.exit(0);
});
