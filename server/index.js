const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load local .env file if present
const localEnvPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(localEnvPath)) {
  try {
    const envLines = fs.readFileSync(localEnvPath, 'utf8').split('\n');
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (err) {
    // Ignore .env read error
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://ollama:11434').replace(/\/$/, '');
const SMART_MODEL = process.env.SMART_MODEL || 'llama3.1:latest';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
];
const GEMINI_MODEL = process.env.GEMINI_MODEL || GEMINI_MODELS[0];

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      return {
        similarityProvider: parsed.similarityProvider === 'ollama' ? 'ollama' : 'gemini',
        requestedCharacters: Array.isArray(parsed.requestedCharacters)
          ? parsed.requestedCharacters
          : [],
        reportedTips: Array.isArray(parsed.reportedTips) ? parsed.reportedTips : [],
        soloShares: Array.isArray(parsed.soloShares) ? parsed.soloShares : [],
      };
    }
  } catch (err) {
    console.warn('[Store Load Error]', err.message);
  }
  return { similarityProvider: 'gemini', requestedCharacters: [], reportedTips: [], soloShares: [] };
}

function saveStore(storeData) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(storeData, null, 2), 'utf8');
  } catch (err) {
    console.error('[Store Save Error]', err.message);
  }
}

let appStore = loadStore();

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// Verify Authentik ForwardAuth Admin headers on /admin and /api/admin/*
function getAuthentikAdminUser(req) {
  const username = (
    req.headers['x-authentik-username'] ||
    req.headers['remote-user'] ||
    ''
  ).trim();
  const rawGroups =
    req.headers['x-authentik-groups'] ||
    req.headers['remote-groups'] ||
    '';
  const groups = rawGroups
    .split(/[|,]/)
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);

  if (!username) return null;

  const isAdmin =
    groups.includes('admins') ||
    groups.includes('authentik admins') ||
    username.toLowerCase() === 'gian' ||
    username.toLowerCase() === 'akadmin';

  if (!isAdmin) return null;

  return {
    username,
    name: req.headers['x-authentik-name'] || req.headers['remote-name'] || username,
    groups,
  };
}

function requireAuthentikAdmin(req, res, next) {
  const adminUser = getAuthentikAdminUser(req);
  if (!adminUser) {
    return res
      .status(403)
      .send('Forbidden: Admin permissions from Authentik are required to access this panel.');
  }
  req.adminUser = adminUser;
  next();
}

app.get(['/admin', '/admin.html'], requireAuthentikAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/favicon.ico', (req, res) => {
  res.type('image/svg+xml');
  res.sendFile(path.join(__dirname, '..', 'public', 'favicon.svg'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// In-memory caches & solo game sessions
const searchCache = new Map();
const dossierCache = new Map();
const soloSessions = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Categorized character database with category & obscurity/difficulty tags
const CHARACTER_DATABASE = require('./characters');

const RANDOM_CHARACTER_POOL = CHARACTER_DATABASE.map((c) => c.name);

function stripHtmlAndSpoilers(text = '') {
  return text
    .replace(/~!.*?!~/gs, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/__+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Filter out out-of-universe publishing/broadcast history from Wikipedia extracts so in-universe traits shine
function cleanInUniverseWikipediaText(text = '') {
  const metaPattern =
    /\b(created by|designed by|voiced by|portrayed by|played by|first appeared|debut|premiered|broadcast|sitcom|published by|comic strip|pitched|animator|cartoonist|box office|merchandise|reception|critics|emmy|award|poll|ranked|walk of fame|romanization|yiddish)\b/i;
  const sentences = stripHtmlAndSpoilers(text)
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s, idx) => {
    if (s.length < 18 || /^==/.test(s)) return false;
    if (idx === 0) return true;
    return !metaPattern.test(s);
  });
  return kept.join(' ').slice(0, 1100);
}

function cleanCharacterName(rawTitle = '') {
  return rawTitle
    .replace(/\s*\((?:character|fictional character)\)$/i, '')
    .trim();
}

function cleanWikitextValue(val = '') {
  return val
    .replace(/<gallery[\s\S]*?<\/gallery>/gi, ' ')
    .replace(/\{\{Scroll box\|([\s\S]*?)\}\}/gi, '$1')
    .replace(/\{\{w\|([^|}]+)(?:\|([^}]+))?\}\}/gi, (_, a, b) => b || a)
    .replace(/\{\{[^{}]*\}\}/g, ' ')
    .replace(/\[\[File:[^\]]+\]\]/gi, ' ')
    .replace(/\[\[Category:[^\]]+\]\]/gi, ' ')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/<br\s*\/?>/gi, ', ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/'{2,}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?:,\s*)+/g, ', ')
    .trim();
}

// Parse Hero Wiki (hero.fandom.com) or Villains Wiki (villains.fandom.com) revision content into rich character traits
function parseHeroOrVillainPage(p, domain) {
  const raw = p.revisions?.[0]?.['*'] || '';
  if (!/\{\{\s*(?:Hero|Villain)\s+Infobox/i.test(raw)) return null;

  const extractField = (fieldNames) => {
    for (const f of fieldNames) {
      const regex = new RegExp(`\\|\\s*${f}\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\|\\s*[a-zA-Z0-9_]+\\s*=|\\n\\}\\}|$)`, 'i');
      const m = raw.match(regex);
      if (m && m[1]) {
        const cleaned = cleanWikitextValue(m[1]).slice(0, 350);
        if (cleaned.length > 1) return cleaned;
      }
    }
    return '';
  };

  const origin = extractField(['origin']);
  const fullname = extractField(['fullname']);
  const occupation = extractField(['occupation']);
  const powers = extractField(['skills', 'powers']);
  const hobby = extractField(['hobby']);
  const goals = extractField(['goals']);
  const type = extractField(['type']);

  const bodyAfterInfobox = raw.split(/\n\}\}/).slice(1).join(' ');
  const appearanceMatch = raw.match(/==\s*Appearance\s*==([\s\S]*?)(?:==|$)/i);
  const personalityMatch = raw.match(/==\s*Personality\s*==([\s\S]*?)(?:==|$)/i);
  const appearanceText = appearanceMatch ? cleanWikitextValue(appearanceMatch[1]).slice(0, 350) : '';
  const personalityText = personalityMatch ? cleanWikitextValue(personalityMatch[1]).slice(0, 350) : '';
  const bodyProse = cleanWikitextValue(bodyAfterInfobox).slice(0, 500);

  const parenMatch = p.title.match(/\(([^)]+)\)$/);
  const cleanOrigin = origin ? origin.split(',')[0].trim() : '';
  const series =
    cleanOrigin ||
    (parenMatch && !/character/i.test(parenMatch[1]) ? parenMatch[1] : domain.includes('villain') ? 'Villains Wiki' : 'Heroes Wiki');

  const traitParts = [];
  if (appearanceText) traitParts.push(`Appearance: ${appearanceText}`);
  if (occupation) traitParts.push(`Role/Occupation: ${occupation}.`);
  if (personalityText) traitParts.push(`Personality: ${personalityText}`);
  if (powers) traitParts.push(`Powers/Skills: ${powers}.`);
  if (hobby) traitParts.push(`Hobbies/Habits: ${hobby}.`);
  if (goals) traitParts.push(`Goals: ${goals}.`);
  if (fullname) traitParts.push(`Full Name: ${fullname}.`);
  if (series) traitParts.push(`Origin/Series: ${series}.`);
  if (bodyProse && !appearanceText) traitParts.push(`Bio: ${bodyProse}`);

  const description = traitParts.join(' ').slice(0, 1600);

  return {
    id: `${domain.split('.')[0]}-${p.pageid}`,
    name: cleanCharacterName(p.title),
    series: series.slice(0, 80),
    source: domain.includes('villain') ? 'Villains Wiki' : 'Heroes Wiki',
    image: p.thumbnail.source,
    description: description || `${cleanCharacterName(p.title)} from ${series}.`,
  };
}

// 1. Search Heroes Wiki (hero.fandom.com) & Villains Wiki (villains.fandom.com)
async function searchHeroOrVillainWiki(domain, query, limit = 8) {
  const prefixParams = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'prefixsearch',
    gpssearch: query,
    gpslimit: String(limit),
    prop: 'pageimages|revisions',
    piprop: 'thumbnail',
    pithumbsize: '400',
    rvprop: 'content',
  });

  const searchParams = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `"${query}"`,
    gsrlimit: String(limit + 4),
    prop: 'pageimages|revisions',
    piprop: 'thumbnail',
    pithumbsize: '400',
    rvprop: 'content',
  });

  const [r1, r2] = await Promise.all([
    fetch(`https://${domain}/api.php?${prefixParams.toString()}`, {
      headers: { 'User-Agent': 'GuessWhoCharacterGame/1.0 (https://guesswho.gian.ink)' },
      signal: AbortSignal.timeout(4500),
    }).catch(() => null),
    query.trim().length >= 3
      ? fetch(`https://${domain}/api.php?${searchParams.toString()}`, {
          headers: { 'User-Agent': 'GuessWhoCharacterGame/1.0 (https://guesswho.gian.ink)' },
          signal: AbortSignal.timeout(4500),
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const pages = [];
  if (r1 && r1.ok) {
    const j1 = await r1.json();
    const p1 = j1?.query?.pages ? Object.values(j1.query.pages) : [];
    p1.sort((a, b) => (a.index || 999) - (b.index || 999));
    pages.push(...p1.map((p) => ({ ...p, _isPrefix: true })));
  }
  if (r2 && r2.ok) {
    const j2 = await r2.json();
    const p2 = j2?.query?.pages ? Object.values(j2.query.pages) : [];
    p2.sort((a, b) => (a.index || 999) - (b.index || 999));
    pages.push(...p2.map((p) => ({ ...p, _isPrefix: false })));
  }

  const results = [];
  const seenIds = new Set();
  const qLower = query.trim().toLowerCase();

  for (const p of pages) {
    if (!p?.title || seenIds.has(p.pageid) || p.title.includes('/') || !p.thumbnail?.source) continue;
    const raw = p.revisions?.[0]?.['*'] || '';
    if (!p._isPrefix && !p.title.toLowerCase().includes(qLower) && !raw.slice(0, 1800).toLowerCase().includes(qLower)) {
      continue;
    }
    seenIds.add(p.pageid);
    const parsed = parseHeroOrVillainPage(p, domain);
    if (parsed) results.push(parsed);
  }
  return results;
}

// 2. Search AniList GraphQL API (both direct character search AND series -> characters lookup)
async function searchAniList(query, limit = 10) {
  const graphqlQuery = `
    query ($search: String, $perPage: Int) {
      charPage: Page(page: 1, perPage: $perPage) {
        characters(search: $search, sort: [SEARCH_MATCH, FAVOURITES_DESC]) {
          id
          name { full }
          image { large medium }
          description
          gender
          age
          bloodType
          media(perPage: 2, sort: POPULARITY_DESC) {
            nodes {
              title { english romaji }
            }
          }
        }
      }
      seriesMedia: Media(search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
        title { english romaji }
        characters(sort: [ROLE, FAVOURITES_DESC], perPage: 18) {
          nodes {
            id
            name { full }
            image { large medium }
            description
            gender
            age
          }
        }
      }
    }
  `;

  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { search: query, perPage: limit },
    }),
    signal: AbortSignal.timeout(4500),
  });

  if (!res.ok) return [];
  const json = await res.json();
  const directChars = json?.data?.charPage?.characters || [];
  const seriesMedia = json?.data?.seriesMedia;

  const mapAniChar = (c, fallbackSeries) => {
    const img = c.image?.large || c.image?.medium || '';
    if (!img || img.includes('default.jpg')) return null;
    const mediaNode = c.media?.nodes?.[0];
    const series =
      fallbackSeries || mediaNode?.title?.english || mediaNode?.title?.romaji || 'Anime / Manga';
    const metaTraits = [
      c.gender ? `Gender: ${c.gender}.` : '',
      c.age ? `Age: ${c.age}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const cleanDesc = stripHtmlAndSpoilers(c.description || '').slice(0, 1400);
    return {
      id: `anilist-${c.id}`,
      name: c.name?.full || query,
      series,
      source: 'AniList',
      image: img,
      description: `${metaTraits} ${cleanDesc}`.trim() || `${c.name?.full} from ${series}.`,
    };
  };

  const results = directChars.map((c) => mapAniChar(c, null)).filter(Boolean);

  if (seriesMedia) {
    const engTitle = seriesMedia.title?.english || '';
    const romTitle = seriesMedia.title?.romaji || '';
    const qLower = query.trim().toLowerCase();
    if (
      qLower.length >= 3 &&
      (engTitle.toLowerCase().includes(qLower) || romTitle.toLowerCase().includes(qLower))
    ) {
      const seriesLabel = engTitle || romTitle;
      const seriesChars = (seriesMedia.characters?.nodes || [])
        .map((c) => mapAniChar(c, seriesLabel))
        .filter(Boolean);
      results.push(...seriesChars);
    }
  }

  return results;
}

function parseFandomPageToChar(p, defaultSeries = 'Cartoon / Fiction') {
  const raw = p.revisions?.[0]?.['*'] || '';
  const summaryMatch = raw.match(/==\s*Summary\s*==([\s\S]*?)(?:==\s*Powers|$)/i);
  const weaknessesMatch = raw.match(/'''Weaknesses:'''([^\n]+)/i);
  const originMatch = raw.match(/\|\s*Origin\s*=\s*([^\n|]+)/i);
  const classificationMatch = raw.match(/'''Classification:'''([^\n]+)/i);

  const origin = originMatch ? cleanWikitextValue(originMatch[1]) : null;
  const classification = classificationMatch ? cleanWikitextValue(classificationMatch[1]) : '';
  const summary = cleanWikitextValue(summaryMatch ? summaryMatch[1] : raw.slice(0, 1200)).slice(0, 900);
  const weaknesses = weaknessesMatch ? cleanWikitextValue(weaknessesMatch[1]).slice(0, 300) : '';

  const parenMatch = p.title.match(/\(([^)]+)\)$/);
  const series =
    origin ||
    (parenMatch && !/character/i.test(parenMatch[1]) ? parenMatch[1] : defaultSeries);

  const fullDesc = [
    classification ? `Species/Classification: ${classification}.` : '',
    weaknesses ? `Weaknesses/Cannot Do: ${weaknesses}.` : '',
    summary ? `Bio: ${summary}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    id: `fandom-${p.pageid}`,
    name: cleanCharacterName(p.title),
    series,
    source: 'Character Wiki',
    image: p.thumbnail.source,
    description: fullDesc || `${cleanCharacterName(p.title)} (${series})`,
  };
}

