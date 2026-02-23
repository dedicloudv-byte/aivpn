// AIVPN - Cloudflare Worker V2Ray Client Dashboard & Relay
// Supports VLESS & Trojan Management and Relaying

import { connect } from 'cloudflare:sockets';

// Default configuration if no env vars are set
const DEFAULT_UUID = '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a7a7a';
const DEFAULT_PASSWORD_HASH = '394205562d989938b29df95107e3ef74421b93f2183c5093153ee046';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgradeHeader = request.headers.get('Upgrade');

      // WebSocket Relay Logic
      if (upgradeHeader === 'websocket') {
        // Dynamic Relay Path: /relay/{host}/{port}/{protocol}/{remotePath}
        if (url.pathname.startsWith('/relay/')) {
          return await handleRelay(request, env);
        }

        // Direct Handlers (Single Account Mode)
        if (url.pathname === '/trojan') {
          return await trojanOverWSHandler(request, env);
        } else {
          return await vlessOverWSHandler(request, env);
        }
      }

      // API Endpoints
      if (url.pathname === '/api/test' && request.method === 'POST') {
        return await handleTestConnection(request);
      }

      if (url.pathname === '/api/sub' && url.searchParams.has('url')) {
        return await handleFetchSubscription(url.searchParams.get('url'));
      }

      // Serve Dashboard
      return new Response(generateDashboard(request, env), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};

// --- API Handlers ---

