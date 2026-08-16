/**
 * ADR-023 S2.6 — GENERATED. Do not edit by hand.
 *
 * Regenerate with: pnpm --filter @orreris/worker font:index-build
 * Source: https://fonts.google.com/metadata/fonts
 * Generated: 2026-08-16 — 1942 families, 7804 faces.
 *
 * METADATA ONLY. No URLs, no hashes, no bytes. A row here says a family EXISTS, what faces and
 * scripts it has, and where its LICENCE lives; it does not say what any of them weigh in SHA-256,
 * because that answer belongs to the mirror, which hashes what it actually fetched (D1). See
 * `font-index.ts` for the decoder and the format.
 *
 * One line per family, in POPULARITY order — the order is the default sort and costs nothing to
 * store. Fields: family|category|faces|subsets|licence, where category is one of s/f/d/h/m, faces
 * are Google's own keys ("400", "700i"), subsets are indices into FONT_INDEX_SUBSETS, and licence is
 * either a key of FONT_INDEX_LICENSE_PATHS, "x" for a family verified to have
 * no public licence at all (Google-proprietary — see RESTRICTED_FAMILIES in font-index-build.ts), or
 * "?" for a family a human has acknowledged and dated on
 * KNOWN_UNRESOLVED_LICENSES (the lookup missed, shipped anyway, flagged unresolved). NEVER empty: a
 * family this build could not resolve AND could not find acknowledged fails the whole run rather than
 * shipping a blank that reads as a licence fact — 2 families are restricted,
 * 10 families are unresolved-but-acknowledged, this run.
 */
export const FONT_INDEX_SUBSETS: readonly string[] = ["cyrillic", "cyrillic-ext", "greek", "greek-ext", "latin", "latin-ext", "math", "symbols", "vietnamese", "hebrew", "armenian", "bengali", "canadian-aboriginal", "devanagari", "ethiopic", "georgian", "gujarati", "gurmukhi", "khmer", "lao", "malayalam", "oriya", "sinhala", "tamil", "telugu", "thai", "japanese", "arabic", "korean", "chinese-traditional", "emoji", "chinese-simplified", "cherokee", "nushu", "syriac", "tifinagh", "symbols2", "gothic", "old-italic", "runic", "braille", "kayah-li", "adlam", "old-permic", "chinese-hongkong", "myanmar", "kannada", "meetei-mayek", "ol-chiki", "mayan-numerals", "warang-citi", "khojki", "bhaiksuki", "tibetan", "caucasian-albanian", "lisu", "thaana", "javanese", "new-tai-lue", "khudawadi", "music", "yi", "samaritan", "tagalog", "buhid", "linear-a", "ahom", "osmanya", "sora-sompeng", "tai-viet", "glagolitic", "elbasan", "anatolian-hieroglyphs", "syloti-nagri", "tangsa", "beria-erfe", "batak", "balinese", "mongolian", "old-hungarian", "kaithi", "cypro-minoan", "coptic", "yezidi", "pahawh-hmong", "tamil-supplement", "shavian", "vithkuqi", "dives-akuru", "carian", "siddham", "gunjala-gondi", "tangut", "avestan", "dogra", "toto", "hanunoo", "duployan", "multani", "marchen", "old-persian", "nko", "mende-kikakui", "bamum", "sunuwar", "takri", "limbu", "nag-mundari", "lepcha", "makasar", "wancho", "egyptian-hieroglyphs", "nandinagari", "osage", "old-turkic", "grantha", "medefaidrin", "lydian", "khitan-small-script", "old-north-arabian", "todhri", "vai", "znamenny", "indic-siyaq-numbers", "nabataean", "mahajani", "tai-le", "mandaic", "deseret", "cuneiform", "phoenician", "nyiakeng-puachue-hmong", "inscriptional-parthian", "ottoman-siyaq-numbers", "sundanese", "imperial-aramaic", "kana-extended", "sogdian", "newa", "meroitic", "meroitic-cursive", "meroitic-hieroglyphs", "inscriptional-pahlavi", "palmyrene", "tagbanwa", "cham", "buginese", "zanabazar-square", "brahmi", "miao", "tai-tham", "hanifi-rohingya", "old-south-arabian", "sharada", "elymaic", "old-uyghur", "kawi", "ugaritic", "chakma", "rejang", "kirat-rai", "bassa-vah", "mro", "tirhuta", "chorasmian", "linear-b", "hatran", "pau-cin-hau", "cypriot", "masaram-gondi", "saurashtra", "signwriting", "kharoshthi", "manichaean", "old-sogdian", "psalter-pahlavi", "phags-pa", "lycian", "ogham", "soyombo", "modi"];

/** Licence code → path in `google/fonts`, with `%` standing for the family's directory slug. Does
 *  NOT include "x" (restricted) — that code names no path; see font-index.ts's decoder. */
export const FONT_INDEX_LICENSE_PATHS: Readonly<Record<string, string>> = {
  "o": "ofl/%/OFL.txt",
  "a": "apache/%/LICENSE.txt",
  "u": "ufl/%/UFL.txt",
  "c": "ufl/%/LICENCE.txt"
};

