/**
 * Builds the prayer-location dataset under `database/prayer/`.
 *
 *   node scripts/build-prayer-locations.mjs
 *
 * The script downloads its raw inputs into a cache directory (see
 * `scripts/prayer-sources.mjs`), derives every output file from them, and
 * prints a build report. The generated files are committed to the repository,
 * so the API and the frontend never run this script at runtime.
 *
 * Calculation-method parameters are cross-checked against the runtime registry
 * in `src/services/prayer-times.js`: the build fails if the two ever disagree.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALCULATION_METHODS, SUPPORTED_MADHABS } from '../src/services/prayer-times.js';
import {
    REMOTE_FILES,
    SOURCE_REGISTRY,
    ensureSource,
    fetchWikidataArabicLabels,
    streamZipLines,
    unzipText,
} from './prayer-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'database', 'prayer');
const GENERATED_AT = new Date().toISOString();
const FALLBACK_METHOD = 'muslim_world_league';
const FALLBACK_MADHAB = 'shafi';

/**
 * Canonical calculation-method registry.
 *
 * `key` values are exactly the method keys accepted by the Raheq API
 * (`?method=<key>`), which is why they are snake_case. `aladhanMethodId` is the
 * numeric id used by the AlAdhan API, kept for interoperability.
 *
 * Parameters come from AlAdhan's published method definitions
 * (https://api.aladhan.com/v1/methods) cross-checked against batoulapps/adhan-js
 * (MIT). `tuning` records the published minute adjustments; the current runtime
 * does *not* apply them, as documented in methods.json > runtime.
 */
const METHOD_REGISTRY = [
    {
        key: 'muslim_world_league',
        aladhanMethodId: 3,
        name: 'Muslim World League',
        nameAr: 'رابطة العالم الإسلامي',
        authority: 'Muslim World League (MWL), 2007 consensus',
        fajrAngle: 18,
        ishaAngle: 17,
        tuning: { dhuhr: 1 },
        notes: 'The most widely used international default.',
    },
    {
        key: 'north_america',
        aladhanMethodId: 2,
        name: 'Islamic Society of North America (ISNA)',
        nameAr: 'الجمعية الإسلامية لأمريكا الشمالية',
        authority: 'Islamic Society of North America (ISNA)',
        fajrAngle: 15,
        ishaAngle: 15,
        tuning: { dhuhr: 1 },
        notes: 'Also common at high latitudes, where an 18° Fajr is not reachable in summer.',
    },
    {
        key: 'egyptian',
        aladhanMethodId: 5,
        name: 'Egyptian General Authority of Survey',
        nameAr: 'الهيئة المصرية العامة للمساحة',
        authority: 'Egyptian General Authority of Survey',
        fajrAngle: 19.5,
        ishaAngle: 17.5,
        tuning: { dhuhr: 1 },
        notes: null,
    },
    {
        key: 'umm_al_qura',
        aladhanMethodId: 4,
        name: 'Umm al-Qura University, Makkah',
        nameAr: 'أم القرى، مكة المكرمة',
        authority: 'Umm al-Qura University, Makkah (Saudi Arabia)',
        fajrAngle: 18.5,
        ishaMinutes: 90,
        ramadanIshaMinutes: 120,
        notes:
            'Isha is 90 minutes after Maghrib, and 120 minutes during Ramadan ' +
            '(the runtime switches automatically).',
    },
    {
        key: 'karachi',
        aladhanMethodId: 1,
        name: 'University of Islamic Sciences, Karachi',
        nameAr: 'جامعة العلوم الإسلامية بكراتشي',
        authority: 'University of Islamic Sciences, Karachi (Pakistan)',
        fajrAngle: 18,
        ishaAngle: 18,
        tuning: { dhuhr: 1 },
        notes: null,
    },
    {
        key: 'gulf_region',
        aladhanMethodId: 8,
        name: 'Gulf Region',
        nameAr: 'منطقة الخليج',
        authority: 'Gulf Region convention (AlAdhan reference location in the United Arab Emirates)',
        fajrAngle: 19.5,
        ishaMinutes: 90,
        notes: 'AlAdhan documents this method as the closest match to UAE Awqaf/IACAD tables.',
    },
    {
        key: 'kuwait',
        aladhanMethodId: 9,
        name: 'Kuwait',
        nameAr: 'الكويت',
        authority: 'Kuwait (Ministry of Awqaf and Islamic Affairs)',
        fajrAngle: 18,
        ishaAngle: 17.5,
        notes: null,
    },
    {
        key: 'qatar',
        aladhanMethodId: 10,
        name: 'Qatar',
        nameAr: 'قطر',
        authority: 'Qatar (Qatar Calendar House / Ministry of Awqaf and Islamic Affairs)',
        fajrAngle: 18,
        ishaMinutes: 90,
        notes: 'Isha is 90 minutes after Maghrib; the Ramadan interval is not changed.',
    },
    {
        key: 'singapore',
        aladhanMethodId: 11,
        name: 'Majlis Ugama Islam Singapura (MUIS)',
        nameAr: 'المجلس الإسلامي السنغافوري',
        authority: 'Majlis Ugama Islam Singapura (MUIS)',
        fajrAngle: 20,
        ishaAngle: 18,
        tuning: { dhuhr: 1 },
        rounding: 'up',
        notes: 'adhan-js rounds MUIS times up to the next minute; the runtime rounds to the nearest.',
    },
    {
        key: 'france',
        aladhanMethodId: 12,
        name: 'Union des Organisations Islamiques de France (UOIF)',
        nameAr: 'اتحاد المنظمات الإسلامية في فرنسا',
        authority: 'Union des Organisations Islamiques de France (UOIF)',
        fajrAngle: 12,
        ishaAngle: 12,
        notes: 'A low angle chosen for high latitudes; suitable for France and neighbouring regions.',
    },
    {
        key: 'turkey',
        aladhanMethodId: 13,
        name: 'Diyanet İşleri Başkanlığı (Turkey)',
        nameAr: 'رئاسة الشؤون الدينية التركية',
        authority: 'Diyanet İşleri Başkanlığı (Presidency of Religious Affairs, Turkey)',
        fajrAngle: 18,
        ishaAngle: 17,
        tuning: { sunrise: -7, dhuhr: 5, asr: 4, maghrib: 7 },
        notes: 'Diyanet publishes additional minute tunings that the runtime does not apply.',
    },
    {
        key: 'russia',
        aladhanMethodId: 14,
        name: 'Spiritual Administration of Muslims of Russia',
        nameAr: 'الإدارة الدينية لمسلمي روسيا',
        authority: 'Spiritual Administration of Muslims of Russia',
        fajrAngle: 16,
        ishaAngle: 15,
        notes: null,
    },
    {
        key: 'moonsighting_committee',
        aladhanMethodId: 15,
        name: 'Moonsighting Committee Worldwide (Moonsighting.com)',
        nameAr: 'لجنة رؤية الهلال العالمية',
        authority: 'Moonsighting Committee Worldwide (moonsighting.com)',
        fajrAngle: 18,
        ishaAngle: 18,
        tuning: { dhuhr: 5, maghrib: 3 },
        notes:
            'The full Moonsighting.com method (shafaq-based Isha and its own high-latitude ' +
            'rules) is approximated by 18°/18°; adhan-js additionally applies dhuhr +5 and maghrib +3.',
    },
    {
        key: 'dubai',
        aladhanMethodId: 16,
        name: 'Dubai (IACAD)',
        nameAr: 'دبي',
        authority: 'Dubai Islamic Affairs and Charitable Activities Department (IACAD)',
        fajrAngle: 18.2,
        ishaAngle: 18.2,
        tuning: { sunrise: -3, dhuhr: 3, asr: 3, maghrib: 3 },
        notes: 'IACAD publishes additional minute tunings that the runtime does not apply.',
    },
    {
        key: 'jakim',
        aladhanMethodId: 17,
        name: 'Jabatan Kemajuan Islam Malaysia (JAKIM)',
        nameAr: 'إدارة التنمية الإسلامية الماليزية',
        authority: 'Jabatan Kemajuan Islam Malaysia (JAKIM)',
        fajrAngle: 20,
        ishaAngle: 18,
        notes: null,
    },
    {
        key: 'tunisia',
        aladhanMethodId: 18,
        name: 'Tunisia',
        nameAr: 'تونس',
        authority: 'Tunisian Ministry of Religious Affairs',
        fajrAngle: 18,
        ishaAngle: 18,
        notes: null,
    },
    {
        key: 'algeria',
        aladhanMethodId: 19,
        name: 'Algeria',
        nameAr: 'الجزائر',
        authority: 'Algerian Ministry of Religious Affairs and Wakfs',
        fajrAngle: 18,
        ishaAngle: 17,
        notes: null,
    },
    {
        key: 'indonesia',
        aladhanMethodId: 20,
        name: 'Kementerian Agama Republik Indonesia (KEMENAG)',
        nameAr: 'وزارة الشؤون الدينية الإندونيسية',
        authority: 'Kementerian Agama Republik Indonesia (KEMENAG)',
        fajrAngle: 20,
        ishaAngle: 18,
        notes: 'KEMENAG adds an ihtiyati safety margin of 2 minutes; not applied by the runtime.',
    },
    {
        key: 'morocco',
        aladhanMethodId: 21,
        name: 'Morocco',
        nameAr: 'المغرب',
        authority: 'Moroccan Ministry of Habous and Islamic Affairs',
        fajrAngle: 19,
        ishaAngle: 17,
        notes: null,
    },
];

