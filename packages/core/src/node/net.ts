import { isIP } from 'node:net';

/** True for IPv4 127.0.0.0/8, IPv6 ::1 and IPv4-mapped loopback addresses. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const addr = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(addr) === 4) return addr.startsWith('127.');
  return addr === '::1' || addr === '0:0:0:0:0:0:0:1';
}

/**
 * True when a Host header (hostname with optional port) names the local
 * machine. Used against DNS-rebinding attacks: a malicious page can resolve
 * its own domain to 127.0.0.1, but its requests still carry that domain in
 * `Host`.
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    if (end === -1) return false;
    hostname = hostname.slice(1, end);
  } else {
    const colon = hostname.lastIndexOf(':');
    if (colon !== -1) hostname = hostname.slice(0, colon);
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return isLoopbackAddress(hostname);
}

/** True for bind addresses that only accept local connections. */
export function isLoopbackBindHost(host: string): boolean {
  return host === 'localhost' || isLoopbackAddress(host);
}
