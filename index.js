// AIVPN - Cloudflare Worker V2Ray Client Dashboard & Relay
// v2.5.1 - Added Auto-UUID Generation in Config Generator

import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgradeHeader = request.headers.get('Upgrade');

      if (upgradeHeader === 'websocket') {
        return await handleWebSocket(request, env);
      }

      if (url.pathname === '/api/myip') {
        const clientIP = request.headers.get('CF-Connecting-IP') || 'Unknown';
        return new Response(JSON.stringify({ ip: clientIP }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url.pathname === '/api/test' && request.method === 'POST') {
        return await handleTestConnection(request);
      }

      if (url.pathname === '/api/sub' && url.searchParams.has('url')) {
        return await handleFetchSubscription(request);
      }

      return new Response(generateDashboard(request), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    } catch (err) {
      console.error('Worker Error:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

async function handleTestConnection(request) {
  let socket;
  try {
    const { host, port } = await request.json();
    if (!host || isNaN(port)) throw new Error('Invalid host or port');

    socket = connect({ hostname: host, port: parseInt(port) });
    const start = Date.now();

    await Promise.race([
      socket.opened,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000))
    ]);

    const latency = Date.now() - start;
    socket.close();
    return new Response(JSON.stringify({ success: true, latency }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    if (socket) try { socket.close(); } catch(e) {}
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleFetchSubscription(request) {
  const subUrl = new URL(request.url).searchParams.get('url');
  try {
    const response = await fetch(subUrl, {
      headers: { 'User-Agent': 'v2rayNG/1.8.5' }
    });
    let text = await response.text();
    try {
      if (!text.includes('://')) text = atob(text.trim());
    } catch (e) {}
    return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch (err) {
    return new Response('Error', { status: 500 });
  }
}

async function handleWebSocket(request, env) {
  const url = new URL(request.url);
  const nauticaMatch = url.pathname.match(/^\/([^\/]+)[:=-](\d+)$/);
  const isRelay = url.pathname.startsWith('/relay/') || nauticaMatch;

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  let tcpSocket = null;
  let remoteWriter = null;

  const closeAll = () => {
    try { if (remoteWriter) { remoteWriter.releaseLock(); remoteWriter = null; } } catch(e) {}
    try { if (tcpSocket) tcpSocket.close(); } catch(e) {}
    try { server.close(); } catch(e) {}
  };

  const wsStream = new ReadableStream({
    start(controller) {
      server.addEventListener('message', (event) => controller.enqueue(event.data));
      server.addEventListener('close', () => controller.close());
      server.addEventListener('error', () => controller.close());
    }
  });

  wsStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (tcpSocket) {
        if (!remoteWriter) remoteWriter = tcpSocket.writable.getWriter();
        await remoteWriter.write(chunk);
        return;
      }

      try {
        let host, port, payload;

        if (isRelay) {
          if (nauticaMatch) {
            host = nauticaMatch[1];
            port = parseInt(nauticaMatch[2]);
          } else {
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length < 2) throw new Error('Invalid relay path');
            host = parts[1];
            port = parseInt(parts[2] || (parts[1].includes(':') ? parts[1].split(':')[1] : '443'));
            if (host.includes(':')) host = host.split(':')[0];
          }
          payload = chunk;
        } else {
          const result = parseV2RayHeader(chunk, url.pathname === '/trojan');
          if (!result) return;
          host = result.host;
          port = result.port;
          payload = result.payload;
          if (url.pathname !== '/trojan') server.send(new Uint8Array([result.version, 0]));
        }

        if (!host || isNaN(port)) throw new Error('Target parse failed');

        tcpSocket = connect({ hostname: host, port: port });
        remoteWriter = tcpSocket.writable.getWriter();
        await remoteWriter.write(payload);

        tcpSocket.readable.pipeTo(new WritableStream({
          write(c) { if (server.readyState === 1) server.send(c); },
          close() { closeAll(); },
          abort() { closeAll(); }
        })).catch(closeAll);

      } catch (err) {
        closeAll();
      }
    },
    close() { closeAll(); },
    abort() { closeAll(); }
  })).catch(closeAll);

  return new Response(null, { status: 101, webSocket: client });
}

function parseV2RayHeader(buffer, isTrojan) {
  if (buffer.byteLength < 24) return null;
  const view = new DataView(buffer);
  let host = '', port = 0, offset = 0, version = 0;

  try {
    if (isTrojan) {
      if (buffer.byteLength < 58) return null;
      const addrType = view.getUint8(59);
      offset = 60;
      if (addrType === 1) { host = new Uint8Array(buffer.slice(offset, offset + 4)).join('.'); offset += 4; }
      else if (addrType === 2) { const len = view.getUint8(offset); offset += 1; host = new TextDecoder().decode(buffer.slice(offset, offset + len)); offset += len; }
      else if (addrType === 3) { const ipv6 = []; for (let i = 0; i < 8; i++) ipv6.push(view.getUint16(offset + i * 2).toString(16)); host = ipv6.join(':'); offset += 16; }
      port = view.getUint16(offset);
      offset += 4;
    } else {
      version = view.getUint8(0);
      const optLen = view.getUint8(17);
      const addrType = view.getUint8(21 + optLen);
      port = view.getUint16(19 + optLen);
      offset = 22 + optLen;
      if (addrType === 1) { host = new Uint8Array(buffer.slice(offset, offset + 4)).join('.'); offset += 4; }
      else if (addrType === 2) { const len = view.getUint8(offset); offset += 1; host = new TextDecoder().decode(buffer.slice(offset, offset + len)); offset += len; }
      else if (addrType === 3) { const ipv6 = []; for (let i = 0; i < 8; i++) ipv6.push(view.getUint16(offset + i * 2).toString(16)); host = ipv6.join(':'); offset += 16; }
    }
    return { host, port, version, payload: buffer.slice(offset) };
  } catch (e) { return null; }
}

function generateDashboard(request) {
  const host = request.headers.get('Host') || 'aivpn.pro';
  return `
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AIVPN Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #020617; color: #f8fafc; }
        .glass { background: rgba(15, 23, 42, 0.8); backdrop-filter: blur(20px); border: 1px solid rgba(51, 65, 85, 0.4); }
        .sidebar-item.active { background: linear-gradient(90deg, rgba(56, 189, 248, 0.1) 0%, transparent 100%); border-left: 4px solid #38bdf8; color: #38bdf8; }
        .card { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
        .card:hover { border-color: #38bdf8; }
        .log-line { font-family: 'monospace'; font-size: 11px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
        .hidden { display: none !important; }
    </style>
</head>
<body class="flex min-h-screen overflow-hidden">
    <aside class="w-72 glass border-r border-slate-800 flex flex-col shrink-0">
        <div class="p-8">
            <div class="flex items-center space-x-3 mb-12">
                <div class="bg-sky-500 p-2.5 rounded-2xl shadow-lg shadow-sky-500/20"><i class="fas fa-shield-halved text-white text-xl"></i></div>
                <span class="text-2xl font-black tracking-tighter">AI<span class="text-sky-400">VPN</span></span>
            </div>
            <nav class="space-y-4">
                <button onclick="showSection('servers')" class="sidebar-item w-full flex items-center space-x-4 p-4 rounded-xl active" id="nav-servers"><i class="fas fa-server"></i><span class="font-bold">Configs</span></button>
                <button onclick="showSection('gen')" class="sidebar-item w-full flex items-center space-x-4 p-4 rounded-xl" id="nav-gen"><i class="fas fa-magic"></i><span class="font-bold">Generator</span></button>
                <button onclick="showSection('subs')" class="sidebar-item w-full flex items-center space-x-4 p-4 rounded-xl" id="nav-subs"><i class="fas fa-rss"></i><span class="font-bold">Subscriptions</span></button>
                <button onclick="showSection('logs')" class="sidebar-item w-full flex items-center space-x-4 p-4 rounded-xl" id="nav-logs"><i class="fas fa-terminal"></i><span class="font-bold">System Logs</span></button>
            </nav>
        </div>
        <div class="mt-auto p-6">
            <div class="glass p-5 rounded-2xl border-slate-700/50">
                <p class="text-[10px] font-black uppercase text-slate-500 mb-3">Network Identity</p>
                <p class="text-xs font-mono text-white truncate mb-1" id="client-ip-display">Detecting...</p>
                <button onclick="refreshIP()" class="w-full bg-slate-800 hover:bg-slate-700 py-2 rounded-lg text-[10px] font-black uppercase mt-2">Refresh</button>
            </div>
            <div class="mt-6 text-[9px] font-bold text-slate-600 text-center uppercase">AIVPN EDGE CORE v2.5.1</div>
        </div>
    </aside>

    <main class="flex-1 p-6 md:p-12 overflow-y-auto">
        <header class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-12 gap-6">
            <div><h1 class="text-4xl font-black tracking-tight mb-2" id="title">Servers</h1><p class="text-slate-400 font-medium" id="desc">Your private gateway to the global internet</p></div>
            <button onclick="openModal('import')" class="bg-sky-600 hover:bg-sky-500 px-8 py-4 rounded-2xl font-black shadow-xl shadow-sky-600/30 transition-all uppercase text-sm tracking-widest"><i class="fas fa-plus-circle mr-3"></i>Import</button>
        </header>

        <section id="section-servers" class="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-8"></section>

        <section id="section-gen" class="hidden max-w-5xl mx-auto">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-12">
                <div class="glass p-10 rounded-[3rem] space-y-8">
                    <h3 class="text-2xl font-black"><i class="fas fa-cog mr-4 text-sky-400"></i>Relay Settings</h3>
                    <div class="space-y-6">
                        <select id="gen-proto" oninput="updateGen()" class="w-full bg-slate-900 border border-slate-700 rounded-2xl px-6 py-4 text-white font-bold appearance-none">
                            <option value="vless">VLESS</option>
                            <option value="trojan">Trojan</option>
                        </select>
                        <input type="text" id="gen-host" oninput="updateGen()" class="w-full bg-slate-900 border border-slate-700 rounded-2xl px-6 py-4 text-white font-mono" placeholder="Proxy Host (e.g. sg1.node.com)">
                        <input type="number" id="gen-port" oninput="updateGen()" class="w-full bg-slate-900 border border-slate-700 rounded-2xl px-6 py-4 text-white font-mono" placeholder="443" value="443">
                        <div class="flex gap-2">
                            <input type="text" id="gen-uuid" oninput="updateGen()" class="flex-1 bg-slate-900 border border-slate-700 rounded-2xl px-6 py-4 text-white font-mono text-xs" placeholder="UUID / Password">
                            <button onclick="regenUUID()" class="bg-slate-800 hover:bg-slate-700 px-4 rounded-2xl text-sky-400 transition-all"><i class="fas fa-sync-alt"></i></button>
                        </div>
                    </div>
                </div>
                <div class="glass p-10 rounded-[3rem] flex flex-col items-center justify-center">
                    <div id="gen-qrcode" class="bg-white p-6 rounded-[2.5rem] mb-8"></div>
                    <div id="gen-link" class="bg-slate-950/50 p-4 rounded-xl border border-slate-800 text-[10px] font-mono text-slate-400 break-all mb-4 h-20 overflow-y-auto">Enter host...</div>
                    <button onclick="copyGenLink()" class="w-full bg-sky-600 hover:bg-sky-500 py-4 rounded-2xl font-black uppercase tracking-widest text-sm">Copy Link</button>
                </div>
            </div>
        </section>

        <section id="section-subs" class="hidden space-y-8 max-w-4xl">
            <div class="glass p-8 rounded-[2rem]">
                <div class="flex gap-4"><input type="text" id="sub-input" class="flex-1 bg-slate-900 border border-slate-700 rounded-2xl px-6 py-4 text-white" placeholder="https://subscription-url.com"><button onclick="addSubscription()" class="bg-slate-700 hover:bg-slate-600 px-10 py-4 rounded-2xl font-black uppercase">Load</button></div>
            </div>
            <div id="sub-list" class="space-y-4"></div>
        </section>

        <section id="section-logs" class="hidden">
            <div class="glass rounded-[2rem] overflow-hidden flex flex-col h-[60vh]">
                <div id="log-container" class="flex-1 p-8 overflow-y-auto bg-slate-950/20"></div>
                <button onclick="clearLogs()" class="p-4 bg-slate-900/60 text-[10px] font-black uppercase text-slate-500 hover:text-white">Clear Logs</button>
            </div>
        </section>
    </main>

    <div id="import-modal" class="fixed inset-0 bg-slate-950/95 backdrop-blur-xl flex items-center justify-center hidden z-50 p-6">
        <div class="glass w-full max-w-2xl rounded-[2.5rem] p-10">
            <div class="flex justify-between items-center mb-8"><h3 class="text-3xl font-black">Import Config</h3><button onclick="closeModal('import')"><i class="fas fa-times text-xl"></i></button></div>
            <textarea id="import-text" class="w-full h-80 bg-slate-900 border border-slate-700 rounded-3xl p-8 mb-8 text-xs text-white" placeholder="vless://..."></textarea>
            <button onclick="doImport()" class="w-full bg-sky-600 py-5 rounded-2xl font-black uppercase">Process</button>
        </div>
    </div>

    <div id="qr-modal" class="fixed inset-0 bg-slate-950/95 backdrop-blur-xl flex items-center justify-center hidden z-50 p-6">
        <div class="glass w-full max-w-md rounded-[3rem] p-12 text-center">
            <h3 class="text-2xl font-black mb-10" id="qr-name">Config</h3>
            <div id="qrcode" class="bg-white p-8 rounded-[2rem] inline-block mb-10"></div>
            <div id="qr-link" class="bg-slate-900/60 p-5 rounded-2xl mb-10 break-all font-mono text-[9px] text-slate-500 border border-slate-800 uppercase tracking-tight"></div>
            <div class="flex gap-4">
                <button onclick="copyLink()" class="flex-1 bg-slate-800 py-4 rounded-2xl font-black uppercase text-xs">Copy</button>
                <button onclick="closeModal('qr')" class="flex-1 bg-sky-600 py-4 rounded-2xl font-black uppercase text-xs">Done</button>
            </div>
        </div>
    </div>

    <script>
        let servers = JSON.parse(localStorage.getItem('aivpn_srv_v5') || '[]');
        let subs = JSON.parse(localStorage.getItem('aivpn_sub_v5') || '[]');
        let activeId = localStorage.getItem('aivpn_act_v5');
        const workerHost = "${host}";

        function addLog(msg, type = 'info') {
            const container = document.getElementById('log-container');
            const time = new Date().toLocaleTimeString([], { hour12: false });
            const line = document.createElement('div');
            line.className = 'log-line';
            line.innerHTML = \`[\${time}] <span class="uppercase font-black mr-2 text-[9px] \${type === 'error' ? 'text-rose-500' : 'text-sky-500'}">[\${type}]</span> \${msg}\`;
            container.appendChild(line);
            container.scrollTop = container.scrollHeight;
        }

        function clearLogs() { document.getElementById('log-container').innerHTML = ''; }

        function showSection(s) {
            ['servers', 'gen', 'subs', 'logs'].forEach(x => {
                document.getElementById('section-'+x).classList.add('hidden');
                document.getElementById('nav-'+x).classList.remove('active');
            });
            document.getElementById('section-'+s).classList.remove('hidden');
            document.getElementById('nav-'+s).classList.add('active');
            const titles = { servers: 'Servers', gen: 'Generator', subs: 'Subscriptions', logs: 'Live Console' };
            const descs = { servers: 'Your private gateway to the global internet', gen: 'Quickly generate relay configurations', subs: 'Manage your remote config feeds', logs: 'Real-time monitoring' };
            document.getElementById('title').innerText = titles[s];
            document.getElementById('desc').innerText = descs[s];
        }

        function updateGen() {
            const proto = document.getElementById('gen-proto').value;
            const host = document.getElementById('gen-host').value.trim();
            const port = document.getElementById('gen-port').value || '443';
            const uuidField = document.getElementById('gen-uuid');
            const display = document.getElementById('gen-link');
            const qrContainer = document.getElementById('gen-qrcode');

            if (!uuidField.value) regenUUID();
            const uuid = uuidField.value;

            if (!host) {
                display.innerText = 'Enter host...';
                qrContainer.innerHTML = '';
                return;
            }

            const path = encodeURIComponent('/' + host + ':' + port);
            const link = \`\${proto}://\${uuid}@\${workerHost}:443?security=tls&type=ws&host=\${workerHost}&sni=\${workerHost}&path=\${path}#AIVPN-Relay\`;

            display.innerText = link;
            qrContainer.innerHTML = '';
            new QRCode(qrContainer, { text: link, width: 200, height: 200 });
        }

        function regenUUID() {
            const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
            document.getElementById('gen-uuid').value = uuid;
            updateGen();
        }

        function copyGenLink() { navigator.clipboard.writeText(document.getElementById('gen-link').innerText); addLog('Link copied', 'success'); }
        function openModal(m) { document.getElementById(m+'-modal').classList.remove('hidden'); }
        function closeModal(m) { document.getElementById(m+'-modal').classList.add('hidden'); }

        async function refreshIP() {
            const display = document.getElementById('client-ip-display');
            display.innerText = 'Detecting...';
            try {
                const res = await fetch('/api/myip');
                const data = await res.json();
                display.innerText = data.ip;
                addLog(\`IP Identity verified: \${data.ip}\`, 'success');
            } catch (e) { display.innerText = 'Error'; }
        }

        function parse(l) {
            try {
                if (!l.includes('://')) return null;
                const protocol = l.split('://')[0];
                const parts = l.split('://')[1];
                let creds = '', hpq = '', host = '', port = '', params = new URLSearchParams(), alias = 'Relay Node';
                if (parts.includes('@')) { [creds, hpq] = parts.split('@'); } else { hpq = parts; }
                if (hpq.includes('#')) { const [p, a] = hpq.split('#'); hpq = p; alias = decodeURIComponent(a); }
                if (hpq.includes('?')) { const [p, q] = hpq.split('?'); hpq = p; params = new URLSearchParams(q); }
                if (hpq.includes(':')) { [host, port] = hpq.split(':'); } else { host = hpq; port = protocol === 'trojan' ? '443' : '80'; }
                return { id: Math.random().toString(36).substr(2, 9), alias, protocol, uuid: creds, host, port, path: params.get('path') || '/', latency: null };
            } catch (e) { return null; }
        }

        function doImport() {
            const lines = document.getElementById('import-text').value.split('\\n');
            let count = 0;
            lines.forEach(l => { const c = parse(l.trim()); if(c) { servers.push(c); count++; } });
            if (count) { addLog(\`Imported \${count} config(s)\`, 'success'); save(); closeModal('import'); render(); }
        }

        async function addSubscription() {
            const url = document.getElementById('sub-input').value.trim();
            if(!url) return;
            addLog(\`Feed: \${url}\`);
            try {
                const res = await fetch(\`/api/sub?url=\${encodeURIComponent(url)}\`);
                const text = await res.text();
                let count = 0;
                text.split('\\n').forEach(l => { const c = parse(l.trim()); if(c) { servers.push(c); count++; } });
                if(!subs.includes(url)) subs.push(url);
                addLog(\`Success: \${count} servers loaded\`, 'success');
                save(); saveSubs(); render();
                document.getElementById('sub-input').value = '';
            } catch (e) { addLog(\`Error: \${e.message}\`, 'error'); }
        }

        function render() {
            const c = document.getElementById('section-servers');
            c.innerHTML = servers.length ? '' : '<div class="col-span-full py-32 text-center text-slate-700 border-4 border-dashed border-slate-800/40 rounded-[3rem] font-bold">No accounts found.</div>';
            servers.forEach(s => {
                const isConn = s.id === activeId;
                const d = document.createElement('div');
                d.className = \`card glass p-8 rounded-[2.5rem] relative group \${isConn ? 'border-sky-500/50 bg-sky-500/[0.03]' : ''}\`;
                d.innerHTML = \`
                    <button onclick="del('\${s.id}')" class="absolute top-8 right-8 text-slate-700 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"><i class="fas fa-trash-alt"></i></button>
                    <div class="flex items-center space-x-6 mb-10">
                        <div class="w-16 h-16 rounded-[1.5rem] flex items-center justify-center \${s.protocol === 'vless' ? 'bg-sky-500' : 'bg-indigo-600'} text-white shadow-xl font-black text-xl">\${s.protocol[0].toUpperCase()}</div>
                        <div class="overflow-hidden">
                            <h4 class="font-black text-2xl truncate text-white mb-2">\${s.alias}</h4>
                            <span class="text-xs font-black \${s.latency === 'Error' ? 'text-rose-500' : 'text-emerald-400'}">\${s.latency || 'Pending'}</span>
                        </div>
                    </div>
                    <div class="flex gap-4">
                        <button onclick="conn('\${s.id}')" class="flex-[3] \${isConn ? 'bg-emerald-600' : 'bg-sky-600'} hover:opacity-90 py-4 rounded-2xl font-black text-sm shadow-xl uppercase">\${isConn ? 'CONNECTED' : 'CONNECT'}</button>
                        <button onclick="qr('\${s.id}')" class="flex-1 bg-slate-800 hover:bg-slate-700 py-4 rounded-2xl text-xl"><i class="fas fa-qrcode"></i></button>
                    </div>
                \`;
                c.appendChild(d);
            });
        }

        async function ping(id) {
            const s = servers.find(x => x.id === id); if(!s) return;
            try {
                const res = await fetch('/api/test', { method: 'POST', body: JSON.stringify({ host: s.host, port: s.port }) });
                const data = await res.json();
                s.latency = data.success ? data.latency + 'ms' : 'Error';
            } catch (e) { s.latency = 'Error'; }
            render();
        }

        async function conn(id) {
            const s = servers.find(x => x.id === id); if(!s) return;
            addLog(\`Handshaking \${s.host}...\`);
            activeId = id; localStorage.setItem('aivpn_act_v5', id);
            s.latency = 'Testing...'; render();
            try {
                const res = await fetch('/api/test', { method: 'POST', body: JSON.stringify({ host: s.host, port: s.port }) });
                const data = await res.json();
                if(data.success) {
                    addLog(\`Handshake verified in \${data.latency}ms\`, 'success');
                    await refreshIP();
                } else { addLog(\`Handshake Failed\`, 'error'); activeId = null; }
            } catch (e) { addLog(\`Error\`, 'error'); activeId = null; }
            render(); save();
        }

        function qr(id) {
            const s = servers.find(x => x.id === id);
            const link = \`\${s.protocol}://\${s.uuid}@\${workerHost}:443?security=tls&type=ws&host=\${workerHost}&sni=\${workerHost}&path=\${encodeURIComponent('/relay/'+s.host+'/'+s.port)}#AIVPN-\${s.alias}\`;
            document.getElementById('qr-name').innerText = s.alias;
            document.getElementById('qr-link').innerText = link;
            const q = document.getElementById('qrcode'); q.innerHTML = '';
            new QRCode(q, { text: link, width: 250, height: 250 });
            openModal('qr');
        }

        function copyLink() { navigator.clipboard.writeText(document.getElementById('qr-link').innerText); addLog('Copied', 'success'); }
        function save() { localStorage.setItem('aivpn_srv_v5', JSON.stringify(servers)); }
        function saveSubs() { localStorage.setItem('aivpn_sub_v5', JSON.stringify(subs)); renderSubs(); }
        function del(id) { servers = servers.filter(x => x.id !== id); if(activeId === id) activeId = null; save(); render(); }
        function renderSubs() {
            const c = document.getElementById('sub-list');
            c.innerHTML = '';
            subs.forEach(u => {
                const d = document.createElement('div');
                d.className = 'glass p-6 rounded-3xl flex justify-between items-center border-l-8 border-slate-700';
                d.innerHTML = \`<span class="text-sm truncate font-bold text-slate-400 mr-8">\${u}</span><button onclick="delSub('\${u}')" class="text-slate-600 hover:text-rose-500"><i class="fas fa-trash-alt text-xl"></i></button>\`;
                c.appendChild(d);
            });
        }
        function delSub(u) { subs = subs.filter(x => x !== u); saveSubs(); }

        refreshIP();
        addLog('AIVPN Engine v2.5.1 started.', 'success');
        render(); renderSubs();

        (async () => {
            for (let s of servers) {
                await ping(s.id);
                await new Promise(r => setTimeout(r, 200));
            }
        })();
    </script>
</body>
</html>
  `;
}