async function handleTestConnection(request) {
  const { host, port } = await request.json();
  const start = Date.now();
  try {
    const socket = connect({ hostname: host, port: parseInt(port) });
    await socket.opened;
    const latency = Date.now() - start;
    socket.close();
    return new Response(JSON.stringify({ success: true, latency }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleFetchSubscription(subUrl) {
  try {
    const response = await fetch(subUrl, {
      headers: { 'User-Agent': 'v2rayNG/1.8.5' }
    });
    const text = await response.text();
    let decoded = text;
    try {
      if (!text.includes('://')) {
          decoded = atob(text.trim());
      }
    } catch (e) {}
    return new Response(decoded, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  } catch (err) {
    return new Response('Error fetching subscription', { status: 500 });
  }
}

// --- Relay Handler ---
async function handleRelay(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // /relay/host/port/protocol/...
  if (parts.length < 4) return new Response('Invalid relay path', { status: 400 });

  const targetHost = parts[1];
  const targetPort = parseInt(parts[2]);

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  let remoteSocket = null;
  const log = (msg) => console.log(msg);

  server.addEventListener('message', async (event) => {
    try {
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(event.data);
        writer.releaseLock();
        return;
      }

      log(`Relaying to ${targetHost}:${targetPort}`);
      const tcpSocket = connect({ hostname: targetHost, port: targetPort });
      remoteSocket = tcpSocket;

      const writer = tcpSocket.writable.getWriter();
      await writer.write(event.data);
      writer.releaseLock();

      tcpSocket.readable.pipeTo(new WritableStream({
        write(chunk) { server.send(chunk); },
        close() { server.close(); },
        abort() { server.close(); }
      })).catch(err => {
        log('relay pipe error', err);
        server.close();
      });

    } catch (err) {
      log('relay handler error', err);
      server.close();
    }
  });

  server.addEventListener('close', () => {
    if (remoteSocket) remoteSocket.close();
  });

  return new Response(null, { status: 101, webSocket: client });
}

// --- Protocol Handlers (Direct) ---

async function trojanOverWSHandler(request, env) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();
  let remoteSocket = null;
  server.addEventListener('message', async (event) => {
    try {
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(event.data);
        writer.releaseLock();
        return;
      }
      const buffer = event.data;
      if (buffer.byteLength < 56) return;
      const receivedHash = new TextDecoder().decode(buffer.slice(0, 56));
      const expectedHash = env.PASSWORD_HASH || DEFAULT_PASSWORD_HASH;
      if (receivedHash !== expectedHash) { server.close(); return; }

      const view = new DataView(buffer);
      let offset = 58;
      const addressType = view.getUint8(offset + 1);
      offset += 2;

      let address = '';
      if (addressType === 1) { address = new Uint8Array(buffer.slice(offset, offset + 4)).join('.'); offset += 4; }
      else if (addressType === 2) { const len = view.getUint8(offset); offset += 1; address = new TextDecoder().decode(buffer.slice(offset, offset + len)); offset += len; }
      const port = view.getUint16(offset); offset += 2;
      offset += 2;

      const tcpSocket = connect({ hostname: address, port: port });
      remoteSocket = tcpSocket;
      const writer = tcpSocket.writable.getWriter();
      await writer.write(buffer.slice(offset));
      writer.releaseLock();
      tcpSocket.readable.pipeTo(new WritableStream({ write(c) { server.send(c); }, close() { server.close(); }, abort() { server.close(); } }));
    } catch (e) { server.close(); }
  });
  return new Response(null, { status: 101, webSocket: client });
}

async function vlessOverWSHandler(request, env) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();
  let remoteSocket = null;
  server.addEventListener('message', async (event) => {
    try {
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(event.data);
        writer.releaseLock();
        return;
      }
      const buffer = event.data;
      if (buffer.byteLength < 24) return;
      const version = new Uint8Array(buffer.slice(0, 1));
      const uuid = new Uint8Array(buffer.slice(1, 17));
      const expectedUUID = (env.UUID || DEFAULT_UUID).replace(/-/g, '');
      const receivedUUID = Array.from(uuid).map(b => b.toString(16).padStart(2, '0')).join('');
      if (receivedUUID !== expectedUUID) { server.close(); return; }

      const optLength = new Uint8Array(buffer.slice(17, 18))[0];
      const port = new DataView(buffer.slice(19 + optLength, 21 + optLength)).getUint16(0);
      const addressType = new Uint8Array(buffer.slice(21 + optLength, 22 + optLength))[0];

      let address = '';
      let addressEnd = 22 + optLength;
      if (addressType === 1) { address = new Uint8Array(buffer.slice(22 + optLength, 26 + optLength)).join('.'); addressEnd = 26 + optLength; }
      else if (addressType === 2) { const len = new Uint8Array(buffer.slice(22 + optLength, 23 + optLength))[0]; address = new TextDecoder().decode(buffer.slice(23 + optLength, 23 + optLength + len)); addressEnd = 23 + optLength + len; }

      const tcpSocket = connect({ hostname: address, port: port });
      remoteSocket = tcpSocket;
      server.send(new Uint8Array([version[0], 0]));
      const writer = tcpSocket.writable.getWriter();
      await writer.write(buffer.slice(addressEnd));
      writer.releaseLock();
      tcpSocket.readable.pipeTo(new WritableStream({ write(c) { server.send(c); }, close() { server.close(); }, abort() { server.close(); } }));
    } catch (e) { server.close(); }
  });
  return new Response(null, { status: 101, webSocket: client });
}

// --- Dashboard UI ---