/**
 * Methods that are documented and in use in the wider ecosystem, but that the
 * current runtime cannot reproduce yet. They are kept in methods.json so the
 * gap is explicit (and so adding them to the engine is a data-free change).
 */
const UNIMPLEMENTED_METHODS = [
    {
        key: 'tehran',
        aladhanMethodId: 7,
        name: 'Institute of Geophysics, University of Tehran',
        nameAr: 'معهد الجيوفيزياء، جامعة طهران',
        authority: 'Institute of Geophysics, University of Tehran (Iran)',
        fajrAngle: 17.7,
        ishaAngle: 14,
        maghribAngle: 4.5,
        midnightRule: 'jafari',
        reason:
            'Requires Maghrib computed from an angle (4.5°). The runtime always derives Maghrib ' +
            'from sunset, so this method cannot be reproduced yet.',
    },
    {
        key: 'jafari',
        aladhanMethodId: 0,
        name: 'Shia Ithna-Ashari, Leva Institute, Qum',
        nameAr: 'الشيعة الإثنا عشرية، معهد ليفا، قم',
        authority: 'Shia Ithna-Ashari (Leva Institute, Qum)',
        fajrAngle: 16,
        ishaAngle: 14,
        maghribAngle: 4,
        midnightRule: 'jafari',
        reason: 'Requires Maghrib computed from an angle (4°).',
    },
    {
        key: 'portugal',
        aladhanMethodId: 22,
        name: 'Comunidade Islamica de Lisboa',
        nameAr: 'الجالية الإسلامية في لشبونة',
        authority: 'Comunidade Islamica de Lisboa (Portugal)',
        fajrAngle: 18,
        maghribMinutes: 3,
        ishaMinutes: 77,
        reason: 'Uses a fixed Maghrib offset (sunset + 3 min), which the runtime does not support.',
    },
    {
        key: 'jordan',
        aladhanMethodId: 23,
        name: 'Ministry of Awqaf, Islamic Affairs and Holy Places (Jordan)',
        nameAr: 'وزارة الأوقاف والشؤون والمقدسات الإسلامية (الأردن)',
        authority: 'Jordanian Ministry of Awqaf, Islamic Affairs and Holy Places',
        fajrAngle: 18,
        ishaAngle: 18,
        maghribMinutes: 5,
        reason: 'Uses a fixed Maghrib offset (sunset + 5 min), which the runtime does not support.',
    },
];

