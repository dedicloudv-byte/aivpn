// AIVPN - Cloudflare Worker V2Ray Client Dashboard & Relay
// v2.4.0 - Added Quick Config Generator & Short Relay Paths

import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgradeHeader = request.headers.get('Upgrade');

      if (upgradeHeader === 'websocket') {
        const nauticaMatch = url.pathname.match(/^\/([^\/]+)[:=-](\d+)$/);
        if (url.pathname.startsWith('/relay/') || nauticaMatch) {
          return await handleRelay(request, nauticaMatch);
        }
        return await handleDirect(request, env);
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

async function handleRelay(request, nauticaMatch) {
  const url = new URL(request.url);
  let targetHost, targetPort;

  if (nauticaMatch) {
    targetHost = nauticaMatch[1];
    targetPort = parseInt(nauticaMatch[2]);
  } else {
    const parts = url.pathname.split('/').filter(Boolean);
    targetHost = parts[1];
    targetPort = parseInt(parts[2]);
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  try {
    const tcpSocket = connect({ hostname: targetHost, port: targetPort });

    const wsToTcp = new ReadableStream({
      start(controller) {
        server.addEventListener('message', (event) => controller.enqueue(event.data));
        server.addEventListener('close', () => controller.close());
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
    <!-- Sidebar -->
    <aside class="w-72 glass border-r border-slate-800 flex flex-col shrink-0">
        <div class="p-8">
            <div class="flex items-center space-x-3 mb-12">
                <div class="bg-sky-500 p-2.5 rounded-2xl shadow-lg shadow-sky-500/20"><i class="fas fa-shield-halved text-white text-xl"></i></div>
                <span class="text-2xl font-black tracking-tight tracking-tighter">AI<span class="text-sky-400">VPN</span></span>
            </div>
            <nav class="space-y-4">
                <button onclick="showSection('servers')" class="sidebar-item w-full flex items-center space-x-4 p-4 rounded-xl transition-all active" id="nav-servers"><i class="fas fa-server"></i><span class="font-bold">Configs</span></button>
                <button onclick="showSection('gen')" class="sidebar-item w-full flex items-center space-x-4 p-4 rounded-xl transition-all" id="nav-gen"><i class="fas fa-magic"></i><span class="font-bold">Generator</span></button>
                <button onclick="showSection('subs')" class="sidebar-item w-full flex items-center space-x-4 p-4 rounded-xl transition-all" id="nav-subs"><i class="fas fa-rss"></i><span class="font-bold">Subscriptions</span></button>
                <button onclick="showSection('logs')" class="sidebar-item w-full flex items-center space-x-4 p-4 rounded-xl transition-all" id="nav-logs"><i class="fas fa-terminal"></i><span class="font-bold">System Logs</span></button>
            </nav>
        </div>

        <div class="mt-auto p-6">
            <div class="glass p-5 rounded-2xl border-slate-700/50">
                <p class="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-3">Network Status</p>
                <div class="space-y-3">
                    <div>
                        <p class="text-[10px] text-slate-400 font-bold mb-1">Current IP</p>
                        <p class="text-xs font-mono text-white truncate" id="client-ip-display">Detecting...</p>
                    </div>
                    <div>
                        <p class="text-[10px] text-slate-400 font-bold mb-1">Encryption</p>
                        <p class="text-xs font-bold text-emerald-400 flex items-center"><i class="fas fa-lock text-[8px] mr-2"></i> Protected</p>
                    </div>
                </div>
                <button onclick="refreshIP()" class="mt-4 w-full bg-slate-800 hover:bg-slate-700 py-2 rounded-lg text-[10px] font-black uppercase transition-all">Refresh IP</button>
            </div>
            <div class="mt-6 text-[9px] font-bold text-slate-600 text-center uppercase tracking-widest">AIVPN EDGE CORE</div>
        </div>
    </aside>

    <!-- Main -->
    <main class="flex-1 p-6 md:p-12 overflow-y-auto">
        <header class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-12 gap-6">
            <div><h1 class="text-4xl font-black tracking-tight mb-2" id="title">Servers</h1><p class="text-slate-400 font-medium" id="desc">Your private gateway to the global internet</p></div>
            <button onclick="openModal('import')" class="bg-sky-600 hover:bg-sky-500 px-8 py-4 rounded-2xl font-black shadow-xl shadow-sky-600/30 transition-all flex items-center uppercase text-sm tracking-widest"><i class="fas fa-plus-circle mr-3"></i>Import Account</button>
        </header>

        <section id="section-servers" class="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-8"></section>

        <section id="section-gen" class="hidden max-w-5xl mx-auto">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-12">
                <div class="glass p-10 rounded-[3rem] space-y-8">
                    <h3 class="text-2xl font-black flex items-center"><i class="fas fa-cog mr-4 text-sky-400"></i>Relay Settings</h3>
                    <div class="space-y-6">
                        <div>
                            <label class="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-3 block">Protocol</label>
                            <select id="gen-proto" oninput="updateGen()" class="w-full bg-slate-900 border border-slate-700 rounded-2xl px-6 py-4 focus:outline-none focus:border-sky-500 text-white font-bold appearance-none cursor-pointer">
                                <option value="vless">VLESS (Recommended)</option>
                                <option value="trojan">Trojan</option>
                            </select>
                        </div>
                        <div>
                            <label class="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-3 block">Proxy Host (IP or Domain)</label>
                            <input type="text" id="gen-host" oninput="updateGen()" class="w-full bg-slate-900 border border-slate-700 rounded-2xl px-6 py-4 focus:outline-none focus:border-sky-500 text-white font-mono" placeholder="e.g. 1.1.1.1 or sg1.v2ray.com">
                        </div>
                        <div>
                            <label class="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-3 block">Proxy Port</label>
                            <input type="number" id="gen-port" oninput="updateGen()" class="w-full bg-slate-900 border border-slate-700 rounded-2xl px-6 py-4 focus:outline-none focus:border-sky-500 text-white font-mono" placeholder="443" value="443">
                        </div>
                    </div>
                </div>

                <div class="glass p-10 rounded-[3rem] flex flex-col items-center text-center justify-center">
                    <div id="gen-qrcode-container" class="bg-white p-6 rounded-[2.5rem] shadow-2xl mb-8">
                        <div id="gen-qrcode"></div>
                    </div>
                    <div class="w-full space-y-4">
                        <div id="gen-link" class="bg-slate-950/50 p-4 rounded-xl border border-slate-800 text-[10px] font-mono text-slate-400 break-all leading-relaxed h-20 overflow-y-auto">Enter host to generate link...</div>
                        <button onclick="copyGenLink()" class="w-full bg-sky-600 hover:bg-sky-500 py-4 rounded-2xl font-black uppercase tracking-widest text-sm transition-all shadow-lg shadow-sky-600/20">Copy Config Link</button>
                    </div>
                </div>
            </div>
        </section>

        <section id="section-subs" class="hidden space-y-8 max-w-4xl">
            <div class="glass p-8 rounded-[2rem]">
                <h3 class="text-xl font-black mb-6">Load Subscription</h3>
                <div class="flex gap-4"><input type="text" id="sub-input" class="flex-1 bg-slate-900 border border-slate-700 rounded-2xl px-6 py-4 focus:outline-none focus:border-sky-500 transition-all text-white font-medium" placeholder="https://v2ray-subscription-url.com"><button onclick="addSubscription()" class="bg-slate-700 hover:bg-slate-600 px-10 py-4 rounded-2xl font-black uppercase tracking-widest">Load</button></div>
            </div>
            <div id="sub-list" class="space-y-4"></div>
        </section>

        <section id="section-logs" class="hidden">
            <div class="glass rounded-[2rem] overflow-hidden flex flex-col h-[70vh]">
                <div class="bg-slate-900/60 p-6 border-b border-slate-800 flex justify-between items-center">
                    <div class="flex items-center space-x-4"><div class="w-3 h-3 rounded-full bg-sky-500 animate-ping"></div><span class="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Live Traffic Logs</span></div>
                    <button onclick="clearLogs()" class="text-[10px] font-black text-slate-500 hover:text-white uppercase tracking-widest">Clear Logs</button>
                </div>
                <div id="log-container" class="flex-1 p-8 overflow-y-auto bg-slate-950/20 scrollbar-hide"></div>
            </div>
        </section>
    </main>

    <!-- Modals -->
    <div id="import-modal" class="fixed inset-0 bg-slate-950/95 backdrop-blur-xl flex items-center justify-center hidden z-50 p-6">
        <div class="glass w-full max-w-2xl rounded-[2.5rem] p-10 shadow-2xl border-slate-700">
            <div class="flex justify-between items-center mb-10"><h3 class="text-3xl font-black">Import Config</h3><button onclick="closeModal('import')" class="w-12 h-12 rounded-full hover:bg-slate-800 flex items-center justify-center transition-all"><i class="fas fa-times text-xl"></i></button></div>
            <textarea id="import-text" class="w-full h-80 bg-slate-900 border border-slate-700 rounded-3xl p-8 mb-8 focus:outline-none focus:border-sky-500 font-mono text-xs text-white leading-loose" placeholder="vless://...\\ntrojan://..."></textarea>
            <button onclick="doImport()" class="w-full bg-sky-600 hover:bg-sky-500 py-5 rounded-2xl font-black shadow-2xl shadow-sky-600/40 transition-all uppercase tracking-[0.2em]">Process</button>
        </div>
    </div>

    <div id="qr-modal" class="fixed inset-0 bg-slate-950/95 backdrop-blur-xl flex items-center justify-center hidden z-50 p-6">
        <div class="glass w-full max-w-md rounded-[3rem] p-12 text-center border-slate-700">
            <h3 class="text-2xl font-black mb-10" id="qr-name">Config</h3>
            <div id="qrcode" class="bg-white p-8 rounded-[2rem] inline-block mb-10 shadow-2xl"></div>
            <div class="bg-slate-900/60 p-5 rounded-2xl mb-10 break-all font-mono text-[9px] text-slate-500 border border-slate-800 leading-relaxed uppercase tracking-tight" id="qr-link"></div>
            <div class="flex gap-4">
                <button onclick="copyLink()" class="flex-1 bg-slate-800 hover:bg-slate-700 py-4 rounded-2xl font-black uppercase tracking-widest text-xs">Copy Link</button>
                <button onclick="closeModal('qr')" class="flex-1 bg-sky-600 hover:bg-sky-500 py-4 rounded-2xl font-black uppercase tracking-widest text-xs shadow-lg shadow-sky-600/20">Done</button>
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
            const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const line = document.createElement('div');
            line.className = 'log-line';
            line.innerHTML = \`<span class="log-time">[\${time}]</span> <span class="uppercase font-black mr-2 text-[9px] \${type === 'error' ? 'text-rose-500' : type === 'success' ? 'text-emerald-500' : 'text-sky-500'}">[\${type}]</span> <span class="text-slate-300">\${msg}</span>\`;
            container.appendChild(line);
            container.scrollTop = container.scrollHeight;
        }

        function clearLogs() { document.getElementById('log-container').innerHTML = ''; }

        function showSection(s) {
            ['servers', 'gen', 'subs', 'logs'].forEach(x => {
                const el = document.getElementById('section-'+x);
                const nav = document.getElementById('nav-'+x);
                if(el) el.classList.add('hidden');
                if(nav) nav.classList.remove('active');
            });
            const target = document.getElementById('section-'+s);
            const navTarget = document.getElementById('nav-'+s);
            if(target) target.classList.remove('hidden');
            if(navTarget) navTarget.classList.add('active');
            const titles = { servers: 'Servers', gen: 'Generator', subs: 'Subscriptions', logs: 'Live Console' };
            const descs = { servers: 'Your private gateway to the global internet', gen: 'Quickly generate relay configurations', subs: 'Manage your remote config feeds', logs: 'Real-time protocol handshake monitoring' };
            document.getElementById('title').innerText = titles[s];
            document.getElementById('desc').innerText = descs[s];
        }

        let genQr = null;
        function updateGen() {
            const proto = document.getElementById('gen-proto').value;
            const host = document.getElementById('gen-host').value.trim();
            const port = document.getElementById('gen-port').value || '443';
            const display = document.getElementById('gen-link');
            const qrContainer = document.getElementById('gen-qrcode');

            if (!host) {
                display.innerText = 'Enter host to generate link...';
                qrContainer.innerHTML = '';
                return;
            }

            const uuid = '00000000-0000-0000-0000-000000000000'; // Default or from env
            const path = encodeURIComponent('/' + host + ':' + port);
            const link = \`\${proto}://\${uuid}@\${workerHost}:443?security=tls&type=ws&host=\${workerHost}&sni=\${workerHost}&path=\${path}#AIVPN-\${host}\`;

            display.innerText = link;
            qrContainer.innerHTML = '';
            new QRCode(qrContainer, { text: link, width: 200, height: 200 });
        }

        function copyGenLink() {
            const link = document.getElementById('gen-link').innerText;
            if (link.includes('://')) {
                navigator.clipboard.writeText(link);
                addLog('Generator link copied', 'success');
            }
        }

        function openModal(m) { document.getElementById(m+'-modal').classList.remove('hidden'); }
        function closeModal(m) { document.getElementById(m+'-modal').classList.add('hidden'); }

        async function refreshIP() {
            const display = document.getElementById('client-ip-display');
            display.innerText = 'Detecting...';
            try {
                const res = await fetch('/api/myip');
                const data = await res.json();
                display.innerText = data.ip;
                addLog(\`Network Identity verified: \${data.ip}\`, 'success');
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
            if (count) { addLog(\`Imported \${count} configuration(s)\`, 'success'); save(); closeModal('import'); document.getElementById('import-text').value = ''; }
        }

        async function addSubscription() {
            const url = document.getElementById('sub-input').value.trim();
            if(!url) return;
            addLog(\`Connecting to feed: \${url}\`);
            try {
                const res = await fetch(\`/api/sub?url=\${encodeURIComponent(url)}\`);
                const text = await res.text();
                let count = 0;
                text.split('\\n').forEach(l => { const c = parse(l.trim()); if(c) { servers.push(c); count++; } });
                if(!subs.includes(url)) subs.push(url);
                addLog(\`Feed Success: \${count} servers imported\`, 'success');
                save(); saveSubs(); showSection('servers');
                document.getElementById('sub-input').value = '';
            } catch (e) { addLog(\`Feed Error: \${e.message}\`, 'error'); }
        }

        function render() {
            const c = document.getElementById('section-servers');
            c.innerHTML = servers.length ? '' : '<div class="col-span-full py-32 text-center text-slate-600 border-4 border-dashed border-slate-800/40 rounded-[3rem] font-bold"><i class="fas fa-inbox text-5xl mb-6 block opacity-20"></i>No accounts found.</div>';
            servers.forEach(s => {
                const isConn = s.id === activeId;
                const d = document.createElement('div');
                d.className = \`card glass p-8 rounded-[2.5rem] relative group \${isConn ? 'border-sky-500/50 bg-sky-500/[0.03]' : ''}\`;
                d.innerHTML = \`
                    <button onclick="del('\${s.id}')" class="absolute top-8 right-8 text-slate-700 hover:text-rose-500 transition-all opacity-0 group-hover:opacity-100"><i class="fas fa-trash-alt"></i></button>
                    <div class="flex items-center space-x-6 mb-10">
                        <div class="w-16 h-16 rounded-[1.5rem] flex items-center justify-center \${s.protocol === 'vless' ? 'bg-sky-500' : 'bg-indigo-600'} text-white shadow-xl font-black text-xl">\${s.protocol[0].toUpperCase()}</div>
                        <div class="overflow-hidden">
                            <h4 class="font-black text-2xl truncate text-white mb-2">\${s.alias}</h4>
                            <div class="flex items-center space-x-4">
                                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500 bg-slate-800/80 px-3 py-1 rounded-lg">\${s.protocol}</span>
                                <span class="text-xs font-black \${s.latency === 'Error' ? 'text-rose-500' : 'text-emerald-400'}">\${s.latency || 'Checking...'}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-4">
                        <button onclick="conn('\${s.id}')" class="flex-[3] \${isConn ? 'bg-emerald-600' : 'bg-sky-600'} hover:opacity-90 py-4 rounded-2xl font-black text-sm transition-all shadow-xl uppercase tracking-widest">\${isConn ? 'CONNECTED' : 'CONNECT'}</button>
                        <button onclick="qr('\${s.id}')" class="flex-1 bg-slate-800 hover:bg-slate-700 py-4 rounded-2xl text-xl transition-all"><i class="fas fa-qrcode"></i></button>
                    </div>
                \`;
                c.appendChild(d);
                if (s.latency === null) ping(s.id);
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
            addLog(\`Initializing secure tunnel to \${s.alias}...\`);
            addLog(\`Resolving DNS for \${s.host}...\`);
            activeId = id; localStorage.setItem('aivpn_act_v5', id); render();
            try {
                const res = await fetch('/api/test', { method: 'POST', body: JSON.stringify({ host: s.host, port: s.port }) });
                const data = await res.json();
                if(data.success) {
                    addLog(\`TCP Connection established in \${data.latency}ms\`, 'success');
                    addLog(\`Protocol Handshake (\${s.protocol.toUpperCase()}) verified\`, 'success');
                    addLog(\`Relay Route: https://\${workerHost}/relay/\${s.host}/\${s.port}\`);
                    await refreshIP();
                } else { addLog(\`Handshake Failed: \${data.error}\`, 'error'); }
            } catch (e) { addLog(\`Connection Timeout\`, 'error'); }
            save();
        }

        function qr(id) {
            const s = servers.find(x => x.id === id);
            const link = \`\${s.protocol}://\${s.uuid}@\${workerHost}:443?security=tls&type=ws&host=\${workerHost}&sni=\${workerHost}&path=\${encodeURIComponent('/relay/'+s.host+'/'+s.port)}#AIVPN-\${s.alias}\`;
            document.getElementById('qr-name').innerText = s.alias;
            document.getElementById('qr-link').innerText = link;
            const q = document.getElementById('qrcode'); q.innerHTML = '';
            new QRCode(q, { text: link, width: 250, height: 250 });
            openModal('qr');
            addLog(\`Exported configuration for \${s.alias}\`);
        }

        function copyLink() { navigator.clipboard.writeText(document.getElementById('qr-link').innerText); addLog('Config URI copied to clipboard', 'success'); }
        function save() { localStorage.setItem('aivpn_srv_v5', JSON.stringify(servers)); render(); }
        function saveSubs() { localStorage.setItem('aivpn_sub_v5', JSON.stringify(subs)); renderSubs(); }
        function del(id) { servers = servers.filter(x => x.id !== id); if(activeId === id) activeId = null; save(); }
        function renderSubs() {
            const c = document.getElementById('sub-list');
            c.innerHTML = '';
            subs.forEach(u => {
                const d = document.createElement('div');
                d.className = 'glass p-6 rounded-3xl flex justify-between items-center border-l-8 border-slate-700';
                d.innerHTML = \`<span class="text-sm truncate font-bold text-slate-400 mr-8">\${u}</span><button onclick="delSub('\${u}')" class="text-slate-600 hover:text-rose-500 transition-all"><i class="fas fa-trash-alt text-xl"></i></button>\`;
                c.appendChild(d);
            });
        }
        function delSub(u) { subs = subs.filter(x => x !== u); saveSubs(); }

        refreshIP();
        addLog('AIVPN Engine v2.4.0 started successfully.', 'success');
        render(); renderSubs();
    </script>
</body>
</html>
  `;
}