function generateDashboard(request, env) {
  const host = request.headers.get('Host') || 'aivpn.example.com';

  return `
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AIVPN Client Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #020617; color: #f8fafc; }
        .glass { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(51, 65, 85, 0.5); }
        .sidebar-item.active { background: rgba(56, 189, 248, 0.1); border-left: 4px solid #38bdf8; color: #38bdf8; }
        .card { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
        .card:hover { transform: translateY(-4px); border-color: rgba(56, 189, 248, 0.4); box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1); }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 10px; }
        .hidden { display: none !important; }
    </style>
</head>
<body class="flex min-h-screen">
    <!-- Sidebar -->
    <aside class="w-64 glass border-r border-slate-800 flex-col hidden md:flex">
        <div class="p-6">
            <div class="flex items-center space-x-3 mb-10">
                <div class="bg-sky-500 p-2 rounded-xl shadow-lg shadow-sky-500/20">
                    <i class="fas fa-shield-halved text-white text-xl"></i>
                </div>
                <span class="text-2xl font-bold tracking-tight">AI<span class="text-sky-400">VPN</span></span>
            </div>
            <nav class="space-y-2">
                <a href="#" onclick="showSection('servers')" class="sidebar-item flex items-center space-x-3 p-3 rounded-lg hover:bg-slate-800/50 transition-all active" id="nav-servers">
                    <i class="fas fa-server w-5"></i>
                    <span class="font-medium">Configs</span>
                </a>
                <a href="#" onclick="showSection('subscriptions')" class="sidebar-item flex items-center space-x-3 p-3 rounded-lg hover:bg-slate-800/50 transition-all" id="nav-subscriptions">
                    <i class="fas fa-rss w-5"></i>
                    <span class="font-medium">Subscriptions</span>
                </a>
                <a href="#" onclick="showSection('tools')" class="sidebar-item flex items-center space-x-3 p-3 rounded-lg hover:bg-slate-800/50 transition-all" id="nav-tools">
                    <i class="fas fa-tools w-5"></i>
                    <span class="font-medium">Tools</span>
                </a>
            </nav>
        </div>
        <div class="mt-auto p-6 border-t border-slate-800">
            <div class="flex items-center space-x-3">
                <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                <span class="text-xs text-slate-400 font-medium">Cloudflare Worker Active</span>
            </div>
        </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 overflow-y-auto p-4 md:p-10">
        <header class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-bold mb-1" id="section-title">Servers</h1>
                <p class="text-slate-400" id="section-desc">Manage your VLESS and Trojan accounts</p>
            </div>
            <div class="flex space-x-3">
                <button onclick="openModal('import')" class="bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-lg font-semibold flex items-center shadow-lg shadow-sky-600/20 transition-all">
                    <i class="fas fa-plus mr-2 text-sm"></i> Add Server
                </button>
            </div>
        </header>

        <section id="section-servers" class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        </section>

        <section id="section-subscriptions" class="hidden space-y-6">
            <div class="card glass p-6 rounded-2xl">
                <h3 class="text-xl font-bold mb-4">Subscription URLs</h3>
                <div class="flex space-x-3 mb-6">
                    <input type="text" id="sub-url-input" placeholder="https://example.com/sub/..." class="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 focus:outline-none focus:border-sky-500 transition-all text-white">
                    <button onclick="addSubscription()" class="bg-slate-700 hover:bg-slate-600 px-6 py-2 rounded-lg font-semibold transition-all">Add</button>
                </div>
                <div id="sub-list" class="space-y-4">
                </div>
            </div>
        </section>

        <section id="section-tools" class="hidden">
            <div class="card glass p-6 rounded-2xl max-w-2xl">
                <h3 class="text-xl font-bold mb-4">Worker Information</h3>
                <div class="space-y-4 text-sm text-slate-300">
                    <div class="flex justify-between border-b border-slate-800 pb-2">
                        <span>Worker Host</span>
                        <span class="font-mono text-sky-400">${host}</span>
                    </div>
                    <div class="flex justify-between border-b border-slate-800 pb-2">
                        <span>Relay Path</span>
                        <span class="font-mono">/relay/{host}/{port}/{protocol}/{path}</span>
                    </div>
                    <div class="pt-4">
                        <button onclick="clearAllData()" class="text-rose-400 hover:text-rose-300 transition-all font-bold">
                            <i class="fas fa-trash-can mr-2"></i> Clear All Saved Data
                        </button>
                    </div>
                </div>
            </div>
        </section>
    </main>

    <!-- Modals -->
    <div id="import-modal" class="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center hidden z-50 p-4">
        <div class="glass w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl">
            <div class="p-6 border-b border-slate-800 flex justify-between items-center">
                <h3 class="text-xl font-bold">Add New Server</h3>
                <button onclick="closeModal('import')" class="text-slate-400 hover:text-white"><i class="fas fa-times"></i></button>
            </div>
            <div class="p-6 space-y-4">
                <textarea id="import-link" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-4 h-32 focus:outline-none focus:border-sky-500 transition-all font-mono text-sm text-white" placeholder="vless://... or trojan://..."></textarea>
                <button onclick="processImport()" class="w-full bg-sky-600 hover:bg-sky-500 py-3 rounded-xl font-bold shadow-lg shadow-sky-600/20 transition-all">Import Server</button>
            </div>
        </div>
    </div>

    <div id="qr-modal" class="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center hidden z-50 p-4">
        <div class="glass w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl p-6 text-center">
            <div class="flex justify-between items-center mb-6">
                <h3 class="text-xl font-bold" id="qr-title">Relay Config</h3>
                <button onclick="closeModal('qr')" class="text-slate-400 hover:text-white"><i class="fas fa-times"></i></button>
            </div>
            <div id="qrcode" class="bg-white p-4 rounded-2xl inline-block mx-auto mb-6"></div>
            <p class="text-[10px] text-slate-400 break-all bg-slate-900 p-3 rounded-lg mb-6 font-mono" id="qr-link-text"></p>
            <div class="flex space-x-3">
                <button onclick="copyQRLink()" class="flex-1 bg-slate-800 hover:bg-slate-700 py-2 rounded-lg font-semibold transition-all">Copy</button>
                <button onclick="closeModal('qr')" class="flex-1 bg-sky-600 hover:bg-sky-500 py-2 rounded-lg font-semibold transition-all">Done</button>
            </div>
        </div>
    </div>

    <script>
        let servers = JSON.parse(localStorage.getItem('aivpn_servers') || '[]');
        let subscriptions = JSON.parse(localStorage.getItem('aivpn_subs') || '[]');
        const workerHost = "${host}";

        function saveServers() { localStorage.setItem('aivpn_servers', JSON.stringify(servers)); renderServers(); }
        function saveSubs() { localStorage.setItem('aivpn_subs', JSON.stringify(subscriptions)); renderSubs(); }

        function showSection(section) {
            ['servers', 'subscriptions', 'tools'].forEach(s => {
                document.getElementById('section-' + s).classList.add('hidden');
                document.getElementById('nav-' + s).classList.remove('active');
            });
            document.getElementById('section-' + section).classList.remove('hidden');
            document.getElementById('nav-' + section).classList.add('active');
            const titles = { servers: 'Servers', subscriptions: 'Subscriptions', tools: 'Tools' };
            const descs = { servers: 'Manage your accounts', subscriptions: 'Automated feeds', tools: 'App info' };
            document.getElementById('section-title').innerText = titles[section];
            document.getElementById('section-desc').innerText = descs[section];
        }

        function openModal(id) { document.getElementById(id + '-modal').classList.remove('hidden'); }
        function closeModal(id) { document.getElementById(id + '-modal').classList.add('hidden'); }

        function parseConfig(link) {
            try {
                const protocol = link.split('://')[0];
                const rest = link.split('://')[1];
                const [creds, queryAndHash] = rest.split('@');
                const [hostPort, queryPart] = (queryAndHash || '').split('?');
                const [host, port] = (hostPort || '').split(':');
                const [query, hash] = (queryPart || '').split('#');
                const params = new URLSearchParams(query || '');
                return {
                    id: Math.random().toString(36).substr(2, 9),
                    alias: decodeURIComponent(hash || 'Server'),
                    protocol, uuid: creds, host, port,
                    path: params.get('path') || '/',
                    type: params.get('type') || 'ws',
                    latency: null
                };
            } catch (e) { return null; }
        }

        function processImport() {
            const val = document.getElementById('import-link').value.trim();
            if (!val) return;
            val.split('\\n').forEach(line => {
                const config = parseConfig(line.trim());
                if (config) servers.push(config);
            });
            saveServers(); closeModal('import');
            document.getElementById('import-link').value = '';
        }

        async function testLatency(id) {
            const s = servers.find(x => x.id === id);
            if (!s) return;
            s.latency = '...'; renderServers();
            try {
                const res = await fetch('/api/test', { method: 'POST', body: JSON.stringify({ host: s.host, port: s.port }) });
                const data = await res.json();
                s.latency = data.success ? data.latency + 'ms' : 'Error';
            } catch (e) { s.latency = 'Timeout'; }
            saveServers();
        }

        function deleteServer(id) { servers = servers.filter(s => s.id !== id); saveServers(); }

        function getRelayLink(s) {
            const relayPath = \`/relay/\${s.host}/\${s.port}/\${s.protocol}\${s.path}\`;
            return \`\${s.protocol}://\${s.uuid}@\${workerHost}:443?encryption=none&security=tls&type=ws&host=\${workerHost}&sni=\${workerHost}&path=\${encodeURIComponent(relayPath)}#Relay-\${s.alias}\`;
        }

        function showQR(id) {
            const s = servers.find(x => x.id === id);
            const link = getRelayLink(s);
            document.getElementById('qr-title').innerText = s.alias;
            document.getElementById('qr-link-text').innerText = link;
            const q = document.getElementById('qrcode'); q.innerHTML = '';
            new QRCode(q, { text: link, width: 200, height: 200 });
            openModal('qr');
        }

        function copyQRLink() { navigator.clipboard.writeText(document.getElementById('qr-link-text').innerText); alert('Copied!'); }

        function renderServers() {
            const c = document.getElementById('section-servers');
            c.innerHTML = servers.length ? '' : '<div class="col-span-full text-center py-20 text-slate-500">No servers.</div>';
            servers.forEach(s => {
                const d = document.createElement('div');
                d.className = 'card glass p-5 rounded-2xl group relative';
                d.innerHTML = \`
                    <button onclick="deleteServer('\${s.id}')" class="absolute top-4 right-4 text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all"><i class="fas fa-trash-can"></i></button>
                    <div class="flex items-center space-x-3 mb-4">
                        <div class="w-10 h-10 rounded-xl flex items-center justify-center bg-sky-500/10 text-sky-400"><i class="fas fa-server"></i></div>
                        <div><h4 class="font-bold truncate w-32 text-slate-100">\${s.alias}</h4><p class="text-[10px] text-slate-500 font-bold uppercase">\${s.protocol} · \${s.latency || '--'}</p></div>
                    </div>
                    <div class="flex space-x-2">
                        <button onclick="testLatency('\${s.id}')" class="flex-1 bg-slate-800 hover:bg-slate-700 py-2 rounded-lg text-xs font-bold">Test</button>
                        <button onclick="showQR('\${s.id}')" class="flex-1 bg-sky-600 hover:bg-sky-500 py-2 rounded-lg text-xs font-bold">Relay</button>
                    </div>
                \`;
                c.appendChild(d);
            });
        }

        async function addSubscription() {
            const url = document.getElementById('sub-url-input').value.trim();
            if(!url) return;
            try {
                const res = await fetch(\`/api/sub?url=\${encodeURIComponent(url)}\`);
                const text = await res.text();
                text.split('\\n').forEach(l => { const c = parseConfig(l.trim()); if(c) servers.push(c); });
                saveServers(); document.getElementById('sub-url-input').value = ''; showSection('servers');
            } catch(e) { alert('Error'); }
        }

        function renderSubs() {}
        function clearAllData() { if(confirm('Clear?')) { localStorage.clear(); location.reload(); } }
        renderServers();
    </script>
</body>
</html>
  `;
}
