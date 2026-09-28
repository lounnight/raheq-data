/**
 * Small reference implementation for consuming the prayer-location dataset.
 *
 * It shows exactly how a consumer turns a city into the query parameters of
 * `GET /api/prayer-times`:
 *
 *   city -> country default method (or city override) -> method parameters
 *   city.timezone -> UTC offset for the requested date (IANA/ICU, DST-aware)
 *
 * The dataset is fetched from jsDelivr/GitHub in production; this module reads
 * it from `database/prayer/` so it can be re-used by the validator and tests.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'database',
    'prayer',
);

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/** Loads all five dataset files. */
export const loadPrayerLocations = async ({ dir = DEFAULT_DIR } = {}) => {
    const [meta, methods, countries, timezones, cities] = await Promise.all([
        readJson(path.join(dir, 'meta.json')),
        readJson(path.join(dir, 'methods.json')),
        readJson(path.join(dir, 'countries.json')),
        readJson(path.join(dir, 'timezones.json')),
        readJson(path.join(dir, 'cities.json')),
    ]);

    const cityById = new Map(cities.cities.map((city) => [city.id, city]));
    const citiesByCountry = new Map();
    for (const city of cities.cities) {
        if (!citiesByCountry.has(city.countryCode)) citiesByCountry.set(city.countryCode, []);
        citiesByCountry.get(city.countryCode).push(city);
    }

    return {
        meta,
        methods: methods.methods,
        unimplementedMethods: methods.unimplemented,
        countries: countries.countries,
        timezones: timezones.timezones,
        cities: cities.cities,
        cityById,
        citiesByCountry,
    };
};

/**
 * UTC offset of an IANA time zone at an instant, in minutes.
 * ICU (through `Intl`) resolves the IANA rules, so DST is always applied.
 */
export const utcOffsetMinutesFor = (timeZone, timestampMs) => {
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

/** Finds cities by (case-insensitive) English or Arabic name. */
export const findCities = (dataset, name, { countryCode } = {}) => {
    const wanted = name.trim().toLowerCase();
    return dataset.cities.filter(
        (city) =>
            (!countryCode || city.countryCode === countryCode.toUpperCase()) &&
            (city.name.toLowerCase() === wanted || city.nameAr === name.trim() || city.ascii?.toLowerCase() === wanted),
    );
};

/**
 * Resolves everything `GET /api/prayer-times` needs for a city.
 * @param {object} options
 * @param {Awaited<ReturnType<typeof loadPrayerLocations>>} options.dataset
 * @param {number} options.cityId GeoNames id
 * @param {Date|number} [options.date] date used to derive the UTC offset
 */
export const resolveCityPrayerConfig = ({ dataset, cityId, date = new Date() }) => {
    const city = dataset.cityById.get(Number(cityId));
    if (!city) throw new Error(`unknown city id: ${cityId}`);

    const country = dataset.countries[city.countryCode];
    if (!country) throw new Error(`city ${cityId} references unknown country ${city.countryCode}`);

    const methodId = city.method ?? country.defaultMethod ?? dataset.meta.resolution.fallbackMethod;
    const method = dataset.methods[methodId];
    if (!method) throw new Error(`city ${cityId} resolves to unknown method "${methodId}"`);

    const madhab = city.madhab ?? country.defaultMadhab ?? dataset.meta.resolution.fallbackMadhab;
    const offsetMinutes = utcOffsetMinutesFor(
        city.timezone,
        date instanceof Date ? date.getTime() : Number(date),
    );

    return {
        city: {
            id: city.id,
            name: city.name,
            nameAr: city.nameAr ?? null,
            countryCode: city.countryCode,
            country: country.name,
            latitude: city.latitude,
            longitude: city.longitude,
            timezone: city.timezone,
        },
        method: { id: methodId, ...method },
        madhab,
        offsetMinutes,
        utcOffsetHours: offsetMinutes / 60,
        query: {
            latitude: city.latitude,
            longitude: city.longitude,
            utcOffset: offsetMinutes / 60,
            method: methodId,
            madhab,
            date: date instanceof Date ? toIsoDate(date, offsetMinutes) : null,
        },
    };
};

const toIsoDate = (date, offsetMinutes) => {
    const shifted = new Date(date.getTime() + offsetMinutes * 60000);
    return shifted.toISOString().slice(0, 10);
};
