import os from 'node:os';

// Lista IPv4 da rede local, priorizando Wi-Fi/Ethernet "de verdade" (192.168.x / 10.x)
// e empurrando para o fim interfaces virtuais (VPN, Docker, VMs).
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address });
    }
  }
  const score = (x) =>
    (/^(en0|en1|wlan|wl|wi-?fi|eth0|ethernet)/i.test(x.name) ? 0 : 1) +
    (x.address.startsWith('192.168.') ? 0 : x.address.startsWith('10.') ? 0.5 : 1) +
    (/^(utun|bridge|vboxnet|docker|veth|tun|tap|vmnet|awdl|llw|zt|tailscale)/i.test(x.name) ? 5 : 0);
  return out.sort((a, b) => score(a) - score(b));
}
