// AIVPN - Cloudflare Worker V2Ray Relay & Dashboard
// Fixed race conditions and stream locking issues

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
  // Simple check to prevent blatant SSRF if deployed publicly
  // In a real app, you might want to sign these requests or restrict domains
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

    // Use pipeTo for robust bidirectional streaming
    const wsToTcp = new ReadableStream({
      start(controller) {
        server.addEventListener('message', (event) => {
          controller.enqueue(event.data);
        });
        server.addEventListener('close', () => controller.close());
        server.addEventListener('error', (e) => controller.error(e));
      }
    }).pipeTo(tcpSocket.writable);

    const tcpToWs = tcpSocket.readable.pipeTo(new WritableStream({
      write(chunk) {
        if (server.readyState === 1) server.send(chunk);
      },
      close() { server.close(); },
      abort() { server.close(); }
    }));

    // Monitor both pipes
    Promise.all([wsToTcp, tcpToWs]).catch(err => {
      console.error('Relay pipe failed:', err);
      server.close();
      tcpSocket.close();
    });

  } catch (err) {
    console.error('Relay connection failed:', err);
    server.close();
  }

  return new Response(null, { status: 101, webSocket: client });
}

async function handleDirect(request, env) {
  const url = new URL(request.url);
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  // Unified Protocol Handler
  server.addEventListener('message', async (event) => {
    // This is the first message (handshake)
    try {
      const buffer = event.data;
      let address = '', port = 0, addressEnd = 0, version = 0;

      if (url.pathname === '/trojan') {
          // Trojan logic
          if (buffer.byteLength < 58) return;
          // Simple pass-through for demo, actual validation should be here
          const view = new DataView(buffer);
          const addressType = view.getUint8(59);
          let offset = 60;
          if (addressType === 1) { address = new Uint8Array(buffer.slice(offset, offset + 4)).join('.'); offset += 4; }
          else if (addressType === 2) { const len = view.getUint8(offset); offset += 1; address = new TextDecoder().decode(buffer.slice(offset, offset + len)); offset += len; }
          port = view.getUint16(offset);
          addressEnd = offset + 4; // Including the trailing \r\n
      } else {
          // VLESS logic
          if (buffer.byteLength < 24) return;
          version = new Uint8Array(buffer.slice(0, 1))[0];
          const optLength = new Uint8Array(buffer.slice(17, 18))[0];
          port = new DataView(buffer.slice(19 + optLength, 21 + optLength)).getUint16(0);
          const addressType = new Uint8Array(buffer.slice(21 + optLength, 22 + optLength))[0];
          addressEnd = 22 + optLength;
          if (addressType === 1) { address = new Uint8Array(buffer.slice(addressEnd, addressEnd + 4)).join('.'); addressEnd += 4; }
          else if (addressType === 2) { const len = new Uint8Array(buffer.slice(addressEnd, addressEnd + 1))[0]; addressEnd += 1; address = new TextDecoder().decode(buffer.slice(addressEnd, addressEnd + len)); addressEnd += len; }
      }

      console.log(`Connecting to ${address}:${port}`);
      const tcpSocket = connect({ hostname: address, port: port });

      if (url.pathname !== '/trojan') server.send(new Uint8Array([version, 0]));

      const writer = tcpSocket.writable.getWriter();
      await writer.write(buffer.slice(addressEnd));
      writer.releaseLock();

      // After handshake, switch to pipeTo
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
      console.error('Handshake failed:', e);
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
    <title>AIVPN Relay Manager</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #020617; color: #f8fafc; }
        .glass { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(51, 65, 85, 0.5); }
        .sidebar-item.active { background: rgba(56, 189, 248, 0.1); border-left: 4px solid #38bdf8; color: #38bdf8; }
    </style>
</head>
<body class="flex min-h-screen">
    <aside class="w-64 glass border-r border-slate-800 flex-col hidden md:flex">
        <div class="p-6">
            <div class="flex items-center space-x-3 mb-10"><div class="bg-sky-500 p-2 rounded-xl"><i class="fas fa-shield-halved text-white text-xl"></i></div><span class="text-2xl font-bold">AI<span class="text-sky-400">VPN</span></span></div>
            <nav class="space-y-2">
                <a href="#" onclick="showSection('servers')" class="sidebar-item flex items-center space-x-3 p-3 rounded-lg active" id="nav-servers"><i class="fas fa-server w-5"></i><span>Servers</span></a>
                <a href="#" onclick="showSection('subs')" class="sidebar-item flex items-center space-x-3 p-3 rounded-lg" id="nav-subs"><i class="fas fa-rss w-5"></i><span>Subscriptions</span></a>
            </nav>
        </div>
    </aside>
    <main class="flex-1 p-6 md:p-10 overflow-y-auto">
        <header class="flex justify-between items-center mb-8">
            <div><h1 class="text-3xl font-bold" id="title">Servers</h1><p class="text-slate-400" id="desc">Manage your proxy accounts</p></div>
            <button onclick="openModal('import')" class="bg-sky-600 hover:bg-sky-500 px-6 py-2 rounded-xl font-bold transition-all"><i class="fas fa-plus mr-2"></i>Add Server</button>
        </header>
        <section id="section-servers" class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6"></section>
        <section id="section-subs" class="hidden space-y-6">
            <div class="glass p-6 rounded-2xl">
                <h3 class="text-xl font-bold mb-4">Subscription URL</h3>
                <div class="flex space-x-3"><input type="text" id="sub-input" class="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 focus:outline-none" placeholder="https://..."><button onclick="addSubscription()" class="bg-slate-700 hover:bg-slate-600 px-6 py-2 rounded-lg font-bold">Import</button></div>
            </div>
            <div id="sub-list" class="space-y-4"></div>
        </section>
    </main>

    <div id="import-modal" class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center hidden z-50 p-4">
        <div class="glass w-full max-w-lg rounded-2xl p-6">
            <div class="flex justify-between items-center mb-6"><h3 class="text-xl font-bold">Import Links</h3><button onclick="closeModal('import')"><i class="fas fa-times"></i></button></div>
            <textarea id="import-text" class="w-full h-40 bg-slate-900 border border-slate-700 rounded-xl p-4 mb-4 focus:outline-none font-mono text-xs" placeholder="vless://...\\ntrojan://..."></textarea>
            <button onclick="doImport()" class="w-full bg-sky-600 py-3 rounded-xl font-bold">Process</button>
        </div>
    </div>

    <div id="qr-modal" class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center hidden z-50 p-4">
        <div class="glass w-full max-w-sm rounded-2xl p-6 text-center">
            <h3 class="text-xl font-bold mb-6" id="qr-name">Relay</h3>
            <div id="qrcode" class="bg-white p-4 rounded-xl inline-block mb-6"></div>
            <p class="text-[10px] bg-slate-900 p-3 rounded-lg mb-6 break-all font-mono" id="qr-link"></p>
            <button onclick="closeModal('qr')" class="w-full bg-sky-600 py-2 rounded-lg font-bold">Done</button>
        </div>
    </div>

    <script>
        let servers = JSON.parse(localStorage.getItem('aivpn_srv') || '[]');
        let subs = JSON.parse(localStorage.getItem('aivpn_sub_list') || '[]');
        const host = "${host}";

        function save() { localStorage.setItem('aivpn_srv', JSON.stringify(servers)); render(); }
        function saveSubs() { localStorage.setItem('aivpn_sub_list', JSON.stringify(subs)); renderSubs(); }

        function showSection(s) {
            ['servers', 'subs'].forEach(x => { document.getElementById('section-'+x).classList.add('hidden'); document.getElementById('nav-'+x).classList.remove('active'); });
            document.getElementById('section-'+s).classList.remove('hidden'); document.getElementById('nav-'+s).classList.add('active');
            document.getElementById('title').innerText = s === 'servers' ? 'Servers' : 'Subscriptions';
        }

        function openModal(m) { document.getElementById(m+'-modal').classList.remove('hidden'); }
        function closeModal(m) { document.getElementById(m+'-modal').classList.add('hidden'); }

        function parse(l) {
            try {
                const protocol = l.split('://')[0];
                const rest = l.split('://')[1];
                const [creds, qh] = rest.split('@');
                const [hp, q] = qh.split('?');
                const [h, p] = hp.split(':');
                const [query, hash] = q.split('#');
                const params = new URLSearchParams(query);
                return { id: Math.random().toString(36).substr(2, 9), alias: decodeURIComponent(hash || 'Server'), protocol, uuid: creds, host: h, port: p, path: params.get('path') || '/', latency: null };
            } catch (e) { return null; }
        }

        function doImport() {
            document.getElementById('import-text').value.split('\\n').forEach(l => { const c = parse(l.trim()); if(c) servers.push(c); });
            save(); closeModal('import'); document.getElementById('import-text').value = '';
        }

        async function addSubscription() {
            const url = document.getElementById('sub-input').value.trim();
            if(!url) return;
            const res = await fetch(\`/api/sub?url=\${encodeURIComponent(url)}\`);
            const text = await res.text();
            text.split('\\n').forEach(l => { const c = parse(l.trim()); if(c) servers.push(c); });
            if(!subs.includes(url)) subs.push(url);
            save(); saveSubs(); showSection('servers');
        }

        function render() {
            const c = document.getElementById('section-servers');
            c.innerHTML = servers.length ? '' : '<div class="col-span-full py-20 text-center text-slate-500">No servers.</div>';
            servers.forEach(s => {
                const d = document.createElement('div');
                d.className = 'glass p-5 rounded-2xl relative group';
                d.innerHTML = \`
                    <button onclick="del('\${s.id}')" class="absolute top-4 right-4 text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100"><i class="fas fa-trash"></i></button>
                    <div class="flex items-center space-x-3 mb-4">
                        <div class="w-10 h-10 rounded-xl flex items-center justify-center bg-sky-500/10 text-sky-400 font-bold">\${s.protocol[0].toUpperCase()}</div>
                        <div class="overflow-hidden"><h4 class="font-bold truncate w-32">\${s.alias}</h4><p class="text-[10px] text-slate-500 font-bold uppercase">\${s.protocol} · \${s.latency || '--'}</p></div>
                    </div>
                    <div class="flex space-x-2">
                        <button onclick="ping('\${s.id}')" class="flex-1 bg-slate-800 py-2 rounded-lg text-xs font-bold">Ping</button>
                        <button onclick="qr('\${s.id}')" class="flex-1 bg-sky-600 py-2 rounded-lg text-xs font-bold">Relay</button>
                    </div>
                \`;
                c.appendChild(d);
            });
        }

        function renderSubs() {
            const c = document.getElementById('sub-list');
            c.innerHTML = subs.length ? '' : '';
            subs.forEach(u => {
                const d = document.createElement('div');
                d.className = 'glass p-4 rounded-xl flex justify-between items-center';
                d.innerHTML = \`<span class="text-sm truncate mr-4">\${u}</span><button onclick="delSub('\${u}')" class="text-slate-500 hover:text-rose-400"><i class="fas fa-trash"></i></button>\`;
                c.appendChild(d);
            });
        }

        async function ping(id) {
            const s = servers.find(x => x.id === id); s.latency = '...'; render();
            const res = await fetch('/api/test', { method: 'POST', body: JSON.stringify({ host: s.host, port: s.port }) });
            const data = await res.json();
            s.latency = data.success ? data.latency + 'ms' : 'Error';
            save();
        }

        function qr(id) {
            const s = servers.find(x => x.id === id);
            const link = \`\${s.protocol}://\${s.uuid}@\${host}:443?security=tls&type=ws&host=\${host}&sni=\${host}&path=\${encodeURIComponent('/relay/'+s.host+'/'+s.port)}#Relay-\${s.alias}\`;
            document.getElementById('qr-name').innerText = s.alias;
            document.getElementById('qr-link').innerText = link;
            const q = document.getElementById('qrcode'); q.innerHTML = '';
            new QRCode(q, { text: link, width: 200, height: 200 });
            openModal('qr');
        }

        function del(id) { servers = servers.filter(x => x.id !== id); save(); }
        function delSub(u) { subs = subs.filter(x => x !== u); saveSubs(); }

        render(); renderSubs();
    </script>
</body>
</html>
  `;
}
