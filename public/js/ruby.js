const READING = /^[\u3041-\u3096ー]+$/u;

export function parseRuby(value) {
  const source = String(value);
  const parts = [];
  let plain = '';
  const flush = () => {
    if (plain) parts.push(plain);
    plain = '';
  };

  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === '|' || char === '}') throw new Error(`stray ${char} at ${index}`);
    if (char !== '{') {
      plain += char;
      index += 1;
      continue;
    }
    flush();
    const end = source.indexOf('}', index + 1);
    if (end < 0) throw new Error(`unbalanced { at ${index}`);
    const body = source.slice(index + 1, end);
    if (body.includes('{') || body.includes('}')) throw new Error(`nested braces at ${index}`);
    const separator = body.indexOf('|');
    if (separator < 0 || body.indexOf('|', separator + 1) >= 0) {
      throw new Error(`ruby group must contain one | at ${index}`);
    }
    const base = body.slice(0, separator);
    const reading = body.slice(separator + 1);
    if (!base) throw new Error(`empty ruby base at ${index}`);
    if (!reading) throw new Error(`empty ruby reading at ${index}`);
    if (!READING.test(reading)) throw new Error(`invalid ruby reading at ${index}`);
    parts.push([base, reading]);
    index = end + 1;
  }
  flush();
  return parts;
}

export function rubyPlain(value) {
  return parseRuby(value).map((part) => Array.isArray(part) ? part[0] : part).join('');
}

export function rubyReading(value) {
  return parseRuby(value).map((part) => Array.isArray(part) ? part[1] : part).join('');
}
