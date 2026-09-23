export function backDecision(route, hasEarlierPage) {
  if (hasEarlierPage) return { action: 'back' };
  const match = /^\/m\/([a-z]{2})-(\d{4})-Q\d+-Q\d+$/.exec(route);
  if (match) return { action: 'hash', hash: `#/s/${match[1]}/${match[2]}` };
  const season = /^\/s\/([a-z]{2})\/\d{4}$/.exec(route);
  if (season) return { action: 'hash', hash: `#/l/${season[1]}` };
  if (/^\/l\/[a-z]{2}$/.test(route) || /^\/c\/Q\d+$/.test(route) || route === '/credits') {
    return { action: 'hash', hash: '#/' };
  }
  return { action: 'hash', hash: '#/' };
}
