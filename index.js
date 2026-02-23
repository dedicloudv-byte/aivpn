// AIVPN - Cloudflare Worker implementation of VLESS and Trojan protocols
// Supports WebSocket + TLS

import { connect } from 'cloudflare:sockets';

const userID = '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a7a7a'; // Default UUID
const trojanPasswordHash = '394205562d989938b29df95107e3ef74421b93f2183c5093153ee046'; // SHA224 of 'aivpn'

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgradeHeader = request.headers.get('Upgrade');

      if (upgradeHeader === 'websocket') {
        if (url.pathname === '/trojan') {
          return await trojanOverWSHandler(request, env);
        } else {
          return await vlessOverWSHandler(request, env);
        }
      }

      return new Response(generateDashboard(request, env), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};

function generateDashboard(request, env) {
  const host = request.headers.get('Host') || 'aivpn.example.com';
  const uuid = env.UUID || userID;
  const password = env.PASSWORD || 'aivpn';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AIVPN Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body { background-color: #0f172a; color: #f8fafc; font-family: 'Inter', sans-serif; }
        .card { background-color: #1e293b; border-radius: 1rem; padding: 1.5rem; border: 1px solid #334155; }
        .btn { transition: all 0.2s; }
        .btn:hover { transform: translateY(-2px); }
        .gradient-text { background: linear-gradient(90deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .hidden { display: none !important; }
    </style>
</head>
<body class="min-h-screen">
    <nav class="border-b border-slate-800 p-4">
        <div class="container mx-auto flex justify-between items-center">
            <div class="flex items-center space-x-2">
                <i class="fas fa-shield-halved text-2xl text-sky-400"></i>
                <span class="text-xl font-bold tracking-tight">AI<span class="text-sky-400">VPN</span></span>
            </div>
            <div class="text-sm text-slate-400">
                <i class="fas fa-circle text-emerald-500 text-[10px] mr-1"></i> System Online
            </div>
        </div>
    </nav>

    <main class="container mx-auto p-4 md:p-8">
        <header class="mb-8">
            <h1 class="text-3xl font-bold mb-2">Welcome to <span class="gradient-text">AIVPN</span></h1>
            <p class="text-slate-400">Fast, Secure, and Anonymous. Your private gateway to the internet.</p>
        </header>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <!-- VLESS Card -->
            <div class="card">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center space-x-3">
                        <div class="bg-sky-500/10 p-2 rounded-lg"><i class="fas fa-bolt text-sky-400"></i></div>
                        <h2 class="text-xl font-semibold">VLESS</h2>
                    </div>
                    <span class="bg-sky-500/10 text-sky-400 text-xs px-2 py-1 rounded">WS + TLS</span>
                </div>
                <p class="text-sm text-slate-400 mb-4">High performance protocol with minimal overhead.</p>
                <div class="space-y-3">
                    <button onclick="copyVless()" class="btn w-full bg-slate-700 hover:bg-slate-600 p-3 rounded-lg flex items-center justify-between">
                        <span class="truncate mr-2 text-xs font-mono" id="vless-link">vless://${uuid}@${host}:443...</span>
                        <i class="fas fa-copy text-slate-400"></i>
                    </button>
                    <button onclick="showQR('vless')" class="btn w-full bg-sky-600 hover:bg-sky-500 p-3 rounded-lg font-semibold">
                        <i class="fas fa-qrcode mr-2"></i> Show QR Code
                    </button>
                </div>
            </div>

            <!-- Trojan Card -->
            <div class="card">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center space-x-3">
                        <div class="bg-indigo-500/10 p-2 rounded-lg"><i class="fas fa-horse text-indigo-400"></i></div>
                        <h2 class="text-xl font-semibold">Trojan</h2>
                    </div>
                    <span class="bg-indigo-500/10 text-indigo-400 text-xs px-2 py-1 rounded">WS + TLS</span>
                </div>
                <p class="text-sm text-slate-400 mb-4">Simple and secure protocol designed to bypass firewalls.</p>
                <div class="space-y-3">
                    <button onclick="copyTrojan()" class="btn w-full bg-slate-700 hover:bg-slate-600 p-3 rounded-lg flex items-center justify-between">
                        <span class="truncate mr-2 text-xs font-mono" id="trojan-link">trojan://${password}@${host}:443...</span>
                        <i class="fas fa-copy text-slate-400"></i>
                    </button>
                    <button onclick="showQR('trojan')" class="btn w-full bg-indigo-600 hover:bg-indigo-500 p-3 rounded-lg font-semibold">
                        <i class="fas fa-qrcode mr-2"></i> Show QR Code
                    </button>
                </div>
            </div>
        </div>

        <!-- System Stats -->
        <div class="mt-8 card">
            <h3 class="text-lg font-semibold mb-4">Node Information</h3>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                    <div class="text-slate-400 text-xs uppercase tracking-wider mb-1">Server Host</div>
                    <div class="font-mono text-sm">${host}</div>
                </div>
                <div>
                    <div class="text-slate-400 text-xs uppercase tracking-wider mb-1">Port</div>
                    <div class="font-mono text-sm">443</div>
                </div>
                <div>
                    <div class="text-slate-400 text-xs uppercase tracking-wider mb-1">Path (VLESS)</div>
                    <div class="font-mono text-sm">/</div>
                </div>
                <div>
                    <div class="text-slate-400 text-xs uppercase tracking-wider mb-1">Path (Trojan)</div>
                    <div class="font-mono text-sm">/trojan</div>
                </div>
            </div>
        </div>
    </main>

    <!-- Modal for QR Code -->
    <div id="qr-modal" class="fixed inset-0 bg-black/80 flex items-center justify-center hidden z-50 p-4">
        <div class="card w-full max-w-sm text-center">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-xl font-bold" id="qr-title">Configuration QR</h3>
                <button onclick="closeModal()" class="text-slate-400 hover:text-white"><i class="fas fa-times"></i></button>
            </div>
            <div id="qrcode" class="bg-white p-4 rounded-xl inline-block mx-auto mb-4"></div>
            <p class="text-sm text-slate-400 break-all mb-4" id="qr-link-text"></p>
            <button onclick="closeModal()" class="btn w-full bg-slate-700 hover:bg-slate-600 p-2 rounded-lg">Close</button>
        </div>
    </div>

    <script>
        const host = "${host}";
        const uuid = "${uuid}";
        const password = "${password}";

        function getVlessLink() {
            return \`vless://\${uuid}@\${host}:443?encryption=none&security=tls&type=ws&host=\${host}&sni=\${host}&path=%2F#AIVPN-VLESS\`;
        }

        function getTrojanLink() {
            return \`trojan://\${password}@\${host}:443?security=tls&type=ws&host=\${host}&sni=\${host}&path=%2Ftrojan#AIVPN-Trojan\`;
        }

        window.copyVless = function() {
            navigator.clipboard.writeText(getVlessLink());
            alert('VLESS link copied to clipboard!');
        }

        window.copyTrojan = function() {
            navigator.clipboard.writeText(getTrojanLink());
            alert('Trojan link copied to clipboard!');
        }

        window.showQR = function(type) {
            try {
                const link = type === 'vless' ? getVlessLink() : getTrojanLink();
                document.getElementById('qr-title').innerText = type.toUpperCase() + ' Configuration';
                document.getElementById('qr-link-text').innerText = link;
                const qrcodeDiv = document.getElementById('qrcode');
                qrcodeDiv.innerHTML = '';
                new QRCode(qrcodeDiv, {
                    text: link,
                    width: 256,
                    height: 256,
                    colorDark : "#000000",
                    colorLight : "#ffffff",
                    correctLevel : QRCode.CorrectLevel.H
                });
                document.getElementById('qr-modal').classList.remove('hidden');
            } catch (e) {
                console.error('Error in showQR:', e);
            }
        }

        window.closeModal = function() {
            document.getElementById('qr-modal').classList.add('hidden');
        }

        // Initialize display links
        document.getElementById('vless-link').innerText = getVlessLink().substring(0, 30) + '...';
        document.getElementById('trojan-link').innerText = getTrojanLink().substring(0, 30) + '...';
    </script>
</body>
</html>
  `;
}

// --- Trojan Handler ---
async function trojanOverWSHandler(request, env) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  let remoteSocket = null;
  let isConnecting = false;
  const log = (msg) => console.log(msg);

  server.addEventListener('message', async (event) => {
    try {
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(event.data);
        writer.releaseLock();
        return;
      }

      if (isConnecting) return;
      isConnecting = true;

      const buffer = event.data;
      if (buffer.byteLength < 56) {
          server.close();
          return;
      }

      const receivedHash = new TextDecoder().decode(buffer.slice(0, 56));
      const expectedHash = env.PASSWORD_HASH || trojanPasswordHash;

      if (receivedHash !== expectedHash) {
        log('invalid trojan password hash');
        server.close();
        return;
      }

      const view = new DataView(buffer);
      let offset = 56;
      if (view.getUint8(offset) !== 0x0D || view.getUint8(offset + 1) !== 0x0A) {
          server.close();
          return;
      }
      offset += 2;

      const command = view.getUint8(offset); offset += 1;
      const addressType = view.getUint8(offset); offset += 1;

      let address = '';
      if (addressType === 1) {
        address = new Uint8Array(buffer.slice(offset, offset + 4)).join('.');
        offset += 4;
      } else if (addressType === 2) {
        const len = view.getUint8(offset); offset += 1;
        address = new TextDecoder().decode(buffer.slice(offset, offset + len));
        offset += len;
      } else {
          log('unsupported address type');
          server.close();
          return;
      }

      const port = view.getUint16(offset); offset += 2;
      if (view.getUint8(offset) !== 0x0D || view.getUint8(offset + 1) !== 0x0A) {
          server.close();
          return;
      }
      offset += 2;

      log(`Trojan connecting to ${address}:${port}`);
      const tcpSocket = connect({ hostname: address, port: port });
      remoteSocket = tcpSocket;

      const remainingData = buffer.slice(offset);
      if (remainingData.byteLength > 0) {
        const writer = tcpSocket.writable.getWriter();
        await writer.write(remainingData);
        writer.releaseLock();
      }

      tcpSocket.readable.pipeTo(new WritableStream({
        write(chunk) { server.send(chunk); },
        close() { server.close(); },
        abort() { server.close(); }
      })).catch(err => {
          log('trojan pipe error', err);
          server.close();
      });

    } catch (err) {
      log('trojan handler error', err);
      server.close();
    }
  });

  server.addEventListener('close', () => {
      if (remoteSocket) remoteSocket.close();
  });

  return new Response(null, { status: 101, webSocket: client });
}

// --- VLESS Handler ---
async function vlessOverWSHandler(request, env) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();
  let remoteSocket = null;
  let isConnecting = false;
  const log = (msg) => console.log(msg);

  server.addEventListener('message', async (event) => {
    try {
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(event.data);
        writer.releaseLock();
        return;
      }

      if (isConnecting) return;
      isConnecting = true;

      const vlessBuffer = event.data;
      if (vlessBuffer.byteLength < 24) {
          server.close();
          return;
      }

      const version = new Uint8Array(vlessBuffer.slice(0, 1));
      const uuid = new Uint8Array(vlessBuffer.slice(1, 17));

      const expectedUUID = (env.UUID || userID).replace(/-/g, '');
      const receivedUUID = Array.from(uuid).map(b => b.toString(16).padStart(2, '0')).join('');

      if (receivedUUID !== expectedUUID) {
        log('invalid vless uuid');
        server.close();
        return;
      }

      const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
      const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 19 + optLength))[0];
      const port = new DataView(vlessBuffer.slice(19 + optLength, 21 + optLength)).getUint16(0);
      const addressType = new Uint8Array(vlessBuffer.slice(21 + optLength, 22 + optLength))[0];

      let address = '';
      let addressEnd = 22 + optLength;
      if (addressType === 1) {
        address = new Uint8Array(vlessBuffer.slice(22 + optLength, 26 + optLength)).join('.');
        addressEnd = 26 + optLength;
      } else if (addressType === 2) {
        const domainLength = new Uint8Array(vlessBuffer.slice(22 + optLength, 23 + optLength))[0];
        address = new TextDecoder().decode(vlessBuffer.slice(23 + optLength, 23 + optLength + domainLength));
        addressEnd = 23 + optLength + domainLength;
      } else {
          log('unsupported address type');
          server.close();
          return;
      }

      log(`VLESS connecting to ${address}:${port}`);
      const tcpSocket = connect({ hostname: address, port: port });
      remoteSocket = tcpSocket;

      const responseHeader = new Uint8Array([version[0], 0]);
      server.send(responseHeader);

      const remainingData = vlessBuffer.slice(addressEnd);
      if (remainingData.byteLength > 0) {
        const writer = tcpSocket.writable.getWriter();
        await writer.write(remainingData);
        writer.releaseLock();
      }

      tcpSocket.readable.pipeTo(new WritableStream({
        write(chunk) { server.send(chunk); },
        close() { server.close(); },
        abort() { server.close(); }
      })).catch(err => {
          log('vless pipe error', err);
          server.close();
      });

    } catch (err) {
      log('vless handler error', err);
      server.close();
    }
  });

  server.addEventListener('close', () => {
      if (remoteSocket) remoteSocket.close();
  });

  return new Response(null, { status: 101, webSocket: client });
}
