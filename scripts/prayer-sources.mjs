/**
 * Source acquisition helpers for the prayer-location dataset.
 *
 * Every raw input used by `scripts/build-prayer-locations.mjs` is downloaded
 * once into a local cache directory and re-used on later runs, so the build is
 * reproducible and cheap to re-run:
 *
 *   PRAYER_SOURCE_CACHE=/custom/dir   # where raw inputs are cached
 *   PRAYER_SOURCE_REFRESH=1           # force a fresh download
 *
 * The generated data under `database/prayer/` is committed to the repository,
 * so consumers (and the API) never need these raw files.
 */
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';

export const CACHE_DIR =
    process.env.PRAYER_SOURCE_CACHE || path.join(os.tmpdir(), 'raheq-prayer-sources');

const REFRESH = process.env.PRAYER_SOURCE_REFRESH === '1';

const USER_AGENT =
    'raheq-data-dataset-builder/1.0 (+https://github.com/Nothamod6R/raheq-data)';

/** Raw inputs downloaded over HTTP. */
export const REMOTE_FILES = {
    cities: {
        file: 'cities15000.zip',
        entry: 'cities15000.txt',
        url: 'https://download.geonames.org/export/dump/cities15000.zip',
    },
    alternateNames: {
        file: 'alternateNamesV2.zip',
        entry: 'alternateNamesV2.txt',
        url: 'https://download.geonames.org/export/dump/alternateNamesV2.zip',
    },
    timezones: {
        file: 'timeZones.txt',
        url: 'https://download.geonames.org/export/dump/timeZones.txt',
    },
    countries: {
        file: 'countryInfo.txt',
        url: 'https://download.geonames.org/export/dump/countryInfo.txt',
    },
    regions: {
        file: 'admin1CodesASCII.txt',
        url: 'https://download.geonames.org/export/dump/admin1CodesASCII.txt',
    },
    cldrArabicTerritories: {
        file: 'cldr_ar_territories.json',
        url: 'https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-localenames-full/main/ar/territories.json',
    },
};


/**
 * Provenance metadata for every upstream source. Written verbatim into
 * `database/prayer/meta.json` so the dataset is self-describing.
 */