/**
 * Country -> default calculation method.
 *
 * Mapping policy (also documented in database/prayer/README.md):
 *   1. `national` — the country has its own published authority method and the
 *      runtime implements it (e.g. Qatar, Saudi Arabia, Egypt, Turkey, Malaysia).
 *   2. `regional` — the country commonly follows a neighbouring/regional authority
 *      (Umm al-Qura across most Gulf states, the Egyptian authority in
 *      Libya/Sudan/Nigeria, ISNA in the United Kingdom). Cross-checked against the
 *      239 per-country defaults published by Salahtimes (retrieved 2026-09-28).
 *   3. `default`  — no documented country convention; the global fallback
 *      (`muslim_world_league`) is used, by far the most widely adopted
 *      international method.
 *
 * `alternatives` lists other runtime-supported methods worth offering in a UI.
 * `pendingMethods` names a better-fitting method that is not implemented yet.
 */
const COUNTRY_METHODS = {
    SA: {
        method: 'umm_al_qura',
        source: 'national',
        notes: 'Umm al-Qura University (Makkah) is the official Saudi calendar authority.',
    },
    QA: {
        method: 'qatar',
        source: 'national',
        notes: 'Qatar Calendar House timings: Fajr 18°, Isha 90 minutes after Maghrib.',
    },
    KW: {
        method: 'kuwait',
        source: 'national',
        notes: 'Kuwaiti Ministry of Awqaf convention: Fajr 18°, Isha 17.5°.',
    },
    AE: {
        method: 'umm_al_qura',
        source: 'regional',
        alternatives: ['gulf_region', 'dubai'],
        notes:
            'Umm al-Qura is the common Gulf default; AlAdhan documents the Gulf Region method ' +
            'as the closest match to UAE Awqaf, and Dubai (IACAD) publishes 18.2°/18.2° timings.',
    },
    BH: {
        method: 'umm_al_qura',
        source: 'regional',
        notes: 'Umm al-Qura is the Gulf default used for Bahrain.',
    },
    OM: {
        method: 'umm_al_qura',
        source: 'regional',
        notes: 'Umm al-Qura is the Gulf default used for Oman.',
    },
    YE: {
        method: 'umm_al_qura',
        source: 'regional',
        notes: 'Umm al-Qura is the Gulf default used for Yemen.',
    },
    SY: {
        method: 'umm_al_qura',
        source: 'regional',
        notes: 'Umm al-Qura is the commonly used default for Syria.',
    },
    JO: {
        method: 'umm_al_qura',
        source: 'regional',
        alternatives: ['karachi'],
        pendingMethods: ['jordan'],
        notes:
            'The Jordanian ministry method is Fajr 18°/Isha 18° with sunset + 5 minutes for ' +
            'Maghrib; the 18°/18° part matches `karachi`, and the Maghrib offset is documented ' +
            'in methods.json > unimplemented.',
    },
    EG: { method: 'egyptian', source: 'national', notes: null },
    LY: {
        method: 'egyptian',
        source: 'regional',
        notes: 'Egyptian General Authority of Survey is the default used in Libya.',
    },
    SD: {
        method: 'egyptian',
        source: 'regional',
        notes: 'Egyptian General Authority of Survey is the default used in Sudan.',
    },
    SS: {
        method: 'egyptian',
        source: 'regional',
        notes: 'Egyptian General Authority of Survey is the default used in South Sudan.',
    },
    NG: {
        method: 'egyptian',
        source: 'regional',
        alternatives: ['muslim_world_league'],
        notes: 'The Egyptian authority is the common Nigerian default; MWL is the usual alternative.',
    },
    PK: { method: 'karachi', madhab: 'hanafi', source: 'national', notes: null },
    IN: {
        method: 'karachi',
        madhab: 'hanafi',
        source: 'national',
        notes: 'University of Islamic Sciences, Karachi is the prevailing convention in India.',
    },
    BD: {
        method: 'karachi',
        madhab: 'hanafi',
        source: 'national',
        notes: 'Matches the 18°/18° convention used by the Islamic Foundation Bangladesh.',
    },
    AF: {
        method: 'karachi',
        madhab: 'hanafi',
        source: 'national',
        notes: 'Matches the 18°/18° convention used in Afghanistan.',
    },
    MY: { method: 'jakim', source: 'national', notes: null },
    SG: { method: 'singapore', source: 'national', notes: null },
    ID: { method: 'indonesia', source: 'national', notes: null },
    TR: { method: 'turkey', madhab: 'hanafi', source: 'national', notes: null },
    FR: { method: 'france', source: 'national', notes: null },
    RU: { method: 'russia', madhab: 'hanafi', source: 'national', notes: null },
    US: { method: 'north_america', source: 'national', notes: null },
    CA: { method: 'north_america', source: 'national', notes: null },
    AS: {
        method: 'north_america',
        source: 'regional',
        notes: 'ISNA angles are the default used in American Samoa.',
    },
    GB: {
        method: 'north_america',
        source: 'regional',
        alternatives: ['muslim_world_league', 'moonsighting_committee'],
        notes:
            'ISNA 15°/15° is the widely used UK default and copes better with UK summer ' +
            'twilights than 18° angles.',
    },
    MA: { method: 'morocco', source: 'national', notes: null },
    DZ: {
        method: 'algeria',
        source: 'national',
        notes: 'Maliki madhab uses the single-shadow Asr rule (madhab "shafi" in the API).',
    },
    TN: { method: 'tunisia', source: 'national', notes: null },
    IR: {
        method: 'muslim_world_league',
        source: 'default',
        pendingMethods: ['tehran', 'jafari'],
        notes:
            'Iran is normally served by the Tehran/Jafari methods, which the runtime cannot ' +
            'reproduce yet (they need Maghrib from an angle). MWL is used until then.',
    },
    PT: {
        method: 'muslim_world_league',
        source: 'default',
        pendingMethods: ['portugal'],
        notes:
            'The Comunidade Islamica de Lisboa method (sunset + 3 min, Isha 77 min) is not ' +
            'implemented by the runtime yet.',
    },
};

/**
 * Countries whose Asr convention is the Hanafi (two-shadow) rule. Every other
 * country defaults to the single-shadow rule, exposed as madhab `shafi`
 * (Shafi'i, Maliki, Hanbali and Ja'fari all use shadow factor 1).
 */
const HANAFI_COUNTRIES = new Set([
    'TR', 'PK', 'IN', 'BD', 'AF', 'IQ', 'UZ', 'KZ', 'KG', 'TJ', 'TM', 'AZ', 'AL',
    'BA', 'MK', 'XK', 'RU', 'CN',
]);

