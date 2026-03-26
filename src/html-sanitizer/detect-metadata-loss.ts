import { parse } from "node-html-parser";

export interface MetadataLossResult {
  /** Property identifiers present in original but missing in sanitized HTML */
  lostProperties: string[];
}

/**
 * Compare original and sanitized HTML to detect loss of important SEO metadata.
 * Only flags properties that had non-empty content in the original.
 */
export function detectMetadataLoss(
  originalHtml: string,
  sanitizedHtml: string,
): MetadataLossResult {
  const originalProps = extractProperties(originalHtml);
  const sanitizedProps = extractProperties(sanitizedHtml);

  const lostProperties: string[] = [];
  for (const prop of originalProps) {
    if (!sanitizedProps.has(prop)) {
      lostProperties.push(prop);
    }
  }

  return { lostProperties };
}

function extractProperties(html: string): Set<string> {
  const props = new Set<string>();
  const root = parse(html);
  const head = root.querySelector("head");
  if (!head) return props;

  // <title>
  const title = head.querySelector("title");
  if (title && title.textContent.trim()) {
    props.add("title");
  }

  // <meta name="description">
  const description = head.querySelector('meta[name="description"]');
  if (description && description.getAttribute("content")?.trim()) {
    props.add("meta:description");
  }

  // <meta property="og:*">
  const ogMetas = head.querySelectorAll('meta[property^="og:"]');
  for (const el of ogMetas) {
    const property = el.getAttribute("property");
    const content = el.getAttribute("content");
    if (property && content?.trim()) {
      props.add(property);
    }
  }

  // <meta name="twitter:*">
  const twitterMetas = head.querySelectorAll('meta[name^="twitter:"]');
  for (const el of twitterMetas) {
    const name = el.getAttribute("name");
    const content = el.getAttribute("content");
    if (name && content?.trim()) {
      props.add(name);
    }
  }

  return props;
}