// 3. Search VS Battles Character Database
async function searchFandomCharacters(query, limit = 8) {
  const prefixParams = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'prefixsearch',
    gpssearch: query,
    gpslimit: String(limit),
    prop: 'pageimages|categories|revisions',
    piprop: 'thumbnail',
    pithumbsize: '400',
    clcategories: 'Category:Characters',
    rvprop: 'content',
  });

  const catLookupParams = new URLSearchParams({
    action: 'query',
    format: 'json',
    list: 'allcategories',
    acprefix: query,
    aclimit: '3',
  });

  const [prefixRes, catRes] = await Promise.all([
    fetch(`https://vsbattles.fandom.com/api.php?${prefixParams.toString()}`, {
      headers: { 'User-Agent': 'GuessWhoCharacterGame/1.0 (https://guesswho.gian.ink)' },
      signal: AbortSignal.timeout(4500),
    }).catch(() => null),
    fetch(`https://vsbattles.fandom.com/api.php?${catLookupParams.toString()}`, {
      headers: { 'User-Agent': 'GuessWhoCharacterGame/1.0 (https://guesswho.gian.ink)' },
      signal: AbortSignal.timeout(3500),
    }).catch(() => null),
  ]);

  const results = [];

  if (prefixRes && prefixRes.ok) {
    const json = await prefixRes.json();
    const pages = json?.query?.pages ? Object.values(json.query.pages) : [];
    pages.sort((a, b) => (a.index || 999) - (b.index || 999));

    for (const p of pages) {
      const isChar = (p.categories || []).some((c) => c.title === 'Category:Characters');
      if (isChar && p.thumbnail?.source && p.title) {
        results.push(parseFandomPageToChar(p));
      }
    }
  }

  if (catRes && catRes.ok && query.trim().length >= 3) {
    const catJson = await catRes.json();
    const cats = (catJson?.query?.allcategories || []).map((c) => c['*']);
    const bestCat = cats.find((c) => c.toLowerCase().startsWith(query.trim().toLowerCase()));
    if (bestCat) {
      const memberParams = new URLSearchParams({
        action: 'query',
        format: 'json',
        generator: 'categorymembers',
        gcmtitle: `Category:${bestCat}`,
        gcmnamespace: '0',
        gcmlimit: '18',
        prop: 'pageimages|categories|revisions',
        piprop: 'thumbnail',
        pithumbsize: '400',
        clcategories: 'Category:Characters',
        rvprop: 'content',
      });
      const memberRes = await fetch(
        `https://vsbattles.fandom.com/api.php?${memberParams.toString()}`,
        {
          headers: { 'User-Agent': 'GuessWhoCharacterGame/1.0 (https://guesswho.gian.ink)' },
          signal: AbortSignal.timeout(4500),
        }
      ).catch(() => null);

      if (memberRes && memberRes.ok) {
        const memberJson = await memberRes.json();
        const memberPages = memberJson?.query?.pages ? Object.values(memberJson.query.pages) : [];
        for (const p of memberPages) {
          const isChar = (p.categories || []).some((c) => c.title === 'Category:Characters');
          if (isChar && p.thumbnail?.source && p.title) {
            results.push(parseFandomPageToChar(p, bestCat));
          }
        }
      }
    }
  }

  return results;
}

// Strict classifier ensuring a Wikipedia page is an actual CHARACTER and has an image
function isStrictlyWikipediaCharacter(p) {
  if (!p.title) return false;
  const img = p.thumbnail?.source || p.original?.source;
  if (!img) return false;

  const title = p.title.trim();
  if (/^(List of |Index of |Category:|Template:)/i.test(title)) return false;
  if (
    /\b(in film|in other media|in popular culture|in comics|in video games|in television|in politics|universe|filmography|bibliography|discography|franchise|soundtrack|disambiguation)\b/i.test(
      title
    )
  ) {
    return false;
  }
  if (
    /\((?:[^)]*\b(?:film|movie|TV series|television series|animated series|series|video game|game|episode|season|franchise|album|song|novel|book|comics|comic book|magazine|company|band|soundtrack|disambiguation)\b[^)]*)\)/i.test(
      title
    )
  ) {
    return false;
  }

  const desc = (p.description || '').trim();
  if (!desc) {
    const firstSentence = ((p.extract || '').split('.')[0] || '').trim();
    const m = firstSentence.match(
      /\bis\s+(?:a|an|the)\s+([^.,;]+?)(?:\s+(?:in|from|of|for|on|who|that|created|appearing|featured|introduced)\b|[.,;]|$)/i
    );
    if (!m) return /\((?:[a-z\s]*character)\)$/i.test(title);
    const extractHead = m[1].trim();
    return (
      /\b(character|protagonist|antagonist|superhero|supervillain|villain|antihero|mascot|pokémon)\s*$/i.test(
        extractHead
      ) && !/^(?:character\s+type|stock\s+character|supporting\s+character)$/i.test(extractHead)
    );
  }

  if (/\b(character type|stock character|narrative|literary|archetype|trope|universe)\b/i.test(desc)) {
    return false;
  }

  const headPhrase = desc
    .split(
      /\s*(?:;|,|\b(?:of|from|in|for|on|at|by|with|involving|appearing|created|introduced|featured|based|portrayed|voiced|played)\b)/i
    )[0]
    .trim();

  const validHeadNoun =
    /\b(characters?|protagonists?|antagonists?|superhero(?:es|ine)?|supervillains?|villains?|antihero(?:es)?|arch-?enem(?:y|ies)|sidekicks?|mascots?|pokémon species|(?:fictional|cartoon|animated|anthropomorphic|comic|anime|manga|disney|looney tunes|hanna-barbera|sanrio|muppet|puppet|mythological|legendary|folklore)\s+(?:[a-z-]+\s+){0,3}(?:character|person|being|creature|animal|dog|cat|mouse|duck|rabbit|sponge|ogre|bear|hedgehog|plumber|pirate|ninja|wizard|witch|robot|cyborg|android|alien|monster|detective|knight|princess|prince|squirrel|starfish|octopus|crab|plankton|boy|girl|man|woman|kid|child|human|mutant|deity|god|goddess|demon|ghost|vampire|werewolf|dragon|fairy|elf|dwarf|goblin|troll|giant|turtle|frog|bird|pig|horse|lion|tiger|wolf|fox|monkey|ape|panda|koala|kangaroo|penguin|dolphin|shark|whale|fish))\s*$/i;

  return validHeadNoun.test(headPhrase);
}