export const SOURCE_REGISTRY = [
    {
        id: 'geonames-cities',
        name: 'GeoNames gazetteer — cities15000 (cities with population > 15 000, plus capitals)',
        url: 'https://download.geonames.org/export/dump/',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        usedFor: [
            'city names',
            'coordinates',
            'population',
            'country code',
            'IANA timezone',
            'admin1 region identifier',
        ],
    },
    {
        id: 'geonames-alternatenames',
        name: 'GeoNames alternateNamesV2 — language-tagged alternate names (isolanguage = ar)',
        url: 'https://download.geonames.org/export/dump/',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        usedFor: ['Arabic city names (primary source)'],
    },
    {
        id: 'geonames-countryinfo',
        name: 'GeoNames countryInfo — ISO 3166-1 alpha-2/alpha-3 codes, country names and continent codes',
        url: 'https://download.geonames.org/export/dump/',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        usedFor: ['country codes', 'English country names', 'continent codes'],
    },
    {
        id: 'geonames-timezones',
        name: 'GeoNames timeZones — country/IANA zone rows with January, July and DST-independent GMT offsets',
        url: 'https://download.geonames.org/export/dump/',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        usedFor: ['cross-checking the standard-time (raw) UTC offset of every IANA zone'],
    },
    {
        id: 'geonames-admin1',
        name: 'GeoNames admin1CodesASCII — English names for first-level administrative divisions',
        url: 'https://download.geonames.org/export/dump/',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        usedFor: ['readable region/state names for cities'],
    },
    {
        id: 'wikidata',
        name: 'Wikidata — Arabic labels (rdfs:label @ar) resolved through property P1566 (GeoNames ID)',
        url: 'https://query.wikidata.org/',
        license: 'CC0 1.0',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        usedFor: ['Arabic city names (secondary source, only when GeoNames has none)'],
    },
    {
        id: 'cldr',
        name: 'Unicode CLDR — cldr-localenames-full/main/ar/territories (Arabic territory names)',
        url: 'https://github.com/unicode-org/cldr-json',
        license: 'Unicode License v3',
        licenseUrl: 'https://www.unicode.org/license.txt',
        usedFor: ['Arabic country names'],
    },
    {
        id: 'aladhan',
        name: 'AlAdhan — published calculation-method definitions (method ids and twilight angles)',
        url: 'https://api.aladhan.com/v1/methods',
        license: 'Factual method definitions; API operated by Islamic Network (https://aladhan.com)',
        licenseUrl: 'https://aladhan.com/credits',
        usedFor: ['calculation-method ids, Fajr/Isha angles, Isha/Maghrib intervals'],
    },
    {
        id: 'adhan-js',
        name: 'batoulapps/adhan-js — open-source reference implementation of the same method set',
        url: 'https://github.com/batoulapps/adhan-js/blob/master/src/CalculationMethod.ts',
        license: 'MIT',
        licenseUrl: 'https://github.com/batoulapps/adhan-js/blob/master/LICENSE',
        usedFor: ['cross-checking method parameters and published method tunings'],
    },
    {
        id: 'salahtimes',
        name: 'Salah Times — published per-country default calculation method (239 countries)',
        url: 'https://www.salahtimes.com/countries',
        license: 'Cross-reference only; no content copied into this dataset',
        licenseUrl: 'https://www.salahtimes.com/privacy',
        usedFor: ['cross-checking the default country → calculation method mapping'],
    },
    {
        id: 'iana-tz',
        name: 'IANA time zone database, evaluated through the ICU/Intl implementation shipped with Node.js',
        url: 'https://www.iana.org/time-zones',
        license: 'Public domain',
        licenseUrl: 'https://www.iana.org/time-zones',
        usedFor: ['UTC offsets per IANA zone (winter/summer samples) and DST observance'],
    },
    {
        id: 'raheq-engine',
        name: 'raheq-data prayer-time engine (src/services/prayer-times.js) — the runtime that consumes this dataset',
        url: 'https://github.com/Nothamod6R/raheq-data/blob/main/src/services/prayer-times.js',
        license: 'ISC',
        licenseUrl: 'https://github.com/Nothamod6R/raheq-data/blob/main/package.json',
        usedFor: ['method keys, Asr madhab factors, and which parameters the runtime actually applies'],
    },
];

const exists = async (file) => {
    try {
        const info = await stat(file);
        return info.isFile() && info.size > 0;
    } catch {
        return false;
    }
};

const download = async (url, target) => {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok || !response.body) {
        throw new Error(`download failed (${response.status}) for ${url}`);
    }
    const partial = `${target}.part`;
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rename(partial, target);
};

/**
 * Returns the absolute path of a cached raw input, downloading it when needed.
 * @param {{file: string, url: string}} source one entry of {@link REMOTE_FILES}
 * @returns {Promise<string>} path inside {@link CACHE_DIR}
 */
export const ensureSource = async (source) => {
    const target = path.join(CACHE_DIR, source.file);
    if (!REFRESH && (await exists(target))) return target;
    await mkdir(CACHE_DIR, { recursive: true });
    process.stdout.write(`downloading ${source.url}\n`);
    await download(source.url, target);
    return target;
};

/** Reads a whole text entry out of a ZIP archive (requires the `unzip` CLI). */
export const unzipText = (zipPath, entry) =>
    new Promise((resolve, reject) => {
        execFile(
            'unzip',
            ['-p', zipPath, entry],
            { encoding: 'utf8', maxBuffer: 1 << 30 },
            (error, stdout) => (error ? reject(zipError(error, zipPath)) : resolve(stdout)),
        );
    });