/** Non-exhaustive search aliases for countries that are commonly named differently. */
const COUNTRY_ALIASES = {
    AE: { en: ['UAE', 'Emirates'], ar: ['الإمارات'] },
    BA: { en: ['Bosnia'] },
    BN: { en: ['Brunei Darussalam'] },
    BO: { en: ['Bolivia (Plurinational State of)'] },
    CD: { en: ['DR Congo', 'Congo-Kinshasa', 'Zaire'] },
    CG: { en: ['Congo-Brazzaville', 'Republic of the Congo'] },
    CH: { en: ['Switzerland'], ar: ['سويسرا'] },
    CI: { en: ["Côte d'Ivoire", 'Ivory Coast'] },
    CV: { en: ['Cape Verde'] },
    CZ: { en: ['Czechia'], ar: ['التشيك'] },
    DE: { en: ['Germany'], ar: ['ألمانيا'] },
    EG: { en: ['Misr'], ar: ['مصر'] },
    FR: { ar: ['فرنسا'] },
    GB: { en: ['UK', 'Britain', 'Great Britain', 'England'], ar: ['بريطانيا', 'إنجلترا'] },
    IR: { en: ['Iran (Islamic Republic of)'], ar: ['إيران'] },
    KR: { en: ['South Korea', 'Republic of Korea'] },
    KP: { en: ['North Korea', "Democratic People's Republic of Korea"] },
    LA: { en: ['Laos'] },
    MD: { en: ['Moldova'] },
    MK: { en: ['Macedonia'] },
    MM: { en: ['Burma'] },
    NL: { en: ['Holland'], ar: ['هولندا'] },
    PS: { en: ['Palestine', 'West Bank', 'Gaza'], ar: ['فلسطين'] },
    RU: { en: ['Russian Federation'], ar: ['روسيا'] },
    SA: { en: ['KSA', 'Kingdom of Saudi Arabia'], ar: ['السعودية', 'المملكة العربية السعودية'] },
    SY: { ar: ['سوريا'] },
    SZ: { en: ['Swaziland'] },
    TL: { en: ['East Timor'] },
    TR: { en: ['Türkiye', 'Turkiye'], ar: ['تركيا'] },
    TZ: { en: ['Tanzania', 'United Republic of Tanzania'] },
    US: {
        en: ['USA', 'United States of America', 'America'],
        ar: ['أمريكا', 'الولايات المتحدة الأمريكية'],
    },
    VA: { en: ['Vatican City', 'Holy See'] },
    VE: { en: ['Venezuela (Bolivarian Republic of)'] },
    VN: { en: ['Viet Nam'] },
};

/**
 * City-level overrides, keyed by GeoNames id. Only used where the country
 * default would be visibly wrong for that particular city; the override
 * mechanism itself is generic (see database/prayer/README.md).
 */
const CITY_OVERRIDES = {
    292223: {
        method: 'dubai',
        notes:
            'Dubai IACAD publishes 18.2°/18.2° timings, while the UAE country default is Umm al-Qura.',
    },
};

/** GeoNames `cities*.txt` column order (tab separated, no header). */
const CITY_COLUMNS = [
    'geonameid', 'name', 'asciiname', 'alternatenames', 'latitude', 'longitude',
    'featureClass', 'featureCode', 'countryCode', 'cc2', 'admin1', 'admin2', 'admin3',
    'admin4', 'population', 'elevation', 'dem', 'timezone', 'modificationDate',
];

/** GeoNames `countryInfo.txt` column order (tab separated, '#' comment lines). */
const COUNTRY_COLUMNS = [
    'iso2', 'iso3', 'isoNumeric', 'fips', 'name', 'capital', 'area', 'population',
    'continent', 'tld', 'currencyCode', 'currencyName', 'phone', 'postalCodeFormat',
    'postalCodeRegex', 'languages', 'geonameid', 'neighbours', 'equivalentFipsCode',
];

const splitRows = (text, columns, { skipComment = false } = {}) => {
    const rows = [];
    for (const line of text.split('\n')) {
        if (!line || (skipComment && line.startsWith('#'))) continue;
        const cells = line.split('\t');
        const row = {};
        columns.forEach((column, index) => {
            row[column] = (cells[index] ?? '').replace(/\r$/, '');
        });
        rows.push(row);
    }
    return rows;
};

/**
 * UTC offset in minutes of an IANA time zone at a given instant, resolved by
 * ICU through `Intl` (so DST rules always come from the IANA database).
 */
const utcOffsetMinutes = (timeZone, timestampMs) => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(timestampMs));
    const value = (type) => Number(parts.find((part) => part.type === type).value);
    const asUtc = Date.UTC(
        value('year'),
        value('month') - 1,
        value('day'),
        value('hour') % 24,
        value('minute'),
        value('second'),
    );
    return Math.round((asUtc - timestampMs) / 60000);
};

const round = (value, decimals = 6) => Number(value.toFixed(decimals));

const isKnownTimeZone = (timeZone) => {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
    } catch {
        return false;
    }
};

const hasArabicText = (value) => typeof value === 'string' && /[\u0600-\u06FF]/.test(value);

const writeJson = async (name, value) => {
    const file = path.join(OUTPUT_DIR, name);
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
};

/**
 * Writes `{ ...header, [key]: [ ...records ] }` with one compact record per
 * line: the file stays small and every change shows up as a one-line diff.
 */
const writeCollection = async (name, header, key, records) => {
    const head = Object.entries(header)
        .map(([headerKey, value]) => `  ${JSON.stringify(headerKey)}: ${JSON.stringify(value)}`)
        .join(',\n');
    const body = records.map((record) => `    ${JSON.stringify(record)}`).join(',\n');
    const file = path.join(OUTPUT_DIR, name);
    await writeFile(file, `{\n${head},\n  ${JSON.stringify(key)}: [\n${body}\n  ]\n}\n`);
    return file;
};

const omitEmpty = (object) =>
    Object.fromEntries(
        Object.entries(object).filter(([, value]) => {
            if (value === null || value === undefined) return false;
            if (Array.isArray(value) && value.length === 0) return false;
            return true;
        }),
    );