// 4. Search Wikipedia API
async function searchWikipedia(query, limit = 14) {
  const prefixParams = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'prefixsearch',
    gpssearch: query,
    gpslimit: String(limit),
    prop: 'pageimages|extracts|description',
    piprop: 'thumbnail|original',
    pilicense: 'any',
    pithumbsize: '400',
    exintro: '1',
    explaintext: '1',
    exchars: '1200',
    redirects: '1',
    origin: '*',
  });

  const seriesSearchParams = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `"${query}" (character OR protagonist OR antagonist)`,
    gsrlimit: '15',
    prop: 'pageimages|extracts|description',
    piprop: 'thumbnail|original',
    pilicense: 'any',
    pithumbsize: '400',
    exintro: '1',
    explaintext: '1',
    exchars: '1200',
    redirects: '1',
    origin: '*',
  });

  const [prefixRes, seriesRes] = await Promise.all([
    fetch(`https://en.wikipedia.org/w/api.php?${prefixParams.toString()}`, {
      headers: { 'User-Agent': 'GuessWhoCharacterGame/1.0 (https://guesswho.gian.ink)' },
      signal: AbortSignal.timeout(4500),
    }).catch(() => null),
    query.trim().length >= 3
      ? fetch(`https://en.wikipedia.org/w/api.php?${seriesSearchParams.toString()}`, {
          headers: { 'User-Agent': 'GuessWhoCharacterGame/1.0 (https://guesswho.gian.ink)' },
          signal: AbortSignal.timeout(4500),
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const mapWikiPage = (p) => ({
    id: `wiki-${p.pageid}`,
    name: cleanCharacterName(p.title),
    series: p.description || 'Cartoon / Pop Culture Character',
    source: 'Wikipedia',
    image: p.thumbnail?.source || p.original?.source,
    description: cleanInUniverseWikipediaText(p.extract || p.description || p.title),
  });

  const results = [];

  if (prefixRes && prefixRes.ok) {
    const json = await prefixRes.json();
    const pages = json?.query?.pages ? Object.values(json.query.pages) : [];
    pages.sort((a, b) => (a.index || 999) - (b.index || 999));
    results.push(...pages.filter(isStrictlyWikipediaCharacter).map(mapWikiPage));
  }

  if (seriesRes && seriesRes.ok) {
    const json = await seriesRes.json();
    const pages = json?.query?.pages ? Object.values(json.query.pages) : [];
    pages.sort((a, b) => (a.index || 999) - (b.index || 999));
    const qLower = query.trim().toLowerCase();
    const seriesChars = pages
      .filter((p) => {
        if (!isStrictlyWikipediaCharacter(p)) return false;
        const descMatch = (p.description || '').toLowerCase().includes(qLower);
        const extractMatch = (p.extract || '').toLowerCase().includes(qLower);
        return descMatch || extractMatch;
      })
      .map(mapWikiPage);
    results.push(...seriesChars);
  }

  return results;
}

// Unified multi-source character search across 5 character databases
async function performHybridSearch(query) {
  const normalized = query.trim().toLowerCase();
  const cached = searchCache.get(normalized);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.results;
  }

  const [wikiResults, heroResults, villainResults, fandomResults, anilistResults] = await Promise.all([
    searchWikipedia(query, 14).catch(() => []),
    searchHeroOrVillainWiki('hero.fandom.com', query, 8).catch(() => []),
    searchHeroOrVillainWiki('villains.fandom.com', query, 8).catch(() => []),
    searchFandomCharacters(query, 8).catch(() => []),
    searchAniList(query, 10).catch(() => []),
  ]);

  const combined = [];
  const seenNames = new Map();

  const allLists = [wikiResults, heroResults, villainResults, fandomResults, anilistResults];
  const maxLen = Math.max(...allLists.map((l) => l.length));

  const canonicalTokenKey = (nameStr) =>
    nameStr
      .replace(/\s*\([^)]+\)$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .sort()
      .join(' ');

  for (let i = 0; i < maxLen; i++) {
    for (const list of allLists) {
      const item = list[i];
      if (!item || !item.image) continue;
      // Reject alternate game/musical/live-action/spinoff pages
      if (
        /\((?:Nicktoons|Nickelodeon All-Star|Super Brawl|Globs of Doom|Broadway|Musical|Lego|Live-Action|2019|2016|Reboot|Game|Treehouse of Horror|Mirror|Future|Clone|Robot|Mecha|Possessed|William Steig)\b/i.test(
          item.name
        )
      ) {
        continue;
      }
      const hasParenVariant = /\([^)]+\)$/.test(item.name);
      const tokenKey = canonicalTokenKey(item.name);
      const exactKey = item.name.toLowerCase();

      if (!seenNames.has(exactKey)) {
        if (seenNames.has(tokenKey)) {
          const existing = seenNames.get(tokenKey);
          // Only merge description if the new item is NOT a parenthetical variant (e.g. merge AniList "Luffy Monkey" into "Monkey D. Luffy")
          if (
            !hasParenVariant &&
            item.description &&
            !existing.description.includes(item.description.slice(0, 50))
          ) {
            existing.description = `${existing.description} | ${item.description}`.slice(0, 1800);
          }
          continue;
        }
        seenNames.set(exactKey, item);
        seenNames.set(tokenKey, item);
        combined.push(item);
      }
    }
  }

  const finalResults = combined.slice(0, 36);
  searchCache.set(normalized, { timestamp: Date.now(), results: finalResults });
  return finalResults;
}

// Deep dossier builder: gathers rich in-universe traits across wikis and flags whether sufficient info exists
async function buildDeepCharacterDossier(charObj) {
  const baseName = (charObj.name || '').replace(/\s*\([^)]+\)$/, '').trim();
  const cacheKey = baseName.toLowerCase();
  if (dossierCache.has(cacheKey)) {
    return dossierCache.get(cacheKey);
  }

  const results = await performHybridSearch(baseName);
  const matchingEntries = results.filter((r) => {
    // Only merge canonical main entries (no parenthetical alternate versions)
    if (/\([^)]+\)$/.test(r.name)) return false;
    const rBase = r.name.toLowerCase();
    return rBase === cacheKey;
  });

  const primaryEntry = matchingEntries[0] || results[0];
  const mergedDescriptions = [];
  if (charObj.description && charObj.description.trim() !== charObj.name.trim()) {
    mergedDescriptions.push(charObj.description);
  }
  if (primaryEntry?.description && !mergedDescriptions.some((d) => d.includes(primaryEntry.description.slice(0, 50)))) {
    mergedDescriptions.push(primaryEntry.description);
  }

  const combinedText = mergedDescriptions.filter(Boolean).join('\n').slice(0, 1600);
  const hasVerifiedInfo = combinedText.length >= 40 || matchingEntries.length > 0;

  const richDossier = {
    name: baseName || charObj.name,
    series: charObj.series !== 'Custom' && charObj.series !== 'Manual Entry'
      ? (charObj.series || matchingEntries[0]?.series || 'Unknown')
      : (matchingEntries[0]?.series || 'Unknown'),
    image: charObj.image || matchingEntries[0]?.image || null,
    description: combinedText,
    hasVerifiedInfo,
  };

  if (hasVerifiedInfo) {
    dossierCache.set(cacheKey, richDossier);
  }
  return richDossier;
}

