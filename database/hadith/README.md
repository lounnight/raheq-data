# Hadith dataset

Arabic hadith of the Nine Books, one JSON file per book:

| file | book |
| --- | --- |
| `bukhari.json` | صحيح البخاري |
| `muslim.json` | صحيح مسلم |
| `abudawud.json` | سنن أبي داود |
| `tirmidhi.json` | جامع الترمذي |
| `nasai.json` | سنن النسائي |
| `ibnmajah.json` | سنن ابن ماجه |
| `malik.json` | موطأ مالك |
| `ahmad.json` | مسند أحمد |
| `darimi.json` | سنن الدارمي |

The chapters (أبواب) of every book are kept beside the narrations, in
`chapters/<book>.json` — one metadata file per book, never a field of a record.
`books.json` is the manifest of the dataset: the nine books, their Arabic names and
how many narrations each one holds, so that a reader can list the dataset without
reading all of it.

## Record shape

Every narration is one object with **exactly four fields**, in this order:

```json
{
  "sanad": "حَدَّثَنَا عَبْدُ اللَّهِ بْنُ يُوسُفَ، قَالَ أَخْبَرَنَا مَالِكٌ، عَنْ هِشَامِ بْنِ عُرْوَةَ، عَنْ أَبِيهِ، عَنْ عَائِشَةَ أُمِّ الْمُؤْمِنِينَ",
  "matn": "رضى الله عنها ـ أَنَّ الْحَارِثَ بْنَ هِشَامٍ ـ رضى الله عنه ـ سَأَلَ رَسُولَ اللَّهِ صلى الله عليه وسلم فَقَالَ يَا رَسُولَ اللَّهِ كَيْفَ يَأْتِيكَ الْوَحْىُ",
  "first_narrator": "Aisha",
  "grade": "Sahih"
}
```

That is Bukhari 2 (`database/hadith/bukhari.json`): the chain of Malik ibn Anas
ends with `عائشة`, and the wording is what follows — the Companion's own
invocation (`رضى الله عنها`) stays with the wording, as it is printed.

| field | meaning |
| --- | --- |
| `sanad` | the chain of transmission, up to and including the last narrator |
| `matn` | the wording of the hadith that follows that chain |
| `first_narrator` | the Companion the narration is attributed to, transliterated (`""` when the chain names no Companion) |
| `grade` | the documented grading (`""` when no source documents one) |

A narration is addressed by its place in the file: the first record is hadith 1,
the second hadith 2, and so on. Nothing else is stored — the chapters of the book
are the metadata file of the next section, and book names, URLs and grading
sources live in the build script (`SOURCE_REGISTRY`) and in this file.

## Chapter metadata

`chapters/<book>.json` holds the chapters of one book in the order the book
prints them, each with the first and the last narration that belongs to it:

```json
{
  "chapters": [
    {
      "chapter_name": "باب كَيْفَ كَانَ بَدْءُ الْوَحْىِ إِلَى رَسُولِ اللَّهِ صلى الله عليه وسلم",
      "hadith_from": 1,
      "hadith_to": 1
    },
    {
      "chapter_name": "باب دُعَاؤُكُمْ إِيمَانُكُمْ",
      "hadith_from": 8,
      "hadith_to": 8
    }
  ]
}
```

| field | meaning |
| --- | --- |
| `chapter_name` | the Arabic heading the source prints, copied verbatim (diacritics and honourifics included) |
| `hadith_from` | the number of the first narration of the book that belongs to the chapter |
| `hadith_to` | the number of the last narration of the book that belongs to the chapter |

Those are the positions of the narrations in `<book>.json`, so the chapter of a
narration is the entry whose range holds its number. The same name appears once
per chapter it names: a book prints `باب الإيمان` again in its next كتاب, and
those are two chapters of the book, never merged into one.

## Rules the build follows

1. **No invented text.** `sanad` is a prefix of the published narration and
   `matn` is what follows it, both copied verbatim from the source. Narration
   formatting (tatweel, control marks) is normalised; wording and diacritics are
   untouched.