const ASR_FACTORS = {
    shafi: {
        shadowFactor: 1,
        description:
            "Shafi'i, Maliki, Hanbali and Ja'fari: Asr begins when an object's shadow equals " +
            'its own length plus the shadow length at noon.',
    },
    hanafi: {
        shadowFactor: 2,
        description:
            "Hanafi: Asr begins when an object's shadow is twice its own length plus the " +
            'shadow length at noon.',
    },
};

const buildAsrBlock = () => {
    const block = {};
    for (const madhab of SUPPORTED_MADHABS) {
        const entry = ASR_FACTORS[madhab];
        if (!entry) throw new Error(`runtime exposes Asr madhab "${madhab}" with no shadow factor`);
        block[madhab] = { ...entry, identifier: madhab };
    }
    return block;
};

/**
 * Builds methods.json. The runtime registry in `src/services/prayer-times.js`
 * is the source of truth for the parameters it actually applies; the build
 * fails if this file and the runtime ever drift apart.
 */
const buildMethodsFile = () => {
    const engineKeys = Object.keys(CALCULATION_METHODS).sort();
    const registryKeys = METHOD_REGISTRY.map((entry) => entry.key).sort();
    if (engineKeys.join(',') !== registryKeys.join(',')) {
        const engineOnly = engineKeys.filter((key) => !registryKeys.includes(key));
        const registryOnly = registryKeys.filter((key) => !engineKeys.includes(key));
        throw new Error(
            'METHOD_REGISTRY and src/services/prayer-times.js are out of sync — ' +
                `runtime only: [${engineOnly.join(', ')}], registry only: [${registryOnly.join(', ')}]`,
        );
    }

    const methods = {};
    for (const entry of METHOD_REGISTRY) {
        const engine = CALCULATION_METHODS[entry.key];
        for (const field of ['fajrAngle', 'ishaAngle', 'ishaMinutes', 'ramadanIshaMinutes']) {
            const runtimeValue = engine[field] ?? null;
            const registryValue = entry[field] ?? null;
            if (runtimeValue !== registryValue) {
                throw new Error(
                    `method "${entry.key}": ${field} is ${runtimeValue} in the runtime but ` +
                        `${registryValue} in the registry`,
                );
            }
        }

        methods[entry.key] = omitEmpty({
            id: entry.key,
            name: entry.name,
            nameAr: entry.nameAr,
            authority: entry.authority,
            aladhanMethodId: entry.aladhanMethodId,
            fajrAngle: entry.fajrAngle,
            ishaAngle: entry.ishaAngle ?? null,
            ishaMinutes: entry.ishaMinutes ?? null,
            ramadanIshaMinutes: entry.ramadanIshaMinutes ?? null,
            maghribAngle: null,
            maghribMinutes: 0,
            maghribRule: 'sunset',
            tuning: entry.tuning ?? null,
            rounding: entry.rounding ?? null,
            notes: entry.notes ?? null,
        });
    }

    const unimplemented = {};
    for (const entry of UNIMPLEMENTED_METHODS) {
        unimplemented[entry.key] = omitEmpty({
            id: entry.key,
            name: entry.name,
            nameAr: entry.nameAr,
            authority: entry.authority,
            aladhanMethodId: entry.aladhanMethodId,
            fajrAngle: entry.fajrAngle ?? null,
            ishaAngle: entry.ishaAngle ?? null,
            ishaMinutes: entry.ishaMinutes ?? null,
            maghribAngle: entry.maghribAngle ?? null,
            maghribMinutes: entry.maghribMinutes ?? null,
            midnightRule: entry.midnightRule ?? null,
            reason: entry.reason,
        });
    }

    const byAladhanId = {};
    for (const [key, method] of Object.entries(methods)) byAladhanId[method.aladhanMethodId] = key;
    for (const entry of UNIMPLEMENTED_METHODS) {
        if (!(entry.aladhanMethodId in byAladhanId)) {
            // Documented but not implemented yet: present with a null value.
            byAladhanId[entry.aladhanMethodId] = null;
        }
    }

    return {
        schemaVersion: 1,
        fallbackMethod: FALLBACK_METHOD,
        coordinateSystem: 'WGS84',
        asr: buildAsrBlock(),
        runtime: {
            implementation: 'src/services/prayer-times.js',
            apiParameter: 'method',
            reads: ['fajrAngle', 'ishaAngle', 'ishaMinutes', 'ramadanIshaMinutes'],
            asrMadhabParameter: 'madhab',
            maghribRule: 'sunset',
            highLatitudeFallback: 'angle_based',
            rounding: 'nearest_minute',
            notApplied: [
                'tuning',
                'rounding',
                'maghribAngle',
                'maghribMinutes',
                'midnight',
                'imsak',
            ],
            note:
                'Fields listed in notApplied are published for information only: the current ' +
                'runtime does not implement them, so its output can differ from the authority ' +
                'by a few minutes.',
        },
        byAladhanId,
        methods,
        unimplemented,
    };
};

/** Builds countries.json: ISO identity, Arabic name, and the default prayer settings. */
const buildCountriesFile = (countryRows, arabicTerritories) => {
    const countries = {};
    const warnings = [];

    for (const row of countryRows) {
        const iso2 = row.iso2.trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(iso2)) continue;

        const mapping = COUNTRY_METHODS[iso2] ?? {};
        const defaultMethod = mapping.method ?? FALLBACK_METHOD;
        const defaultMadhab =
            mapping.madhab ?? (HANAFI_COUNTRIES.has(iso2) ? 'hanafi' : FALLBACK_MADHAB);
        const methodSource =
            mapping.source ?? (defaultMethod === FALLBACK_METHOD ? 'default' : 'national');

        if (methodSource === 'default' && defaultMethod !== FALLBACK_METHOD) {
            warnings.push(`country ${iso2} is marked "default" but does not use the fallback method`);
        }

        const aliases = COUNTRY_ALIASES[iso2];
        const nameAr = arabicTerritories[iso2] ?? null;
        const keepAlias = (alias, canonical) =>
            canonical ? alias.toLowerCase() !== canonical.toLowerCase() : true;

        countries[iso2] = omitEmpty({
            iso2,
            iso3: row.iso3.trim().toUpperCase(),
            name: row.name,
            nameAr,
            continent: row.continent,
            defaultMethod,
            methodSource,
            defaultMadhab,
            alternatives: mapping.alternatives ?? [],
            pendingMethods: mapping.pendingMethods ?? [],
            aliasesEn: (aliases?.en ?? []).filter((alias) => keepAlias(alias, row.name)),
            aliasesAr: (aliases?.ar ?? []).filter((alias) => keepAlias(alias, nameAr)),
            notes: mapping.notes ?? null,
        });
    }

    return {
        file: {
            schemaVersion: 1,
            defaults: { method: FALLBACK_METHOD, madhab: FALLBACK_MADHAB },
            methodSourceMeaning: {
                national: 'Method published by the country’s own religious authority.',
                regional:
                    'Method of a neighbouring/regional authority that the country commonly follows.',
                default: 'No documented country convention; the global fallback method is used.',
            },
            countries,
        },
        warnings,
    };
};