// Helper to fetch a completely random character directly from live external databases (AniList, Fandom Heroes & Villains)
async function fetchTrulyRandomCharacterFromDatabases(category = 'all') {
  // 1. If category is anime, query AniList directly for a random character
  if (category === 'anime' || (category === 'all' && Math.random() < 0.35)) {
    try {
      const randomPage = Math.floor(Math.random() * 2500) + 20;
      const query = `
        query ($page: Int) {
          Page(page: $page, perPage: 1) {
            characters(sort: [FAVOURITES_DESC]) {
              id
              name { full }
              image { large medium }
              description
              media(perPage: 1) {
                nodes {
                  title { english romaji }
                }
              }
            }
          }
        }
      `;
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables: { page: randomPage } }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json();
        const char = data?.data?.Page?.characters?.[0];
        if (char?.name?.full && (char.image?.large || char.image?.medium)) {
          const series =
            char.media?.nodes?.[0]?.title?.english ||
            char.media?.nodes?.[0]?.title?.romaji ||
            'Anime / Manga';
          return {
            name: char.name.full,
            series,
            image: char.image?.large || char.image?.medium,
            description: stripHtmlAndSpoilers(char.description || `${char.name.full} from ${series}.`).slice(0, 1500),
          };
        }
      }
    } catch (err) {
      console.warn('[AniList Random Error]', err.message);
    }
  }

  // 2. Fandom Heroes Wiki (hero.fandom.com) & Villains Wiki (villains.fandom.com)
  const domains = ['hero.fandom.com', 'villains.fandom.com'];
  const domain = domains[Math.floor(Math.random() * domains.length)];
  try {
    const url = `https://${domain}/api.php?action=query&generator=random&grnnamespace=0&grnlimit=15&prop=pageimages|revisions&piprop=thumbnail&pithumbsize=400&rvprop=content&format=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GuessWhoCharacterGame/1.0 (https://guesswho.gian.ink)' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      const pages = Object.values(data?.query?.pages || {});
      const shuffledPages = pages.sort(() => Math.random() - 0.5);
      for (const p of shuffledPages) {
        if (!p?.title || p.title.includes('/') || !p.thumbnail?.source) continue;
        const parsed = parseHeroOrVillainPage(p, domain);
        if (parsed && parsed.name && parsed.image) {
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn('[Fandom Random Error]', err.message);
  }

  return null;
}

// Helper to pick a random character filtered by category and difficulty/obscurity
async function pickRandomCharacterByMode(category = 'all', difficulty = 'easy') {
  // For the Hard difficulty, literally pull a completely random character from live databases!
  if (difficulty === 'hard') {
    const dbChar = await fetchTrulyRandomCharacterFromDatabases(category);
    if (dbChar) {
      return dbChar;
    }
    // Fall back to curated hard pool if network/API drops
  }

  let pool = CHARACTER_DATABASE;

  if (category && category !== 'all') {
    const catPool = pool.filter((c) => c.category === category);
    if (catPool.length > 0) pool = catPool;
  }

  if (difficulty && difficulty !== 'any') {
    const diffPool = pool.filter((c) => c.difficulty === difficulty);
    if (diffPool.length > 0) pool = diffPool;
  }

  const shuffled = pool.slice().sort(() => Math.random() - 0.5);

  for (const item of shuffled.slice(0, 8)) {
    const results = await performHybridSearch(item.name);
    if (results && results.length > 0) {
      const exactMatch = results.find(
        (r) => r.name.replace(/\s*\([^)]+\)$/, '').trim().toLowerCase() === item.name.toLowerCase()
      );
      return exactMatch || results[0];
    }
  }

  return pickMainstreamRandomCharacterFallback();
}

async function pickMainstreamRandomCharacterFallback() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const randomName =
      RANDOM_CHARACTER_POOL[Math.floor(Math.random() * RANDOM_CHARACTER_POOL.length)];
    const results = await performHybridSearch(randomName);
    if (results && results.length > 0) {
      const exactMatch = results.find(
        (r) => r.name.replace(/\s*\([^)]+\)$/, '').trim().toLowerCase() === randomName.toLowerCase()
      );
      return exactMatch || results[0];
    }
  }
  return null;
}

// Backward-compatible alias
async function pickMainstreamRandomCharacter() {
  return pickRandomCharacterByMode('all', 'easy');
}

// Sanitize AI similarity output so it never leaks the character names, series names, parenthetical spoilers, or meta media cop-outs
function cleanSimilarityOutput(rawText, ...chars) {
  let text = (rawText || '')
    .replace(/\*\*+/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(Similarity|Commonality|Answer|Output|Clue|Connection)\s*:\s*/i, '')
    .replace(/^Both\/Neither\b/i, '')
    .replace(/\s*\([^)]*\)/g, '') // Strip parenthetical explanations
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || /^[\W_]+$/.test(text)) {
    return '';
  }

  // Strictly reject out-of-universe meta clues (players want in-universe clues, never "Both star in animated series")
  if (
    /\b(anime|cartoon|cartoons|manga|comic|comics|series|franchise|television|video game|video games|media|fictional|debuted|broadcast|voice actor|voiced by|actor|actress|mascot|mascots)\b/i.test(
      text
    )
  ) {
    return '';
  }

  const firstSentenceMatch = text.match(/^[^.!?]+[.!?]?/);
  if (firstSentenceMatch) {
    text = firstSentenceMatch[0].trim();
  }

  const flatChars = chars.flat().filter(Boolean);
  const forbiddenSources = [];
  for (const c of flatChars) {
    if (!c) continue;
    if (c.name) forbiddenSources.push(c.name);
    if (c.series) {
      forbiddenSources.push(
        c.series.replace(/character|protagonist|antagonist|fictional|animated|series|franchise/gi, '')
      );
    }
  }

  const forbiddenTokens = forbiddenSources
    .filter(Boolean)
    .flatMap((n) => n.split(/\s+/))
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((w) => w.length >= 4 && !/^(both|neither|they|have|wear|live|from|with|comic|comics|anime|manga|game|movie|show|toon|cartoon|hero|villain|superhero|unknown|info|character|characters|your|each|some|none|many|also|more|less)$/i.test(w));

  for (const token of forbiddenTokens) {
    const regex = new RegExp(`\\b${token}\\b`, 'gi');
    if (regex.test(text)) {
      text = text.replace(regex, 'they');
    }
  }

  if (!/[.!?]$/.test(text) && text.length > 0) {
    text += '.';
  }
  return text;
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    res.json({
      status: 'ok',
      ollamaConnected: ollamaRes.ok,
      ollamaUrl: OLLAMA_URL,
      smartModel: SMART_MODEL,
      randomPoolSize: RANDOM_CHARACTER_POOL.length,
    });
  } catch (err) {
    res.json({
      status: 'ok',
      ollamaConnected: false,
      ollamaUrl: OLLAMA_URL,
      error: err.message,
    });
  }
});

// Autocomplete & Series Character Search Endpoint
app.get('/api/characters/search', async (req, res) => {
  const q = (req.query.q || '').trim();

  if (q.length < 2) {
    return res.json({ results: [] });
  }

  try {
    const results = await performHybridSearch(q);
    res.json({ results });
  } catch (err) {
    console.error('[Search Error]', err);
    res.status(500).json({ error: 'Failed to search characters', results: [] });
  }
});

// Random Character Endpoint (strictly mainstream characters)
app.get('/api/characters/random', async (req, res) => {
  try {
    const character = await pickMainstreamRandomCharacter();
    if (character) {
      return res.json({ character });
    }
    res.status(404).json({ error: 'Could not fetch random character' });
  } catch (err) {
    console.error('[Random Character Error]', err);
    res.status(500).json({ error: 'Failed to pick random character' });
  }
});

// Request a Missing Character (from bottom of search dropdown)
app.post('/api/characters/request', (req, res) => {
  const rawName = (req.body?.name || '').trim();
  if (rawName.length < 2 || rawName.length > 120) {
    return res.status(400).json({ error: 'Character name must be between 2 and 120 characters.' });
  }

  const norm = rawName.toLowerCase();
  const existing = appStore.requestedCharacters.find((c) => c.name.toLowerCase() === norm);
  const now = new Date().toISOString();

  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastRequestedAt = now;
  } else {
    appStore.requestedCharacters.unshift({
      id: crypto.randomUUID(),
      name: rawName,
      count: 1,
      firstRequestedAt: now,
      lastRequestedAt: now,
    });
  }

  saveStore(appStore);
  res.json({ ok: true, requestedCharacters: appStore.requestedCharacters });
});

// Report a weird or inaccurate bot clue (from main game)
app.post('/api/tips/report', (req, res) => {
  const { char1, char2, level, clue, note } = req.body || {};
  const trimmedClue = (clue || '').trim();
  if (!trimmedClue) {
    return res.status(400).json({ error: 'Clue text is required to submit a report.' });
  }

  const formatChar = (c) => {
    if (!c) return 'Unknown';
    if (typeof c === 'object') {
      return `${c.name || 'Unknown'}${c.series ? ` (${c.series})` : ''}`;
    }
    return String(c);
  };

  const report = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    char1: formatChar(char1),
    char2: formatChar(char2),
    level: Math.min(3, Math.max(1, Number(level) || 1)),
    clue: trimmedClue.slice(0, 500),
    note: (note || '').trim().slice(0, 500),
  };

  appStore.reportedTips.unshift(report);
  if (appStore.reportedTips.length > 250) {
    appStore.reportedTips = appStore.reportedTips.slice(0, 250);
  }
  saveStore(appStore);

  res.json({ ok: true, message: 'Tip reported. Thank you for the feedback!' });
});

// ============================================================================
// ADMIN PANEL ENDPOINTS (/api/admin/* - Protected by Authentik Admin check)
// ============================================================================

app.use('/api/admin', requireAuthentikAdmin);

app.get('/api/admin/state', (req, res) => {
  res.json({
    adminUser: req.adminUser,
    similarityProvider: appStore.similarityProvider,
    geminiModel: GEMINI_MODEL,
    ollamaModel: SMART_MODEL,
    requestedCharacters: appStore.requestedCharacters,
    reportedTips: appStore.reportedTips,
  });
});

app.post('/api/admin/settings', (req, res) => {
  const { similarityProvider } = req.body || {};
  if (similarityProvider !== 'gemini' && similarityProvider !== 'ollama') {
    return res.status(400).json({ error: 'Invalid similarityProvider. Must be "gemini" or "ollama".' });
  }
  appStore.similarityProvider = similarityProvider;
  saveStore(appStore);
  res.json({
    ok: true,
    similarityProvider: appStore.similarityProvider,
  });
});

app.delete('/api/admin/requests/:id', (req, res) => {
  const { id } = req.params;
  appStore.requestedCharacters = appStore.requestedCharacters.filter((c) => c.id !== id);
  saveStore(appStore);
  res.json({ ok: true, requestedCharacters: appStore.requestedCharacters });
});

app.delete('/api/admin/requests', (req, res) => {
  appStore.requestedCharacters = [];
  saveStore(appStore);
  res.json({ ok: true, requestedCharacters: [] });
});

app.delete('/api/admin/reports/:id', (req, res) => {
  const { id } = req.params;
  appStore.reportedTips = appStore.reportedTips.filter((r) => r.id !== id);
  saveStore(appStore);
  res.json({ ok: true, reportedTips: appStore.reportedTips });
});

app.delete('/api/admin/reports', (req, res) => {
  appStore.reportedTips = [];
  saveStore(appStore);
  res.json({ ok: true, reportedTips: [] });
});

// ============================================================================
// SOLO MODE ENDPOINTS (Site picks a random character; user asks Yes/No questions)
// ============================================================================

function isIncompleteInput(text = '') {
  const t = (text || '').trim();
  if (!t) return true;

  // Single word fragment that isn't a known stand-alone guess
  if (/^(is|are|am|was|were|do|does|did|can|could|will|would|has|have|had|what|who|where|when|why|how|the|a|an)$/i.test(t)) {
    return true;
  }

  // Trailing incomplete grammar particles (e.g. "is he a", "does she have", "is this", "are they", "what is")
  const words = t.split(/\s+/);
  if (words.length <= 4) {
    if (/^(is|are|was|were|do|does|did|can|could|will|would|has|have|had)\s+(he|she|it|they|this|that|the|a|an)?$/i.test(t)) {
      return true;
    }
    if (/^(what|who|where|when|why|how)\s+(is|are|was|were|do|does|did)?$/i.test(t)) {
      return true;
    }
  }

  // Ending with dangling prepositions/conjunctions/articles with no punctuation
  if (/(?:\s|^)(?:a|an|the|and|or|of|in|to|with|from|about|like|as)\s*$/i.test(t)) {
    return true;
  }

  return false;
}

function isNonYesNoQuestion(text = '') {
  const raw = (text || '').trim();
  const q = raw.toLowerCase().replace(/[^a-z0-9\s?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return false;

  // Direct guess check - e.g. "Is it Naruto?", "Naruto Uzumaki", "Are you SpongeBob?"
  if (/^(is it|are you|is the character|is he|is she)\s+([a-z0-9\s]+)\?*$/i.test(q)) {
    return false;
  }

  // Open-ended interrogatives: what, where, when, why, how, which, whose
  if (/^(what|where|when|why|how|which|whose)\b/i.test(q)) {
    return true;
  }

  // Who questions asking for explanation/relationship rather than a direct guess
  // e.g. "who is his dad", "who killed him", "who made this"
  if (/^who\s+(is|are|was|were)\s+(his|her|their|the\s+main|the\s+best|the\s+worst|the|your)\b/i.test(q)) {
    return true;
  }
  if (/^(who|whom)\s+(did|does|do|killed|created|made|voiced|wrote|likes|loves|hates)\b/i.test(q)) {
    return true;
  }

  // Demands / imperatives: "tell me", "give me", "describe", "explain"
  if (/^(tell me|give me|describe|explain|show me|give a hint|hint|give clue|clue)\b/i.test(q)) {
    return true;
  }

  return false;
}

app.post('/api/solo/start', async (req, res) => {
  try {
    const { category = 'all', difficulty = 'easy' } = req.body || {};
    const baseChar = await pickRandomCharacterByMode(category, difficulty);
    if (!baseChar) {
      return res.status(500).json({ error: 'Could not pick a random character for Solo Mode.' });
    }
    const dossier = await buildDeepCharacterDossier(baseChar);
    const sessionId = crypto.randomUUID();

    soloSessions.set(sessionId, {
      createdAt: Date.now(),
      category,
      difficulty,
      character: {
        name: dossier.name || baseChar.name,
        series: dossier.series || baseChar.series,
        image: dossier.image || baseChar.image,
        description: dossier.description || baseChar.description,
      },
      history: [],
    });

    // Clean up old sessions (> 2 hours)
    for (const [id, sess] of soloSessions.entries()) {
      if (Date.now() - sess.createdAt > 2 * 60 * 60 * 1000) {
        soloSessions.delete(id);
      }
    }

    res.json({
      sessionId,
      message: 'Secret character selected! Ask any Yes/No question or guess who it is.',
    });
  } catch (err) {
    console.error('[Solo Start Error]', err);
    res.status(500).json({ error: 'Failed to start Solo Mode.' });
  }
});

function isStandardDemographicQuestion(text) {
  const q = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // If question contains specific franchise or specific archetype keywords, it is NOT just a generic screening question
  const specificClues = /\b(pirate|ninja|shinobi|wizard|witch|jedi|sith|alchemist|stand|devil fruit|super saiyan|pokemon|digimon|bender|bending|avatar|sponge|squirrel|starfish|crab|plankton|gravity falls|mystery shack|bikini bottom|straw hat|hogwarts|leaf village|konoha|shinigami|ghoul|cyborg|android|god|demigod|vampire|werewolf|zombie|mermaid|pineapple)\b/i;
  if (specificClues.test(q)) return false;

  // 1. Gender inquiries
  if (/^(is\s+(the\s+character|it|he|she)|are\s+they)\s+(a\s+)?(male|female|man|woman|boy|girl|guy|dude)$/i.test(q)) return true;
  if (/\b(what\s+gender|is\s+(it|the\s+character)\s+(male\s+or\s+female|boy\s+or\s+girl))\b/i.test(q)) return true;
  if (/\b(male|female)\b/i.test(q) && q.split(' ').length <= 6) return true;

  // 2. Human vs non-human / animal inquiries
  if (/^(is\s+(the\s+character|it|he|she)|are\s+they)\s+(a\s+|an\s+)?(human|person|animal|creature|mammal|alien|monster|robot)$/i.test(q)) return true;
  if (/\b(human\s+or\s+not|human\s+or\s+animal)\b/i.test(q)) return true;
  if (/\b(human|animal)\b/i.test(q) && q.split(' ').length <= 5) return true;

  // 3. Medium / Fiction type
  if (/^(is\s+(the\s+character|it|he|she)|are\s+they)\s+(from\s+(an?\s+)?)?(anime|cartoon|animation|animated|movie|film|tv\s+show|series|video\s+game|game|book|comic|live\s+action)$/i.test(q)) return true;
  if (/^(are\s+they|is\s+(it|the\s+character))\s+(real|fictional)$/i.test(q)) return true;
  if (/\b(anime|cartoon|animated|live\s+action|fictional)\b/i.test(q) && q.split(' ').length <= 6) return true;

  // 4. Morality / Role
  if (/^(is\s+(the\s+character|it|he|she)|are\s+they)\s+(a\s+)?(hero|villain|good\s+guy|bad\s+guy|protagonist|antagonist|main\s+character|side\s+character)$/i.test(q)) return true;
  if (/\b(good\s+or\s+evil|hero\s+or\s+villain|good\s+or\s+bad)\b/i.test(q)) return true;

  // 5. Alive / Dead / Age
  if (/^(is\s+(the\s+character|it|he|she)|are\s+they)\s+(a\s+)?(alive|dead|mortal|adult|child|kid|teen|teenager|old|young)$/i.test(q)) return true;

  // 6. Generic body traits
  if (/^do\s+they\s+(have\s+(hair|eyes|legs|arms|clothes)|wear\s+clothes)$/i.test(q)) return true;

  return false;
}

async function askAIAboutSoloCharacter(char, userQ, history = []) {
  const systemPrompt = `You are an expressive, lively game-show judge in a Solo "Guess Who" / 20-Questions character guessing game.
You know the secret character and their confirmed canon lore.
The player is asking a question or trying to guess who the secret character is.

EVALUATION RULES:
1. CHARACTER IDENTITY GUESS:
   - If the player is directly guessing who the character is and gets it RIGHT:
     "guessed": true, "verdict": "GUESSED", "heat": "hot", "answer": "🎉 Yes! You guessed it — the character is ${char.name}!"
   - If the player is guessing a specific wrong character name:
     "guessed": false, "verdict": "NO", "heat": "cold", "answer": "❌ Nope, not that character!"

2. TRAIT / LORE QUESTION EVALUATION:
   Check the character's confirmed canon facts:
   - Determine the core verdict: "YES", "NO", or "UNKNOWN" (if not confirmed in canon).
   - Create an expressive, realistic reaction for the answer text:
     - Clear/Iconic Yes: e.g. "🤩 Yes, absolutely!", "✨ Yes, definitely!", "👍 Yes, that's right."
     - Nuanced / Technical Yes: e.g. "🧐 Technically yes, but barely...", "🤔 Yes, in a sense."
     - Near miss / right track but technically No: e.g. "🤏 Close, but no!", "😬 No, not quite!"
     - Definite No: e.g. "🙅 Definitely not!", "❌ Nope, not at all.", "👎 No."
     - Unconfirmed / obscure canon: e.g. "🤷 Hard to say / rarely mentioned in canon."

CRITICAL ANTI-SPOILER & NO-EXPLANATION RULE (NEVER LEAK TRAITS OR REASONS):
- STRICT ANSWER LENGTH: Your answer text MUST be ONLY 2 TO 5 WORDS (including emoji)!
- NEVER EXPLAIN WHY: Do NOT explain why an answer is No or Yes!
  - FORBIDDEN: NEVER mention what the character is (e.g. if asked "do they run?", NEVER say "Nope, cars don't run!" or "No, fish swim!" or "Nope, ghosts float!").
  - FORBIDDEN: NEVER volunteer unprompted lore, category names, or justifications (e.g. NEVER say "because...", "since...", "cars...", "robots...", "animals...", "vehicles...", etc.).
  - Simply answer the question directly with a short reaction: e.g. "🙅 Definitely not!", "❌ Nope, not at all.", "👎 No, they do not.", "👍 Yes, absolutely!", "✨ Yes, that's right."
- If the answer is No, just say No. NEVER give away what they actually are!

3. NON-YES/NO QUESTION EVALUATION:
   - In Guess Who, questions MUST be answerable with Yes or No (or be a direct character guess).
   - If the player asks an open-ended question that CANNOT be answered with Yes or No (e.g. "What color is their hair?", "Where do they live?", "Who is their friend?", "How old are they?", "Tell me about them", "What anime is this?"):
     "guessed": false, "verdict": "INVALID", "heat": "neutral", "answer": "⚠️ In Guess Who, you can only ask Yes/No questions! (e.g. 'Do they have black hair?')"
   - DISJUNCTIVE / "OR" QUESTIONS (VERY IMPORTANT):
     Questions with "or" (e.g. "Is the character a sailor or a pirate?", "Are they a hero or villain?", "Do they fight with magic or weapons?", "Is their hair black or brown?") ARE VALID YES/NO QUESTIONS.
     - If the character matches EITHER option: "verdict": "YES" (e.g. "👍 Yes, that's right!", "✨ Yes, definitely!").
     - If the character matches NEITHER option: "verdict": "NO" (e.g. "🙅 No, neither!", "❌ Nope!").
     NEVER mark disjunctive "or" questions as INVALID!

4. HEAT ASSESSMENT ("heat" field):
   Assess whether the player's question indicates they are zeroing in on THIS specific character:
   - "hot": The question targets an iconic signature trait, unique item/weapon/companion, or specific canon relationship unique or famous to this character (e.g. lives in a pineapple, lightning scar, twin brother named Randy, lost an arm, carries journal #3).
   - "warm": The question narrows down to a specific thematic archetype, distinct setting, or signature ability/job (e.g. lives underwater, pirate, works in a restaurant, studies strange anomalies in the woods, detective).
   - "neutral": STANDARD / BASELINE / SCREENING QUESTIONS. Generic demographic or binary category questions MUST ALWAYS be "neutral" (e.g. male/female, human/animal, cartoon/real, alive/dead, hero/villain, has hair, wears clothes). The player is just doing standard Guess Who filtering, NOT on a specific track yet.
   - "cold": Completely wrong direction, contradictory archetype, or wildly irrelevant universe/genre.

STRICT CONSTRAINTS:
- NEVER reveal the secret character's name or franchise in the answer unless "guessed": true!
- NEVER reveal unprompted lore facts, secret names, or spoiler clues in your answer! Keep your answer short and focused on confirming or denying the player's exact question.
- Output ONLY valid JSON matching this schema:
{
  "reasoning": "1 sentence checking canon facts and heat relevance",
  "guessed": false,
  "verdict": "YES" | "NO" | "UNKNOWN" | "GUESSED" | "INVALID",
  "heat": "hot" | "warm" | "neutral" | "cold",
  "answer": "<emoji> <expressive short phrase>"
}`;

  const historyText = Array.isArray(history) && history.length > 0
    ? history.slice(-10).map((h, i) => `${i + 1}. Q: "${h.question}" -> A: "${h.answer}" (${h.verdict})`).join('\n')
    : '(No previous questions asked yet)';

  const userPrompt = `=== SECRET CHARACTER DOSSIER ===
Name: ${char.name}
Series/Origin: ${char.series}
Verified Info:
${char.description || 'No extra description.'}

=== PREVIOUS CONVERSATION IN THIS GAME ===
${historyText}

=== CURRENT PLAYER QUESTION / GUESS ===
"${userQ}"

Use the dossier and previous conversation context (e.g., if the user references previous questions like "are they still alive" or "does he also...") to evaluate this question accurately.
Respond with JSON:`;

  if (appStore.similarityProvider === 'gemini') {
    try {
      const { parsed } = await callGeminiJSON(systemPrompt, userPrompt, 0.2);
      return parsed;
    } catch (err) {
      console.warn('[Solo Ask Gemini failed, falling back to Ollama]', err.message);
    }
  }

  // Ollama fallback
  const ollamaResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SMART_MODEL,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options: {
        num_ctx: 2048,
        temperature: 0.2,
        num_predict: 140,
      },
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!ollamaResponse.ok) {
    throw new Error(`Ollama returned ${ollamaResponse.status}`);
  }

  const data = await ollamaResponse.json();
  const rawContent = data?.message?.content || '{}';
  return JSON.parse(rawContent);
}

function sanitizeSoloAnswer(rawAnswer, verdict, userQ, char) {
  if (!rawAnswer) return rawAnswer;
  let cleaned = rawAnswer.trim();

  if (verdict === 'INVALID' || verdict === 'GUESSED') {
    return cleaned;
  }

  // 1. Strip explanatory clauses like "because", "since", "as", etc.
  cleaned = cleaned.replace(/([,;:—–-]\s*)(?:because|since|as|for|given that|due to|they\s+are\s+a|they're\s+a)\b.*$/i, '.');

  // 2. For NO answers: allow only safe adverbs/modifiers after comma, strip any noun/entity explanation:
  // e.g. "❌ Nope, cars don't run!" -> "❌ Nope."
  // e.g. "🙅 No, fish swim!" -> "🙅 No."
  // e.g. "❌ Nope, not at all." -> "❌ Nope, not at all." (preserved!)
  if (verdict === 'NO' || /\bno(pe)?\b/i.test(cleaned)) {
    const safeNoPattern = /^([^\w\s]*\s*(?:no|nope|definitely not|close, but no|hardly))\s*,\s*(not at all|definitely not|not quite|they don't|they do not|not really|not even close)[.!]?$/i;
    const genericNoMatch = cleaned.match(/^([^\w\s]*\s*(?:no|nope|definitely not|close, but no|hardly))\s*,\s*(.+)$/i);
    if (genericNoMatch && !safeNoPattern.test(cleaned)) {
      cleaned = genericNoMatch[1].trim() + '.';
    }
  }

  // 3. For YES answers: allow only safe adverbs/modifiers after comma, strip unsolicited lore explanations:
  if (verdict === 'YES' || /\byes\b/i.test(cleaned)) {
    const safeYesPattern = /^([^\w\s]*\s*yes)\s*,\s*(absolutely|definitely|that's right|that is correct|they do|they are|in a sense|indeed|for sure|nailed it|spot on)[.!]?(\s*(nailed it|spot on|great job|you got it)[.!]?)?$/i;
    const genericYesMatch = cleaned.match(/^([^\w\s]*\s*yes)\s*,\s*(.+)$/i);
    if (genericYesMatch && !safeYesPattern.test(cleaned)) {
      cleaned = genericYesMatch[1].trim() + '!';
    }
  }

  // 4. Scrub character name if leaked prematurely
  if (char && char.name) {
    const nameRegex = new RegExp(`\\b${char.name.replace(/[^a-z0-9]/gi, '\\s*')}\\b`, 'gi');
    cleaned = cleaned.replace(nameRegex, 'the secret character');
  }

  cleaned = cleaned.replace(/\s+\./g, '.').replace(/\.+$/, '.');
  if (!/[.!?]$/.test(cleaned)) {
    cleaned += '.';
  }

  return cleaned;
}

app.post('/api/solo/ask', async (req, res) => {
  const { sessionId, question } = req.body || {};
  if (!sessionId || !soloSessions.has(sessionId)) {
    return res.status(404).json({ error: 'Solo game session not found. Please start a new game.' });
  }
  const userQ = (question || '').trim();
  if (!userQ) {
    return res.status(400).json({ error: 'Please enter a question or character guess.' });
  }

  // Detect when the user enters an incomplete thought or grammatical fragment
  if (isIncompleteInput(userQ)) {
    return res.json({
      answer: "✍️ It looks like your thought isn't finished! Take your time and complete your question.",
      verdict: 'INCOMPLETE',
      incomplete: true,
      heat: 'neutral',
      guessed: false,
    });
  }

  // Detect open-ended / non-Yes-or-No questions early
  if (isNonYesNoQuestion(userQ)) {
    return res.json({
      answer: "⚠️ In Guess Who, you can only ask Yes/No questions! (e.g. instead of 'What color is their hair?', ask 'Do they have black hair?')",
      verdict: 'INVALID',
      invalid: true,
      heat: 'neutral',
      guessed: false,
    });
  }

  const session = soloSessions.get(sessionId);
  const char = session.character;

  // 1. Direct deterministic name guess check
  const cleanName = char.name.replace(/\s*\([^)]+\)$/, '').trim().toLowerCase();
  const nameParts = cleanName.split(/\s+/).filter((p) => p.length >= 3 && !/^(the|and|mr|mrs|dr|sir)$/i.test(p));
  const qNorm = userQ.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const isDirectFullMatch = qNorm.includes(cleanName.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim());
  const isDistinctFirstOrLastMatch =
    nameParts.length > 0 &&
    nameParts.some((part) => part.length >= 4 && new RegExp(`\\b${part}\\b`, 'i').test(qNorm)) &&
    (/\b(is it|are you|guess|character)\b/i.test(qNorm) || qNorm.split(' ').length <= 4);

  if (isDirectFullMatch || isDistinctFirstOrLastMatch) {
    return res.json({
      answer: `🎉 Yes! You guessed it — the character is ${char.name}!`,
      verdict: 'GUESSED',
      heat: 'hot',
      guessed: true,
      character: {
        name: char.name,
        series: char.series,
        image: char.image,
      },
    });
  }

  try {
    const parsed = await askAIAboutSoloCharacter(char, userQ, session.history);
    const guessed = Boolean(parsed.guessed || parsed.verdict === 'GUESSED');
    let verdict = (parsed.verdict || '').toUpperCase();
    let answer = (parsed.answer || '').trim();
    let heat = (parsed.heat || 'neutral').toLowerCase().trim();

    if (verdict === 'INVALID' || parsed.invalid) {
      return res.json({
        answer: answer || "⚠️ In Guess Who, you can only ask Yes/No questions! (e.g. instead of 'What color is their hair?', ask 'Do they have black hair?')",
        verdict: 'INVALID',
        invalid: true,
        heat: 'neutral',
        guessed: false,
      });
    }

    if (guessed) {
      return res.json({
        answer: `🎉 Yes! You guessed it — the character is ${char.name}!`,
        verdict: 'GUESSED',
        heat: 'hot',
        guessed: true,
        character: {
          name: char.name,
          series: char.series,
          image: char.image,
        },
      });
    }

    if (!['YES', 'NO', 'UNKNOWN'].includes(verdict)) {
      if (/\byes\b/i.test(answer)) verdict = 'YES';
      else if (/\bno(pe)?\b/i.test(answer)) verdict = 'NO';
      else verdict = 'UNKNOWN';
    }

    if (!answer) {
      if (verdict === 'YES') answer = '👍 Yes, that is correct.';
      else if (verdict === 'NO') answer = '🙅 No, that is not correct.';
      else answer = "🤷 Hard to say / rarely mentioned in canon.";
    } else {
      answer = sanitizeSoloAnswer(answer, verdict, userQ, char);
    }

    if (!['hot', 'warm', 'neutral', 'cold'].includes(heat)) {
      heat = 'neutral';
    }

    // Programmatic safeguard: standard demographic screening must NEVER be hot or warm
    if (isStandardDemographicQuestion(userQ)) {
      heat = 'neutral';
    }

    session.history.push({ question: userQ, answer, heat, verdict });

    res.json({
      answer,
      verdict,
      heat,
      guessed: false,
    });
  } catch (err) {
    console.error('[Solo Ask Error]', err);
    res.status(500).json({ error: 'Failed to evaluate question with AI.' });
  }
});

app.post('/api/solo/reveal', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId || !soloSessions.has(sessionId)) {
    return res.status(404).json({ error: 'Solo game session not found.' });
  }
  const session = soloSessions.get(sessionId);
  session.revealed = true;
  const char = session.character;
  res.json({
    character: {
      name: char.name,
      series: char.series,
      image: char.image,
    },
  });
});

// Share Solo Mode Game Chat
app.post('/api/solo/share', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId || !soloSessions.has(sessionId)) {
    return res.status(404).json({ error: 'Solo session not found or expired.' });
  }

  const session = soloSessions.get(sessionId);
  if (!session.history || session.history.length === 0) {
    return res.status(400).json({ error: 'No questions have been asked in this game yet.' });
  }

  const shareId = crypto.randomUUID().slice(0, 8);
  const isGuessed = session.history.some((h) => h.verdict === 'GUESSED');

  const shareRecord = {
    shareId,
    createdAt: Date.now(),
    character: {
      name: session.character.name,
      series: session.character.series,
      image: session.character.image,
    },
    guessed: isGuessed,
    revealed: Boolean(session.revealed),
    history: session.history,
    questionCount: session.history.length,
  };

  appStore.soloShares.unshift(shareRecord);
  if (appStore.soloShares.length > 500) {
    appStore.soloShares = appStore.soloShares.slice(0, 500);
  }
  saveStore(appStore);

  // Generate copyable text summary
  let summaryText = `Guess Who (Solo Mode)\n`;
  if (isGuessed) {
    summaryText += `🎉 Guessed ${session.character.name} in ${session.history.length} questions!\n\n`;
  } else if (session.revealed) {
    summaryText += `Revealed ${session.character.name} after ${session.history.length} questions.\n\n`;
  } else {
    summaryText += `Playing Solo Mode (${session.history.length} questions asked so far)\n\n`;
  }

  session.history.forEach((h, idx) => {
    let heatIcon = '';
    if (h.heat === 'hot') heatIcon = ' 🔥';
    else if (h.heat === 'warm') heatIcon = ' ♨️';
    else if (h.heat === 'cold') heatIcon = ' ❄️';

    let verdictIcon = '❓';
    if (h.verdict === 'GUESSED') verdictIcon = '🎉';
    else if (h.verdict === 'YES') verdictIcon = '👍';
    else if (h.verdict === 'NO') verdictIcon = '🙅';

    summaryText += `${idx + 1}. ${h.question} -> ${verdictIcon}${heatIcon}\n`;
  });

  const shareUrl = `https://guesswho.gian.ink/?share=${shareId}`;
  summaryText += `\nView full chat: ${shareUrl}`;

  res.json({
    ok: true,
    shareId,
    shareUrl,
    summaryText,
    data: shareRecord,
  });
});

