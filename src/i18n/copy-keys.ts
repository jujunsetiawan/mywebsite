// Every `film-copy` key (one `content/film-copy/<key>.yaml` each). Pure module
// (no `astro:content`) so Vitest can check it against the content files.
export const COPY_KEYS = [
  'chrome.credit',
  'chrome.skip-to-content',
  'chrome.projects',
  'chrome.skip-story',
  'chrome.awards',
  'chrome.contact',
  'chrome.footer-label',
] as const;

export type CopyKey = (typeof COPY_KEYS)[number];
