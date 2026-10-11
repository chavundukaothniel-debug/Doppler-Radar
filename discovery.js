const dgram = require('node:dgram');
const crypto = require('node:crypto');
const os = require('node:os');
const DISCOVERY_PORT = 4210;
function localAddressFor(remote, interfaces = os.networkInterfaces()) {
  const numeric = ip => ip.split('.').reduce((value, octet) => (value << 8) | Number(octet), 0) >>> 0;
  let best = null, longest = -1;
  for (const entry of Object.values(interfaces).flat()) {
    if (!entry || !['IPv4',4].includes(entry.family)) continue;
    const mask = numeric(entry.netmask);
    if ((numeric(entry.address) & mask) !== (numeric(remote) & mask)) continue;
    const bits = mask.toString(2).replace(/0/g,'').length;
    if (bits > longest) { best = entry.address; longest = bits; }
  }
  return best;
}
function discoveryReply(message, deviceKey, httpPort, address = '127.0.0.1') {
  if (!deviceKey || message.length > 256) return null;
  let query;
  try { query = JSON.parse(message.toString()); } catch { return null; }
  if (query.type !== 'DOPPLER_DISCOVER_V1' || !/^[a-f0-9]{16}$/.test(query.nonce)) return null;
  const proof = crypto.createHash('sha256').update(`${deviceKey}|${query.nonce}|${httpPort}|${address}`).digest('hex');
  return Buffer.from(JSON.stringify({ type: 'DOPPLER_SERVER_V1', nonce: query.nonce, port: httpPort, address, proof }));
}
function startDiscovery(server, deviceKey, options = {}) {
  const socket = dgram.createSocket('udp4');
  let lastReply = 0;
  socket.on('message', (message, remote) => {
    const now = Date.now();
    if (now - lastReply < 100 || !server.listening) return;
    const address = localAddressFor(remote.address);
    if (!address) return;
    const reply = discoveryReply(message, deviceKey, server.address().port, address);
    if (!reply) return;
    lastReply = now;
    socket.send(reply, remote.port, remote.address, error => { if (error) console.warn('[Discovery]', error.message); });
  });
  socket.on('error', error => console.warn(`[Discovery] ${error.message}; HTTP server remains available.`));
  socket.bind(options.port ?? DISCOVERY_PORT, '0.0.0.0');
  server.once('close', () => { try { socket.close(); } catch {} });
  return socket;
}
module.exports = { discoveryReply, startDiscovery, localAddressFor, DISCOVERY_PORT };
