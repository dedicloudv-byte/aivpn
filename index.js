// AIVPN - Cloudflare Worker V2Ray Client Dashboard & Relay
// v2.2.0 - Robust Parsing, Connect/Log Buttons, System Logs

import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgradeHeader = request.headers.get('Upgrade');

      if (upgradeHeader === 'websocket') {
        if (url.pathname.startsWith('/relay/')) {
          return await handleRelay(request);
        }
        return await handleDirect(request, env);
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
      return new Response(err.stack || err.toString(), { status: 500 });
    }
  }
};

async function handleTestConnection(request) {
  try {
    const { host, port } = await request.json();
    const socket = connect({ hostname: host, port: parseInt(port) });
    const start = Date.now();
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

async function handleFetchSubscription(request) {
  const subUrl = new URL(request.url).searchParams.get('url');
  try {
    const response = await fetch(subUrl, {
      headers: { 'User-Agent': 'v2rayNG/1.8.5' },
      cf: { cacheTtl: 600 }
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

async function handleRelay(request) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 3) return new Response('Invalid path', { status: 400 });

  const targetHost = parts[1];
  const targetPort = parseInt(parts[2]);

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  try {
    const tcpSocket = connect({ hostname: targetHost, port: targetPort });

    const wsToTcp = new ReadableStream({
      start(controller) {
        server.addEventListener('message', (event) => controller.enqueue(event.data));
        server.addEventListener('close', () => controller.close());
        server.addEventListener('error', (e) => controller.error(e));
      }
    }).pipeTo(tcpSocket.writable);

    const tcpToWs = tcpSocket.readable.pipeTo(new WritableStream({
      write(chunk) { if (server.readyState === 1) server.send(chunk); },
      close() { server.close(); },
      abort() { server.close(); }
    }));

    Promise.all([wsToTcp, tcpToWs]).catch(() => {
      server.close();
      tcpSocket.close();
    });

  } catch (err) {
    server.close();
  }

  return new Response(null, { status: 101, webSocket: client });
}

async function handleDirect(request, env) {
  const url = new URL(request.url);
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  server.addEventListener('message', async (event) => {
    try {
      const buffer = event.data;
      let address = '', port = 0, addressEnd = 0, version = 0;

      if (url.pathname === '/trojan') {
          if (buffer.byteLength < 58) return;
          const view = new DataView(buffer);
          const addressType = view.getUint8(59);
          let offset = 60;
          if (addressType === 1) { address = new Uint8Array(buffer.slice(offset, offset + 4)).join('.'); offset += 4; }
          else if (addressType === 2) { const len = view.getUint8(offset); offset += 1; address = new TextDecoder().decode(buffer.slice(offset, offset + len)); offset += len; }
          port = view.getUint16(offset);
          addressEnd = offset + 4;
      } else {
          if (buffer.byteLength < 24) return;
          version = new Uint8Array(buffer.slice(0, 1))[0];
          const optLength = new Uint8Array(buffer.slice(17, 18))[0];
          port = new DataView(buffer.slice(19 + optLength, 21 + optLength)).getUint16(0);
          const addressType = new Uint8Array(buffer.slice(21 + optLength, 22 + optLength))[0];
          addressEnd = 22 + optLength;
          if (addressType === 1) { address = new Uint8Array(buffer.slice(addressEnd, addressEnd + 4)).join('.'); addressEnd += 4; }
          else if (addressType === 2) { const len = new Uint8Array(buffer.slice(addressEnd, addressEnd + 1))[0]; addressEnd += 1; address = new TextDecoder().decode(buffer.slice(addressEnd, addressEnd + len)); addressEnd += len; }
      }

      const tcpSocket = connect({ hostname: address, port: port });
      if (url.pathname !== '/trojan') server.send(new Uint8Array([version, 0]));
      const writer = tcpSocket.writable.getWriter();
      await writer.write(buffer.slice(addressEnd));
      writer.releaseLock();

      tcpSocket.readable.pipeTo(new WritableStream({
        write(chunk) { if (server.readyState === 1) server.send(chunk); },
        close() { server.close(); },
        abort() { server.close(); }
      })).catch(() => {});

      new ReadableStream({
        start(controller) {
          server.addEventListener('message', (e) => controller.enqueue(e.data));
          server.addEventListener('close', () => controller.close());
        }
      }).pipeTo(tcpSocket.writable).catch(() => {});

    } catch (e) {
      server.close();
    }
  }, { once: true });

  return new Response(null, { status: 101, webSocket: client });
}

function generateDashboard(request) {
  const host = request.headers.get('Host') || 'aivpn.example.com';
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
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; background-color: #020617; color: #f8fafc; }
        .glass { background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(16px); border: 1px solid rgba(51, 65, 85, 0.4); }
        .sidebar-item.active { background: rgba(56, 189, 248, 0.15); border-left: 4px solid #38bdf8; color: #38bdf8; }
        .card { transition: all 0.2s ease-in-out; }
        .card:hover { transform: translateY(-2px); border-color: #38bdf8; }
        .log-line { font-family: 'monospace'; font-size: 11px; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .log-time { color: #64748b; margin-right: 10px; }
        .log-info { color: #38bdf8; }
        .log-success { color: #10b981; }
        .log-error { color: #f43f5e; }
        .hidden { display: none !important; }
    </style>
</head>
<body class="flex min-h-screen">
    <!-- Sidebar -->
    <aside class="w-64 glass border-r border-slate-800 flex flex-col hidden md:flex">
        <div class="p-8">
            <div class="flex items-center space-x-3 mb-12">
                <div class="bg-sky-500 p-2.5 rounded-2xl shadow-xl shadow-sky-500/20"><i class="fas fa-shield-halved text-white text-xl"></i></div>
                <span class="text-2xl font-black tracking-tighter">AI<span class="text-sky-400">VPN</span></span>
            </div>
            <nav class="space-y-3">
                <button onclick="showSection('servers')" class="sidebar-item w-full flex items-center space-x-4 p-3.5 rounded-xl transition-all active" id="nav-servers"><i class="fas fa-server"></i><span class="font-semibold">Servers</span></button>
                <button onclick="showSection('subs')" class="sidebar-item w-full flex items-center space-x-4 p-3.5 rounded-xl transition-all" id="nav-subs"><i class="fas fa-rss"></i><span class="font-semibold">Subscriptions</span></button>
                <button onclick="showSection('logs')" class="sidebar-item w-full flex items-center space-x-4 p-3.5 rounded-xl transition-all" id="nav-logs"><i class="fas fa-terminal"></i><span class="font-semibold">System Logs</span></button>
            </nav>
        </div>
        <div class="mt-auto p-8 border-t border-slate-800 text-[10px] font-bold text-slate-500 tracking-widest uppercase">AIVPN v2.2.0 Stable</div>
    </aside>

    <!-- Content -->
    <main class="flex-1 p-6 md:p-12 overflow-y-auto">
        <header class="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6">
            <div><h1 class="text-4xl font-extrabold tracking-tight mb-2" id="title">Servers</h1><p class="text-slate-400 font-medium" id="desc">Manage and monitor your proxy network</p></div>
            <button onclick="openModal('import')" class="bg-sky-600 hover:bg-sky-500 px-8 py-3.5 rounded-2xl font-bold shadow-2xl shadow-sky-600/30 transition-all flex items-center"><i class="fas fa-plus-circle mr-3"></i>Import Account</button>
        </header>

        <section id="section-servers" class="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-8"></section>

        <section id="section-subs" class="hidden max-w-4xl space-y-8">
            <div class="glass p-8 rounded-3xl">
                <h3 class="text-xl font-bold mb-6">Import Subscription</h3>
                <div class="flex gap-4"><input type="text" id="sub-input" class="flex-1 bg-slate-900/50 border border-slate-700 rounded-2xl px-6 py-3.5 focus:outline-none focus:border-sky-500 transition-all text-white" placeholder="Paste subscription URL here..."><button onclick="addSubscription()" class="bg-slate-700 hover:bg-slate-600 px-10 py-3.5 rounded-2xl font-bold transition-all">Load</button></div>
            </div>
            <div id="sub-list" class="space-y-4"></div>
        </section>

        <section id="section-logs" class="hidden">
            <div class="glass rounded-3xl overflow-hidden flex flex-col h-[65vh]">
                <div class="bg-slate-900/80 p-5 border-b border-slate-800 flex justify-between items-center">
                    <div class="flex items-center space-x-3"><div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div><span class="text-xs font-bold uppercase tracking-widest text-slate-400">Live Traffic Logs</span></div>
                    <button onclick="clearLogs()" class="text-[10px] font-black text-slate-500 hover:text-white uppercase">Clear Console</button>
                </div>
                <div id="log-container" class="flex-1 p-6 overflow-y-auto bg-slate-950/40 scrollbar-hide"></div>
            </div>
        </section>
    </main>

    <!-- Modals -->
    <div id="import-modal" class="fixed inset-0 bg-slate-950/90 backdrop-blur-md flex items-center justify-center hidden z-50 p-6">
        <div class="glass w-full max-w-2xl rounded-3xl p-8 shadow-2xl border-slate-700">
            <div class="flex justify-between items-center mb-8"><h3 class="text-2xl font-bold">Import Links</h3><button onclick="closeModal('import')" class="w-10 h-10 rounded-full hover:bg-slate-800 flex items-center justify-center"><i class="fas fa-times text-xl"></i></button></div>
            <textarea id="import-text" class="w-full h-64 bg-slate-900/50 border border-slate-700 rounded-2xl p-6 mb-6 focus:outline-none focus:border-sky-500 font-mono text-xs text-white leading-relaxed" placeholder="vless://...\\ntrojan://..."></textarea>
            <button onclick="doImport()" class="w-full bg-sky-600 hover:bg-sky-500 py-4 rounded-2xl font-black shadow-xl shadow-sky-600/30 transition-all uppercase tracking-widest">Add to Server List</button>
        </div>
    </div>

    <div id="qr-modal" class="fixed inset-0 bg-slate-950/90 backdrop-blur-md flex items-center justify-center hidden z-50 p-6">
        <div class="glass w-full max-w-md rounded-3xl p-10 text-center border-slate-700">
            <h3 class="text-2xl font-bold mb-8" id="qr-name">Configuration</h3>
            <div id="qrcode" class="bg-white p-6 rounded-3xl inline-block mb-8 shadow-2xl"></div>
            <div class="bg-slate-900/80 p-4 rounded-2xl mb-8 break-all font-mono text-[10px] text-slate-400 border border-slate-800" id="qr-link"></div>
            <div class="flex gap-4">
                <button onclick="copyLink()" class="flex-1 bg-slate-800 hover:bg-slate-700 py-3.5 rounded-2xl font-bold">Copy Link</button>
                <button onclick="closeModal('qr')" class="flex-1 bg-sky-600 hover:bg-sky-500 py-3.5 rounded-2xl font-bold">Dismiss</button>
            </div>
        </div>
    </div>

    <script>
        let servers = JSON.parse(localStorage.getItem('aivpn_servers_v3') || '[]');
        let subs = JSON.parse(localStorage.getItem('aivpn_subs_v3') || '[]');
        let activeId = localStorage.getItem('aivpn_active_id');
        const workerHost = "${host}";

        function addLog(msg, type = 'info') {
            const container = document.getElementById('log-container');
            const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const line = document.createElement('div');
            line.className = 'log-line';
            line.innerHTML = \`<span class="log-time">[\${time}]</span> <span class="log-\${type}">\${msg}</span>\`;
            container.appendChild(line);
            container.scrollTop = container.scrollHeight;
        }

        function clearLogs() { document.getElementById('log-container').innerHTML = ''; }

        function save() { localStorage.setItem('aivpn_servers_v3', JSON.stringify(servers)); render(); }
        function saveSubs() { localStorage.setItem('aivpn_subs_v3', JSON.stringify(subs)); renderSubs(); }

        function showSection(s) {
            ['servers', 'subs', 'logs'].forEach(x => {
                document.getElementById('section-'+x).classList.add('hidden');
                document.getElementById('nav-'+x).classList.remove('active');
            });
            document.getElementById('section-'+s).classList.remove('hidden');
            document.getElementById('nav-'+s).classList.add('active');
            const titles = { servers: 'Servers', subs: 'Subscriptions', logs: 'System Logs' };
            document.getElementById('title').innerText = titles[s];
        }

        function openModal(m) { document.getElementById(m+'-modal').classList.remove('hidden'); }
        function closeModal(m) { document.getElementById(m+'-modal').classList.add('hidden'); }

        function parse(l) {
            try {
                if (!l.includes('://')) return null;
                const protocol = l.split('://')[0];
                const parts = l.split('://')[1];
                let creds = '', hpq = '', host = '', port = '', params = new URLSearchParams(), alias = 'Server';

                if (parts.includes('@')) {
                    [creds, hpq] = parts.split('@');
                } else {
                    hpq = parts;
                }

                if (hpq.includes('#')) {
                    const [p, a] = hpq.split('#');
                    hpq = p;
                    alias = decodeURIComponent(a);
                }

                if (hpq.includes('?')) {
                    const [p, q] = hpq.split('?');
                    hpq = p;
                    params = new URLSearchParams(q);
                }

                if (hpq.includes(':')) {
                    [host, port] = hpq.split(':');
                } else {
                    host = hpq;
                    port = protocol === 'trojan' ? '443' : '80';
                }

                return {
                    id: Math.random().toString(36).substr(2, 9),
                    alias, protocol, uuid: creds, host, port,
                    path: params.get('path') || '/',
                    latency: null,
                    active: false
                };
            } catch (e) { return null; }
        }

        function doImport() {
            const lines = document.getElementById('import-text').value.split('\\n');
            let success = 0;
            lines.forEach(l => { const c = parse(l.trim()); if(c) { servers.push(c); success++; } });
            if (success) {
                addLog(\`Successfully imported \${success} accounts\`, 'success');
                save(); closeModal('import'); document.getElementById('import-text').value = '';
            } else {
                addLog('Import failed: No valid links found', 'error');
            }
        }

        async function addSubscription() {
            const url = document.getElementById('sub-input').value.trim();
            if(!url) return;
            addLog(\`Fetching subscription from \${url}\`);
            try {
                const res = await fetch(\`/api/sub?url=\${encodeURIComponent(url)}\`);
                const text = await res.text();
                let success = 0;
                text.split('\\n').forEach(l => { const c = parse(l.trim()); if(c) { servers.push(c); success++; } });
                if(!subs.includes(url)) subs.push(url);
                addLog(\`Subscription loaded: \${success} servers added\`, 'success');
                save(); saveSubs(); showSection('servers');
                document.getElementById('sub-input').value = '';
            } catch (e) {
                addLog(\`Subscription failure: \${e.message}\`, 'error');
            }
        }

        function render() {
            const c = document.getElementById('section-servers');
            c.innerHTML = servers.length ? '' : '<div class="col-span-full py-24 text-center text-slate-500 border-4 border-dashed border-slate-800/50 rounded-[2.5rem]"><i class="fas fa-satellite-dish text-5xl mb-6 block opacity-20"></i>No active configurations.</div>';
            servers.forEach(s => {
                const isConnected = s.id === activeId;
                const d = document.createElement('div');
                d.className = \`card glass p-7 rounded-[2.5rem] relative group \${isConnected ? 'border-sky-500/60 ring-2 ring-sky-500/20 bg-sky-500/5' : ''}\`;
                d.innerHTML = \`
                    <button onclick="del('\${s.id}')" class="absolute top-6 right-6 text-slate-600 hover:text-rose-500 transition-all opacity-0 group-hover:opacity-100"><i class="fas fa-trash-alt text-lg"></i></button>
                    <div class="flex items-center space-x-5 mb-8">
                        <div class="w-14 h-14 rounded-3xl flex items-center justify-center \${s.protocol === 'vless' ? 'bg-sky-500 text-white' : 'bg-indigo-600 text-white'} shadow-2xl font-black">\${s.protocol[0].toUpperCase()}</div>
                        <div class="overflow-hidden">
                            <h4 class="font-extrabold text-xl truncate tracking-tight text-white mb-1">\${s.alias}</h4>
                            <div class="flex items-center space-x-3">
                                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500 bg-slate-800 px-2 py-0.5 rounded-md">\${s.protocol}</span>
                                <span class="text-xs font-bold \${s.latency === 'Error' ? 'text-rose-500' : 'text-emerald-400'}">\${s.latency || 'Unchecked'}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-3">
                        <button onclick="conn('\${s.id}')" class="flex-[3] \${isConnected ? 'bg-emerald-600' : 'bg-sky-600'} hover:opacity-90 py-3.5 rounded-2xl font-black text-sm transition-all shadow-xl">\${isConnected ? 'CONNECTED' : 'CONNECT'}</button>
                        <button onclick="qr('\${s.id}')" class="flex-1 bg-slate-800 hover:bg-slate-700 py-3.5 rounded-2xl text-lg transition-all"><i class="fas fa-qrcode"></i></button>
                    </div>
                \`;
                c.appendChild(d);
            });
        }

        function renderSubs() {
            const c = document.getElementById('sub-list');
            c.innerHTML = '';
            subs.forEach(u => {
                const d = document.createElement('div');
                d.className = 'glass p-6 rounded-3xl flex justify-between items-center border-l-8 border-slate-700 hover:border-sky-500 transition-all';
                d.innerHTML = \`<span class="text-sm truncate font-bold text-slate-300 mr-8">\${u}</span><button onclick="delSub('\${u}')" class="text-slate-600 hover:text-rose-500 transition-all"><i class="fas fa-trash-alt text-xl"></i></button>\`;
                c.appendChild(d);
            });
        }

        async function conn(id) {
            const s = servers.find(x => x.id === id); if(!s) return;
            addLog(\`Connecting to \${s.alias} (\${s.host})...\`);
            activeId = id; localStorage.setItem('active_id', id); s.latency = 'Checking...'; render();
            try {
                const start = Date.now();
                const res = await fetch('/api/test', { method: 'POST', body: JSON.stringify({ host: s.host, port: s.port }) });
                const data = await res.json();
                if(data.success) {
                    s.latency = data.latency + 'ms';
                    addLog(\`Handshake established in \${s.latency}\`, 'success');
                    addLog(\`Tunnel active via \${workerHost}/relay/\${s.host}/\${s.port}\`, 'info');
                } else {
                    s.latency = 'Error';
                    addLog(\`Handshake failed: \${data.error}\`, 'error');
                }
            } catch (e) { s.latency = 'Error'; addLog(\`Timeout: Server unreachable\`, 'error'); }
            save();
        }

        function qr(id) {
            const s = servers.find(x => x.id === id);
            const link = \`\${s.protocol}://\${s.uuid}@\${workerHost}:443?security=tls&type=ws&host=\${workerHost}&sni=\${workerHost}&path=\${encodeURIComponent('/relay/'+s.host+'/'+s.port)}#AIVPN-\${s.alias}\`;
            document.getElementById('qr-name').innerText = s.alias;
            document.getElementById('qr-link').innerText = link;
            const q = document.getElementById('qrcode'); q.innerHTML = '';
            new QRCode(q, { text: link, width: 220, height: 220 });
            openModal('qr');
        }

        function copyLink() { navigator.clipboard.writeText(document.getElementById('qr-link').innerText); addLog('Config link copied'); alert('Copied!'); }
        function del(id) { servers = servers.filter(x => x.id !== id); if(activeId === id) activeId = null; save(); }
        function delSub(u) { subs = subs.filter(x => x !== u); saveSubs(); }

        addLog('System Startup: AIVPN Edge Engine v2.2.0 is online', 'success');
        render(); renderSubs();
    </script>
</body>
</html>
  `;
}
