/**
 * Validates the prayer-location dataset in `database/prayer/`.
 *
 *   node scripts/validate-prayer-data.mjs
 *
 * The script is offline and deterministic: it validates the committed files
 * against schema.json, re-derives every IANA offset with `Intl` (DST aware),
 * checks referential integrity between the files, verifies the method registry
 * against the runtime engine, and prints the resolved prayer configuration of a
 * set of reference cities. Exit code 1 means the dataset must not be shipped.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALCULATION_METHODS, SUPPORTED_MADHABS } from '../src/services/prayer-times.js';
import { loadPrayerLocations, resolveCityPrayerConfig, utcOffsetMinutesFor } from './prayer-locations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'database', 'prayer');

const errors = [];
const notes = [];
const fail = (message) => errors.push(message);
const check = (condition, message) => {
    if (!condition) fail(message);
};

const validateAgainstSchema = (value, schema, root, pointer) => {
    if (!schema || typeof schema !== 'object') return;

    if (schema.$ref) {
        const target = schema.$ref
            .replace(/^#\//, '')
            .split('/')
            .reduce((node, key) => (node ? node[key] : undefined), root);
        if (!target) {
            fail(`${pointer}: unresolved $ref ${schema.$ref}`);
            return;
        }
        validateAgainstSchema(value, target, root, pointer);
        return;
    }

    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (types.length > 0) {
        const actual =
            value === null
                ? 'null'
                : Array.isArray(value)
                  ? 'array'
                  : Number.isInteger(value)
                    ? 'integer'
                    : typeof value;
        const matches = types.some(
            (type) => type === actual || (type === 'number' && actual === 'integer'),
        );
        if (!matches) {
            fail(`${pointer}: expected ${types.join('|')}, got ${actual}`);
            return;
        }
        if (value === null) return;
    }

    if (schema.enum && !schema.enum.includes(value)) {
        fail(`${pointer}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            fail(`${pointer}: ${value} < minimum ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            fail(`${pointer}: ${value} > maximum ${schema.maximum}`);
        }
    }
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            fail(`${pointer}: shorter than minLength ${schema.minLength}`);
        }
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
            fail(`${pointer}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
        }
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            fail(`${pointer}: fewer than ${schema.minItems} items`);
        }
        if (schema.items) {
            value.forEach((item, index) =>
                validateAgainstSchema(item, schema.items, root, `${pointer}[${index}]`),
            );
        }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const properties = schema.properties ?? {};
        for (const key of schema.required ?? []) {
            if (!(key in value)) fail(`${pointer}: missing required property "${key}"`);
        }
        if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
            fail(`${pointer}: fewer than ${schema.minProperties} properties`);
        }
        for (const [key, child] of Object.entries(value)) {
            if (properties[key]) {
                validateAgainstSchema(child, properties[key], root, `${pointer}.${key}`);
            } else if (schema.additionalProperties === false) {
                fail(`${pointer}: unexpected property "${key}"`);
            } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                validateAgainstSchema(child, schema.additionalProperties, root, `${pointer}.${key}`);
            }
        }
    }
};
/** Reference cities verified by hand against GeoNames, IANA and the national methods. */
const REFERENCE_CITIES = [
    { id: 290030, name: 'Doha', countryCode: 'QA', latitude: 25.28545, longitude: 51.53096, timezone: 'Asia/Qatar', method: 'qatar', madhab: 'shafi', offsetJanuary: 180, offsetJuly: 180, arabic: 'الدوحة' },
    { id: 104515, name: 'Makkah', countryCode: 'SA', latitude: 21.42664, longitude: 39.82563, timezone: 'Asia/Riyadh', method: 'umm_al_qura', madhab: 'shafi', offsetJanuary: 180, offsetJuly: 180, arabic: 'مكة المكرمة' },
    { id: 109223, name: 'Madinah', countryCode: 'SA', latitude: 24.46861, longitude: 39.61417, timezone: 'Asia/Riyadh', method: 'umm_al_qura', madhab: 'shafi', offsetJanuary: 180, offsetJuly: 180, arabic: 'المدينة' },
    { id: 360630, name: 'Cairo', countryCode: 'EG', latitude: 30.06263, longitude: 31.24967, timezone: 'Africa/Cairo', method: 'egyptian', madhab: 'shafi', offsetJanuary: 120, offsetJuly: 180, arabic: 'القاهرة' },
    { id: 745044, name: 'Istanbul', countryCode: 'TR', latitude: 41.01384, longitude: 28.94966, timezone: 'Europe/Istanbul', method: 'turkey', madhab: 'hanafi', offsetJanuary: 180, offsetJuly: 180, arabic: 'اسطنبول' },
    { id: 1174872, name: 'Karachi', countryCode: 'PK', latitude: 24.8608, longitude: 67.0104, timezone: 'Asia/Karachi', method: 'karachi', madhab: 'hanafi', offsetJanuary: 300, offsetJuly: 300, arabic: 'كراتشي' },
    { id: 2643743, name: 'London', countryCode: 'GB', latitude: 51.50853, longitude: -0.12574, timezone: 'Europe/London', method: 'north_america', madhab: 'shafi', offsetJanuary: 0, offsetJuly: 60, arabic: 'لندن' },
    { id: 5128581, name: 'New York City', countryCode: 'US', latitude: 40.71427, longitude: -74.00597, timezone: 'America/New_York', method: 'north_america', madhab: 'shafi', offsetJanuary: -300, offsetJuly: -240, arabic: 'نيويورك' },
    { id: 292223, name: 'Dubai', countryCode: 'AE', latitude: 25.07725, longitude: 55.30927, timezone: 'Asia/Dubai', method: 'dubai', madhab: 'shafi', offsetJanuary: 240, offsetJuly: 240, arabic: 'دبي' },
];

