export interface SanitizeOptions {
  /** The rendered HTML string from headless browser */
  html: string;
  /** The final URL of the rendered page (after any redirects) */
  url: string;
  /** The preferred canonical domain hostname (e.g. "example.com" or "www.example.com") */
  canonicalDomain: string;
}
