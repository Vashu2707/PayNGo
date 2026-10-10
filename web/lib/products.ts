/**
 * Product catalog: maps the YOLO class names (as written by smart_shelf.py
 * from cv-ml-core/data/dataset.yaml) to display labels and prices.
 *
 * All 113 classes are present — the cart UI, Mongo seed and Razorpay
 * pricing all key off this map. Keep it in sync with dataset.yaml
 * (enforced by tests/test_dataset_consistency.py).
 *
 * Labels below are auto-derived from the class name; the four hand-written
 * entries are kept in OVERRIDES. Prices for classes without an override are
 * placeholders (DEFAULT_PRICE) — replace them with real prices before
 * going live (checkout rejects a zero total, so every class needs a price).
 */

export interface ProductInfo {
  slug: string;
  label: string;
  price: number; // whole rupees
}

/** Class names in dataset.yaml order (index == YOLO class id). */
export const CLASS_NAMES: string[] = [
  "blue-lays",
  "green-lays",
  "orange-lays",
  "dark-green-lays",
  "7days_croissantschoko_packung_80_1",
  "airwaves_menthoneucalyptus_riegel_14_1",
  "b_tarteaupomme",
  "balisto_muesli_37g",
  "balisto_yoberry_37g",
  "berger",
  "berger_???",
  "berger_bruensli",
  "berger_brunsli",
  "berger_mailaenderli",
  "berger_nusstoertli",
  "berger_schoggitoertli",
  "berger_spitzbueb",
  "berger_vogelnestli",
  "bifi_roll_50",
  "bounty",
  "branche_maxi",
  "bueno_43",
  "c+swiss_dosenabisicetea_33",
  "caferoyal_classicmacchiato_33",
  "caprisun_multivitamin_20",
  "coke_50",
  "coke_dose_33",
  "coke_flasche_50",
  "coke_light_flasche_50_5449238",
  "coke_zero_flasche_50",
  "comella_schokodrink_33",
  "comella_schokodrink_flasche_50",
  "corny_schoko",
  "darwida_chocaulait",
  "darwida_sandwich",
  "erle",
  "evian_50",
  "fanta_50",
  "fini_galaxymix_packung_100_1",
  "fini_jellykisses_packung_80_1",
  "fuse_blackicetea_50",
  "fuse_lemon_50",
  "fuse_lemon_dose_33",
  "fuse_peach_50",
  "fuse_peach_dose_33",
  "granini_orange",
  "granini_orange_50",
  "haribo_goldbaerensauer",
  "henniez_blau_33",
  "henniez_gruen_33",
  "henniez_rot_33",
  "jacklinks_beefjerkyorginal_25",
  "jlbrichard_gauffre_90",
  "jlbrichard_gauffrechoko_90",
  "kagi_50",
  "kagi_specialedition_50",
  "kinder_delice",
  "kitkat",
  "knoppers_riegel",
  "lindt_nocciolate",
  "lorenz_nicnacs_40",
  "lorenz_studentenfutter",
  "malburner_partysticks_40",
  "maltesers_100",
  "maltesers_teasers_35",
  "mezzomix_50",
  "milka_oreo_riegel_37_1",
  "milka_peanutbutter",
  "milka_tender",
  "mnms_gelb_45",
  "momo_icetea_50",
  "oreo_66",
  "ovomaltine_kekse",
  "panettone",
  "pepsi_max_50",
  "powerbar_proteinplusschoko_55",
  "ragusa_50",
  "ramseier_jusdepomme_50",
  "ramseier_jusdepomme_tetrapak_33",
  "ramseier_orange_tetrapak_33",
  "ramseier_schorle_50",
  "redbull_33",
  "redbull_light_33",
  "rivella_rot_50",
  "schweppes_bitterlemon_50",
  "schweppes_citrus_50",
  "sinalco_50",
  "sinalco_orange_50",
  "skittles_sour_riegel_51_1",
  "snickers_50",
  "snickers_weiß_50",
  "sprite_flasche_50",
  "stimorol_spearmint_riegel_14_1",
  "stimorol_wildcherry_riegel_14_1",
  "tiki_himbeer_brause_50",
  "tiki_himbeerbrause_dose_33_1",
  "toffifee_33",
  "torino_46",
  "twix_50",
  "valser_classic_50",
  "valser_still_50",
  "valser_vivabirne_50",
  "vitaminwell_reload_50",
  "vivitz_classiczitrone_50",
  "vivitz_gruentee_50",
  "volvic_pinapple_50",
  "volvic_pink_50",
  "volvic_teeminze_50",
  "wasser_???",
  "zweifel_graneochilli_100",
  "zweifel_paprika_90",
  "zweifel_saltedpeanuts",
  "zweifel_salz_90",
];

/** Hand-written label/price overrides, keyed by class name. */
const OVERRIDES: Record<string, Partial<ProductInfo>> = {
  "blue-lays": { label: "Lays Blue", price: 1 },
  "green-lays": { label: "Lays Green", price: 1 },
  "orange-lays": { label: "Lays Orange", price: 1 },
  "dark-green-lays": { label: "Lays Dark Green", price: 1 },
};

/** Placeholder price for classes without an override (whole rupees). */
const DEFAULT_PRICE = 10;

function labelFor(slug: string): string {
  if (OVERRIDES[slug]?.label) return OVERRIDES[slug].label as string;
  return slug
    .replace(/[-_]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const PRODUCT_CATALOG: Record<string, ProductInfo> =
  Object.fromEntries(
    CLASS_NAMES.map((slug) => [
      slug,
      { slug, label: labelFor(slug), price: OVERRIDES[slug]?.price ?? DEFAULT_PRICE },
    ])
  );

/** Cart / receipt label for a class name (falls back to a prettified slug). */
export function prettyName(slug: string): string {
  return labelFor(slug);
}

export function getProduct(slug: string): ProductInfo | undefined {
  return PRODUCT_CATALOG[slug];
}

/** Hand-written emoji for classes that also have a color chip in globals.css. */
const EMOJI_OVERRIDES: Record<string, string> = {
  "blue-lays": "🔵",
  "green-lays": "🟢",
  "orange-lays": "🟠",
  "dark-green-lays": "🟤",
};

/** Category emoji for a class name — first rule wins, otherwise the default box. */
const EMOJI_RULES: [RegExp, string][] = [
  [/lays|zweifel|pringles/, "🥔"],
  [/haribo|skittles|mnms|stimorol|fini|tiki|bounty|airwaves/, "🍬"],
  [/kitkat|twix|snickers|bueno|milka|oreo|kinder|maltesers|toffifee|ragusa|lindt|balisto|corny|knoppers|ovomaltine|branche|comella|darwida|torino|kagi/, "🍫"],
  [/berger|gauffre|panettone|jlbrichard|7days|croissant/, "🍪"],
  [/nicnacs|studentenfutter|jacklinks|bifi|malburner|powerbar/, "🥜"],
  [/redbull/, "⚡"],
  [/caferoyal/, "☕"],
  [/evian|valser|volvic|wasser|granini/, "💧"],
  [/coke|pepsi|fanta|sprite|schweppes|henniez|mezzomix|fuse|sinalco|ramseier|momo|vitaminwell|vivitz|rivella|caprisun|erle|tarteaupomme|dosen|icetea/, "🥤"],
];

export function emojiFor(slug: string): string {
  if (EMOJI_OVERRIDES[slug]) return EMOJI_OVERRIDES[slug];
  for (const [re, emoji] of EMOJI_RULES) {
    if (re.test(slug)) return emoji;
  }
  return "📦";
}