/** Instants used to prove that the dataset never treats a UTC offset as permanent. */
const WINTER = Date.parse('2026-01-15T12:00:00Z');
const SUMMER = Date.parse('2026-07-15T12:00:00Z');

const validateDocuments = async (schema) => {
    const documents = {
        citiesDocument: 'cities.json',
        countriesDocument: 'countries.json',
        timezonesDocument: 'timezones.json',
        methodsDocument: 'methods.json',
        metaDocument: 'meta.json',
    };
    for (const [name, file] of Object.entries(documents)) {
        const value = JSON.parse(await readFile(path.join(DIR, file), 'utf8'));
        validateAgainstSchema(value, schema.documents[name], schema, file);
    }
};

const validateMethods = (dataset) => {
    const engineKeys = Object.keys(CALCULATION_METHODS).sort();
    const publishedKeys = Object.keys(dataset.methods).sort();
    check(
        engineKeys.join(',') === publishedKeys.join(','),
        'methods.json keys differ from the runtime registry: ' +
            `runtime [${engineKeys}], published [${publishedKeys}]`,
    );

    for (const [id, method] of Object.entries(dataset.methods)) {
        const engine = CALCULATION_METHODS[id];
        if (!engine) continue;
        check(method.fajrAngle === engine.fajrAngle, `${id}: fajrAngle differs from the runtime`);
        check(
            (method.ishaAngle ?? null) === (engine.ishaAngle ?? null),
            `${id}: ishaAngle differs from the runtime`,
        );
        check(
            (method.ishaMinutes ?? null) === (engine.ishaMinutes ?? null),
            `${id}: ishaMinutes differs from the runtime`,
        );
        check(
            (method.ramadanIshaMinutes ?? null) === (engine.ramadanIshaMinutes ?? null),
            `${id}: ramadanIshaMinutes differs from the runtime`,
        );
        if (typeof method.ishaMinutes === 'number') {
            check(
                method.ishaAngle === undefined || method.ishaAngle === null,
                `${id}: ishaAngle and ishaMinutes are mutually exclusive`,
            );
        } else {
            check(typeof method.ishaAngle === 'number', `${id}: needs an ishaAngle or ishaMinutes`);
        }
    }

    check(
        Object.keys(dataset.unimplementedMethods).length > 0,
        'methods.json documents no unimplemented methods',
    );
    check(
        dataset.methods[dataset.meta.resolution.fallbackMethod] !== undefined,
        `fallback method "${dataset.meta.resolution.fallbackMethod}" is not published`,
    );
};