/** Builds the city records from the GeoNames city rows. */
const buildCities = ({ cityRows, arabicNames, wikidataNames, regions }) => {
    const cities = [];
    const quality = {
        skippedInvalid: [],
        skippedUnknownTimezone: [],
        duplicateIds: [],
        duplicateCoordinates: [],
        duplicateNames: [],
        duplicateNameGroups: new Map(),
        arabicFromGeonames: 0,
        arabicFromWikidata: 0,
        missingArabic: 0,
        missingRegion: 0,
        overridesApplied: [],
    };

    const seenIds = new Set();
    const seenCoordinates = new Map();
    const seenNames = new Map();

    for (const row of cityRows) {
        const id = Number(row.geonameid);
        const latitude = round(Number(row.latitude));
        const longitude = round(Number(row.longitude));
        const countryCode = row.countryCode.trim().toUpperCase();
        const timezone = row.timezone.trim();

        const valid =
            Number.isFinite(id) &&
            Number.isFinite(latitude) &&
            Number.isFinite(longitude) &&
            Math.abs(latitude) <= 90 &&
            Math.abs(longitude) <= 180 &&
            /^[A-Z]{2}$/.test(countryCode) &&
            Boolean(timezone);
        if (!valid) {
            quality.skippedInvalid.push({ id, name: row.name, latitude, longitude });
            continue;
        }
        if (!isKnownTimeZone(timezone)) {
            quality.skippedUnknownTimezone.push({ id, name: row.name, timezone });
            continue;
        }
        if (seenIds.has(id)) {
            quality.duplicateIds.push(id);
            continue;
        }
        seenIds.add(id);

        const coordinateKey = `${latitude},${longitude}`;
        if (seenCoordinates.has(coordinateKey)) {
            quality.duplicateCoordinates.push({
                id,
                name: row.name,
                countryCode,
                coordinates: coordinateKey,
                firstSeenId: seenCoordinates.get(coordinateKey),
            });
        } else {
            seenCoordinates.set(coordinateKey, id);
        }

        const nameKey = `${countryCode}|${row.name.toLowerCase()}`;
        if (seenNames.has(nameKey)) {
            quality.duplicateNames.push({
                id,
                name: row.name,
                countryCode,
                firstSeenId: seenNames.get(nameKey),
            });
            quality.duplicateNameGroups.set(nameKey, true);
        } else {
            seenNames.set(nameKey, id);
        }

        let nameAr = arabicNames.get(id) ?? null;
        if (nameAr) {
            quality.arabicFromGeonames += 1;
        } else if (wikidataNames.has(id)) {
            nameAr = wikidataNames.get(id);
            quality.arabicFromWikidata += 1;
        } else {
            quality.missingArabic += 1;
        }
        if (nameAr) nameAr = nameAr.trim();
        if (nameAr && !hasArabicText(nameAr)) nameAr = null;

        const region = regions.get(`${countryCode}.${row.admin1}`) ?? null;
        if (!region) quality.missingRegion += 1;

        const population = Number(row.population);
        const override = CITY_OVERRIDES[id];
        if (override) quality.overridesApplied.push({ id, name: row.name, ...override });

        cities.push(
            omitEmpty({
                id,
                name: row.name,
                ascii: row.asciiname && row.asciiname !== row.name ? row.asciiname : null,
                nameAr,
                countryCode,
                region,
                latitude,
                longitude,
                population: Number.isFinite(population) && population > 0 ? population : null,
                timezone,
                method: override?.method ?? null,
                madhab: override?.madhab ?? null,
                notes: override?.notes ?? null,
            }),
        );
    }

    cities.sort(
        (a, b) =>
            a.countryCode.localeCompare(b.countryCode) ||
            (b.population ?? 0) - (a.population ?? 0) ||
            a.name.localeCompare(b.name, 'en'),
    );

    return { cities, quality };
};

/**
 * Streams GeoNames alternate names and keeps the best Arabic name per city id.
 * Language-tagged `ar` entries are authoritative, so they win over any other
 * source; a preferred-name flag outranks a plain variant.
 */
const collectGeoNamesArabicNames = async (zipPath, entry, wantedIds) => {
    const best = new Map();
    const score = (fields) => {
        let value = 0;
        if (fields.isPreferredName === '1') value += 4;
        if (fields.isColloquial === '1') value -= 1;
        if (fields.isShortName === '1') value -= 1;
        return value;
    };

    for await (const line of streamZipLines(zipPath, entry)) {
        if (!line) continue;
        const cells = line.split('\t');
        const language = cells[2];
        if (language !== 'ar' && !language?.startsWith('ar-')) continue;
        const id = Number(cells[1]);
        if (!wantedIds.has(id)) continue;
        if (cells[7] === '1') continue; // historic name
        const name = (cells[3] ?? '').trim();
        if (!name || !hasArabicText(name)) continue;

        const candidate = {
            name,
            score: score({ isPreferredName: cells[4], isShortName: cells[5], isColloquial: cells[6] }),
        };
        const current = best.get(id);
        if (!current || candidate.score > current.score) best.set(id, candidate);
    }

    return new Map([...best].map(([id, candidate]) => [id, candidate.name]));
};

