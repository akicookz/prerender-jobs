export type SeoConfig = {
  weights: Record<string, number>;
  thresholds: {
    title_min: number;
    title_max: number;
    meta_desc_min: number;
    meta_desc_max: number;
    size_large: number;
    size_very_large: number;
    latency_slow: number;
    latency_very_slow: number;
    depth_threshold: number;
    img_alt_low_ratio: number;
    img_alt_very_low_ratio: number;
    nofollow_high_ratio: number;
    content_words_low: number; // below this is low
    content_words_min: number; // below this is very low
  };
  caps: { redirect: number; depth: number };
};

export const DEFAULT_SEO_CONFIG: SeoConfig = {
  weights: {
    status_200_missing: 60,
    status_3xx: 20,
    status_4xx: 50,
    status_5xx: 60,
    redirect_per_hop: 5,
    redirect_cap: 20,
    title_missing: 20,
    title_too_short: 5,
    title_too_long: 5,
    title_multiple: 10,
    meta_desc_missing: 10,
    meta_desc_too_short: 3,
    meta_desc_too_long: 3,
    h1_missing: 10,
    h1_multiple: 10,
    canonical_missing: 5,
    canonical_multiple: 5,
    viewport_missing: 3,
    size_large: 5,
    size_very_large: 10,
    latency_slow: 3,
    latency_very_slow: 10,
    depth_deep: 2,
    depth_cap: 10,
    img_alt_low_ratio: 5,
    img_alt_very_low_ratio: 10,
    nofollow_high_ratio: 2,
    content_words_low: 5,
    content_words_very_low: 30,
  },
  thresholds: {
    title_min: 10,
    title_max: 60,
    meta_desc_min: 50,
    meta_desc_max: 160,
    size_large: 2_000_000,
    size_very_large: 4_000_000,
    latency_slow: 2.0,
    latency_very_slow: 5.0,
    depth_threshold: 3,
    img_alt_low_ratio: 0.5,
    img_alt_very_low_ratio: 0.8,
    nofollow_high_ratio: 0.8,
    content_words_low: 600,
    content_words_min: 300,
  },
  caps: { redirect: 20, depth: 10 },
};