export const FONT_INDEX_RAW = `Roboto|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,6,7,8|o
Open Sans|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|0,1,2,3,9,4,5,6,7,8|o
Google Sans|s|400,400i,500,500i,600,600i,700,700i|10,11,12,0,1,13,14,15,2,3,16,17,9,18,19,4,5,20,21,22,7,23,24,25,8|x
Inter|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Montserrat|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Poppins|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|13,4,5|o
Noto Sans JP|s|100,200,300,400,500,600,700,800,900|0,26,4,5,8|o
Lato|s|100,100i,300,300i,400,400i,700,700i,900,900i|4,5|o
Arimo|s|400,400i,500,500i,600,600i,700,700i|0,1,2,3,9,4,5,8|o
Roboto Condensed|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Roboto Mono|m|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|0,1,2,4,5,8|o
Oswald|s|200,300,400,500,600,700|0,1,4,5,8|o
Noto Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,13,2,3,4,5,8|o
DM Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|4,5|o
Raleway|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Nunito|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,4,5,8|o
Playfair Display|f|400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,4,5,8|o
Nunito Sans|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,4,5,8|o
Roboto Slab|f|100,200,300,400,500,600,700,800,900|0,1,2,3,4,5,8|a
Rubik|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|27,0,1,9,4,5|o
Archivo Black|s|400|4,5|o
Outfit|s|100,200,300,400,500,600,700,800,900|4,5|o
Ubuntu|s|300,300i,400,400i,500,500i,700,700i|0,1,2,3,4,5|u
Manrope|s|200,300,400,500,600,700,800|0,1,2,4,5,8|o
Kanit|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,25,8|o
Noto Sans KR|s|100,200,300,400,500,600,700,800,900|0,28,4,5,8|o
Merriweather|f|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Work Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Black Ops One|d|400|1,4,5,8|o
Prompt|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,25,8|o
Lora|f|400,400i,500,500i,600,600i,700,700i|0,1,4,5,6,7,8|o
Bebas Neue|s|400|4,5|o
Saira|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Noto Sans TC|s|100,200,300,400,500,600,700,800,900|29,0,4,5,8|o
PT Sans|s|400,400i,700,700i|0,1,4,5|o
Figtree|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Bricolage Grotesque|s|200,300,400,500,600,700,800|4,5,8|o
Plus Jakarta Sans|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|1,4,5,8|o
Mulish|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,4,5,8|o
Share Tech|s|400|4|o
Smooch Sans|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Barlow|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Quicksand|s|300,400,500,600,700|4,5,8|o
Source Sans 3|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Jost|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,4,5|o
Karla|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5|o
IBM Plex Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|0,1,2,4,5,8|o
Source Code Pro|m|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Heebo|s|100,200,300,400,500,600,700,800,900|9,4,5,6,7|o
Archivo|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
JetBrains Mono|m|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|0,1,2,4,5,8|o
Fira Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Titillium Web|s|200,200i,300,300i,400,400i,600,600i,700,700i,900|4,5|o
Noto Serif|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,6,8|o
Fjalla One|s|400|1,4,5,8|o
Space Grotesk|s|300,400,500,600,700|4,5,8|o
Noto Color Emoji|s|400|30|o
PT Serif|f|400,400i,700,700i|0,1,4,5|o
Lobster Two|d|400,400i,700,700i|4|o
Changa One|d|400,400i|4|o
Noto Sans SC|s|100,200,300,400,500,600,700,800,900|31,0,4,5,8|o
Google Sans Flex|s|1,100,200,300,400,500,600,700,800,900,1000|12,32,4,5,6,33,7,34,35,8|x
Libre Baskerville|f|400,400i,500,500i,600,600i,700,700i|4,5|o
Cormorant Garamond|f|300,300i,400,400i,500,500i,600,600i,700,700i|0,1,4,5,8|o
Dancing Script|h|400,500,600,700|4,5,8|o
Noto Serif JP|f|200,300,400,500,600,700,800,900|0,26,4,5,8|o
Libre Franklin|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Barlow Condensed|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Inconsolata|m|200,300,400,500,600,700,800,900|4,5,8|o
Anton|s|400|4,5,8|o
Josefin Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4,5,8|o
EB Garamond|f|400,400i,500,500i,600,600i,700,700i,800,800i|0,1,2,3,4,5,8|o
Alfa Slab One|d|400|4,5,8|o
Instrument Serif|f|400,400i|4,5|o
Cairo|s|200,300,400,500,600,700,800,900,1000|27,4,5|o
Public Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Assistant|s|200,300,400,500,600,700,800|9,4,5|o
Mukta|s|200,300,400,500,600,700,800|13,4,5|o
Roboto Flex|s|100,200,300,400,500,600,700,800,900,1000|0,1,2,4,5,8|o
Hind Siliguri|s|300,400,500,600,700|11,4,5|o
Lilita One|d|400|4,5|o
Sora|s|100,200,300,400,500,600,700,800|4,5|o
Fraunces|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Lexend|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Schibsted Grotesk|s|400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Inter Tight|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Nanum Gothic|s|400,700,800|28,4|o
Cabin|s|400,400i,500,500i,600,600i,700,700i|4,5,8|o
Noto Sans Khmer|s|100,200,300,400,500,600,700,800,900|18,4,5|o
Bitter|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
M PLUS Rounded 1c|s|100,300,400,500,700,800,900|0,1,2,3,9,26,4,5,8|?
Dosis|s|200,300,400,500,600,700,800|4,5,8|o
Fredoka|s|300,400,500,600,700|9,4,5|o
Orbitron|s|400,500,600,700,800,900|4|o
Rajdhani|s|300,400,500,600,700|13,4,5|o
Urbanist|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Red Hat Display|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Exo 2|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Noto Sans Telugu|s|100,200,300,400,500,600,700,800,900|4,5,24|o
IBM Plex Mono|m|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|0,1,4,5,8|o
Ramabhadra|s|400|4,24|o
Geist|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Anek Telugu|s|100,200,300,400,500,600,700,800|4,5,24|o
Hind|s|300,400,500,600,700|13,4,5|o
Caveat|h|400,500,600,700|0,1,4,5|o
Instrument Sans|s|400,400i,500,500i,600,600i,700,700i|4,5|o
DM Serif Display|f|400,400i|4,5|o
Crimson Text|f|400,400i,600,600i,700,700i|4,5,8|o
Bungee|d|400|4,5,8|o
Oxygen|s|300,400,700|4,5|o
Pacifico|h|400|0,1,4,5,8|o
Tajawal|s|200,300,400,500,700,800,900|27,4|o
Cinzel|f|400,500,600,700,800,900|4,5|o
PT Sans Narrow|s|400,700|0,1,4,5|o
Gravitas One|d|400|4|o
Source Serif 4|f|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,4,5,8|o
Slabo 27px|f|400|4,5|o
Lobster|d|400|0,1,4,5,8|o
Merriweather Sans|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|1,4,5,8|o
Barlow Semi Condensed|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Overpass|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Arvo|f|400,400i,700,700i|4|o
Abel|s|400|4|o
Noto Sans Arabic|s|100,200,300,400,500,600,700,800,900|27,4,5,6,7|o
Teko|s|300,400,500,600,700|13,4,5|o
M PLUS 1p|s|100,300,400,500,700,800,900|0,1,2,3,9,26,4,5,8|o
Noto Serif KR|f|200,300,400,500,600,700,800,900|0,28,4,5,8|o
Comfortaa|d|300,400,500,600,700|0,1,2,4,5,8|o
Noto Sans Thai|s|100,200,300,400,500,600,700,800,900|4,5,25|o
Rethink Sans|s|400,400i,500,500i,600,600i,700,700i,800,800i|4,5|o
Bodoni Moda|f|400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,6,7|o
Maven Pro|s|400,500,600,700,800,900|4,5,8|o
Onest|s|100,200,300,400,500,600,700,800,900|0,1,4,5|o
Alumni Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Newsreader|f|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5,8|o
Domine|f|400,500,600,700|4,5|o
Asap|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Chakra Petch|s|300,300i,400,400i,500,500i,600,600i,700,700i|4,5,25,8|o
ABeeZee|s|400,400i|4,5|o
Shadows Into Light|h|400|4,5|o
Hanken Grotesk|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|1,4,5,8|o
Geist Mono|m|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,36,8|o
Abril Fatface|d|400|4,5|o
Lexend Deca|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Zen Kaku Gothic New|s|300,400,500,700,900|0,26,4,5|o
Play|s|400,700|0,1,2,4,5,8|o
Zilla Slab|f|300,300i,400,400i,500,500i,600,600i,700,700i|4,5|o
Questrial|s|400|4,5,8|o
Be Vietnam Pro|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Space Mono|m|400,400i,700,700i|4,5,8|o
Almarai|s|300,400,700,800|27,4|o
Archivo Narrow|s|400,400i,500,500i,600,600i,700,700i|4,5,8|o
Albert Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Marcellus|f|400|4,5|o
Noto Sans Tamil|s|100,200,300,400,500,600,700,800,900|4,5,23|o
DM Mono|m|300,300i,400,400i,500,500i|4,5|o
Exo|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Varela Round|s|400|9,4,5,8|o
League Spartan|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Cormorant|f|300,300i,400,400i,500,500i,600,600i,700,700i|0,1,4,5,8|o
Saira Condensed|s|100,200,300,400,500,600,700,800,900|4,5,8|o
IBM Plex Serif|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|0,1,4,5,8|o
Unbounded|s|200,300,400,500,600,700,800,900|0,1,4,5,8|o
Great Vibes|h|400|0,1,3,4,5,8|o
Indie Flower|h|400|4,5|o
Spectral|f|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|0,1,4,5,8|o
Frank Ruhl Libre|f|300,400,500,600,700,800,900|9,4,5|o
Syne|s|400,500,600,700,800|2,4,5|o
Sofia Sans|s|1,1i,100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,2,4,5|o
Righteous|d|400|4,5|o
Nanum Myeongjo|f|400,700,800|28,4|o
Noto Serif TC|f|200,300,400,500,600,700,800,900|29,0,4,5,8|o
Crimson Pro|f|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Epilogue|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
IBM Plex Sans Arabic|s|100,200,300,400,500,600,700|27,1,4,5|o
Geologica|s|100,200,300,400,500,600,700,800,900|0,1,2,4,5,8|o
Zen Maru Gothic|s|300,400,500,700,900|0,2,26,4,5|o
Permanent Marker|h|400|4|a
Roboto Serif|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Noto Serif SC|f|200,300,400,500,600,700,800,900|31,0,4,5,8|o
Satisfy|h|400|4|a
Kalam|h|300,400,700|13,4,5|o
Press Start 2P|d|400|0,1,2,4,5|o
Amiri|f|400,400i,700,700i|27,4,5|o
Viga|s|400|4,5|o
Baloo 2|d|400,500,600,700,800|13,4,5,8|o
Antic Slab|f|400|4|o
Angkor|d|400|18,4|o
Sarabun|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5,25,8|o
News Cycle|s|400,700|0,1,2,3,4,5,8|o
Vollkorn|f|400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,4,5,8|o
Luckiest Guy|d|400|4,5|a
LINE Seed JP|s|100,400,700,800|0,3,26,4,5|o
Fira Sans Condensed|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Catamaran|s|100,200,300,400,500,600,700,800,900|4,5,23|o
Literata|f|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
DM Serif Text|f|400,400i|4,5|o
Signika|s|300,400,500,600,700|4,5,8|o
Hammersmith One|s|400|4,5|o
Rowdies|d|300,400,700|4,5,8|o
Yellowtail|h|400|4,5|a
Noto Kufi Arabic|s|100,200,300,400,500,600,700,800,900|27,4,5,6,7|o
Red Hat Text|s|300,300i,400,400i,500,500i,600,600i,700,700i|4,5|o
Khand|s|300,400,500,600,700|13,4,5|o
Russo One|s|400|0,4,5|o
Alegreya Sans|s|100,100i,300,300i,400,400i,500,500i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Prata|f|400|0,1,4,8|o
Shippori Mincho|f|400,500,600,700,800|26,4,5|o
IBM Plex Sans Condensed|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|1,4,5,8|o
Hind Madurai|s|300,400,500,600,700|4,5,23|o
Cardo|f|400,400i,700|37,2,3,9,4,5,38,39|o
Acme|s|400|4|o
Aleo|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Tinos|f|400,400i,700,700i|0,1,2,3,9,4,5,8|?
Bree Serif|f|400|4,5|o
Montserrat Alternates|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Chivo|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Special Elite|d|400|4,5|a
Libre Barcode 39|d|400|4|o
Baskervville|f|400,400i,500,500i,600,600i,700,700i|4,5|o
Tenor Sans|s|400|0,4,5|o
Encode Sans|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Atkinson Hyperlegible|s|400,400i,700,700i|4,5|o
Courier Prime|m|400,400i,700,700i|4,5|o
Yanone Kaffeesatz|s|200,300,400,500,600,700|0,1,4,5,6,7,8|o
Noto Sans Display|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Alata|s|400|4,5,8|o
Playfair|f|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Share Tech Mono|m|400|4|o
Kumbh Sans|s|100,200,300,400,500,600,700,800,900|4,5,6,7|o
Gothic A1|s|100,200,300,400,500,600,700,800,900|0,1,2,3,28,4,5,8|o
Sawarabi Mincho|f|400|40,26,4,5|o
Amatic SC|h|400,700|0,9,4,5,8|o
Readex Pro|s|200,300,400,500,600,700|27,4,5,8|o
Alegreya|f|400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Cantarell|s|400,400i,700,700i|4,5|o
Sanchez|f|400,400i|4,5|o
Libre Caslon Text|f|400,400i,700|4,5|o
Patua One|d|400|4|o
Noto Sans Devanagari|s|100,200,300,400,500,600,700,800,900|13,4,5|o
Bangers|d|400|4,5,8|o
VT323|m|400|4,5,8|o
Crete Round|f|400,400i|4,5|o
Noto Sans Mono|s|100,200,300,400,500,600,700,800,900|0,1,2,3,4,5,8|o
Noto Naskh Arabic|f|400,500,600,700|27,4,5,6,7|o
Changa|s|200,300,400,500,600,700,800|27,4,5|o
Lexend Giga|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Fira Code|m|300,400,500,600,700|0,1,2,3,4,5,36|o
Oleo Script|d|400,700|4,5|o
Sawarabi Gothic|s|400|0,26,4,5,8|o
Advent Pro|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,4,5|o
Courgette|h|400|4,5|o
Rubik Mono One|s|400|0,4,5|o
Comic Neue|h|300,300i,400,400i,700,700i|4|o
Kaushan Script|h|400|4,5|o
Titan One|d|400|4,5|o
Golos Text|s|400,500,600,700,800,900|0,1,4,5|o
League Gothic|s|400|4,5,8|o
Old Standard TT|f|400,400i,700|0,1,4,5,8|o
Allura|h|400|4,5,8|o
Sen|s|400,500,600,700,800|4,5|o
Monda|s|400,500,600,700|4,5,8|o
Biryani|s|200,300,400,600,700,800,900|13,4,5|o
Sacramento|h|400|4,5|o
Antonio|s|100,200,300,400,500,600,700|4,5|o
Patrick Hand|h|400|4,5,8|o
Chelsea Market|d|400|4,5|o
Passion One|d|400,700,900|4,5|o
Creepster|d|400|4|o
BIZ UDPGothic|s|400,700|0,3,26,4,5|o
Yantramanav|s|100,300,400,500,700,900|13,4,5|o
Cookie|h|400|4|o
Italianno|h|400|4,5,8|o
Noticia Text|f|400,400i,700,700i|4,5,8|o
Gruppo|s|400|4,5|o
Signika Negative|s|300,400,500,600,700|4,5,8|o
Francois One|s|400|4,5,8|o
Zen Old Mincho|f|400,500,600,700,900|0,2,26,4,5|o
Philosopher|s|400,400i,700,700i|0,1,4,5,8|o
Martel|f|200,300,400,600,700,800,900|13,4,5|o
Zeyada|h|400|4,5|o
Asap Condensed|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Noto Nastaliq Urdu|f|400,500,600,700|27,4,5|o
Oxanium|d|200,300,400,500,600,700,800|4,5|o
Noto Sans Bengali|s|100,200,300,400,500,600,700,800,900|11,4,5|o
Josefin Slab|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4|o
Actor|s|400|4|o
PT Sans Caption|s|400,700|0,1,4,5|o
Nanum Gothic Coding|h|400,700|28,4|o
Amaranth|s|400,400i,700,700i|4|o
Quattrocento|f|400,700|4,5|o
Mitr|s|200,300,400,500,600,700|4,5,25,8|o
Neuton|f|200,300,400,400i,700,800|4,5|o
Rokkitt|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Encode Sans Condensed|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Kosugi Maru|s|400|0,26,4,5|a
Unica One|d|400|4,5,8|o
Black Han Sans|s|400|28,4|o
Fugaz One|d|400|4|o
Krub|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4,5,25,8|o
Alexandria|s|100,200,300,400,500,600,700,800,900|27,4,5,8|o
Rock Salt|h|400|4|a
Gilda Display|f|400|4,5|o
Unna|f|400,400i,700,700i|4,5|o
Commissioner|s|100,200,300,400,500,600,700,800,900|0,1,2,4,5,8|o
Didact Gothic|s|400|0,1,2,3,4,5|o
Playfair Display SC|f|400,400i,700,700i,900,900i|0,4,5,8|o
Gloria Hallelujah|h|400|4,5|o
Berkshire Swash|h|400|4,5|o
Libre Bodoni|f|400,400i,500,500i,600,600i,700,700i|4,5,8|o
Delius|h|400|4|o
Bai Jamjuree|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4,5,25,8|o
Vazirmatn|s|100,200,300,400,500,600,700,800,900|27,4,5|o
Forum|d|400|0,1,4,5|o
Sofia Sans Condensed|s|1,1i,100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,2,4,5|o
Suez One|f|400|9,4,5|o
Jura|s|300,400,500,600,700|0,1,2,3,41,4,5,8|o
Paytone One|s|400|4,5,8|o
Quattrocento Sans|s|400,400i,700,700i|4,5|o
Ubuntu Condensed|s|400|0,1,2,3,4,5|u
Faustina|f|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5,8|o
Rammetto One|d|400|4,5|o
STIX Two Text|f|400,400i,500,500i,600,600i,700,700i|0,1,2,4,5,8|o
Audiowide|d|400|4,5|o
Concert One|d|400|4,5|o
Andada Pro|f|400,400i,500,500i,600,600i,700,700i,800,800i|4,5,8|o
Tangerine|h|400,700|4|o
M PLUS 1|s|100,200,300,400,500,600,700,800,900|26,4,5,8|o
Yeseva One|d|400|0,1,4,5,8|o
Poiret One|d|400|0,4,5|o
Pinyon Script|h|400|4,5,8|o
Radio Canada|s|300,300i,400,400i,500,500i,600,600i,700,700i|12,4,5,8|o
Monoton|d|400|4,5|o
Playball|d|400|4,5,8|o
Cinzel Decorative|d|400,700,900|4,5|o
Pathway Gothic One|s|400|4,5|o
Dela Gothic One|d|400|0,2,26,4,5,8|o
Istok Web|s|400,400i,700,700i|0,1,4,5|o
El Messiri|s|400,500,600,700|27,0,4,5|o
Chango|d|400|4,5|o
Volkhov|f|400,400i,700,700i|4|o
Staatliches|d|400|4,5|o
Gabarito|d|400,500,600,700,800,900|4,5|o
Alex Brush|h|400|4,5,8|o
Noto Sans Hebrew|s|100,200,300,400,500,600,700,800,900|1,3,9,4,5|o
Google Sans Code|m|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|42,12,32,4,5,6,43,7,36,34,8|o
Abhaya Libre|f|400,500,600,700,800|4,5,22|o
PT Mono|m|400|0,1,4,5|o
Quantico|s|400,400i,700,700i|4|o
Eater|d|400|4,5|o
Architects Daughter|h|400|4,5|o
Arsenal|s|400,400i,700,700i|0,1,4,5,8|o
Lustria|f|400|4|o
Hind Guntur|s|300,400,500,600,700|4,5,24|o
Homemade Apple|h|400|4|a
Noto Serif Bengali|f|100,200,300,400,500,600,700,800,900|11,4,5|o
Lalezar|s|400|27,4,5,8|o
Gelasio|f|400,400i,500,500i,600,600i,700,700i|4,5,8|o
Lusitana|f|400,700|4|o
Ubuntu Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|0,1,2,3,4,5|c
Goldman|d|400,700|4,5,8|o
Caveat Brush|h|400|4,5|o
GFS Didot|f|400|2,3,4,8|o
Sorts Mill Goudy|f|400,400i|4,5|o
Cormorant Infant|f|300,300i,400,400i,500,500i,600,600i,700,700i|0,1,4,5,8|o
Saira Extra Condensed|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Ubuntu Mono|m|400,400i,700,700i|0,1,2,3,4,5|u
Michroma|s|400|4,5|o
Noto Serif Display|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Parisienne|h|400|4,5|o
Afacad|s|400,400i,500,500i,600,600i,700,700i|1,4,5,6,7,8|o
Noto Sans Symbols|s|100,200,300,400,500,600,700,800,900|4,5,7|o
Merienda|h|300,400,500,600,700,800,900|4,5,8|o
Petrona|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
IBM Plex Sans Thai|s|100,200,300,400,500,600,700|1,4,5,25|o
Noto Sans HK|s|100,200,300,400,500,600,700,800,900|44,0,4,5,8|o
Saira Semi Condensed|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Nanum Pen Script|h|400|28,4|o
Belleza|s|400|4,5|o
Radio Canada Big|s|400,400i,500,500i,600,600i,700,700i|4,5|o
Pragati Narrow|s|400,700|13,4,5|o
Varela|s|400|4,5|o
Vidaloka|f|400|4|o
Noto Sans Malayalam|s|100,200,300,400,500,600,700,800,900|4,5,20|o
Fira Sans Extra Condensed|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Reenie Beanie|h|400|4|o
Hind Vadodara|s|300,400,500,600,700|16,4,5|o
Averia Serif Libre|d|300,300i,400,400i,700,700i|4|o
Reddit Sans|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Dongle|s|300,400,700|28,4,5,8|o
Blinker|s|100,200,300,400,600,700,800,900|4,5|o
Besley|f|400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Alice|f|400|0,1,4,5|o
Bad Script|h|400|0,1,4,5,8|o
Fira Mono|m|400,500,700|0,1,2,3,4,5,36|o
Calistoga|d|400|4,5,8|o
Cousine|m|400,400i,700,700i|0,1,2,3,9,4,5,8|o
Cuprum|s|400,400i,500,500i,600,600i,700,700i|0,1,4,5,8|o
Syncopate|s|400,700|4,5|a
Amita|h|400,700|13,4,5|o
Anonymous Pro|m|400,400i,700,700i|0,2,4,5|o
Racing Sans One|d|400|4,5|o
Sofia Sans Extra Condensed|s|1,1i,100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,2,4,5|o
Jua|s|400|28,4|o
Host Grotesk|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5|o
Six Caps|s|400|4,5|o
Kaisei Decol|f|400,500,700|0,26,4,5|o
Carter One|d|400|4|o
Mate|f|400,400i|4,5|o
Nothing You Could Do|h|400|4|o
Squada One|d|400|4|o
Arapey|f|400,400i|4|o
Belanosima|s|400,600,700|4,5|o
Bowlby One SC|d|400|4,5|o
Economica|s|400,400i,700,700i|4,5|o
Mada|s|200,300,400,500,600,700,800,900|27,4,5|o
Pridi|f|200,300,400,500,600,700|4,5,25,8|o
Mukta Malar|s|200,300,400,500,600,700,800|4,5,23|o
Shippori Mincho B1|f|400,500,600,700,800|26,4,5|o
Ultra|f|400|4,5|a
Mrs Saint Delafield|h|400|4,5|o
Ropa Sans|s|400,400i|4,5|o
Pangolin|h|400|0,1,4,5,8|o
Adamina|f|400|4|o
Gochi Hand|h|400|4|o
Mona Sans|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Taviraj|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,25,8|o
Murecho|s|100,200,300,400,500,600,700,800,900|0,1,2,26,4,5|o
Handlee|h|400|4|o
Khula|s|300,400,600,700,800|13,4,5|o
Georama|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Eczar|f|400,500,600,700,800|13,2,3,4,5|o
Cabin Condensed|s|400,500,600,700|4,5,8|o
Londrina Solid|d|100,300,400,900|4|o
Hachi Maru Pop|h|400|0,26,4,5|o
Potta One|d|400|26,4,5,8|o
Anek Bangla|s|100,200,300,400,500,600,700,800|11,4,5|o
Julius Sans One|s|400|4,5|o
Sriracha|h|400|4,5,25,8|o
Sofia|h|400|4|o
Zen Kaku Gothic Antique|s|300,400,500,700,900|0,26,4,5|o
Funnel Sans|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5|o
Caprasimo|d|400|4,5|o
Wix Madefor Display|s|400,500,600,700,800|0,1,4,5,8|o
Familjen Grotesk|s|400,400i,500,500i,600,600i,700,700i|4,5,8|o
M PLUS 2|s|100,200,300,400,500,600,700,800,900|26,4,5,8|o
Martel Sans|s|200,300,400,600,700,800,900|13,4,5|o
Marck Script|h|400|0,4,5|o
Pirata One|d|400|4,5|o
Leckerli One|h|400|4|o
Akshar|s|300,400,500,600,700|13,4,5|o
Tilt Warp|d|400|4,5,8|o
Italiana|s|400|4|o
Damion|h|400|4,5|o
Gudea|s|400,400i,700|4,5|o
Yrsa|f|300,300i,400,400i,500,500i,600,600i,700,700i|4,5,8|o
Aboreto|d|400|4,5|o
Chewy|d|400|4|a
Mr Dafoe|h|400|4,5|o
IBM Plex Sans JP|s|100,200,300,400,500,600,700|0,26,4,5|o
Palanquin|s|100,200,300,400,500,600,700|13,4,5|o
Basic|s|400|4,5|o
Reem Kufi|s|400,500,600,700|27,4,5,8|o
Limelight|d|400|4,5|o
Mandali|s|400|4,24|o
Rye|d|400|4,5|o
Nixie One|d|400|4|o
Darker Grotesque|s|300,400,500,600,700,800,900|4,5,8|o
REM|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Ovo|f|400|4|o
Yuji Mai|f|400|0,26,4,5|o
Palanquin Dark|s|400,500,600,700|13,4,5|o
Lemonada|d|300,400,500,600,700|27,4,5,8|o
Jersey 25|d|400|4,5|o
Niramit|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4,5,25,8|o
Alegreya Sans SC|s|100,100i,300,300i,400,400i,500,500i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Covered By Your Grace|h|400|4,5|o
K2D|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5,25,8|o
Carlito|s|400,400i,700,700i|0,1,2,3,4,5,8|o
Spline Sans|s|300,400,500,600,700|4,5|o
Cutive Mono|m|400|4,5|o
Tomorrow|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
IM Fell English|f|400,400i|4|o
Ruda|s|400,500,600,700,800,900|0,4,5,8|o
Bevan|f|400,400i|4,5,8|o
Parkinsans|s|300,400,500,600,700,800|4,5|o
Electrolize|s|400|4|o
Coda|d|400,800|4,5|o
BenchNine|s|300,400,700|4,5|o
MuseoModerno|d|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Itim|h|400|4,5,25,8|o
UnifrakturMaguntia|d|400|4|o
Grandstander|d|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Cedarville Cursive|h|400|4|o
Charm|h|400,700|4,5,25,8|o
Boogaloo|d|400|4|o
Red Hat Mono|m|300,300i,400,400i,500,500i,600,600i,700,700i|4,5|o
Charis SIL|f|400,400i,700,700i|0,1,4,5,8|o
Fahkwang|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4,5,25,8|o
Wix Madefor Text|s|400,400i,500,500i,600,600i,700,700i,800,800i|0,1,4,5,8|o
Atkinson Hyperlegible Next|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5|o
Just Another Hand|h|400|4,5|a
Ma Shan Zheng|h|400|31,4|o
Big Shoulders|d|100,200,300,400,500,600,700,800,900|4,5,8|o
Baloo Da 2|d|400,500,600,700,800|11,4,5,8|o
Funnel Display|d|300,400,500,600,700,800|4,5|o
Shrikhand|d|400|16,4,5|o
Skranji|d|400,700|4,5|o
Krona One|s|400|4,5|o
Kiwi Maru|f|300,400,500|0,26,4,5|o
Anuphan|s|100,200,300,400,500,600,700|4,5,25,8|o
Ms Madi|h|400|4,5,8|o
Anek Latin|s|100,200,300,400,500,600,700,800|4,5,8|o
Marcellus SC|f|400|4,5|o
Aldrich|s|400|4|o
ZCOOL XiaoWei|s|400|31,4|o
Sansita|s|400,400i,700,700i,800,800i,900,900i|4,5|o
Fustat|s|200,300,400,500,600,700,800|27,4,5|o
Noto Sans Sinhala|s|100,200,300,400,500,600,700,800,900|4,5,22|o
Neucha|h|400|0,4|o
Kreon|f|300,400,500,600,700|4,5|o
Gloock|f|400|1,4,5|o
Rufina|f|400,700|4,5|o
Reddit Sans Condensed|s|200,300,400,500,600,700,800,900|4,5,8|o
Secular One|s|400|9,4,5|o
Grenze Gotisch|d|100,200,300,400,500,600,700,800,900|4,5,8|o
Pontano Sans|s|300,400,500,600,700|4,5|o
Do Hyeon|s|400|28,4|o
Bona Nova SC|f|400,400i,700|0,1,2,9,4,5,8|o
Noto Sans Gujarati|s|100,200,300,400,500,600,700,800,900|16,4,5,6,7|o
Andika|s|400,400i,700,700i|0,1,4,5,8|o
Yatra One|d|400|13,4,5|o
Geo|s|400,400i|4|o
Lexend Exa|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Germania One|d|400|4|o
Spinnaker|s|400|4,5|o
Aclonica|s|400|4,5|a
Noto Sans Myanmar|s|100,200,300,400,500,600,700,800,900|4,5,45|o
Days One|s|400|0,4|o
Balsamiq Sans|d|400,400i,700,700i|0,1,4,5|o
Inria Serif|f|300,300i,400,400i,700,700i|4,5|o
Caudex|f|400,400i,700,700i|2,3,4,5,39,8|o
Nova Square|d|400|4,5|o
Vina Sans|d|400|4,5,8|o
Judson|f|400,400i,700|4,5,8|o
ADLaM Display|d|400|42,4,5|o
Livvic|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,900,900i|4,5,8|o
Athiti|s|200,300,400,500,600,700|4,5,25,8|o
Rozha One|f|400|13,4,5|o
Tiro Bangla|f|400,400i|11,4,5|o
Bellefair|f|400|9,4,5|o
Libre Barcode 128|d|400|4|o
Shadows Into Light Two|h|400|4,5|o
Castoro|f|400,400i|4,5|o
Special Gothic Expanded One|s|400|4,5|o
La Belle Aurore|h|400|4,5|o
Glory|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5,8|o
Sofia Sans Semi Condensed|s|1,1i,100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,2,4,5|o
Gowun Batang|f|400,700|28,4,5,8|o
Herr Von Muellerhoff|h|400|4,5|o
Bowlby One|d|400|4|o
Stardos Stencil|d|400,700|4|o
Podkova|f|400,500,600,700,800|0,1,4,5,8|o
Fondamento|h|400,400i|4,5|o
Proza Libre|s|400,400i,500,500i,600,600i,700,700i,800,800i|4,5|o
Sintony|s|400,700|4,5|o
Uncial Antiqua|d|400|4,5|o
Cormorant Upright|f|300,400,500,600,700|4,5,8|o
Seaweed Script|d|400|4,5|o
PT Serif Caption|f|400,400i|0,1,4,5|o
Glegoo|f|400,700|13,4,5|o
Pixelify Sans|d|400,500,600,700|0,4,5|o
Oranienbaum|f|400|0,1,4,5|o
Laila|f|300,400,500,600,700|13,4,5|o
Libre Caslon Display|f|400|4,5|o
Radley|f|400,400i|4,5|o
Barriecito|d|400|4,5,8|o
Oooh Baby|h|400|4,5,8|o
Trirong|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,25,8|o
AR One Sans|s|400,500,600,700|4,5,8|o
Fredericka the Great|d|400|4,5|o
DotGothic16|s|400|0,26,4,5|o
Overpass Mono|m|300,400,500,600,700|0,1,4,5,8|o
Gantari|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Gabriela|f|400|0,1,4,5|o
Corben|d|400,700|4,5|o
Metrophobic|s|400|4,5,8|o
BIZ UDGothic|s|400,700|0,3,26,4,5|o
Protest Revolution|d|400|4,5,6,7,8|o
Averia Libre|d|300,300i,400,400i,700,700i|4|o
ZCOOL KuaiLe|s|400|31,4|o
Cabin Sketch|d|400,700|4|o
Tektur|d|400,500,600,700,800,900|0,1,2,4,5,8|o
Elsie|d|400,900|4,5|o
Pathway Extreme|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Graduate|f|400|4|o
Niconne|h|400|4,5|o
Candal|s|400|4|o
Fragment Mono|m|400,400i|1,4,5|o
Klee One|h|400,600|0,3,26,4,5|o
Tiro Devanagari Hindi|f|400,400i|13,4,5|o
Noto Serif Georgian|f|100,200,300,400,500,600,700,800,900|15,4,5|o
Aguafina Script|h|400|4,5|o
Noto Sans Kannada|s|100,200,300,400,500,600,700,800,900|46,4,5|o
Kameron|f|400,500,600,700|4,5|o
Afacad Flux|s|100,200,300,400,500,600,700,800,900,1000|4,5,8|o
Lateef|f|200,300,400,500,600,700,800|27,4,5|o
Hina Mincho|f|400|0,26,4,5,8|o
Karma|f|300,400,500,600,700|13,4,5|o
Allison|h|400|4,5,8|o
Rampart One|d|400|0,26,4,5|o
Sarala|s|400,700|13,4,5|o
Ibarra Real Nova|f|400,400i,500,500i,600,600i,700,700i|4,5|o
Knewave|d|400|4,5|o
Kosugi|s|400|0,26,4,5|a
Cantata One|f|400|4,5|o
IM Fell English SC|f|400|4|o
IBM Plex Sans KR|s|100,200,300,400,500,600,700|28,4,5|o
Chonburi|d|400|4,5,25,8|o
Telex|s|400|4,5|o
Wallpoet|d|400|4|o
Mochiy Pop One|s|400|26,4|o
Yesteryear|h|400|4,5|o
Nobile|s|400,400i,500,500i,700,700i|0,4,5|o
Pattaya|s|400|0,4,5,25,8|o
Markazi Text|f|400,500,600,700|27,4,5,8|o
STIX Two Math|f|400||o
Fjord One|f|400|4|o
Noto Sans Meetei Mayek|s|100,200,300,400,500,600,700,800,900|4,5,47|o
Petit Formal Script|h|400|4,5|o
Mali|h|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4,5,25,8|o
Alef|s|400,700|9,4|o
Pompiere|d|400|4|o
Noto Sans Gurmukhi|s|100,200,300,400,500,600,700,800,900|17,4,5|o
Armata|s|400|4,5|o
Style Script|h|400|4,5,8|o
Share|s|400,400i,700,700i|4,5|o
Nanum Brush Script|h|400|28,4|o
Chivo Mono|m|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Cormorant SC|f|300,400,500,600,700|0,1,4,5,8|o
Hepta Slab|f|1,100,200,300,400,500,600,700,800,900|4,5,8|o
Brygada 1918|f|400,400i,500,500i,600,600i,700,700i|0,1,2,4,5,8|o
Honk|d|400|4,5,6,7,8|o
Encode Sans Expanded|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Antic Didone|f|400|4|o
BIZ UDPMincho|f|400,700|0,3,26,4,5|o
Arizonia|h|400|4,5,8|o
Allerta Stencil|s|400|4|o
Trocchi|f|400|4,5|o
RocknRoll One|s|400|26,4,5|o
Major Mono Display|m|400|4,5,8|o
Alegreya SC|f|400,400i,500,500i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Lexend Zetta|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Sedgwick Ave Display|h|400|4,5,8|o
Cal Sans|s|400|4,5,8|o
Azeret Mono|m|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Noto Sans Oriya|s|100,200,300,400,500,600,700,800,900|4,5,21|o
Playpen Sans|h|100,200,300,400,500,600,700,800|0,1,30,2,4,5,6,8|o
Annie Use Your Telescope|h|400|4,5|o
Noto Sans Georgian|s|100,200,300,400,500,600,700,800,900|1,15,3,4,5,6,7|o
Grand Hotel|h|400|4,5|o
Monsieur La Doulaise|h|400|4,5|o
Silkscreen|d|400,700|4,5|o
Enriqueta|f|400,500,600,700|4,5|o
TikTok Sans|s|300,400,500,600,700,800,900|0,1,2,4,5,8|o
Amiko|s|400,600,700|13,4,5|o
Yusei Magic|s|400|26,4,5|o
Monomaniac One|s|400|26,4,5|o
Goudy Bookletter 1911|f|400|4|o
Koulen|d|400|18,4|o
Baloo Thambi 2|d|400,500,600,700,800|4,5,23,8|o
Irish Grover|d|400|4|a
Average Sans|s|400|4,5|o
Alatsi|s|400|1,4,5,8|o
Bellota Text|d|300,300i,400,400i,700,700i|0,4,5,8|o
Caladea|f|400,400i,700,700i|4,5|o
Zalando Sans|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Allerta|s|400|4|o
Flow Circular|d|400|0,1,4,5,8|o
Noto Serif Devanagari|f|100,200,300,400,500,600,700,800,900|13,4,5|o
Schoolbell|h|400|4|a
Bentham|f|400|4,5|o
Sniglet|d|400,800|4,5|o
Arbutus Slab|f|400|4,5|o
Norican|h|400|4,5|o
Halant|f|300,400,500,600,700|13,4,5|o
Ruslan Display|d|400|0,4,5,6,7|o
Rosario|s|300,300i,400,400i,500,500i,600,600i,700,700i|4,5,8|o
Rancho|h|400|4|a
Overlock|d|400,400i,700,700i,900,900i|4,5|o
Ephesis|h|400|4,5,8|o
Faster One|d|400|4,5|o
Kdam Thmor Pro|s|400|18,4,5|o
Poller One|d|400|4|o
Almendra|f|400,400i,700,700i|4,5|o
Marvel|s|400,400i,700,700i|4|o
Kristi|h|400|4|o
Mouse Memoirs|s|400|4,5|o
Rakkas|d|400|27,4,5|o
Spline Sans Mono|m|300,300i,400,400i,500,500i,600,600i,700,700i|4,5|o
Calligraffitti|h|400|4|a
Bayon|s|400|18,4|o
Turret Road|d|200,300,400,500,700,800|4,5|o
Chiron GoRound TC|s|200,300,400,500,600,700,800,900|29,0,1,4,5,8|o
Coming Soon|h|400|4|a
Sigmar One|d|400|4,5,8|o
Mansalva|h|400|2,4,5,8|o
Dawning of a New Day|h|400|4|o
Montagu Slab|f|100,200,300,400,500,600,700|4,5,8|o
Rambla|s|400,400i,700,700i|4,5|o
Marmelad|s|400|0,1,4,5,8|o
BioRhyme|f|200,300,400,500,600,700,800|4,5|o
Poetsen One|d|400|4,5|o
Lekton|m|400,400i,700|4,5|o
Young Serif|f|400|4,5|o
Scada|s|400,400i,700,700i|0,1,4,5|o
Meddon|h|400|4,5|o
Sansita Swashed|d|300,400,500,600,700,800,900|4,5,8|o
Recursive|s|300,400,500,600,700,800,900,1000|1,4,5,8|o
Special Gothic Condensed One|s|400|4,5|o
Kantumruy Pro|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|18,4,5|o
Love Ya Like A Sister|d|400|4,5|o
Anton SC|s|400|4,5,8|o
Square Peg|h|400|4,5,8|o
DynaPuff|d|400,500,600,700|1,4,5|o
Croissant One|d|400|4,5|o
Average|f|400|4,5|o
Bubblegum Sans|d|400|4,5|o
Kurale|f|400|0,1,13,4,5|o
Cairo Play|s|200,300,400,500,600,700,800,900,1000|27,4,5|o
Hahmlet|f|100,200,300,400,500,600,700,800,900|28,4,5,8|o
Spectral SC|f|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|0,1,4,5,8|o
Manjari|s|100,400,700|4,5,20|o
Inria Sans|s|300,300i,400,400i,700,700i|4,5|o
Zen Antique|f|400|0,2,26,4,5|o
Slackey|d|400|4|a
Corinthia|h|400,700|4,5,8|o
Bungee Inline|d|400|4,5,8|o
Hanuman|f|100,200,300,400,500,600,700,800,900|18,4|o
Akatab|s|400,500,600,700,800,900|4,5,35|o
Fanwood Text|f|400,400i|4,5|o
Kadwa|f|400,700|13,4|o
Maitree|f|200,300,400,500,600,700|4,5,25,8|o
Aref Ruqaa|f|400,700|27,4,5|o
Waiting for the Sunrise|h|400|4,5|o
Qwitcher Grypen|h|400,700|4,5,8|o
Contrail One|d|400|4|o
Frijole|d|400|4|o
Over the Rainbow|h|400|4,5|o
Agbalumo|d|400|1,14,4,5,8|o
Baloo Bhaijaan 2|d|400,500,600,700,800|27,4,5,8|o
David Libre|f|400,500,700|9,4,5,6,7,8|o
Lexend Peta|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Sometype Mono|m|400,400i,500,500i,600,600i,700,700i|4,5|o
Delius Unicase|h|400,700|4|o
Metamorphous|d|400|4,5|o
Special Gothic|s|400,500,600,700|4,5|o
IBM Plex Sans Hebrew|s|100,200,300,400,500,600,700|1,9,4,5|o
Rubik Doodle Shadow|d|400|0,1,9,4,5,6,7|o
Oxygen Mono|m|400|4,5|o
Noto Emoji|s|300,400,500,600,700|30|o
Mountains of Christmas|d|400,700|4|a
ZCOOL QingKe HuangYou|s|400|31,4|o
MedievalSharp|d|400|4,5|o
Gowun Dodum|s|400|28,4,5,8|o
Noto Sans Ol Chiki|s|400,500,600,700|4,5,48|o
Mukta Mahee|s|200,300,400,500,600,700,800|17,4,5|o
Zen Kurenaido|s|400|0,2,26,4,5|o
Copse|f|400|4|o
Magra|s|400,700|4,5|o
Battambang|d|100,300,400,700,900|18,4|o
Red Rose|d|300,400,500,600,700|4,5,8|o
Yuji Syuku|f|400|0,26,4,5|o
Syne Mono|m|400|4,5|o
Vesper Libre|f|400,500,700,900|13,4,5|o
Kalnia|f|100,200,300,400,500,600,700|4,5,6|o
Baloo Bhai 2|d|400,500,600,700,800|16,4,5,8|o
Cormorant Unicase|f|300,400,500,600,700|0,1,4,5,8|o
Cambay|s|400,400i,700,700i|13,4,5|o
Boldonse|d|400|4,5|o
Anek Devanagari|s|100,200,300,400,500,600,700,800|13,4,5|o
Alike|f|400|4,5,6,7|o
Rochester|h|400|4|a
Rouge Script|h|400|4|o
Beth Ellen|h|400|4|o
Kaisei Opti|f|400,500,700|0,26,4,5|o
Encode Sans Semi Condensed|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Anybody|d|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Libre Barcode 39 Text|d|400|4|o
Fasthand|d|400|18,4|o
Bagel Fat One|d|400|28,4,5|o
Kodchasan|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4,5,25,8|o
Meow Script|h|400|4,5,8|o
Sunflower|s|300,500,700|28,4|o
Birthstone|h|400|4,5,8|o
Platypi|f|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5,8|o
Hurricane|h|400|4,5,8|o
Zen Dots|d|400|4,5|o
Codystar|d|300,400|4,5|o
Scheherazade New|f|400,500,600,700|27,4,5|o
IM Fell DW Pica|f|400,400i|4|o
Jockey One|s|400|4,5|o
Baloo Chettan 2|d|400,500,600,700,800|4,5,20,8|o
Hedvig Letters Serif|f|400|4,5,6,7|o
Happy Monkey|d|400|4,5|o
Cutive|f|400|4,5|o
KoHo|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4,5,25,8|o
Tilt Neon|d|400|4,5,8|o
Amarante|d|400|4,5|o
Bungee Spice|d|400|4,5,8|o
Bungee Shade|d|400|4,5,8|o
Zalando Sans Expanded|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Baloo Tamma 2|d|400,500,600,700,800|46,4,5,8|o
Shantell Sans|d|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|0,1,4,5,8|o
Quintessential|h|400|4,5|o
Henny Penny|d|400|4|o
Zain|s|200,300,300i,400,400i,700,800,900|27,4|o
Asar|f|400|13,4,5|o
Zen Antique Soft|f|400|0,2,26,4,5|o
Gaegu|h|300,400,700|28,4|o
SUSE|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Coustard|f|400,900|4,5|o
Zalando Sans SemiExpanded|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Rasa|f|300,300i,400,400i,500,500i,600,600i,700,700i|16,4,5,8|o
Carrois Gothic|s|400|4|o
Capriola|s|400|4,5|o
Prosto One|d|400|0,4,5|o
Poly|f|400,400i|4,5|o
Vibur|h|400|4|o
Walter Turncoat|h|400|4|a
Tenali Ramakrishna|s|400|4,24|o
Gotu|s|400|13,4,5,8|o
Ysabeau Office|s|1,1i,100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,2,4,5,6,7,8|o
Asul|f|400,700|4|o
Averia Sans Libre|d|300,300i,400,400i,700,700i|4|o
Encode Sans Semi Expanded|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Teachers|s|400,400i,500,500i,600,600i,700,700i,800,800i|3,4,5|o
Stick No Bills|s|200,300,400,500,600,700,800|4,5,22|o
Megrim|d|400|4,5|o
Noto Sans Symbols 2|s|400|40,4,5,6,49,7|o
Qwigley|h|400|4,5,8|o
Puritan|s|400,400i,700,700i|4|o
Sue Ellen Francisco|h|400|4|o
Rubik Spray Paint|d|400|0,1,9,4,5|o
Arima|d|100,200,300,400,500,600,700|2,3,4,5,20,23,8|o
Inknut Antiqua|f|300,400,500,600,700,800,900|13,4,5|o
Vast Shadow|f|400|4|o
Noto Serif Thai|f|100,200,300,400,500,600,700,800,900|4,5,25|o
Piazzolla|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5,8|o
Give You Glory|h|400|4,5|o
Jaldi|s|400,700|13,4,5|o
Voltaire|s|400|4,5,8|o
Lily Script One|d|400|4,5|o
Coiny|d|400|4,5,23,8|o
Fauna One|f|400|4,5|o
Fontdiner Swanky|d|400|4|a
Noto Sans Armenian|s|100,200,300,400,500,600,700,800,900|10,4,5|o
Crafty Girls|h|400|4|a
Nosifer|d|400|4,5|o
Oleo Script Swash Caps|d|400,700|4,5|o
Shippori Antique|s|400|26,4,5|o
Supermercado One|d|400|4,5|o
Brawler|f|400,700|4|o
Noto Sans Thai Looped|s|100,200,300,400,500,600,700,800,900|4,5,25|o
Quando|f|400|4,5|o
Martian Mono|m|100,200,300,400,500,600,700,800|0,1,4,5|o
Miriam Libre|s|400,500,600,700|9,4,5|o
Finger Paint|d|400|4|o
Numans|s|400|4|o
Nova Mono|m|400|2,4,5|o
Cherry Bomb One|d|400|26,4,5,8|o
Cherry Cream Soda|d|400|4|a
Comic Relief|d|400,700|0,2,4,5|o
Antic|s|400|4|o
Della Respira|f|400|4|o
Noto Sans Warang Citi|s|400|4,5,50|o
Inclusive Sans|s|300,300i,400,400i,500,500i,600,600i,700,700i|4,5,8|o
Rubik Dirt|d|400|0,1,9,4,5|o
Denk One|s|400|1,4,5,8|o
Allan|d|400,700|4,5|o
Xanh Mono|m|400,400i|4,5,8|o
McLaren|d|400|4,5|o
MonteCarlo|h|400|4,5,8|o
Euphoria Script|h|400|4,5|o
Port Lligat Sans|s|400|4|o
Buenard|f|400,500,600,700|4,5|o
Kelly Slab|d|400|0,4,5|o
B612 Mono|m|400,400i,700,700i|4|o
Abyssinica SIL|f|400|14,4,5|o
Song Myung|f|400|28,4|o
Vollkorn SC|f|400,600,700,900|0,1,4,5,8|o
Kaisei Tokumin|f|400,500,700,800|0,26,4,5|o
Jomhuria|d|400|27,4,5|o
Moon Dance|h|400|4,5,8|o
Tienne|f|400,700,900|4|o
Bakbak One|d|400|13,4,5|o
Slabo 13px|f|400|4,5|o
Mohave|s|300,300i,400,400i,500,500i,600,600i,700,700i|4,5|o
Freeman|d|400|4,5,8|o
Aladin|d|400|4,5|o
Expletus Sans|d|400,400i,500,500i,600,600i,700,700i|4,5|o
Nerko One|h|400|4,5|o
Nata Sans|s|100,200,300,400,500,600,700,800,900|0,1,4,5,8|o
Anta|s|400|4,5,6,7|o
Gurajada|s|400|4,24|o
Balthazar|f|400|4|o
Oregano|d|400,400i|4,5|o
Rubik Glitch|d|400|0,1,9,4,5|o
Kufam|s|400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|27,4,5,8|o
Lacquer|d|400|4|o
Macondo|d|400|4|o
Montez|h|400|4,5|a
Doppio One|s|400|4,5|o
Padauk|s|400,700|4,5,45|o
Noto Serif Tamil|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,23|o
Mr De Haviland|h|400|4,5|o
Road Rage|d|400|4,5,8|o
Protest Strike|d|400|4,5,6,7,8|o
Mukta Vaani|s|200,300,400,500,600,700,800|16,4,5|o
B612|s|400,400i,700,700i|4|o
League Script|h|400|4|o
Vujahday Script|h|400|4,5,8|o
Freehand|d|400|18,4|o
IM Fell Double Pica|f|400,400i|4|o
Gamja Flower|h|400|28,4|o
Sarina|d|400|4,5|o
Fresca|s|400|4,5|o
Voces|s|400|4,5|o
Unkempt|d|400,700|4|a
Kranky|d|400|4|a
Griffy|d|400|4,5|o
Carattere|h|400|4,5,8|o
Molengo|s|400|4,5|o
Alike Angular|f|400|4,5,6,7|o
Arya|s|400,700|13,4,5|o
Noto Sans Ethiopic|s|100,200,300,400,500,600,700,800,900|14,4,5|o
Suranna|f|400|4,24|o
New Rocker|d|400|4,5|o
Thasadith|s|400,400i,700,700i|4,5,25,8|o
Bigshot One|d|400|4|o
The Girl Next Door|h|400|4,5|o
Sunshiney|h|400|4|a
Aoboshi One|f|400|26,4,5|o
Julee|h|400|4,5|o
Jolly Lodger|d|400|4,5|o
Zhi Mang Xing|h|400|31,4|o
Loved by the King|h|400|4,5|o
Ceviche One|d|400|4,5|o
Whisper|h|400|4,5,8|o
Sansation|s|300,300i,400,400i,700,700i|0,2,4,5|o
Redressed|h|400|4,5|a
Holtwood One SC|f|400|4,5|o
Fuggles|h|400|4,5,8|o
Fleur De Leah|h|400|4,5,8|o
Bilbo Swash Caps|h|400|4,5|o
Freckle Face|d|400|4,5|o
Modak|d|400|13,4,5|o
Solway|f|300,400,500,700,800|4|o
Sarpanch|s|400,500,600,700,800,900|13,4,5|o
Meie Script|h|400|4,5|o
Farro|s|300,400,500,700|4,5|o
Iceberg|d|400|4|o
Cambo|f|400|4,5|o
Orelega One|d|400|0,1,4,5|o
Fuzzy Bubbles|h|400,700|4,5,8|o
Noto Sans Lao|s|100,200,300,400,500,600,700,800,900|19,4,5|o
Patrick Hand SC|h|400|4,5,8|o
Charmonman|h|400,700|4,5,25,8|o
Grenze|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Asset|d|400|1,4,5,6,7|o
Bonheur Royale|h|400|4,5,8|o
Mako|s|400|4,5|o
Sulphur Point|s|300,400,700|4,5|o
Trade Winds|d|400|4|o
Wendy One|s|400|4,5|o
Inder|s|400|4,5|o
Nokora|s|100,200,300,400,500,600,700,800,900|18,4|o
Lancelot|d|400|4,5|o
Goblin One|d|400|4|o
Modern Antiqua|d|400|4,5|o
Poltawski Nowy|f|400,400i,500,500i,600,600i,700,700i|4,5,8|o
Libertinus Serif|f|400,400i,600,600i,700,700i|0,1,2,3,9,4,5,8|o
Mallanna|s|400|4,24|o
Scope One|f|400|4,5|o
Federo|s|400|4|o
Madimi One|s|400|4,5,6,7|o
Imprima|s|400|4,5|o
Wire One|s|400|4|o
Metal Mania|d|400|4,5|o
Jersey 10|d|400|4,5|o
Bellota|d|300,300i,400,400i,700,700i|0,4,5,8|o
Atma|d|300,400,500,600,700|11,4,5|o
Galada|d|400|11,4|o
Nova Flat|d|400|4,5|o
Anek Tamil|s|100,200,300,400,500,600,700,800|4,5,23|o
Libre Barcode 39 Extended Text|d|400|4|o
Anek Malayalam|s|100,200,300,400,500,600,700,800|4,5,20|o
UnifrakturCook|d|700|4|o
Mina|s|400,700|11,4,5|o
BhuTuka Expanded One|f|400|17,4,5|o
Rosarivo|f|400,400i|4,5|o
Doto|s|100,200,300,400,500,600,700,800,900|4,5|o
Artifika|f|400|4|o
Prociono|f|400|4|o
Viaoda Libre|d|400|0,1,4,5,8|o
Moul|d|400|18,4|o
Mooli|s|400|4,5|o
Chathura|s|100,300,400,700,800|4,24|o
Baloo Paaji 2|d|400,500,600,700,800|17,4,5,8|o
Sekuya|d|400|4,5|o
Just Me Again Down Here|h|400|4,5|o
Long Cang|h|400|31,4|o
Nova Round|d|400|4,5|o
Amethysta|f|400|4|o
Sancreek|d|400|4,5|o
Odibee Sans|d|400|4|o
Bruno Ace|d|400|4,5|o
Darumadrop One|d|400|26,4,5|o
Shanti|s|400|4,5|o
Crushed|d|400|4,5|a
WindSong|h|400,500|4,5,8|o
Noto Serif Khojki|f|400,500,600,700|51,4,5|o
Esteban|f|400|4,5|o
Bona Nova|f|400,400i,700|0,1,2,9,4,5,8|o
Ysabeau SC|s|1,100,200,300,400,500,600,700,800,900,1000|0,1,2,4,5,6,7,8|o
Libertinus Math|d|400||o
Maiden Orange|f|400|4,5|a
Dynalight|d|400|4,5|o
Mirza|f|400,500,600,700|27,4,5|o
Mochiy Pop P One|s|400|26,4|o
Monofett|m|400|4,5|o
Poor Story|d|400|28,4|o
Sour Gummy|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
IM Fell French Canon|f|400,400i|4|o
Asta Sans|s|300,400,500,600,700,800|28,4|o
Reggae One|d|400|0,26,4,5|o
Convergence|s|400|4,5|o
Anaheim|s|400,500,600,700,800|4,5,8|o
Sail|d|400|4,5|o
Life Savers|d|400,700,800|4,5|o
Swanky and Moo Moo|h|400|4,5|o
Carme|s|400|4|o
Sedgwick Ave|h|400|4,5,8|o
Gayathri|s|100,400,700|4,20|o
Ribeye|d|400|4,5|o
Montaga|f|400|4|o
Delicious Handrawn|h|400|4,5|o
Noto Serif HK|f|200,300,400,500,600,700,800,900|44,0,4,5,8|o
Truculenta|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Science Gothic|s|100,200,300,400,500,600,700,800,900|0,1,4,5,8|o
Alan Sans|s|300,400,500,600,700,800,900|4,5|o
Original Surfer|d|400|4,5|o
Sevillana|d|400|4,5|o
Manuale|f|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5,8|o
Delius Swash Caps|h|400|4|o
Medula One|d|400|4|o
Gluten|d|100,200,300,400,500,600,700,800,900|4,5,8|o
Yomogi|h|400|0,26,4,5,8|o
Train One|d|400|0,26,4,5|o
Kablammo|d|400|0,1,30,4,5,8|o
NTR|s|400|4,24|o
Gentium Book Plus|f|400,400i,700,700i|0,1,2,3,4,5,8|o
Comme|s|100,200,300,400,500,600,700,800,900|4,5|o
Atomic Age|d|400|4,5|o
Shojumaru|d|400|4,5|o
Qahiri|s|400|27,4|o
M PLUS 1 Code|m|100,200,300,400,500,600,700|26,4,5,8|o
Karantina|d|300,400,700|9,4,5|o
Borel|h|400|4,5,6,7,8|o
Smythe|d|400|4|o
Salsa|d|400|4|o
Galindo|d|400|4,5|o
Baloo Tammudu 2|d|400,500,600,700,800|4,5,24,8|o
Belgrano|f|400|4|o
Orienta|s|400|4,5|o
Ledger|f|400|0,4,5|o
Cherry Swash|d|400,700|4,5|o
Peralta|f|400|4,5|o
Phudu|d|300,400,500,600,700,800,900|1,4,5,8|o
The Nautigal|h|400,700|4,5,8|o
Birthstone Bounce|h|400,500|4,5,8|o
Baumans|d|400|4|o
Hi Melody|h|400|28,4|o
IM Fell Great Primer|f|400,400i|4|o
Waterfall|h|400|4,5,8|o
Iceland|d|400|4|o
Genos|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|32,4,5,8|o
Gupter|f|400,500,700|4|o
Dokdo|d|400|28,4|o
Gasoek One|s|400|28,4,5|o
IM Fell DW Pica SC|f|400|4|o
Imperial Script|h|400|4,5,8|o
Stalemate|h|400|4,5|o
Kavoon|d|400|4,5|o
Mozilla Headline|s|200,300,400,500,600,700|4,5|o
Protest Riot|d|400|4,5,6,7,8|o
Alkatra|d|400,500,600,700|11,13,4,5,21|o
Nova Oval|d|400|4,5|o
Reddit Mono|m|200,300,400,500,600,700,800,900|4,5,8|o
Stick|s|400|0,26,4,5|o
Jacques Francois|f|400|4|o
Imbue|f|100,200,300,400,500,600,700,800,900|4,5,8|o
Emilys Candy|d|400|4,5|o
Clicker Script|h|400|4,5|o
Overlock SC|d|400|4,5|o
Edu TAS Beginner|h|400,500,600,700|4|o
IBM Plex Sans Thai Looped|s|100,200,300,400,500,600,700|1,4,5,25|o
Notable|s|400|4|o
Solitreo|h|400|9,4,5|o
Liu Jian Mao Cao|h|400|31,4|o
Rubik Bubbles|d|400|0,1,9,4,5|o
Sumana|f|400,700|13,4,5|o
Lemon|d|400|4,5|o
Ysabeau|s|1,1i,100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,2,4,5,6,7,8|o
Sigmar|d|400|4,5,8|o
Victor Mono|m|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|0,1,2,4,5,8|o
Caesar Dressing|d|400|4|o
Chau Philomene One|s|400,400i|4,5|o
Gugi|d|400|28,4|o
Luxurious Script|h|400|4,5,8|o
Duru Sans|s|400|4,5|o
Miltonian|d|400|4|o
Bitcount Single|d|100,200,300,400,500,600,700,800,900|4,5|o
IM Fell Double Pica SC|f|400|4|o
Gentium Plus|f|400,400i,700,700i|0,1,2,3,4,5,8|o
Kenia|d|400|4|o
Nova Slim|d|400|4,5|o
Suwannaphum|f|100,300,400,700,900|18,4|o
Harmattan|s|400,500,600,700|27,4,5|o
Agdasima|s|400,700|4,5|o
Chicle|d|400|4,5|o
Sree Krushnadevaraya|f|400|4,24|o
Badeen Display|d|400|27,4,5|o
Spicy Rice|d|400|4,5|o
Bokor|d|400|18,4|o
Akronim|d|400|4,5|o
Raleway Dots|d|400|4,5|o
Moderustic|s|300,400,500,600,700,800|0,1,2,4,5|o
Tauri|s|400|4,5|o
Rationale|s|400|4|o
Homenaje|s|400|4|o
Eagle Lake|h|400|4,5|o
Timmana|s|400|4,24|o
Elms Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Baloo Bhaina 2|d|400,500,600,700,800|4,5,21,8|o
Headland One|f|400|4,5|o
Licorice|h|400|4,5,8|o
Edu SA Beginner|h|400,500,600,700|4|o
Kode Mono|m|400,500,600,700|4,5|o
Gafata|s|400|4,5|o
Noto Serif Telugu|f|100,200,300,400,500,600,700,800,900|4,5,24|o
Kotta One|f|400|4,5|o
Ranchers|d|400|4,5|o
Ruthie|h|400|4,5,8|o
Noto Sans Bhaiksuki|s|400|52,4,5|o
IM Fell French Canon SC|f|400|4|o
Noto Serif Kannada|f|100,200,300,400,500,600,700,800,900|46,4,5|o
Fenix|f|400|4,5|o
BIZ UDMincho|f|400,700|0,3,26,4,5|o
Inika|f|400,700|4,5|o
Mynerve|h|400|2,4,5,8|o
Baskervville SC|f|400,500,600,700|4,5|o
IM Fell Great Primer SC|f|400|4|o
Alkalami|f|400|27,4,5|o
TASA Orbiter|s|400,500,600,700,800|4,5|o
Short Stack|h|400|4|o
Astloch|d|400,700|4|o
Anek Gujarati|s|100,200,300,400,500,600,700,800|16,4,5|o
Trispace|s|100,200,300,400,500,600,700,800|4,5,8|o
Gemunu Libre|s|200,300,400,500,600,700,800|4,5,22|o
Akaya Kanadaka|d|400|46,4,5|o
Fascinate|d|400|4,5|o
Miniver|d|400|4|o
Hubot Sans|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Londrina Outline|d|400|4|o
Kulim Park|s|200,200i,300,300i,400,400i,600,600i,700,700i|4,5|o
Jomolhari|f|400|4,53|o
Habibi|f|400|4,5|o
Comforter|h|400|0,4,5,8|o
Anek Kannada|s|100,200,300,400,500,600,700,800|46,4,5|o
Varta|s|300,400,500,600,700|4,5,8|o
Khmer|s|400|18|o
Faculty Glyphic|s|400|4,5|o
Miltonian Tattoo|d|400|4|o
East Sea Dokdo|h|400|28,4|o
Nova Cut|d|400|4,5|o
Stint Ultra Condensed|f|400|4,5|o
Beau Rivage|h|400|4,5,8|o
Edu NSW ACT Cursive|h|400,500,600,700|4,5|?
Macondo Swash Caps|d|400|4|o
Stack Sans Text|s|200,300,400,500,600,700|4,5|o
Vampiro One|d|400|4,5|o
Hedvig Letters Sans|s|400|4,5,6,7|o
Noto Sans Caucasian Albanian|s|400|54,4,5|o
Dangrek|d|400|18,4|o
Libre Barcode 128 Text|d|400|4|o
Mystery Quest|d|400|4,5|o
IBM Plex Sans Devanagari|s|100,200,300,400,500,600,700|1,13,4,5|o
Ballet|h|400|4,5,8|o
Noto Serif Hebrew|f|100,200,300,400,500,600,700,800,900|9,4,5|o
Nova Script|d|400|4,5|o
Noto Serif Malayalam|f|100,200,300,400,500,600,700,800,900|4,5,20|o
Bitcount Prop Single|d|100,200,300,400,500,600,700,800,900|4,5|o
Redacted|d|400|4,5|o
Geostar Fill|d|400|4|o
Gorditas|d|400,700|4|o
Katibeh|d|400|27,4,5|o
Dorsa|s|400|4|o
Pavanam|s|400|4,5,23|o
Stoke|f|300,400|4,5|o
Jaro|s|400|4,5,8|o
Winky Sans|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Libertinus Sans|s|400,400i,700|0,1,2,3,4,5,8|o
Mozilla Text|s|200,300,400,500,600,700|4,5|o
Stylish|s|400|28,4|o
Playwrite NO|h|100,200,300,400||o
Margarine|d|400|4,5|o
Smooch|h|400|4,5,8|o
Mea Culpa|h|400|4,5,8|o
Noto Sans Canadian Aboriginal|s|100,200,300,400,500,600,700,800,900|12,4,5,6,7|o
Liter|s|400|0,4,5|o
Tiny5|s|400|0,1,2,4,5|o
Risque|d|400|4,5|o
Bodoni Moda SC|f|400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,6,7|o
Single Day|d|400|28,4|o
Lugrasimo|h|400|4,5|o
Nabla|d|400|1,4,5,6,8|o
Stack Sans Headline|s|200,300,400,500,600,700|4,5|o
Zen Tokyo Zoo|d|400|4,5|o
LXGW WenKai TC|h|300,400,700|29,0,1,2,3,4,5,55,8|o
Chocolate Classical Sans|s|400|29,0,4,5,8|o
Braah One|s|400|17,4,5,8|o
Lavishly Yours|h|400|4,5,8|o
Lovers Quarrel|h|400|4,5,8|o
Underdog|d|400|0,4,5|o
Barrio|d|400|4,5|o
Island Moments|h|400|4,5,8|o
Passions Conflict|h|400|4,5,8|o
Devonshire|h|400|4,5|o
Junge|f|400|4|o
Jacquard 12|d|400|4,5,6,7|o
Mate SC|f|400|4,5|o
Sura|f|400,700|13,4,5|o
Koh Santepheap|f|100,300,400,700,900|18,4|o
Shippori Antique B1|s|400|26,4,5|o
Playpen Sans Arabic|h|100,200,300,400,500,600,700,800|27,30,4,5,6|o
Englebert|s|400|4,5|o
Noto Sans Thaana|s|100,200,300,400,500,600,700,800,900|4,5,56|o
Zilla Slab Highlight|f|400,700|4,5|o
Akaya Telivigala|d|400|4,5,24|o
Rum Raisin|s|400|4,5|o
Playwrite US Trad|h|100,200,300,400||o
Kavivanar|h|400|4,5,23|o
Amiri Quran|f|400|27,4|o
Cagliostro|s|400|4|o
Noto Sans Math|s|400||o
Strait|s|400|4,5|o
Noto Sans Javanese|s|400,500,600,700|57,4,5|o
Glass Antiqua|d|400|4,5|o
Playwrite VN|h|100,200,300,400||o
Dai Banna SIL|f|300,300i,400,400i,500,500i,600,600i,700,700i|4,5,58|o
Noto Sans Khudawadi|s|400|59,4,5|o
Engagement|h|400|4,5|o
Grape Nuts|h|400|4,5,8|o
Yuji Boku|f|400|0,26,4,5|o
Manufacturing Consent|d|400|4,5|o
Playwrite IN|h|100,200,300,400||o
Beiruti|s|200,300,400,500,600,700,800,900|27,4,5,8|o
Odor Mean Chey|f|400|18,4|o
Paprika|d|400|4,5|o
Spirax|d|400|4|o
Rubik Scribble|d|400|0,1,9,4,5,6,7|o
Romanesco|h|400|4,5|o
Port Lligat Slab|f|400|4|o
Yeon Sung|d|400|28,4|o
Montserrat Underline|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Cactus Classical Serif|f|400|29,0,4,5,8|o
Caramel|h|400|4,5,8|o
Noto Music|s|400|4,5,60|o
Smokum|d|400|4,5|a
Story Script|s|400|4,5,8|o
Joan|f|400|4,5|o
Festive|h|400|4,5,8|o
Marhey|d|300,400,500,600,700|27,4,5|o
Cute Font|d|400|28,4|o
Cantora One|s|400|4,5|o
Tac One|s|400|4,5,6,7,8|o
Text Me One|s|400|4,5|o
Nuosu SIL|s|400|4,5,61|o
Unlock|d|400|4,5|o
Geom|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|2,4,5|o
Lexend Mega|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Huninn|s|400|29,0,4,5,8|o
Seymour One|s|400|0,4,5|o
Playwrite DE Grund|h|100,200,300,400||o
Noto Sans Samaritan|s|400|4,5,62|o
Kapakana|h|300,400|26,4,5|o
Noto Sans Tagalog|s|400|4,5,63|o
Noto Sans Buhid|s|400|64,4,5|o
Srisakdi|d|400,700|4,5,25,8|o
Piedra|d|400|4,5|o
Noto Sans Linear A|s|400|4,5,65|o
Sono|s|200,300,400,500,600,700,800|4,5,8|o
Diphylleia|f|400|28,4,5|o
Arbutus|f|400|4,5|o
Noto Serif Khmer|f|100,200,300,400,500,600,700,800,900|18,4,5|o
Linden Hill|f|400,400i|4,5|o
Dekko|h|400|13,4,5|o
Content|d|400,700|18|o
Girassol|d|400|4,5|o
Orbit|s|400|28,4,5|o
Tourney|d|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Castoro Titling|d|400|4,5|o
New Tegomin|f|400|26,4,5|o
Bilbo|h|400|4,5,8|o
Water Brush|h|400|4,5,8|o
Kaisei HarunoUmi|f|400,500,700|0,26,4,5|o
Playwrite IS|h|100,200,300,400||o
Siemreap|s|400|18|o
Shalimar|h|400|4,5,8|o
Texturina|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Handjet|d|100,200,300,400,500,600,700,800,900|27,10,0,1,2,9,4,5,8|o
Gulzar|f|400|27,4,5|o
Playwrite CU|h|100,200,300,400||o
Sonsie One|d|400|4,5|o
SN Pro|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Carrois Gothic SC|s|400|4|o
Noto Serif Tibetan|f|100,200,300,400,500,600,700,800,900|4,5,53|o
Climate Crisis|d|400|0,1,4,5|o
Erica One|d|400|4,5|o
Flamenco|d|300,400|4|o
Playwrite DE SAS Guides|h|400||o
Momo Trust Sans|s|200,300,400,500,600,700,800|4,5,8|o
BBH Bartle|s|400|4|o
Tillana|d|400,500,600,700,800|13,4,5|o
Tiro Devanagari Sanskrit|f|400,400i|13,4,5|o
Tiro Gurmukhi|f|400,400i|17,4,5|o
Encode Sans SC|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Simonetta|d|400,400i,900,900i|4,5|o
Almendra SC|f|400|4|o
Sahitya|f|400,700|13,4|o
Reem Kufi Fun|s|400,500,600,700|27,4,5,8|o
Dhurjati|s|400|4,24|o
Playwrite DE LA Guides|h|400||o
Felipa|h|400|4,5|o
Anek Odia|s|100,200,300,400,500,600,700,800|4,5,21|o
Edu AU VIC WA NT Guides|h|400,500,600,700|4,5|o
Yaldevi|s|200,300,400,500,600,700|4,5,22|o
WDXL Lubrifont JP N|s|400|0,26,4,5,36|o
Emblema One|d|400|4,5|o
Rubik Moonrocks|d|400|0,1,9,4,5|o
Gwendolyn|h|400,700|4,5,8|o
Alumni Sans Pinstripe|s|400,400i|0,1,4,5,8|o
Stint Ultra Expanded|f|400|4,5|o
Condiment|h|400|4,5|o
Ysabeau Infant|s|1,1i,100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|0,1,2,4,5,6,7,8|o
Ramaraja|f|400|4,24|o
Ravi Prakash|d|400|4,24|o
Autour One|d|400|4,5|o
Noto Serif Ahom|f|400|66,4,5|o
Jim Nightshade|h|400|4,5|o
National Park|s|200,300,400,500,600,700,800|4,5,8|o
Mogra|d|400|16,4,5|o
Ewert|d|400|4,5|o
Rubik Wet Paint|d|400|0,1,9,4,5|o
Ancizar Serif|f|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|2,4,5|o
Keania One|d|400|4,5|o
My Soul|h|400|4,5,8|o
Offside|d|400|4,5|o
Monomakh|d|400|0,1,4,5|o
Jersey 20|d|400|4,5|o
Playwrite GB S|h|100,100i,200,200i,300,300i,400,400i||o
Big Shoulders Stencil|d|100,200,300,400,500,600,700,800,900|4,5,8|o
Londrina Shadow|d|400|4|o
Kite One|s|400|4,5|o
Butcherman|d|400|4,5|o
Milonga|d|400|4,5|o
Slackside One|h|400|26,4,5|o
Tilt Prism|d|400|4,5,8|o
Noto Serif Armenian|f|100,200,300,400,500,600,700,800,900|10,4,5|o
Bruno Ace SC|d|400|4,5|o
Joti One|d|400|4,5|o
Noto Sans Osmanya|s|400|4,5,67|o
Cascadia Code|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|27,40,0,1,2,9,4,5,36,8|o
Vend Sans|s|300,300i,400,400i,500,500i,600,600i,700,700i|4,5|o
Chela One|d|400|4,5|o
Federant|d|400|4|o
Farsan|d|400|16,4,5,8|o
Playwrite AU NSW|h|100,200,300,400||o
Comforter Brush|h|400|0,4,5,8|o
Plaster|d|400|4,5|o
Jacquarda Bastarda 9|d|400|4,5,6,7|o
Buda|d|300|4|o
Purple Purse|d|400|4,5|o
Bpmf Huninn|s|400|29,4,5|o
Tiro Devanagari Marathi|f|400,400i|13,4,5|o
Averia Gruesa Libre|d|400|4,5|o
Alyamama|f|300,400,500,600,700,800,900|27,2,4,5|o
Lexend Tera|s|100,200,300,400,500,600,700,800,900|4,5,8|o
Bungee Outline|d|400|4,5,8|o
Donegal One|f|400|4,5|o
Fruktur|d|400,400i|1,4,5,8|o
Benne|f|400|46,4,5|o
Momo Trust Display|s|400|4,5,8|o
Wellfleet|f|400|4,5|o
Marko One|f|400|4|o
SUSE Mono|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5,8|o
Libre Barcode EAN13 Text|d|400|4|o
Chiron Hei HK|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|29,0,1,2,3,4,5,36,8|o
Akt|s|100,200,300,400,500,600,700,800,900|0,1,2,3,4,5,8|o
Trykker|f|400|4,5|o
Alumni Sans SC|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
GFS Neohellenic|s|400,400i,700,700i|2,3,4,8|o
Elsie Swash Caps|d|400,900|4,5|o
Preahvihear|s|400|18,4|o
Praise|h|400|4,5,8|o
Galdeano|s|400|4|o
Atkinson Hyperlegible Mono|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i|4,5|o
Noto Sans Sora Sompeng|s|400,500,600,700|4,5,68|o
Noto Sans Gothic|s|400|37,4,5|o
Bungee Hairline|d|400|4,5,8|o
Sixtyfour|m|400|4,5,6,7|o
Chilanka|h|400|4,5,20|o
Jacques Francois Shadow|d|400|4|o
Luxurious Roman|d|400|4,5,8|o
Oldenburg|d|400|4,5|o
Gidugu|s|400|4,5,24|o
Blaka|d|400|27,4,5|o
Sofadi One|d|400|4|o
Fascinate Inline|d|400|4,5|o
Almendra Display|d|400|4,5|o
Kings|h|400|4,5,8|o
Diplomata|d|400|4,5|o
Metal|d|400|18,4|o
Anek Gurmukhi|s|100,200,300,400,500,600,700,800|17,4,5|o
Bubbler One|s|400|4,5|o
Ruluko|s|400|4,5|o
Edu AU VIC WA NT Hand|h|400,500,600,700|4,5|o
Kirang Haerang|d|400|28,4|o
Babylonica|h|400|4,5,8|o
Uchen|f|400|4,53|o
Sirin Stencil|d|400|4|o
Noto Sans Tai Viet|s|400|4,5,69|o
Noto Serif Gujarati|f|100,200,300,400,500,600,700,800,900|16,4,5,6,7|o
Noto Serif Lao|f|100,200,300,400,500,600,700,800,900|19,4,5|o
Alumni Sans Inline One|d|400,400i|4,5,8|o
Aref Ruqaa Ink|f|400,700|27,4,5|o
Grechen Fuemen|h|400|4,5,8|o
Hubballi|s|400|46,4,5|o
Alumni Sans Collegiate One|s|400,400i|0,4,5,8|o
Libre Barcode 39 Extended|d|400|4|o
Bigelow Rules|d|400|4,5|o
Inspiration|h|400|4,5,8|o
Lakki Reddy|h|400|4,24|o
Grey Qo|h|400|4,5,8|o
Jersey 15|d|400|4,5|o
New Amsterdam|s|400|4,5|o
Ranga|d|400,700|13,4,5|o
Revalia|d|400|4,5|o
Wittgenstein|f|400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Tulpen One|d|400|4|o
Gideon Roman|d|400|4,5,8|o
Bitcount Grid Double|d|100,200,300,400,500,600,700,800,900|4,5|o
Dr Sugiyama|h|400|4,5|o
Oi|d|400|27,0,1,2,4,5,23,8|o
Noto Sans Adlam|s|400,500,600,700|42,4,5|o
Rhodium Libre|f|400|13,4,5|o
Are You Serious|h|400|4,5,8|o
Playwrite VN Guides|h|400||o
Lunasima|s|400,700|0,1,2,3,9,4,5,8|o
Playwrite AU SA|h|100,200,300,400||o
Noto Serif Sinhala|f|100,200,300,400,500,600,700,800,900|4,5,22|o
Edu VIC WA NT Beginner|h|400,500,600,700|4|o
Jacquard 24|d|400|4,5|o
Noto Sans Cherokee|s|100,200,300,400,500,600,700,800,900|32,4,5|o
Sedan SC|f|400|4,5|o
Neonderthaw|h|400|4,5,8|o
Noto Sans Glagolitic|s|400|1,70,4,5,6,7|o
Tiro Kannada|f|400,400i|46,4,5|o
Stalinist One|d|400|0,4,5|o
Miss Fajardose|h|400|4,5|o
Noto Sans Lao Looped|s|100,200,300,400,500,600,700,800,900|19,4,5|o
Ribeye Marrow|d|400|4,5|o
Updock|h|400|4,5,8|o
Bacasime Antique|f|400|4,5|o
Noto Sans Elbasan|s|400|71,4,5|o
Momo Signature|s|400|4,5,8|o
Arsenal SC|s|400,400i,700,700i|0,1,4,5,8|o
Noto Sans Anatolian Hieroglyphs|s|400|72,4,5|o
Meera Inimai|s|400|4,23|o
Kumar One|d|400|16,4,5|o
Reem Kufi Ink|s|400|27,4,5,8|o
Love Light|h|400|4,5,8|o
Diplomata SC|d|400|4,5|o
Foldit|d|100,200,300,400,500,600,700,800,900|4,5,8|o
Geist Pixel|d|400|4,5|o
Micro 5|d|400|4,5,6,7|o
Noto Rashi Hebrew|f|100,200,300,400,500,600,700,800,900|3,9,4,5|o
WDXL Lubrifont SC|s|400|31,0,4,5,36|o
LXGW WenKai Mono TC|m|300,400,700|29,0,1,2,3,4,5,55,8|o
Intel One Mono|m|300,300i,400,400i,500,500i,600,600i,700,700i|4,5,36,8|o
Epunda Sans|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Passero One|d|400|4,5|o
Tiro Telugu|f|400,400i|4,5,24|o
Tsukimi Rounded|s|300,400,500,600,700|26,4,5|o
Send Flowers|h|400|4,5,8|o
Konkhmer Sleokchher|d|400|18,4,5|o
Londrina Sketch|d|400|4|o
Trochut|d|400,400i,700|4|o
Rubik Pixels|d|400|0,1,9,4,5|o
Rubik Distressed|d|400|0,1,9,4,5|o
Playwrite IE|h|100,200,300,400||o
Bahiana|d|400|4,5|o
Big Shoulders Inline|d|100,200,300,400,500,600,700,800,900|4,5,8|o
Ponomar|d|400|0,1,4|o
Rubik Iso|d|400|0,1,9,4,5|o
TASA Explorer|s|400,500,600,700,800|4,5|o
Playwrite US Modern|h|100,200,300,400||o
Noto Sans Syloti Nagri|s|400|4,5,73|o
Edu NSW ACT Foundation|h|400,500,600,700|4|o
Mr Bedfort|h|400|4,5|o
Noto Sans Tangsa|s|400,500,600,700|4,5,74|o
Rubik Glitch Pop|d|400|0,1,9,4,5,6,7|o
Ubuntu Sans Mono|m|400,400i,500,500i,600,600i,700,700i|0,1,2,3,4,5|c
Stack Sans Notch|s|200,300,400,500,600,700|4,5|o
Ancizar Sans|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i,1000,1000i|2,4,5|o
Triodion|d|400|0,1,4|o
Cause|h|100,200,300,400,500,600,700,800,900|4,5|o
BioRhyme Expanded|f|200,300,400,700,800|4,5|o
Cossette Texte|s|400,700|4,5|o
Bonbon|h|400|4|o
Kedebideri|s|400,500,600,700,800,900|75,4|o
Princess Sofia|h|400|4,5|o
Flavors|d|400|4,5|o
Chenla|d|400|18|o
Hanalei Fill|d|400|4,5|o
Shizuru|d|400|26,4|o
Gidole|s|400|0,2,4,5,8|o
Kumar One Outline|d|400|16,4,5|?
Peddana|f|400|4,24|o
Noto Serif Ethiopic|f|100,200,300,400,500,600,700,800,900|14,4,5|o
Noto Sans Batak|s|400|76,4,5|o
Mrs Sheppards|h|400|4,5|o
Sixtyfour Convergence|m|400|4,5,6,7|o
Gajraj One|d|400|13,4,5|o
Noto Sans Balinese|s|400,500,600,700|77,4,5|o
Noto Sans Mongolian|s|400|4,5,6,78,7|o
Twinkle Star|h|400|4,5,8|o
Playwrite HR|h|100,200,300,400||o
Rubik Vinyl|d|400|0,1,9,4,5|o
Black And White Picture|d|400|28,4|o
Sedan|f|400,400i|4,5|o
Rubik Burned|d|400|0,1,9,4,5|o
Pliant|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,2,3,4,5|o
Snippet|s|400|4|o
Kolker Brush|h|400|4,5,8|o
Noto Sans Old Hungarian|s|400|4,5,79|o
Splash|h|400|4,5,8|o
Amarna|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|4,5|o
Cossette Titre|s|400,700|4,5|o
Lumanosimo|h|400|4,5|o
Molle|h|400i|4,5|o
Playwrite BR Guides|h|400||o
Playwrite RO|h|100,200,300,400||o
Vibes|d|400|27,4|o
Iosevka Charon|m|300,300i,400,400i,500,500i,700,700i|10,40,0,1,2,3,4,5,6,7,36,8|o
Bitcount Grid Single|d|100,200,300,400,500,600,700,800,900|4,5|o
Playwrite AU QLD|h|100,200,300,400||o
Iansui|h|400|29,4,5,36|o
Rubik Gemstones|d|400|0,1,9,4,5|o
Gveret Levin|h|400|9,4|o
Workbench|m|400|4,6,7|o
Noto Sans Kaithi|s|400|80,4,5|o
Noto Sans Cypro Minoan|s|400|81,4,5|o
Playwrite AT|h|100,100i,200,200i,300,300i,400,400i||o
Edu AU VIC WA NT Dots|h|400,500,600,700|4,5|o
Aubrey|d|400|4|o
Noto Sans Coptic|s|400|82,4,5|o
Noto Serif Yezidi|f|400,500,600,700|4,5,83|o
Cascadia Mono|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|27,40,0,1,2,9,4,5,36,8|o
Ojuju|s|200,300,400,500,600,700,800|4,5,6,7,8|o
Tiro Tamil|f|400,400i|4,5,23|o
Parastoo|f|400,500,600,700|27,4,5,8|o
Ole|h|400|4,5,8|o
Chiron Sung HK|f|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|44,0,1,2,4,5,36,8|o
Protest Guerrilla|d|400|4,5,6,7,8|o
Playwrite DK Uloopet|h|100,200,300,400||o
Libertinus Mono|m|400|4,5|o
Cherish|h|400|4,5,8|o
Noto Sans Syriac|s|100,200,300,400,500,600,700,800,900|4,5,34|o
Noto Sans Pahawh Hmong|s|400|4,5,84|o
Noto Sans Tamil Supplement|s|400|4,5,85|o
Bahianita|d|400|4,5,8|o
Rubik Puddles|d|400|0,1,9,4,5|o
Wavefont|d|100,200,300,400,500,600,700,800,900,1000||o
Ruwudu|f|400,500,600,700|27,4,5|o
Tagesschrift|d|400|4,5|o
Rubik 80s Fade|d|400|0,1,9,4,5|o
Combo|d|400|4,5|o
M PLUS Code Latin|s|100,200,300,400,500,600,700|4,5,8|o
Butterfly Kids|h|400|4,5|o
Playpen Sans Hebrew|h|100,200,300,400,500,600,700,800|30,9,4,5,6|o
Sassy Frass|h|400|4,5,8|o
Playwrite PL|h|100,200,300,400||o
Playwrite DK Loopet|h|100,200,300,400||o
Noto Sans Shavian|s|400|4,5,86|o
Moulpali|s|400|18,4|o
Noto Sans Vithkuqi|s|400,500,600,700|4,5,87|o
Bungee Tint|d|400|4,5,8|o
Noto Serif Myanmar|f|100,200,300,400,500,600,700,800,900|45|o
Explora|h|400|32,4,5,8|o
Lilex|m|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i|0,1,2,4,5,36,8|o
Iosevka Charon Mono|m|300,300i,400,400i,500,500i,700,700i|10,40,0,1,2,3,4,5,6,7,36,8|o
Playwrite CA|h|100,200,300,400||o
Kalnia Glaze|d|100,200,300,400,500,600,700|4,5|o
Flow Rounded|d|400|0,1,4,5,8|o
Rubik Beastly|d|400|0,1,9,4,5|o
Noto Serif Vithkuqi|f|400,500,600,700|4,5,87|o
Taprom|d|400|18,4|o
Matemasie|s|400|4,5|o
Linefont|d|100,200,300,400,500,600,700,800,900,1000||o
LXGW Marker Gothic|s|400|29,0,1,2,4,5,36,8|o
Noto Sans Yi|s|400|4,5,61|o
Noto Serif Dives Akuru|f|400|88,4,5|o
BBH Bogle|s|400|4|o
Agu Display|d|400|4,5,8|o
Zen Loop|d|400,400i|4,5|o
Danfo|f|400|4,5,8|o
Asimovian|s|400|4,5,8|o
Noto Sans Carian|s|400|89,4,5|o
Langar|d|400|17,4,5|o
Noto Sans Siddham|s|400|4,5,90|o
Suravaram|f|400|4,24|o
WDXL Lubrifont TC|s|400|29,0,4,5,36|o
Karla Tamil Inclined|s|400,700|23|o
Estedad|s|100,200,300,400,500,600,700,800,900|27,4,5,8|o
Narnoor|s|400,500,600,700,800|91,4,5,6,7|o
Flow Block|d|400|0,1,4,5,8|o
Saira Stencil|d|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Noto Serif Tangut|f|400|4,5,92|o
Annapurna SIL|f|400,700|13,4,5,6,7|o
Noto Sans Avestan|s|400|93,4,5|o
Playwrite HU|h|100,200,300,400||o
Noto Sans Runic|s|400|4,5,39|o
Noto Serif Dogra|f|400|94,4,5|o
Rubik Doodle Triangles|d|400|0,1,9,4,5,6,7|o
Noto Serif Toto|f|400,500,600,700|4,5,95|o
Playwrite NZ Basic|h|100,200,300,400||o
Noto Sans Hanunoo|s|400|96,4,5|o
Menbere|s|100,200,300,400,500,600,700|14,4,5,8|o
Geomini|s|200,300,400,500,600,700,800|4,5|o
Tai Heritage Pro|f|400,700|4,5,69,8|o
Playwrite DE SAS|h|100,200,300,400||o
Redacted Script|d|300,400,700|4,5|o
Phetsarath|s|400,700|19|o
UoqMunThenKhung|f|400|29,0,4,36|o
Estonia|h|400|4,5,8|o
Playwrite ZA|h|100,200,300,400||o
BBH Hegarty|s|400|4|o
Petemoss|h|400|4,5,8|o
Noto Sans Duployan|s|400,700|97,4,5|o
Noto Sans Multani|s|400|4,5,98|o
Labrada|f|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,8|o
Edu SA Hand|h|400,500,600,700|4,5|?
Ga Maamli|d|400|4,5,8|o
Noto Sans Marchen|s|400|4,5,99|o
Snowburst One|d|400|4,5|o
Tapestry|h|400|4,5,8|o
Coral Pixels|d|400|4,5|o
Geostar|d|400|4|o
Noto Sans Old Italic|s|400|4,5,38|o
Noto Sans Old Persian|s|400|4,5,100|o
Rubik Broken Fax|d|400|0,1,9,4,5,6,7|o
Rubik Maze|d|400|0,1,9,4,5|o
Noto Serif Balinese|f|400|77,4,5|o
Rubik Microbe|d|400|0,1,9,4,5|o
Noto Sans NKo|s|400|4,5,101|o
Savate|s|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Noto Sans Mende Kikakui|s|400|4,5,102|o
Chokokutai|d|400|26,4,5,8|o
Noto Sans Bamum|s|400,500,600,700|103,4,5|o
Noto Sans Sunuwar|s|400|4,5,104|o
Datatype|m|100,200,300,400,500,600,700,800,900|4,5|o
Rock 3D|d|400|26,4|o
Moirai One|d|400|28,4,5|o
Lisu Bosa|f|200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5,55|o
Ruge Boogie|h|400|4,5,8|o
Noto Sans Takri|s|400|4,5,105|o
Playwrite IT Moderna|h|100,200,300,400||o
Namdhinggo|f|400,500,600,700,800|4,5,106|o
Playwrite NL|h|100,200,300,400||o
Winky Rough|s|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Noto Sans Old Permic|s|400|1,4,5,43|o
Palette Mosaic|d|400|26,4|o
Playpen Sans Deva|h|100,200,300,400,500,600,700,800|13,30,4,5|o
Playwrite MX Guides|h|400||o
Noto Sans Nag Mundari|s|400,500,600,700|4,5,107|o
Playwrite AU TAS|h|100,200,300,400||o
Finlandica Text|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Syne Tactile|d|400|4,5|o
Noto Traditional Nushu|s|300,400,500,600,700|4,5,33|o
Ingrid Darling|h|400|4,5,8|o
Playwrite AR|h|100,200,300,400||o
Mingzat|s|400|4,5,108|o
Hanalei|d|400|4,5|o
Tirra|s|400,500,600,700,800,900|4,5,35|o
M PLUS U|s|100,200,300,400,500,600,700,800,900|26,4,5,36,8|o
Miranda Sans|s|400,400i,500,500i,600,600i,700,700i|4,5|o
Noto Sans Lisu|s|400,500,600,700|4,5,55|o
Epunda Slab|f|300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|4,5|o
Playwrite ES|h|100,200,300,400||o
Noto Sans Tifinagh|s|400|4,5,35|o
Noto Serif Gurmukhi|f|100,200,300,400,500,600,700,800,900|17,4,5|o
Edu AU VIC WA NT Pre|h|400,500,600,700|4,5|o
Libertinus Serif Display|d|400|0,1,2,3,4,5,8|o
Noto Sans Syriac Eastern|s|100,200,300,400,500,600,700,800,900|4,5,34|o
Jaini Purva|d|400|13,4,5|o
Playwrite MX|h|100,200,300,400||o
Hind Mysuru|s|300,400,500,600,700|46,4,5|o
Puppies Play|h|400|4,5,8|o
Noto Serif Makasar|f|400|4,5,109|o
Ponnala|d|400|4,24|o
Noto Sans Adlam Unjoined|s|400,500,600,700|42,4,5|o
Playwrite PT|h|100,200,300,400||o
Bitcount Ink|d|100,200,300,400,500,600,700,800,900|4,5|o
Playwrite BE VLG|h|100,200,300,400||o
Hibur Mono|m|400|14,4,5|o
Noto Sans Wancho|s|400|4,5,110|o
Rubik Marker Hatch|d|400|0,1,9,4,5|o
Noto Sans Egyptian Hieroglyphs|s|400|111,4,5|o
Edu QLD Beginner|h|400,500,600,700|4|o
Exile|d|400|4,5|o
Noto Serif Oriya|f|400,500,600,700|4,5,21|o
Grandiflora One|f|400|28,4,5|o
Shafarik|d|400|0,1,70,4,5|o
Noto Sans Nandinagari|s|400|4,5,112|o
Noto Sans Osage|s|400|4,5,113|o
Bitcount|d|100,200,300,400,500,600,700,800,900|4,5|o
Noto Sans Old Turkic|s|400|4,5,114|o
Playwrite AU VIC|h|100,200,300,400||o
Playpen Sans Thai|h|100,200,300,400,500,600,700,800|30,4,5,6,25|o
Blaka Hollow|d|400|27,4,5|o
Playwrite GB J|h|100,100i,200,200i,300,300i,400,400i||o
Playwrite HR Lijeva|h|100,200,300,400||o
Rubik Maps|d|400|0,1,9,4,5,6,7|o
Noto Sans Grantha|s|400|115,4,5|o
Moo Lah Lah|d|400|4,5,8|o
Edu VIC WA NT Hand Pre|h|400,500,600,700|4,5|?
Noto Sans Medefaidrin|s|400,500,600,700|4,5,116|o
Noto Sans Lydian|s|400|4,5,117|o
Noto Serif Khitan Small Script|f|400|118,4,5|o
Bytesized|s|400|4,5|o
Jaini|d|400|13,4,5|o
Noto Sans Old North Arabian|s|400|4,5,119|o
Noto Serif Todhri|f|400|4,5,120|o
Sirivennela|s|400|4,24|o
Playwrite DE LA|h|100,200,300,400||o
Noto Sans Vai|s|400|4,5,121|o
Noto Znamenny Musical Notation|s|400|4,5,6,7,122|o
Noto Sans NKo Unjoined|s|400,500,600,700|4,5,101|o
Noto Sans Indic Siyaq Numbers|s|400|123,4,5|o
Allkin|d|400||o
Noto Sans Nabataean|s|400|4,5,124|o
Playwrite FR Moderne|h|100,200,300,400||o
Bitcount Prop Double Ink|d|100,200,300,400,500,600,700,800,900|4,5|o
Noto Sans Mahajani|s|400|4,5,125|o
Playwrite NG Modern|h|100,200,300,400||o
Montenegrin Gothic One|f|400|4,5|o
Maname|f|400|4,5,22,8|o
Karla Tamil Upright|s|400,700|23|o
Bitcount Single Ink|d|100,200,300,400,500,600,700,800,900|4,5|o
Yuji Hentaigana Akari|h|400|26,4,5|o
Playwrite SK|h|100,200,300,400||o
Rubik Lines|d|400|0,1,9,4,5,6,7|o
Warnes|d|400|4,5|o
Rubik Storm|d|400|0,1,9,4,5|o
Noto Sans Tai Le|s|400|4,5,126|o
Playwrite CZ|h|100,200,300,400||o
Blaka Ink|d|400|27,4,5|o
Playwrite TZ|h|100,200,300,400||o
Kay Pho Du|f|400,500,600,700|41,4,5|o
Padyakke Expanded One|f|400|46,4,5|o
Playwrite BE WAL|h|100,200,300,400||o
Edu VIC WA NT Hand|h|400,500,600,700|4,5|?
Noto Sans Mandaic|s|400|4,5,127|o
Bitcount Prop Double|d|100,200,300,400,500,600,700,800,900|4,5|o
Edu AU VIC WA NT Arrows|h|400,500,600,700|4,5|o
Noto Sans Deseret|s|400|128,4,5|o
Noto Sans Cuneiform|s|400|129,4,5|o
Tuffy|s|400,400i,700,700i|0,1,2,3,4,5,130|o
Noto Serif NP Hmong|f|400,500,600,700|4,131|o
Sankofa Display|s|400|4,5,8|o
Noto Sans Inscriptional Parthian|s|400|132,4,5|o
Bitcount Grid Single Ink|d|100,200,300,400,500,600,700,800,900|4,5|o
Betania Patmos|h|400|4,5|o
Libertinus Keyboard|d|400|4,5|o
Noto Serif Ottoman Siyaq|f|400|4,5,133|o
Noto Sans Khojki|s|400|51,4,5|o
Jacquard 12 Charted|d|400|4,5,6,7|o
Noto Sans Sundanese|s|400,500,600,700|4,5,134|o
Playwrite NZ|h|100,200,300,400||o
Noto Sans Imperial Aramaic|s|400|135,4,5|o
Bpmf Zihi Kai Std|s|400|29,4,5|o
Noto Serif Hentaigana|f|200,300,400,500,600,700,800,900|136,4,5|o
Noto Sans Sogdian|s|400|4,5,137|o
Playwrite CO|h|100,200,300,400||o
Bitcount Prop Single Ink|d|100,200,300,400,500,600,700,800,900|4,5|o
Noto Sans New Tai Lue|s|400,500,600,700|4,5,58|o
Noto Sans Newa|s|400|4,5,138|o
Noto Sans Meroitic|s|400|4,5,139,140,141|o
BJCree|f|400,500,600,700|12,4|o
Strichpunkt Sans|s|400,500,600,700,800,900|4,5|o
Bitcount Grid Double Ink|d|100,200,300,400,500,600,700,800,900|4,5|o
Noto Sans Inscriptional Pahlavi|s|400|142,4,5|o
Noto Sans Palmyrene|s|400|4,5,143|o
Jersey 10 Charted|d|400|4,5|o
Noto Sans Tagbanwa|s|400|4,5,144|o
Noto Sans Cham|s|100,200,300,400,500,600,700,800,900|145,4,5|o
Yuyu|h|400|4,5|o
Edu NSW ACT Hand Pre|h|400,500,600,700|4,5|?
Noto Serif Grantha|f|400|115,4,5|o
Playwrite PE|h|100,200,300,400||o
Noto Sans Buginese|s|400|146,4,5|o
Noto Sans Zanabazar Square|s|400|4,5,147|o
Noto Sans Brahmi|s|400|148,4,5,6,7|o
Playwrite CO Guides|h|400||o
Noto Sans Miao|s|400|4,5,149|o
Jersey 15 Charted|d|400|4,5|o
Pochaevsk|d|400|0,1,4|o
Noto Sans Tai Tham|s|400,500,600,700|4,5,150|o
Playwrite US Trad Guides|h|400||o
Jacquard 24 Charted|d|400|4,5|o
Idiqlat|f|200,300,400|4,34|o
Playwrite ID|h|100,200,300,400||o
Noto Sans Hanifi Rohingya|s|400,500,600,700|151,4,5|o
Yuyu Short|h|400|4,5|o
Bpmf Iansui|h|400|29,4,5|o
Noto Sans Old South Arabian|s|400|4,5,152|o
Finlandica Headline|s|100,100i,200,200i,300,300i,400,400i,500,500i,600,600i,700,700i,800,800i,900,900i|0,1,4,5,8|o
Noto Sans Sharada|s|400|4,5,153|o
Edu QLD Hand|h|400,500,600,700|4,5,8|?
Jersey 25 Charted|d|400|4,5|o
Matangi|s|300,400,500,600,700,800,900|13,4,5|o
Micro 5 Charted|d|400|4,5,6,7|o
Noto Sans Elymaic|s|400|154,4,5|o
Noto Serif Old Uyghur|f|400|4,5,155|o
Noto Sans Kawi|s|400,500,600,700|156,4,5|o
Yarndings 20 Charted|d|400|4,6,7|o
Playwrite CL|h|100,200,300,400||o
Noto Sans Ugaritic|s|400|4,5,157|o
Noto Sans Chakma|s|400|158,4,5|o
Noto Sans Rejang|s|400|4,5,159|o
Kanchenjunga|s|400,500,600,700|160,4|o
Noto Sans Bassa Vah|s|400,500,600,700|161,4,5|o
Jersey 20 Charted|d|400|4,5|o
Noto Sans Mro|s|400|4,5,162|o
Noto Sans Mayan Numerals|s|400|4,5,49|o
Noto Sans Tirhuta|s|400|4,5,163|o
Playwrite AU VIC Guides|h|400||o
Noto Sans Chorasmian|s|400|164,4,5,6,7|o
Noto Sans Kayah Li|s|400,500,600,700|41,4,5|o
Noto Sans Linear B|s|400|4,5,165|o
Playwrite ES Deco|h|100,200,300,400||o
Noto Sans Syriac Western|s|100,200,300,400,500,600,700,800,900|4,5,34|o
Playwrite NZ Guides|h|400||o
Yarndings 20|d|400|4,6,7|o
Noto Sans Hatran|s|400|166,4,5|o
Alien Block|d|400|4,5|o
Noto Sans Limbu|s|400|4,5,106|o
Noto Sans Pau Cin Hau|s|400|4,5,167|o
Noto Sans Cypriot|s|400|168,4,5|o
Noto Sans Masaram Gondi|s|400|4,5,169|o
Noto Sans Saurashtra|s|400|4,5,170|o
Noto Sans SignWriting|s|400|4,5,171|o
Noto Sans Kharoshthi|s|400|172,4,5|o
Noto Sans Gunjala Gondi|s|400,500,600,700|91,4,5|o
Noto Sans Lepcha|s|400|4,5,108|o
Noto Sans Manichaean|s|400|4,5,173|o
Noto Sans Old Sogdian|s|400|4,5,174|o
Noto Sans Phoenician|s|400|4,5,130|o
Betania Patmos In|h|400|4,5|o
Yuji Hentaigana Akebono|h|400|26,4,5|o
Playwrite NZ Basic Guides|h|400||?
Betania Patmos In GDL|h|400|4,5|o
Noto Sans Psalter Pahlavi|s|400|4,5,175|o
Jacquarda Bastarda 9 Charted|d|400|4,5,6,7|o
Playwrite GB J Guides|h|400,400i||o
Playwrite TZ Guides|h|400||o
Betania Patmos GDL|h|400|4,5|o
Noto Sans PhagsPa|s|400|4,5,6,176,7|o
Noto Sans Lycian|s|400|177|o
Noto Sans Ogham|s|400|4,5,178|o
Noto Sans Soyombo|s|400|4,5,179|o
Yarndings 12|d|400|4,6,7|o
Playwrite PL Guides|h|400||o
Noto Sans Modi|s|400|4,5,180|o
Playwrite BR|h|100,200,300,400||o
Playwrite PT Guides|h|400||o
Playwrite CU Guides|h|400||o
Playwrite DE Grund Guides|h|400||o
Noto Sans Nushu|s|400|4,5,33|o
Ramsina|f|400|4,34|o
Playwrite DE VA|h|100,200,300,400||o
Playwrite PE Guides|h|400||o
Playwrite GB S Guides|h|400,400i||o
Playwrite FR Trad|h|100,200,300,400||o
Playwrite IT Trad|h|100,200,300,400||o
Yarndings 12 Charted|d|400|4,6,7|o
Playwrite IN Guides|h|400||o
Playwrite BE WAL Guides|h|400||o
Playwrite IE Guides|h|400||o
Playwrite DE VA Guides|h|400||o
Playwrite AR Guides|h|400||o
Playwrite DK Uloopet Guides|h|400||o
Playwrite IT Moderna Guides|h|400||o
Playwrite FR Moderne Guides|h|400||o
Playwrite ES Deco Guides|h|400||o
Playwrite IT Trad Guides|h|400||o
Playwrite FR Trad Guides|h|400||o
Playwrite US Modern Guides|h|400||o
Playwrite ID Guides|h|400||o
Playwrite IS Guides|h|400||o
Playwrite AT Guides|h|400,400i||o
Playwrite AU SA Guides|h|400||o
Playwrite HU Guides|h|400||o
Playwrite NG Modern Guides|h|400||o
Playwrite DK Loopet Guides|h|400||o
Playwrite AU NSW Guides|h|400||o
Playwrite CL Guides|h|400||o
Playwrite HR Lijeva Guides|h|400||o
Playwrite ZA Guides|h|400||o
Playwrite ES Guides|h|400||o
Playwrite NL Guides|h|400||o
Playwrite RO Guides|h|400||o
Playwrite AU TAS Guides|h|400||o
Playwrite SK Guides|h|400||o
Playwrite AU QLD Guides|h|400||o
Playwrite NO Guides|h|400||o
Playwrite BE VLG Guides|h|400||o
Playwrite CA Guides|h|400||o
Playwrite CZ Guides|h|400||o
Playwrite HR Guides|h|400||o`;