const buildMetaFile = ({ counts, files, quality, retrieved }) => {
    const sources = SOURCE_REGISTRY.map((source) => ({
        ...source,
        retrievedAt: retrieved.get(source.id) ?? GENERATED_AT,
    }));
    const licenses = [];
    for (const source of sources) {
        if (!licenses.some((entry) => entry.license === source.license)) {
            licenses.push({ license: source.license, licenseUrl: source.licenseUrl, sources: [source.id] });
        } else {
            licenses.find((entry) => entry.license === source.license).sources.push(source.id);
        }
    }

    return {
        schemaVersion: 1,
        dataset: 'raheq-prayer-locations',
        version: '1.0.0',
        generatedAt: GENERATED_AT,
        generator: 'scripts/build-prayer-locations.mjs',
        description:
            'City coordinates, IANA time zones and prayer-time calculation settings for the ' +
            'Raheq Islam prayer-time API (GET /api/prayer-times).',
        counts,
        files,
        resolution: {
            summary: 'city -> country -> default calculation method -> method parameters',
            methodOrder: ['cities[].method', 'countries[].defaultMethod', 'fallbackMethod'],
            fallbackMethod: FALLBACK_METHOD,
            madhabOrder: ['cities[].madhab', 'countries[].defaultMadhab', 'fallbackMadhab'],
            fallbackMadhab: FALLBACK_MADHAB,
            methodLookup: 'methods.methods[methodId]',
            utcOffset:
                'Derive the offset for the requested date from cities[].timezone (IANA); ' +
                'timezones.json only provides reference offsets.',
        },
        utcOffsetHandling: {
            canonicalSourceOfTruth: 'cities[].timezone (IANA time zone identifier)',
            storedValues:
                'timezones.json stores the standard-time offset (rawOffsetMinutes) plus the ' +
                'offsets sampled on one winter and one summer date, so a consumer without a tz ' +
                'database can still tell DST from non-DST zones.',
            staleness:
                'Offsets are re-derived from the IANA database on every build; never treat the ' +
                'stored offsets as permanent for DST-observing zones.',
            apiExpectation:
                'GET /api/prayer-times expects utcOffset in hours (fractional hours allowed): ' +
                'utcOffset = offsetMinutes / 60.',
        },
        quality,
        sources,
        licenses,
    };
};

/** Modification time of a cached file, used as the `retrievedAt` stamp of a source. */
const cachedStamp = async (file) => {
    try {
        const info = await stat(file);
        return info.mtime.toISOString();
    } catch {
        return null;
    }
};

/** Builds timezones.json for every IANA zone referenced by a city. */
const buildTimezonesFile = (zones, geonamesRows, sampleYear) => {
    const january = Date.parse(`${sampleYear}-01-15T12:00:00Z`);
    const july = Date.parse(`${sampleYear}-07-15T12:00:00Z`);

    const geonamesRawOffsets = new Map();
    for (const row of geonamesRows) {
        const raw = Number(row.rawOffset);
        if (!Number.isFinite(raw)) continue;
        if (!geonamesRawOffsets.has(row.timeZoneId)) geonamesRawOffsets.set(row.timeZoneId, new Set());
        geonamesRawOffsets.get(row.timeZoneId).add(Math.round(raw * 60));
    }

    const timezones = {};
    const crossCheckFailures = [];
    const monthlySamples = Array.from({ length: 12 }, (_, month) =>
        Date.parse(`${sampleYear}-${String(month + 1).padStart(2, '0')}-15T12:00:00Z`),
    );

    for (const zone of [...zones].sort()) {
        const offsetJanuarySample = utcOffsetMinutes(zone, january);
        const offsetJulySample = utcOffsetMinutes(zone, july);
        const rawOffsetMinutes = Math.min(offsetJanuarySample, offsetJulySample);
        const dstOffsetMinutes = Math.max(offsetJanuarySample, offsetJulySample) - rawOffsetMinutes;
        const monthly = monthlySamples.map((timestamp) => utcOffsetMinutes(zone, timestamp));
        const offsetMinutesMin = Math.min(...monthly);
        const offsetMinutesMax = Math.max(...monthly);

        const reference = geonamesRawOffsets.get(zone);
        if (reference && !reference.has(rawOffsetMinutes)) {
            crossCheckFailures.push({
                timezone: zone,
                resolved: rawOffsetMinutes,
                geonames: [...reference],
            });
        }

        timezones[zone] = {
            timezone: zone,
            rawOffsetMinutes,
            observesDst: dstOffsetMinutes > 0,
            dstOffsetMinutes,
            offsetVariesDuringYear: offsetMinutesMin !== offsetMinutesMax,
            offsetMinutesMin,
            offsetMinutesMax,
            offsetMinutesOnJanuarySample: offsetJanuarySample,
            offsetMinutesOnJulySample: offsetJulySample,
        };
    }

    return {
        file: {
            schemaVersion: 1,
            offsetSamples: {
                january: new Date(january).toISOString(),
                july: new Date(july).toISOString(),
                monthly: `15th of every month of ${sampleYear}`,
                note:
                    'rawOffsetMinutes is the standard-time offset (DST always moves clocks forward, ' +
                    'so it is the smaller of the January/July samples). offsetMinutesMin/Max are ' +
                    'taken from 12 monthly samples: when offsetVariesDuringYear is true the stored ' +
                    'offsets are not sufficient, and the offset must be derived from the IANA zone ' +
                    'for the requested date (for example Africa/Casablanca returns to UTC+0 during ' +
                    'Ramadan even though it does not observe a regular DST season).',
            },
        },
        timezones,
        crossCheckFailures,
        geonamesRawOffsets,
    };
};

