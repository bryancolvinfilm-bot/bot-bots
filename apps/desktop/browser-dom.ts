import type { BrowserElement } from '../../packages/shared/computer';

// These fixed functions run in an isolated Chromium world. No model-supplied JavaScript runs.
export function readBrowserPage() {
  const state = globalThis as typeof globalThis & {
    __botNodes?: Map<string, Element>;
    __botDocument?: Document;
  };
  state.__botNodes = new Map();
  state.__botDocument = document;
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const elements: BrowserElement[] = [];
  const snapshotId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Search result headings go first, so navigation chrome cannot crowd out actual results.
  const nodes = [
    ...new Set([
      ...document.querySelectorAll('.b_algo h2 a, .result__a, a:has(h3), .snippet-title'),
      ...document.querySelectorAll(
        'a[href], button, input:not([type="hidden"]):not([type="password"]), textarea, select, [role="button"]',
      ),
    ]),
  ];
  for (const e of nodes) {
    if (!visible(e) || elements.length >= 60) continue;
    const ref = `${snapshotId}-e${elements.length + 1}`;
    let href = e instanceof HTMLAnchorElement ? e.href : undefined;
    if (href && /bing\.com\/ck\/a/.test(href)) {
      try {
        const encoded = new URL(href).searchParams.get('u');
        if (encoded?.startsWith('a1'))
          href = atob(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
      } catch {
        /* keep real link */
      }
    }
    if (href && /duckduckgo\.com/.test(href)) {
      try {
        href = new URL(href).searchParams.get('uddg') ?? href;
      } catch {
        /* keep link */
      }
    }
    if (href && /google\.com\/url/.test(href)) {
      try {
        href = new URL(href).searchParams.get('q') ?? new URL(href).searchParams.get('url') ?? href;
      } catch {
        /* keep link */
      }
    }
    const label = (
      e.getAttribute('aria-label') ||
      (e as HTMLElement).innerText ||
      e.getAttribute('placeholder') ||
      e.getAttribute('title') ||
      e.getAttribute('name') ||
      e.tagName
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    state.__botNodes.set(ref, e);
    elements.push({
      ref,
      tag: e.tagName.toLowerCase(),
      label,
      href,
      type: e.getAttribute('type') ?? undefined,
      searchResult: e.matches('.b_algo h2 a, .result__a, a:has(h3), .snippet-title') || undefined,
    });
  }
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText ?? document.documentElement.textContent ?? '').slice(0, 10000),
    elements,
  };
}
export function useBrowserElement(ref: string, kind: 'click' | 'type', text = '') {
  const state = globalThis as typeof globalThis & {
    __botNodes?: Map<string, Element>;
    __botDocument?: Document;
  };
  const node = state.__botNodes?.get(ref);
  if (!node?.isConnected || state.__botDocument !== document)
    throw new Error('This page changed. Read the page again to get fresh element refs.');
  if (kind === 'click') {
    (node as HTMLElement).click();
    return;
  }
  if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement))
    throw new Error('Choose a text input or textarea ref.');
  if (node instanceof HTMLInputElement && ['password', 'file', 'hidden'].includes(node.type))
    throw new Error('Use the browser manually for this kind of field.');
  node.focus();
  const prototype =
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, text);
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}