2. **No invented narrator.** `first_narrator` is filled only when the last link
   of the chain resolves to a Companion:
   * through Arabic Wikipedia, when the chain spelling resolves to an article
     that is in the curated list of Companions (`قائمة الصحابة`) or in the
     Arabic Companions categories, and
   * or through sunnah.com's own English translation, when every English label
     recorded for that Arabic name across the seven graded books points at the
     same Companion.
   Kinship links are resolved first (`عن أبيه` → the father named in the
   previous link). A chain that ends in a tabi'i (`نافع عن ابن عمر`) or in no
   name at all (mursal) gets `""` — the narrator is not guessed.
3. **No invented grade.** `grade` is copied from the grading the source
   publishes:
   * when all graders agree, the verdict alone (`Sahih`),
   * when they disagree, every documented verdict with its grader
     (`Hasan (Al-Albani); Da'if (Zubair Ali Zai)`) — no grader is silently
     preferred,
   * when nothing is documented, the field stays `""`.
4. **No author commentary in `matn`.** The editors' own words are removed where
   the edition appends them (`قَالَ أَبُو عِيسَى هَذَا حَدِيثٌ حَسَنٌ صَحِيحٌ`,
   `وَفِي الْبَابِ عَنْ …`) — most of them in Jami' at-Tirmidhi. A record whose
   wording would be empty after that trim is dropped instead.
5. **No invented chapter.** The chapter metadata holds the Arabic headings the
   book prints, copied verbatim (only the whitespace of the page is normalised,
   diacritics and honourifics included), in the order the book prints them, and
   nothing else.
   * The reference a source gives is taken on trust only when the page prints the
     same wording under it. The Muwatta the mirror serves numbers its narrations
     without the ones sunnah.com prints without Arabic text, so its references
     walk ahead of the pages; a reference the wording contradicts is corrected by
     the narration of the same كتاب that carries the same words.
   * A narration printed under one heading belongs to that chapter.
   * A narration the source lists in more than one chapter belongs to each of
     them, so their ranges overlap.
   * A narration whose source entry carries no reference, and no heading of its
     own, belongs to the chapter the *same wording* is printed under elsewhere in
     the same book — that is the chapter the text belongs to, not a guess. Such a
     narration may sit outside the block of the other narrations of its chapter,
     which is why one range of the nine books starts before the one before it.
   * A book whose source documents no chapter for a narration documents no
     chapter for it at all, and the narration is simply not covered by a range.

## Chapters

Chapters are read from the book pages of the same site the narrations come from,
so that text and chapters can never come from two different editions.

| book | chapter names are | from |
| --- | --- | --- |
| Bukhari | أبواب of every كتاب | `https://sunnah.com/bukhari/<n>` |
| Muslim | أبواب of every كتاب | `https://sunnah.com/muslim/<n>` |
| Abu Dawud | أبواب of every كتاب | `https://sunnah.com/abudawud/<n>` |
| Tirmidhi | أبواب of every كتاب | `https://sunnah.com/tirmidhi/<n>` |
| Nasa'i | أبواب of every كتاب | `https://sunnah.com/nasai/<n>` |
| Ibn Majah | أبواب of every كتاب | `https://sunnah.com/ibnmajah/<n>` |
| Malik | أسماء الكتب | `https://sunnah.com/malik/<n>` — the Muwatta as published there prints no باب |
| Ahmad | أسماء المسانيد | `https://sunnah.com/ahmad/<n>` for the مسانيد it publishes (1–7 and 31) — these pages print no باب |
| Darimi | 24 names it documents | the `chapters` list of the source |

How much each book can document, after the build:

| book | records | chapters printed | chapters written | records covered |
| --- | --- | --- | --- | --- |
| Bukhari | 7555 | 4094 | 3790 | 97% |
| Muslim | 7354 | 1336 | 1328 | 97% |
| Abu Dawud | 5270 | 1892 | 1874 | 98% |
| Tirmidhi | 3896 | 2245 | 1984 | 96% |
| Nasa'i | 5678 | 2526 | 2509 | 98% |
| Ibn Majah | 4337 | 1491 | 1490 | 94% |
| Malik | 1828 | 61 | 60 | 100% |
| Ahmad | 25801 | 8 | 8 | 5% |
| Darimi | 3384 | 24 | 24 | 100% |

A chapter the dataset holds no narration of is left out rather than given a range
of its own. Those are 610 of the 13677 chapters the sources print: 228 headings a
page prints with no narration under them, 334 headings printed without their
wording (their narrations are looked up by the same wording and end up in the
chapter that names them), and 48 narrations a reference the wording contradicts
moved to the chapter that prints them.