const main = async () => {
    await mkdir(OUTPUT_DIR, { recursive: true });

    const [citiesZip, alternateNamesZip, timezoneFile, countryFile, regionFile, cldrFile] =
        await Promise.all([
            ensureSource(REMOTE_FILES.cities),
            ensureSource(REMOTE_FILES.alternateNames),
            ensureSource(REMOTE_FILES.timezones),
            ensureSource(REMOTE_FILES.countries),
            ensureSource(REMOTE_FILES.regions),
            ensureSource(REMOTE_FILES.cldrArabicTerritories),
        ]);

    const cityRows = splitRows(await unzipText(citiesZip, REMOTE_FILES.cities.entry), CITY_COLUMNS);
    const countryRows = splitRows(await readFile(countryFile, 'utf8'), COUNTRY_COLUMNS, {
        skipComment: true,
    });
    const regionRows = splitRows(await readFile(regionFile, 'utf8'), [
        'key', 'name', 'asciiname', 'geonameid',
    ]);
    const timezoneText = await readFile(timezoneFile, 'utf8');
    const timezoneRows = splitRows(timezoneText.split('\n').slice(1).join('\n'), [
        'countryCode', 'timeZoneId', 'janOffset', 'julOffset', 'rawOffset',
    ]);
    const cldr = JSON.parse(await readFile(cldrFile, 'utf8'));
    const arabicTerritories = cldr.main.ar.localeDisplayNames.territories;

    const regions = new Map(regionRows.filter((row) => row.key).map((row) => [row.key, row.name]));

    const wantedIds = new Set(cityRows.map((row) => Number(row.geonameid)));
    const arabicNames = await collectGeoNamesArabicNames(
        alternateNamesZip,
        REMOTE_FILES.alternateNames.entry,
        wantedIds,
    );

    let wikidataNames = new Map();
    if (process.env.PRAYER_SKIP_WIKIDATA === '1') {
        process.stdout.write('wikidata: skipped (PRAYER_SKIP_WIKIDATA=1)\n');
    } else {
        const pending = [...wantedIds].filter((id) => !arabicNames.has(id));
        wikidataNames = await fetchWikidataArabicLabels(pending.map(String));
    }

    const { cities, quality } = buildCities({ cityRows, arabicNames, wikidataNames, regions });

    const zones = new Set(cities.map((city) => city.timezone));
    const timezoneBuild = buildTimezonesFile(zones, timezoneRows, GENERATED_AT.slice(0, 4));
    const countriesBuild = buildCountriesFile(countryRows, arabicTerritories);
    const methods = buildMethodsFile();

    const citiesFile = await writeCollection(
        'cities.json',
        {
            schemaVersion: 1,
            generatedAt: GENERATED_AT,
            countryLookup: 'countries.json > countries[countryCode]',
            methodLookup:
                'methods.json > methods[city.method ?? countries[countryCode].defaultMethod]',
            timezoneLookup: 'timezones.json > timezones[timezone]',
            coordinateSystem: 'WGS84',
            note:
                'One record per line; records are sorted by countryCode, then population (desc), ' +
                'then name. `ascii`, `nameAr`, `region` and `population` are omitted when ' +
                'unknown, and `method`/`madhab` appear only on cities that override their ' +
                'country default.',
        },
        'cities',
        cities,
    );
    const countriesFile = await writeJson('countries.json', countriesBuild.file);
    const timezonesFile = await writeJson('timezones.json', {
        schemaVersion: 1,
        ...timezoneBuild.file,
        timezones: timezoneBuild.timezones,
    });
    const methodsFile = await writeJson('methods.json', methods);

    const qualityReport = {
        cities: cities.length,
        citiesWithArabicName: quality.arabicFromGeonames + quality.arabicFromWikidata,
        citiesWithArabicNameFromGeonames: quality.arabicFromGeonames,
        citiesWithArabicNameFromWikidata: quality.arabicFromWikidata,
        citiesWithoutArabicName: quality.missingArabic,
        citiesWithoutRegion: quality.missingRegion,
        duplicateCityNames: quality.duplicateNames.length,
        duplicateNameGroups: quality.duplicateNameGroups.size,
        duplicateCoordinates: quality.duplicateCoordinates,
        skippedInvalidRows: quality.skippedInvalid.length,
        skippedUnknownTimezones: quality.skippedUnknownTimezone.length,
        cityOverrides: quality.overridesApplied,
        timezoneOffsetMismatchesWithGeoNames: timezoneBuild.crossCheckFailures,
        countryMappingWarnings: countriesBuild.warnings,
    };

    const files = [];
    for (const name of ['cities.json', 'countries.json', 'methods.json', 'timezones.json']) {
        const info = await stat(path.join(OUTPUT_DIR, name));
        files.push({ path: `database/prayer/${name}`, bytes: info.size });
    }

    const retrieved = new Map();
    for (const [id, file] of Object.entries({
        'geonames-cities': citiesZip,
        'geonames-alternatenames': alternateNamesZip,
        'geonames-countryinfo': countryFile,
        'geonames-timezones': timezoneFile,
        'geonames-admin1': regionFile,
        cldr: cldrFile,
    })) {
        const stamp = await cachedStamp(file);
        if (stamp) retrieved.set(id, stamp);
    }

    const metaFile = await writeJson(
        'meta.json',
        buildMetaFile({
            counts: {
                cities: cities.length,
                countries: Object.keys(countriesBuild.file.countries).length,
                methods: Object.keys(methods.methods).length,
                unimplementedMethods: Object.keys(methods.unimplemented).length,
                timezones: Object.keys(timezoneBuild.timezones).length,
                citiesWithMethodOverride: cities.filter((city) => city.method).length,
            },
            files,
            quality: qualityReport,
            retrieved,
        }),
    );

    process.stdout.write(
        [
            '',
            'prayer-location dataset built',
            `  cities ............ ${cities.length}`,
            `  countries ......... ${Object.keys(countriesBuild.file.countries).length}`,
            `  methods ........... ${Object.keys(methods.methods).length} (+${Object.keys(methods.unimplemented).length} documented, not implemented)`,
            `  timezones ......... ${zones.size}`,
            `  Arabic city names . ${qualityReport.citiesWithArabicName} (${qualityReport.citiesWithoutArabicName} missing)`,
            `  duplicate names ... ${qualityReport.duplicateCityNames}`,
            `  duplicate coords .. ${qualityReport.duplicateCoordinates.length}`,
            `  tz cross-check .... ${qualityReport.timezoneOffsetMismatchesWithGeoNames.length} mismatch(es)`,
            '',
            'files written:',
            ...[citiesFile, countriesFile, methodsFile, timezonesFile, metaFile].map(
                (file) => `  ${path.relative(ROOT, file)}`,
            ),
            '',
        ].join('\n'),
    );
};

await main();