const validateTimezones = (dataset) => {
    const sampleYear = dataset.meta.generatedAt.slice(0, 4);
    let checked = 0;
    for (const [zone, entry] of Object.entries(dataset.timezones)) {
        check(entry.timezone === zone, `timezones.json: key ${zone} != record.timezone`);
        const january = utcOffsetMinutesFor(zone, Date.parse(`${sampleYear}-01-15T12:00:00Z`));
        const july = utcOffsetMinutesFor(zone, Date.parse(`${sampleYear}-07-15T12:00:00Z`));
        check(
            entry.offsetMinutesOnJanuarySample === january &&
                entry.offsetMinutesOnJulySample === july,
            `timezones.json: ${zone} samples are stale (stored ` +
                `${entry.offsetMinutesOnJanuarySample}/${entry.offsetMinutesOnJulySample}, ` +
                `IANA says ${january}/${july})`,
        );
        check(
            entry.rawOffsetMinutes ===
                Math.min(entry.offsetMinutesOnJanuarySample, entry.offsetMinutesOnJulySample),
            `timezones.json: ${zone} rawOffsetMinutes is not the standard-time offset`,
        );
        check(
            entry.observesDst ===
                (entry.offsetMinutesOnJulySample !== entry.offsetMinutesOnJanuarySample),
            `timezones.json: ${zone} observesDst disagrees with the samples`,
        );
        check(
            entry.offsetVariesDuringYear === entry.offsetMinutesMax - entry.offsetMinutesMin > 0,
            `timezones.json: ${zone} offsetVariesDuringYear disagrees with offsetMinutesMin/Max`,
        );
        check(
            entry.dstOffsetMinutes ===
                (entry.observesDst
                    ? Math.abs(entry.offsetMinutesOnJulySample - entry.offsetMinutesOnJanuarySample)
                    : 0),
const formatOffset = (minutes) => {
    const sign = minutes < 0 ? '-' : '+';
    const absolute = Math.abs(minutes);
    return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
};

const validateData = (dataset) => {
    const ids = new Set();
    const triples = new Set();
    let arabicNames = 0;
    let regionNames = 0;

    for (const city of dataset.cities) {
        check(!ids.has(city.id), `duplicate city id ${city.id}`);
        ids.add(city.id);

        const triple = `${city.countryCode}|${city.name.toLowerCase()}|${city.latitude},${city.longitude}`;
        check(!triples.has(triple), `duplicate city (country, name, coordinates): ${triple}`);
        triples.add(triple);

        check(
            Boolean(dataset.countries[city.countryCode]),
            `city ${city.id} (${city.name}) has unknown countryCode ${city.countryCode}`,
        );
        check(
            Boolean(dataset.timezones[city.timezone]),
            `city ${city.id} (${city.name}) has unknown timezone ${city.timezone}`,
        );
        check(
            Number.isFinite(city.latitude) && Math.abs(city.latitude) <= 90,
            `city ${city.id} has an invalid latitude (${city.latitude})`,
        );
        check(
            Number.isFinite(city.longitude) && Math.abs(city.longitude) <= 180,
            `city ${city.id} has an invalid longitude (${city.longitude})`,
        );
        for (const key of Object.keys(city)) {
            check(
                !/offset|gmt|dst/i.test(key),
                `city ${city.id} stores "${key}": UTC offsets must be derived from the IANA zone`,
            );
        }
        if (city.method) {
            check(
                Boolean(dataset.methods[city.method]),
                `city ${city.id} overrides to unknown method "${city.method}"`,
            );
        }
        if (city.nameAr) arabicNames += 1;
        if (city.region) regionNames += 1;
    }

    for (const [iso2, country] of Object.entries(dataset.countries)) {
        check(iso2 === country.iso2, `countries.json: key ${iso2} != record.iso2`);
        check(
            Boolean(dataset.methods[country.defaultMethod]),
            `country ${iso2} defaults to unknown method "${country.defaultMethod}"`,
        );
        check(
            SUPPORTED_MADHABS.includes(country.defaultMadhab),
            `country ${iso2} defaults to unknown madhab "${country.defaultMadhab}"`,
        );
        for (const alternative of country.alternatives ?? []) {
            check(
                Boolean(dataset.methods[alternative]),
                `country ${iso2} lists unknown alternative method "${alternative}"`,
            );
        }
        for (const pending of country.pendingMethods ?? []) {
            check(
                Boolean(dataset.unimplementedMethods[pending]),
                `country ${iso2} lists pending method "${pending}" that is not documented as unimplemented`,
            );
        }
    }

    const counts = dataset.meta.counts ?? {};
    check(counts.cities === dataset.cities.length, 'meta.counts.cities does not match cities.json');
    check(
        counts.countries === Object.keys(dataset.countries).length,
        'meta.counts.countries does not match countries.json',
    );
    check(
        counts.timezones === Object.keys(dataset.timezones).length,
        'meta.counts.timezones does not match timezones.json',
    );
    check(
        counts.methods === Object.keys(dataset.methods).length,
        'meta.counts.methods does not match methods.json',
    );

    const quality = dataset.meta.quality ?? {};
    check(quality.skippedInvalidRows === 0, `meta.quality.skippedInvalidRows is ${quality.skippedInvalidRows}`);
    check(
        quality.skippedUnknownTimezones === 0,
        `meta.quality.skippedUnknownTimezones is ${quality.skippedUnknownTimezones}`,
    );
    check(
        quality.citiesWithArabicName === arabicNames,
        `meta.quality.citiesWithArabicName (${quality.citiesWithArabicName}) != ${arabicNames}`,
    );
    notes.push(
        `${dataset.cities.length} cities, ${arabicNames} with Arabic names ` +
            `(${((arabicNames / dataset.cities.length) * 100).toFixed(1)}%), ${regionNames} with region names`,
    );
};

const validateResolution = (dataset) => {
    const rows = [];
    for (const reference of REFERENCE_CITIES) {
        const city = dataset.cityById.get(reference.id);
        check(Boolean(city), `reference city ${reference.name} (${reference.id}) is missing`);
        if (!city) continue;

        check(
            city.name === reference.name,
            `city ${reference.id} is named "${city.name}", expected "${reference.name}"`,
        );
        check(
            Math.abs(city.latitude - reference.latitude) < 1e-4 &&
                Math.abs(city.longitude - reference.longitude) < 1e-4,
            `city ${reference.name}: coordinates ${city.latitude},${city.longitude} differ from the verified values`,
        );
        check(
            city.timezone === reference.timezone,
            `city ${reference.name}: timezone ${city.timezone} != ${reference.timezone}`,
        );
        check(
            city.nameAr === reference.arabic,
            `city ${reference.name}: Arabic name "${city.nameAr}" != "${reference.arabic}"`,
        );

        const winter = resolveCityPrayerConfig({ dataset, cityId: reference.id, date: WINTER });
        const summer = resolveCityPrayerConfig({ dataset, cityId: reference.id, date: SUMMER });
        check(
            winter.method.id === reference.method,
            `city ${reference.name}: method ${winter.method.id} != ${reference.method}`,
        );
        check(
            winter.madhab === reference.madhab,
            `city ${reference.name}: madhab ${winter.madhab} != ${reference.madhab}`,
        );
        check(
            winter.offsetMinutes === reference.offsetJanuary,
            `city ${reference.name}: winter offset ${winter.offsetMinutes} != ${reference.offsetJanuary}`,
        );
        check(
            summer.offsetMinutes === reference.offsetJuly,
            `city ${reference.name}: summer offset ${summer.offsetMinutes} != ${reference.offsetJuly}`,
        );
        check(
            summer.query.utcOffset === reference.offsetJuly / 60,
            `city ${reference.name}: utcOffset ${summer.query.utcOffset}h != ${reference.offsetJuly / 60}h`,
        );

        rows.push({
            city: reference.name,
            country: reference.countryCode,
            timezone: city.timezone,
            coordinates: `${city.latitude},${city.longitude}`,
            method: winter.method.id,
            madhab: winter.madhab,
            offset: `${formatOffset(winter.offsetMinutes)} -> ${formatOffset(summer.offsetMinutes)}`,
        });
    }
    return rows;
};

/** Proves that offsets are derived per date, never treated as a permanent property. */
const validateDstBehaviour = (dataset) => {
    const dstZones = ['Europe/London', 'America/New_York', 'Australia/Sydney'];
    for (const zone of dstZones) {
        const entry = dataset.timezones[zone];
        check(Boolean(entry), `timezones.json is missing ${zone}`);
        if (!entry) continue;
        const winter = utcOffsetMinutesFor(zone, WINTER);
        const summer = utcOffsetMinutesFor(zone, SUMMER);
        check(winter !== summer, `${zone} is expected to change offset between the samples`);
        check(entry.observesDst === true, `${zone} should be flagged as observing DST`);
        check(
            entry.offsetVariesDuringYear === true,
            `${zone} should be flagged as varying during the year`,
        );

        const city = dataset.cities.find((candidate) => candidate.timezone === zone);
        check(Boolean(city), `no city uses ${zone}`);
        if (!city) continue;
        const cityWinter = resolveCityPrayerConfig({ dataset, cityId: city.id, date: WINTER });
        const citySummer = resolveCityPrayerConfig({ dataset, cityId: city.id, date: SUMMER });
        check(
            cityWinter.offsetMinutes !== citySummer.offsetMinutes,
            `${city.name} must resolve to different offsets in winter and summer`,
        );
        check(
            !('utcOffset' in city) && !('gmtOffset' in city),
            `${city.name} must not carry a permanent UTC offset`,
        );
    }

    const casablanca = dataset.timezones['Africa/Casablanca'];
    if (casablanca) {
        check(
            casablanca.offsetVariesDuringYear === true,
            'Africa/Casablanca changes offset during Ramadan and must be flagged as varying',
        );
    }
    notes.push(`DST verified for ${dstZones.join(', ')} plus the Morocco (Ramadan) exception`);
};
            `timezones.json: ${zone} dstOffsetMinutes is inconsistent`,
        );
        checked += 1;
    }
    notes.push(`re-derived ${checked} IANA offsets from the system time-zone database`);
};
    };
    for (const [name, file] of Object.entries(documents)) {
        const value = JSON.parse(await readFile(path.join(DIR, file), 'utf8'));
        validateAgainstSchema(value, schema.documents[name], schema, file);
    }
};