// Retrieve a shared solo game session
app.get('/api/solo/share/:shareId', (req, res) => {
  const { shareId } = req.params;
  const found = appStore.soloShares.find((s) => s.shareId === shareId);
  if (!found) {
    return res.status(404).json({ error: 'Shared game chat not found.' });
  }
  res.json({ ok: true, share: found });
});

// ============================================================================
// 2-PLAYER CHARACTER QUESTION HELPER (Ask AI about Player 1 or Player 2 char)
// ============================================================================

app.post('/api/character/ask', async (req, res) => {
  const { character, question } = req.body || {};
  const userQ = (question || '').trim();
  if (!character?.name || !userQ) {
    return res.status(400).json({ error: 'Character and question are required.' });
  }

  try {
    const dossier = await buildDeepCharacterDossier(character);
    if (!dossier.hasVerifiedInfo) {
      return res.json({
        answer: "I don't know (I don't have enough verified info on this character).",
      });
    }

    const systemPrompt = `You are a factual helper in a two-player Guess Who game.
A player is asking a question about a secret character because they aren't sure of the answer themselves.
Use the provided Character Dossier and 100% certain canonical facts about the character (for example, One Piece Devil Fruit users cannot swim and sink in seawater; Batman is a human with no superpowers; SpongeBob is a yellow sea sponge who works as a fry cook).

STRICT RULES (NO HALLUCINATION, NO SPOILERS):
1. First write "REASONING:" with 1 short sentence checking the character's dossier and canonical traits/weaknesses.
2. On a new line write "ANSWER:" followed by ONLY "Yes.", "No.", or "I don't know."
3. If the dossier does not say and you are not 100% certain, DO NOT GUESS! Output "ANSWER: I don't know."`;

    const userPrompt = `Character: ${dossier.name} (${dossier.series})
Dossier:
${dossier.description.slice(0, 1200)}

Question: "${userQ}"`;

    const ollamaResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SMART_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options: {
          num_ctx: 2048,
          temperature: 0.1,
          num_predict: 90,
        },
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!ollamaResponse.ok) {
      throw new Error(`Ollama returned ${ollamaResponse.status}`);
    }

    const data = await ollamaResponse.json();
    const raw = (data?.message?.content || '').trim();
    const ansMatch = raw.match(/ANSWER\s*:\s*([^\n]+)/i);
    const ansText = (ansMatch ? ansMatch[1] : raw).trim();

    let finalAnswer = "I don't know (not enough confirmed info).";
    if (/^yes\b/i.test(ansText)) {
      finalAnswer = 'Yes.';
    } else if (/^no\b/i.test(ansText)) {
      finalAnswer = 'No.';
    }

    res.json({ answer: finalAnswer });
  } catch (err) {
    console.error('[Character Ask Error]', err);
    res.status(500).json({ error: 'Failed to check character fact with AI.' });
  }
});