Musnad Ahmad is the outlier because sunnah.com publishes 8 of its ~30 مُسَانِد,
and the rest of the book is a continuous list of narrations: the 24445 records of
the مُسَانِد it does not publish belong to no documented chapter and no range covers
them.

Two books have no printed أبواب, so their chapters are what their source does
document: the kitbab of the Muwatta and the musnad of Musnad Ahmad. Headings the
source prints without their wording (`باب` and nothing else) are 418 of the 13677
it prints across the nine books — 224 of them in Jami' at-Tirmidhi, which prints
them for almost every chapter — and the narrations under them are looked up by the
same wording instead, and are left uncovered when even that is not documented.

Nine ranges of the nine books overlap, and one starts before the range before it
(1 of 1328 in Muslim, 4 of 1984 in Tirmidhi, 4 of 1490 in Ibn Majah): those are the
narrations a book prints in two chapters, which the dataset therefore holds
twice. The validator counts and reports them rather than trimming a range that the
source would not print.

### Sources

| book | text | grading |
| --- | --- | --- |
| Bukhari | hadith-api mirror of sunnah.com, `ara-bukhari` edition | Sahih by the book itself |
| Muslim | hadith-api mirror of sunnah.com, `ara-muslim` edition | Sahih by the book itself |
| Abu Dawud | hadith-api mirror of sunnah.com, `ara-abudawud` | sunnah.com gradings (Al-Albani, Muhammad Muhyi al-Din, Shu'ayb al-Arna'ut, Zubair Ali Zai) |
| Tirmidhi | hadith-api mirror of sunnah.com, `ara-tirmidhi` | sunnah.com gradings (Ahmad Shakir, Al-Albani, Bashar Awad, Zubair Ali Zai) |
| Nasa'i | hadith-api mirror of sunnah.com, `ara-nasai` | sunnah.com gradings (Abu Ghuddah, Al-Albani, Zubair Ali Zai) |
| Ibn Majah | hadith-api mirror of sunnah.com, `ara-ibnmajah` | sunnah.com gradings (Al-Albani, Muhammad Fu'ad, Shu'ayb al-Arna'ut, Zubair Ali Zai) |
| Malik | hadith-api mirror of sunnah.com, `ara-malik` (Yahya al-Laythi) | sunnah.com gradings (Salim al-Hilali) |
| Ahmad | IslamWeb edition of Musnad Ahmad, continuous numbering | sunnah.com gradings for the books it publishes (1–7 and 31), matched to the same wording |
| Darimi | sunnah.com's Arabic text | none published |

Sources that publish no per-narration grading (Bukhari, Muslim, Darimi) get the
book-level classification only — `Sahih` for the two Sahihs, `""` for
Sunan ad-Darimi — so that a reader can tell "graded as part of the book" from
"no grading published".

## Building and validating

```bash
npm run build:hadith      # writes database/hadith/<book>.json, chapters/<book>.json and books.json
npm run validate:hadith   # checks the written files
npm test                  # segmentation / narrator / grade / chapter unit tests
```

Useful options of the build:

```bash
node scripts/build-hadith-dataset.mjs --books=bukhari,muslim   # a subset
node scripts/build-hadith-dataset.mjs --documented-only        # only fully documented narrations
HADITH_SOURCE_CACHE=/var/cache/raheq node scripts/build-hadith-dataset.mjs
HADITH_SOURCE_REFRESH=1 node scripts/build-hadith-dataset.mjs  # re-download the sources
```

The build prints, per book, the number of records, the share of graded, of
identified narrators and of documented chapters, how many chapters it wrote, how
many of their ranges overlap or start out of order, how many lost their editor's
commentary, and how many could not be split at all.

`npm run validate:hadith` fails (exit code 1) when `books.json` does not list the
nine books with the counts their files hold, when a record does not have exactly
the four fields, when a field is not a string, when the Arabic text is missing or
contains Latin characters, when `sanad + matn` no longer reconstructs the published
narration, or when the chapter metadata of a book does not hold exactly the three
fields, names a chapter the book does not publish, does not list the chapters in
the order the book prints them, or points at records the book does not have.
