# AIVPN - V2Ray Relay Manager on Cloudflare Workers

AIVPN is a powerful Cloudflare Worker application that acts as a web-based client and relay manager for your VLESS and Trojan accounts. It allows you to manage multiple servers and relay them through Cloudflare's network for better privacy and connectivity.

## Features
- **Modern Web Dashboard**: A UI inspired by v2rayNG for managing your proxy accounts.
- **Relay Support**: Bridge your existing VLESS/Trojan accounts through Cloudflare.
- **Protocol Support**: Handles VLESS and Trojan over WebSocket.
- **Subscription Support**: Import server lists directly from subscription URLs.
- **Connection Testing**: Test latency from the worker to your remote servers.
- **Privacy**: Accounts are stored locally in your browser (`localStorage`).

## Quick Start (Deployment)

### Method 1: Web Interface (Manual)
1. **Sign in** to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Go to **Workers & Pages** -> **Create application** -> **Create Worker**.
3. Name your worker (e.g., `aivpn`) and click **Deploy**.
4. Click **Edit Code**.
5. Copy the entire content of `index.js` from this repository and paste it into the Cloudflare editor.
6. Click **Save and Deploy**.

### Method 2: Wrangler CLI
1. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
2. Run `wrangler deploy` in this directory.

## How to Use
1. Access your worker URL (e.g., `https://aivpn.yourname.workers.dev`).
2. Click **Add Server** and paste your VLESS/Trojan link.
3. Use the **Relay** button to generate a new config that tunnels through this worker.
4. Import the generated relay config into your favorite client (v2rayNG, v2rayN, Shadowrocket, etc.).

## Security
- This worker can be used as a public relay if the URL is known.
- To restrict access, you can add a `PASSWORD` environment variable (feature coming soon) or use Cloudflare Access.

## License
MIT
