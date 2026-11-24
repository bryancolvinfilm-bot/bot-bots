import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6)
    return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  return false;
}
export function browserUrl(input: string) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('The browser opens HTTP(S) web pages only, without credentials in the URL.');
  return url;
}
export async function checkBrowserUrl(input: string, testOrigin = '') {
  const url = browserUrl(input);
  if (testOrigin && url.origin === testOrigin) return url.href;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === 'localhost' || /\.(localhost|local|internal)$/i.test(hostname))
    throw new Error(
      'Private network and local app addresses are outside the web browser workspace.',
    );
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address)))
    throw new Error(
      'Private network and local app addresses are outside the web browser workspace.',
    );
  return url.href;
}