// ============================================================================
// 2-STAGE AI SIMILARITY PIPELINE:
//   Stage 1 (Brainstormer AI): Generates 15 candidate single-trait clues
//   Stage 2 (Judge/Selector AI): Fact-checks, filters out giveaways/multi-clues,
//                                and picks the best 1 clue for LVL 1, LVL 2, LVL 3
// ============================================================================

async function callGeminiJSON(systemText, userText, temperature = 0.35) {
  let lastErr = null;
  for (const modelName of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature,
          },
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!res.ok) {
        const errText = await res.text();
        lastErr = new Error(`${modelName} returned ${res.status}: ${errText.slice(0, 120)}`);
        continue;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return { parsed: JSON.parse(text), modelUsed: modelName };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

async function generateSimilarityWithGemini(c1, c2, avoidCluesText) {
  // STAGE 1: Brainstormer AI generates 15 distinct, deep in-universe canonical similarities
  const brainstormSysPrompt = `You are a master pop culture trivia expert and game designer for a two-player Guess Who character game.
Given two characters, brainstorm 15 GENUINE, INTERESTING, and CANONICALLY ACCURATE similarities that BOTH characters share in their lore.

CRITICAL INSTRUCTION - TAP INTO DEEP CANONICAL KNOWLEDGE:
Do NOT limit yourself to superficial stretches or any brief context snippet!
Draw upon your vast canonical knowledge of both characters across their entire franchise history:
- Deep lore & family: siblings, twin brother/sister, parents, uncles, mentors, pets
- Origins & geography: moving away from home states (e.g. Texas, California) or living in strange/isolated environments
- Personality, intellect & habits: logical thinkers, documenting discoveries, research journals, fears, favorite foods, catchphrases
- Wardrobe & signature equipment: signature hats, headgear, gear, tools, weapons, distinct color schemes
- Dynamics & relationships: being the voice of reason to chaotic/naive best friends, protecting others, fighting monsters

NO SUPERFICIAL STRETCHES:
Do NOT invent weak, generic stretches (like "both wear heavy footwear", "both study weird biology", or "both build complex machines"). Find real, surprising, and distinct facts that are 100% canonically true for BOTH characters!

STRICT RULES:
1. 100% IN-UNIVERSE: Never mention meta facts (NEVER write "Both are cartoon/anime characters", "Both star in animated series", "Both appear in games", "Both are fictional"). Clues must describe their real lives, bodies, actions, diet, appearance, or world!
2. 100% CANONICALLY TRUE for both characters.
3. Exactly 4 to 6 words starting with "Both" or "Neither".
4. ONLY ONE SINGLE TRAIT per sentence! Never stack multiple adjectives.
5. Never mention character names, series names, or franchise lore terms ("bend", "Force", "chakra", "Devil Fruit").
6. If you do not know one of the characters at all, set "known_info": false.${avoidCluesText}

Return ONLY valid JSON:
{
  "known_info": true,
  "candidates": [
    "Both ...",
    "Both ...",
    "... (15 total)"
  ]
}`;

  const userText = `Character 1: ${c1.name} (${c1.series})
${c1.description ? `Background Context: ${c1.description.slice(0, 1000)}` : ''}

Character 2: ${c2.name} (${c2.series})
${c2.description ? `Background Context: ${c2.description.slice(0, 1000)}` : ''}`;

  const stage1 = await callGeminiJSON(brainstormSysPrompt, userText, 0.35);
  if (stage1.parsed.known_info === false) {
    const msg = "I don't have enough verified info on these characters to find a connection.";
    return { known: false, levels: { 1: msg, 2: msg, 3: msg }, provider: `gemini (${stage1.modelUsed})` };
  }

  const rawCandidates = Array.isArray(stage1.parsed.candidates) ? stage1.parsed.candidates : [];
  const candidates = rawCandidates
    .map((c) => cleanSimilarityOutput(c, c1, c2))
    .filter((c) => c && c.split(/\s+/).length >= 3);

  // STAGE 2: Judge AI evaluates difficulty: Level 1 (Obscure), Level 2 (Regular), Level 3 (Obvious)
  const judgeSysPrompt = `You are the Judge AI for a two-player Guess Who character game.
Review the candidate clues below for Character 1 and Character 2.

CRITICAL JUDGING & DIFFICULTY RULES:
1. STRICT DUAL-CHARACTER FACT-CHECK:
   - Verify that the clue is 100% true for BOTH Character 1 AND Character 2!
   - If a place name, origin, or attribute only applies to ONE character (e.g. Dipper is from California, not Texas; only Sandy is from Texas), REJECT IT IMMEDIATELY! Only allow traits true for both.
   - Reject any clue that is false, hallucinated, or a weak/superficial stretch (e.g. reject "Both wear heavy footwear", "Both study weird biology").
   - Reject any out-of-universe meta clues (never mention cartoons, anime, media, fiction, series, or video games).
   - Reject any universe-specific negatives.${avoidCluesText ? `\n   - ${avoidCluesText.trim()}` : ''}
2. ENFORCE ONE SINGLE TRAIT (4-6 WORDS):
   - Rewrite any clue that stacks multiple traits so it states ONLY ONE single fact (e.g. "Both are brilliant strategists." NOT "Both are intelligent young male masterminds.").
3. STRICT DIFFICULTY CALIBRATION (Obscure, Regular, Obvious):
   The 3 levels represent PURELY GUESSABILITY DIFFICULTY and are NOT linked to any specific kind or category of tip:
   - "level_1" (Obscure): Hardest difficulty. An obscure, subtle commonality that is 100% canonically true for both, but very tough to deduce who the characters are from this clue alone.
   - "level_2" (Regular): Medium / standard difficulty. A balanced commonality that is a fair challenge—neither obscure nor an immediate dead giveaway.
   - "level_3" (Obvious): Easiest difficulty. An obvious, recognizable connection that points strongly toward who these characters are.

CRITICAL ANTI-GIVEAWAY RULE:
- NEVER link levels to specific tip categories (any level can draw from habits, powers, appearance, background, relationships, origin, etc.). The levels represent purely how Obscure, Regular, or Obvious the connection is!
- NEVER place an obvious giveaway into level_1 (Obscure) or level_2 (Regular)!
- Level 1 (Obscure) MUST be noticeably harder to deduce than Level 2 (Regular).
- Level 3 (Obvious) MUST be the easiest connection.

Return ONLY valid JSON:
{
  "level_1": "Both/Neither [Obscure - hardest to deduce]",
  "level_2": "Both/Neither [Regular - medium difficulty]",
  "level_3": "Both/Neither [Obvious - easiest to deduce]"
}`;

  const judgeUserText = `Character 1: ${c1.name} (${c1.series})
Character 2: ${c2.name} (${c2.series})

Candidate Clues to Judge:
${candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;

  const stage2 = await callGeminiJSON(judgeSysPrompt, judgeUserText, 0.1);
  const p2 = stage2.parsed || {};

  const l1 = cleanSimilarityOutput(p2.level_1 || '', c1, c2) || candidates[0] || '';
  const l2 = cleanSimilarityOutput(p2.level_2 || '', c1, c2) || candidates[1] || candidates[0] || '';
  const l3 = cleanSimilarityOutput(p2.level_3 || '', c1, c2) || candidates[candidates.length - 1] || candidates[2] || '';

  return {
    known: true,
    levels: {
      1: l1,
      2: l2,
      3: l3,
    },
    provider: `gemini 2-stage (${stage2.modelUsed})`,
  };
}

async function generateSimilarityWithOllama(c1, c2, avoidCluesText) {
  // STAGE 1: Ollama Brainstormer AI generates 15 candidate clues using deep canon knowledge
  const stage1Sys = `You are a master pop culture trivia expert and game designer for Guess Who.
Given two characters, write 15 numbered candidate similarities (1. to 15.) that BOTH characters genuinely share in canon lore.
Dig deep into canon: twin siblings, family, home states, relocations, journals, documenting anomalies, signature hats, fears, and relationships with naive friends.
Never make up weak stretches (like "both wear heavy footwear" or "both study weird biology").
RULES:
1. IN-UNIVERSE ONLY: Never write meta facts (e.g. "Both are cartoon characters" or "Both star in animated series"). Clues must describe their real lives, bodies, actions, diet, appearance, or world!
2. 100% CANONICALLY ACCURATE: Must be true for both characters based on their canon lore.
3. Each line must be 4 to 6 words starting with "Both" or "Neither" and stating ONLY ONE single trait.
4. Never mention character or series names.${avoidCluesText}
If you do not know one of the characters at all, write "UNKNOWN: true".`;

  const stage1User = `Character 1: ${c1.name} (${c1.series})
${c1.description ? `Background Context: ${c1.description.slice(0, 800)}` : ''}

Character 2: ${c2.name} (${c2.series})
${c2.description ? `Background Context: ${c2.description.slice(0, 800)}` : ''}

Write 15 numbered candidate clues (4-6 words each):`;

  const res1 = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SMART_MODEL,
      stream: false,
      options: { num_ctx: 2048, temperature: 0.35, repeat_penalty: 1.15, num_predict: 320 },
      messages: [
        { role: 'system', content: stage1Sys },
        { role: 'user', content: stage1User },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res1.ok) {
    throw new Error(`Ollama Stage 1 returned ${res1.status}`);
  }

  const data1 = await res1.json();
  const raw1 = data1?.message?.content || '';

  if (/UNKNOWN\s*:\s*true/i.test(raw1)) {
    const msg = "I don't have enough verified info on these characters to find a connection.";
    return { known: false, levels: { 1: msg, 2: msg, 3: msg }, provider: `ollama (${SMART_MODEL})` };
  }

  const candidateLines = raw1
    .split('\n')
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
    .map((line) => cleanSimilarityOutput(line, c1, c2))
    .filter((line) => /^(Both|Neither)\b/i.test(line) && line.split(/\s+/).length >= 3);

  // STAGE 2: Ollama Judge AI selects 1 for LVL 1 (Obscure), LVL 2 (Regular), and LVL 3 (Obvious)
  const stage2Sys = `You are the Judge AI for a Guess Who game.
Review the candidate clues below for ${c1.name} (${c1.series}) and ${c2.name} (${c2.series}).
1. STRICT DUAL-CHARACTER FACT-CHECK:
   - Verify the clue is 100% true for BOTH Character 1 AND Character 2. Reject if a specific place or name only belongs to one.
   - Reject any candidate that is false or a weak/superficial stretch.
2. Reject any meta clues mentioning cartoons, anime, media, fiction, or video games.
3. Reject universe-specific power negatives.${avoidCluesText ? `\n4. ${avoidCluesText.trim()}` : ''}
4. Ensure each chosen clue states ONLY ONE single trait in 4 to 6 words starting with Both or Neither.
5. Select 3 different clues with STRICT DIFFICULTY CALIBRATION (Obscure, Regular, Obvious):
   The levels are purely difficulty and are NOT linked to any specific tip category:
   - Line 1: Obscure (hardest difficulty to deduce, subtle connection).
   - Line 2: Regular (medium / standard difficulty, balanced clue).
   - Line 3: Obvious (easiest difficulty, obvious and easily recognizable connection).
   CRITICAL ANTI-GIVEAWAY: Never put an obvious connection in Line 1 or Line 2!

Output EXACTLY 3 lines in order from hardest to easiest giveaway, with NO prefixes, no numbering.`;

  const stage2User = `Candidate Clues:\n${(candidateLines.length ? candidateLines : [raw1]).map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nOutput the 3 chosen clue sentences in order from hardest to easiest now:`;

  const res2 = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SMART_MODEL,
      stream: false,
      options: { num_ctx: 2048, temperature: 0.1, repeat_penalty: 1.15, num_predict: 120 },
      messages: [
        { role: 'system', content: stage2Sys },
        { role: 'user', content: stage2User },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!res2.ok) {
    throw new Error(`Ollama Stage 2 returned ${res2.status}`);
  }

  const data2 = await res2.json();
  const raw2 = data2?.message?.content || '';

  const chosenLines = raw2
    .split('\n')
    .map((line) => line.replace(/^(\*?\*?LVL\s*\d+\*?\*?\s*:?|[-*•\d.)\s]+)/i, '').trim())
    .map((line) => cleanSimilarityOutput(line, c1, c2))
    .filter((line) => /^(Both|Neither)\b/i.test(line) && !line.includes('Both/Neither'));

  const l1 = chosenLines[0] || candidateLines[0] || '';
  const l2 = chosenLines[1] || candidateLines[1] || candidateLines[0] || '';
  const l3 = chosenLines[2] || candidateLines[candidateLines.length - 1] || candidateLines[2] || candidateLines[1] || '';

  return {
    known: true,
    levels: {
      1: l1,
      2: l2,
      3: l3,
    },
    provider: `ollama 2-stage (${SMART_MODEL})`,
  };
}

async function generateMultiplayerSimilarityWithGemini(characters, avoidCluesText) {
  const maxClues = Math.max(1, Math.floor(characters.length / 2));

  // STAGE 1: Gemini Brainstormer AI
  const brainstormSysPrompt = `You are a master pop culture trivia expert and game designer for a multiplayer (${characters.length} players) Guess Who character game.
There are ${characters.length} secret characters chosen by different players.
Your mission is to brainstorm candidate clues describing commonalities or traits among these characters.

CRITICAL RULES FOR MULTIPLAYER CLUES:
1. QUANTIFIED PHRASING:
   - If ALL ${characters.length} characters share a trait: start with "All of your characters..." (e.g. "All of your characters have magical powers.").
   - If a SUBSET of characters shares a trait: start with "X of your characters..." (e.g. "Two of your characters wear white shirts.", "Three of your characters live underground.", "One of your characters is an alien.").
   - If none share a trait: start with "None of your characters...".
   - NEVER name character names, series names, or player numbers!
2. 100% IN-UNIVERSE: Never mention meta facts (NEVER write "animated series", "video games", "cartoons", "fictional", "anime"). Clues must describe their real lives, bodies, abilities, attire, jobs, diet, or universe lore!
3. 100% CANONICALLY TRUE for the exact number of characters claimed.
4. Each clue must be 4 to 8 words and state ONLY ONE SINGLE TRAIT.
5. If you do not know multiple characters, set "known_info": false.${avoidCluesText}

Return ONLY valid JSON:
{
  "known_info": true,
  "candidates": [
    "All of your characters ...",
    "Two of your characters ...",
    "One of your characters ...",
    "... (15 candidate clues total)"
  ]
}`;

  const userText = characters
    .map((c, i) => `Character ${i + 1}: ${c.name} (${c.series})\n${c.description ? `Background Context: ${c.description.slice(0, 600)}` : ''}`)
    .join('\n\n');

  const stage1 = await callGeminiJSON(brainstormSysPrompt, userText, 0.35);
  if (stage1.parsed.known_info === false) {
    const msg = "I don't have enough verified info on these characters to find a connection.";
    return { known: false, levels: { 1: [msg], 2: [msg], 3: [msg] }, provider: `gemini (${stage1.modelUsed})` };
  }

  const rawCandidates = Array.isArray(stage1.parsed.candidates) ? stage1.parsed.candidates : [];
  const candidates = rawCandidates
    .map((c) => cleanSimilarityOutput(c, characters))
    .filter((c) => c && c.split(/\s+/).length >= 3);

  // STAGE 2: Judge AI evaluates difficulty: Level 1 (Obscure), Level 2 (Regular), Level 3 (Obvious)
  const judgeSysPrompt = `You are the Judge AI for a multiplayer (${characters.length} players) Guess Who character game.
Review the candidate clues below for the ${characters.length} characters.
Your goal is to select clues for 3 difficulty levels:
- "level_1" (Obscure): Hardest difficulty. Obscure or subtle connections that are 100% canonically true, but tough to deduce.
- "level_2" (Regular): Medium difficulty. Balanced connections.
- "level_3" (Obvious): Easiest difficulty. Obvious, recognizable traits.

RULES FOR CLUE SELECTION:
1. Target clue count per level: up to ${maxClues} clues (minimum 1 clue).
   - If there is a strong universal clue ("All of your characters..."), you can output just that 1 universal clue.
   - If traits are divided across subsets (e.g. "Three of your characters..." and "Two of your characters..."), output up to ${maxClues} clues that complement each other.
2. Fact-check strictly against all characters. Verify the count (e.g. if it says "Two of your characters", ensure the count matches).
3. Clues must start with "All of your characters", "X of your characters", "One of your characters", or "None of your characters".
4. Never mention character names, series, or player numbers!
5. PURE DIFFICULTY CALIBRATION:
   - level_1 MUST be obscure/challenging.
   - level_2 is medium/standard.
   - level_3 is obvious/easy.

Return ONLY valid JSON:
{
  "level_1": ["Clue 1", "Clue 2"],
  "level_2": ["Clue 1", "Clue 2"],
  "level_3": ["Clue 1", "Clue 2"]
}`;

  const judgeUserText = `Characters:
${characters.map((c, i) => `Character ${i + 1}: ${c.name} (${c.series})`).join('\n')}

Candidate Clues to Judge:
${candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;

  const stage2 = await callGeminiJSON(judgeSysPrompt, judgeUserText, 0.1);
  const p2 = stage2.parsed || {};

  function parseClues(val, fallbackIdx) {
    let list = [];
    if (Array.isArray(val)) {
      list = val;
    } else if (typeof val === 'string' && val.trim()) {
      list = val.split('\n');
    }
    const cleaned = list
      .map((c) => cleanSimilarityOutput(c, characters))
      .filter((c) => c && c.split(/\s+/).length >= 3);
    if (cleaned.length > 0) return cleaned.slice(0, maxClues);
    if (candidates[fallbackIdx]) return [candidates[fallbackIdx]];
    if (candidates[0]) return [candidates[0]];
    return ["All of your characters share a mysterious connection."];
  }

  const l1 = parseClues(p2.level_1, 0);
  const l2 = parseClues(p2.level_2, 1);
  const l3 = parseClues(p2.level_3, candidates.length - 1);

  return {
    known: true,
    levels: {
      1: l1,
      2: l2,
      3: l3,
    },
    provider: `gemini 2-stage (${stage2.modelUsed})`,
  };
}

async function generateMultiplayerSimilarityWithOllama(characters, avoidCluesText) {
  const maxClues = Math.max(1, Math.floor(characters.length / 2));

  // STAGE 1: Ollama Brainstormer AI
  const stage1Sys = `You are a master pop culture trivia expert and game designer for a multiplayer (${characters.length} players) Guess Who game.
Given ${characters.length} characters, write 15 numbered candidate similarities (1. to 15.) that describe commonalities or subset traits among them.
RULES:
1. QUANTIFIED PHRASING:
   - "All of your characters [verb]..." if all share it.
   - "X of your characters [verb]..." (e.g. "Two of your characters...", "Three of your characters...", "One of your characters...") if a subset shares it.
2. IN-UNIVERSE ONLY: Never write meta facts (no "cartoon", "anime", "video game", "series"). Describe their canon abilities, appearance, jobs, or traits.
3. 100% CANONICALLY ACCURATE.
4. Each line must be 4 to 8 words and state ONLY ONE single trait.
5. Never mention character or series names or player numbers.${avoidCluesText}
If you do not know multiple characters, write "UNKNOWN: true".`;

  const stage1User = `Characters:
${characters.map((c, i) => `Character ${i + 1}: ${c.name} (${c.series})\n${c.description ? `Background Context: ${c.description.slice(0, 500)}` : ''}`).join('\n\n')}

Write 15 numbered candidate clues (4-8 words each):`;

  const res1 = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SMART_MODEL,
      stream: false,
      options: { num_ctx: 2048, temperature: 0.35, repeat_penalty: 1.15, num_predict: 350 },
      messages: [
        { role: 'system', content: stage1Sys },
        { role: 'user', content: stage1User },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res1.ok) {
    throw new Error(`Ollama Stage 1 returned ${res1.status}`);
  }

  const data1 = await res1.json();
  const raw1 = data1?.message?.content || '';

  if (/UNKNOWN\s*:\s*true/i.test(raw1)) {
    const msg = "I don't have enough verified info on these characters to find a connection.";
    return { known: false, levels: { 1: [msg], 2: [msg], 3: [msg] }, provider: `ollama (${SMART_MODEL})` };
  }

  const candidateLines = raw1
    .split('\n')
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
    .map((line) => cleanSimilarityOutput(line, characters))
    .filter((line) => line.split(/\s+/).length >= 3);

  // STAGE 2: Ollama Judge AI
  const stage2Sys = `You are the Judge AI for a multiplayer Guess Who game with ${characters.length} players.
Review the candidate clues below. Select clues for:
- LVL 1 (Obscure): hardest difficulty, subtle trait
- LVL 2 (Regular): medium difficulty, balanced trait
- LVL 3 (Obvious): easiest difficulty, obvious trait

Output up to ${maxClues} clues per level.
Prefix each line with "LVL 1:", "LVL 2:", or "LVL 3:".`;

  const stage2User = `Candidate Clues:\n${(candidateLines.length ? candidateLines : [raw1]).map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nOutput the chosen clues:`;

  const res2 = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SMART_MODEL,
      stream: false,
      options: { num_ctx: 2048, temperature: 0.1, repeat_penalty: 1.15, num_predict: 200 },
      messages: [
        { role: 'system', content: stage2Sys },
        { role: 'user', content: stage2User },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!res2.ok) {
    throw new Error(`Ollama Stage 2 returned ${res2.status}`);
  }

  const data2 = await res2.json();
  const raw2 = data2?.message?.content || '';

  const l1 = [];
  const l2 = [];
  const l3 = [];

  raw2.split('\n').forEach((line) => {
    const m = line.match(/^LVL\s*([123])\s*:\s*(.*)/i);
    if (m) {
      const lvl = m[1];
      const cleaned = cleanSimilarityOutput(m[2], characters);
      if (cleaned) {
        if (lvl === '1') l1.push(cleaned);
        else if (lvl === '2') l2.push(cleaned);
        else if (lvl === '3') l3.push(cleaned);
      }
    }
  });

  const fallback = candidateLines.slice(0, maxClues);
  return {
    known: true,
    levels: {
      1: l1.length ? l1.slice(0, maxClues) : fallback,
      2: l2.length ? l2.slice(0, maxClues) : fallback,
      3: l3.length ? l3.slice(0, maxClues) : fallback,
    },
    provider: `ollama 2-stage (${SMART_MODEL})`,
  };
}

app.post('/api/similarity', async (req, res) => {
  const { char1, char2, characters: inputCharacters, level = 2, previousClues = [] } = req.body || {};

  const isMultiplayer = Array.isArray(inputCharacters) && inputCharacters.length >= 3;

  if (!isMultiplayer && (!char1?.name || !char2?.name)) {
    return res.status(400).json({ error: 'Both Player 1 and Player 2 characters are required (or at least 3 characters for Party Mode).' });
  }

  const revealLevel = Math.min(3, Math.max(1, Number(level) || 2));

  try {
    if (isMultiplayer) {
      const charList = await Promise.all(
        inputCharacters.map((c) => buildDeepCharacterDossier(c))
      );

      const unknownChars = charList.filter((c) => !c.hasVerifiedInfo);
      if (unknownChars.length > 0) {
        const unknownNames = unknownChars.map((c) => `"${c.name}"`).join(', ');
        const msg = `I don't know enough verified info about ${unknownNames} to find connections.`;
        return res.json({
          similarity: msg,
          clues: [msg],
          levels: { 1: [msg], 2: [msg], 3: [msg] },
          level: revealLevel,
          unknownCharacter: true,
        });
      }

      const avoidCluesText =
        Array.isArray(previousClues) && previousClues.length > 0
          ? `\nDo NOT repeat or paraphrase any of these previous clues: ${previousClues.map((c) => `"${c}"`).join(', ')}.`
          : '';

      let result;
      if (appStore.similarityProvider === 'gemini') {
        try {
          result = await generateMultiplayerSimilarityWithGemini(charList, avoidCluesText);
        } catch (gemErr) {
          console.warn('[Gemini Fallback to Ollama for Multiplayer]', gemErr.message);
          result = await generateMultiplayerSimilarityWithOllama(charList, avoidCluesText);
        }
      } else {
        result = await generateMultiplayerSimilarityWithOllama(charList, avoidCluesText);
      }

      const parsedLevels = result.levels;
      const defaultClue = ["I don't have enough verified info to find a connection."];
      if (!parsedLevels[1] || parsedLevels[1].length === 0) parsedLevels[1] = parsedLevels[2] || defaultClue;
      if (!parsedLevels[2] || parsedLevels[2].length === 0) parsedLevels[2] = parsedLevels[1] || defaultClue;
      if (!parsedLevels[3] || parsedLevels[3].length === 0) parsedLevels[3] = parsedLevels[2] || defaultClue;

      const currentClues = parsedLevels[revealLevel] || parsedLevels[2] || defaultClue;

      return res.json({
        similarity: currentClues.join(' '),
        clues: currentClues,
        levels: parsedLevels,
        level: revealLevel,
        model: result.provider,
      });
    }

    const [c1, c2] = await Promise.all([
      buildDeepCharacterDossier(char1),
      buildDeepCharacterDossier(char2),
    ]);

    if (!c1.hasVerifiedInfo || !c2.hasVerifiedInfo) {
      const unknownNames = [
        !c1.hasVerifiedInfo ? `"${c1.name}"` : null,
        !c2.hasVerifiedInfo ? `"${c2.name}"` : null,
      ]
        .filter(Boolean)
        .join(' and ');
      const msg = `I don't know enough verified info about ${unknownNames} to find a connection.`;
      return res.json({
        similarity: msg,
        clues: [msg],
        levels: { 1: msg, 2: msg, 3: msg },
        level: revealLevel,
        unknownCharacter: true,
      });
    }

    const avoidCluesText =
      Array.isArray(previousClues) && previousClues.length > 0
        ? `\nDo NOT repeat or paraphrase any of these previous clues: ${previousClues.map((c) => `"${c}"`).join(', ')}.`
        : '';

    let result;
    if (appStore.similarityProvider === 'gemini') {
      try {
        result = await generateSimilarityWithGemini(c1, c2, avoidCluesText);
      } catch (gemErr) {
        console.warn('[Gemini Fallback to Ollama]', gemErr.message);
        result = await generateSimilarityWithOllama(c1, c2, avoidCluesText);
      }
    } else {
      result = await generateSimilarityWithOllama(c1, c2, avoidCluesText);
    }

    const parsedLevels = result.levels;
    const anyValid =
      parsedLevels[2] ||
      parsedLevels[3] ||
      parsedLevels[1] ||
      "I don't have enough verified info to find a connection.";
    if (!parsedLevels[1]) parsedLevels[1] = anyValid;
    if (!parsedLevels[2]) parsedLevels[2] = anyValid;
    if (!parsedLevels[3]) parsedLevels[3] = anyValid;

    const currentClue = parsedLevels[revealLevel];
    res.json({
      similarity: currentClue,
      clues: [currentClue],
      levels: parsedLevels,
      level: revealLevel,
      model: result.provider,
    });
  } catch (err) {
    console.error('[Similarity Error]', err);
    res.status(500).json({
      error: 'Failed to generate similarity.',
      details: err.message,
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Guess Who server listening on http://0.0.0.0:${PORT}`);
  console.log(`Ollama endpoint: ${OLLAMA_URL} (Model: ${SMART_MODEL})`);
});
