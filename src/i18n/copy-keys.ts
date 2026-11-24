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
  'chrome.lang-id',
  'chrome.lang-en',
  'chrome.lang-id-name',
  'chrome.lang-en-name',
  'chrome.lang-switch-label',
  'page.home.title',
  'page.home.intro',
  'page.home.projects-heading',
] as const;

export type CopyKey = (typeof COPY_KEYS)[number];