/** Streams a text entry out of a ZIP archive line by line (requires the `unzip` CLI). */
export async function* streamZipLines(zipPath, entry) {
    const child = spawn('unzip', ['-p', zipPath, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });
    const closed = new Promise((resolve, reject) => {
        child.on('error', (error) => reject(zipError(error, zipPath)));
        child.on('close', (code) =>
            code === 0 ? resolve() : reject(zipError(new Error(stderr || `exit ${code}`), zipPath)),
        );
    });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
        for await (const line of lines) yield line;
        await closed;
    } finally {
        lines.close();
        if (!child.killed) child.kill('SIGKILL');
    }
}

const zipError = (error, zipPath) => {
    if (error && error.code === 'ENOENT') {
        return new Error(
            'the `unzip` command is required to read GeoNames ZIP archives ' +
                `(missing while reading ${zipPath}). Install unzip, or pre-extract the raw ` +
                'files into PRAYER_SOURCE_CACHE.',
        );
    }
    return new Error(`failed to read ${zipPath}: ${error?.message ?? error}`);
};

/**
 * Queries Wikidata for the Arabic label of GeoNames ids. Results are cached in
 * the source cache so a rebuild does not re-query every id.
 * @param {string[]} geonamesIds
 * @param {{batchSize?: number, concurrency?: number}} [options]
 * @returns {Promise<Map<string, string>>} GeoNames id -> Arabic label
 */
export const fetchWikidataArabicLabels = async (geonamesIds, options = {}) => {
    const batchSize = options.batchSize ?? 800;
    const concurrency = options.concurrency ?? 3;
    const cacheFile = path.join(CACHE_DIR, 'wikidata_ar_labels.json');

    const cache = new Map();
    if (await exists(cacheFile)) {
        const raw = JSON.parse(await readFile(cacheFile, 'utf8'));
        for (const [id, label] of Object.entries(raw)) cache.set(id, label ?? null);
    }
    if (process.env.PRAYER_REFRESH_WIKIDATA === '1') {
        // Forget the "Wikidata has no Arabic label" results and ask again.
        for (const [id, label] of [...cache]) if (!label) cache.delete(id);
    }

    const missing = geonamesIds.filter((id) => !cache.has(id));
    if (missing.length > 0) {
        const batches = [];
        for (let i = 0; i < missing.length; i += batchSize) {
            batches.push(missing.slice(i, i + batchSize));
        }
        process.stdout.write(
            `wikidata: resolving Arabic labels for ${missing.length} cities ` +
                `in ${batches.length} batches\n`,
        );

        let cursor = 0;
        const worker = async () => {
            while (cursor < batches.length) {
                const batch = batches[cursor++];
                for (const [id, label] of await queryWikidataBatch(batch)) cache.set(id, label);
                for (const id of batch) if (!cache.has(id)) cache.set(id, null);
            }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));

        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cacheFile, JSON.stringify(Object.fromEntries(cache), null, 0));
    }

    const result = new Map();
    for (const [id, label] of cache) if (label) result.set(Number(id), label);
    return result;
};

const queryWikidataBatch = async (ids) => {
    const query = `SELECT ?gid ?label WHERE {
  VALUES ?gid { ${ids.map((id) => `"${id}"`).join(' ')} }
  ?item wdt:P1566 ?gid ;
        rdfs:label ?label .
  FILTER(LANG(?label) = "ar")
}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch('https://query.wikidata.org/sparql', {
                method: 'POST',
                headers: {
                    'user-agent': USER_AGENT,
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'application/sparql-results+json',
                },
                body: new URLSearchParams({ query }).toString(),
            });
            if (!response.ok) throw new Error(`wikidata responded ${response.status}`);
            const body = await response.json();
            return body.results.bindings.map((row) => [row.gid.value, row.label.value]);
        } catch (error) {
            if (attempt === 2) {
                process.stdout.write(`wikidata batch failed (${error.message}); skipping it\n`);
                return [];
            }
            await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        }
    }
    return [];
};