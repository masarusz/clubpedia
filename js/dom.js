import { rubyPlain } from './ruby.js?v=0.3.3';

const ALLOWED_ATTRIBUTES = new Set([
  'alt', 'aria-current', 'aria-label', 'aria-live', 'aria-pressed', 'class', 'colspan', 'for', 'height', 'href', 'id',
  'name', 'placeholder', 'role', 'scope', 'selected', 'src', 'type', 'value', 'width',
  'autocomplete', 'autocorrect', 'autocapitalize', 'spellcheck', 'enterkeyhint', 'loading',
]);

const APPROVED_HTTPS_HOSTS = new Set([
  'github.com', 'creativecommons.org', 'www.wikidata.org', 'openligadb.de', 'en.wikipedia.org', 'ja.wikipedia.org',
]);

function validHref(value) {
  if (value.startsWith('#/')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && APPROVED_HTTPS_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function text(value) {
  return document.createTextNode(String(value));
}

export function rubyNodes(markup) {
  return text(rubyPlain(markup));
}

export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (!ALLOWED_ATTRIBUTES.has(name)) throw new Error(`attribute not allowed: ${name}`);
    if (value !== null && value !== undefined && value !== false) {
      const serialized = value === true ? '' : String(value);
      if (name === 'href' && !validHref(serialized)) throw new Error(`href not allowed: ${serialized}`);
      node.setAttribute(name, serialized);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : text(child));
  }
  return node;
}

export function rubyEl(tag, markup, attributes = {}) {
  return el(tag, attributes, rubyNodes(markup));
}

export function replace(node, children) {
  node.replaceChildren(...(Array.isArray(children) ? children.flat(Infinity) : [children]));
}
