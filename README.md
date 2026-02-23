# AIVPN - VLESS & Trojan on Cloudflare Workers

A high-performance VLESS and Trojan implementation on Cloudflare Workers with a modern, V2Ray-style dashboard.

## Features
- **VLESS Protocol**: WebSocket + TLS support.
- **Trojan Protocol**: WebSocket + TLS support.
- **Modern Dashboard**: Built-in web UI served directly from the worker.
- **Auto-Config**: Generates `vless://` and `trojan://` links automatically.
- **QR Codes**: Scan directly from the dashboard to your mobile app.
- **Cloudflare Sockets**: Uses the latest `cloudflare:sockets` API for better performance.
- **Secure**: Authentication included for both protocols.

## Quick Start (Deployment)

### Method 1: Web Interface (Manual)
1. **Sign in** to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Go to **Workers & Pages** -> **Create application** -> **Create Worker**.
3. Name your worker (e.g., `aivpn`) and click **Deploy**.
4. Click **Edit Code**.
5. Copy the entire content of `index.js` from this repository and paste it into the Cloudflare editor, replacing all existing code.
6. Click **Save and Deploy**.

### Method 2: Wrangler CLI (Recommended)
1. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm install -g wrangler`
2. Login to your account: `wrangler login`
3. Edit `wrangler.toml` to customize your `UUID` and `PASSWORD`.
4. Deploy the worker: `wrangler deploy`

## Configuration (Optional)

You can customize your credentials by adding environment variables in the Cloudflare Worker settings or in `wrangler.toml`:

| Variable | Description | Default |
|----------|-------------|---------|
| `UUID` | Your VLESS User ID (UUID) | `7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a7a7a` |
| `PASSWORD` | Trojan Password (used for Dashboard UI) | `aivpn` |
| `PASSWORD_HASH` | SHA224 Hash of your Trojan Password | (Hash of 'aivpn') |

To add these via Web Interface:
1. Go to your Worker's dashboard.
2. Go to **Settings** -> **Variables**.
3. Add the variables under **Environment Variables**.
4. Redeploy the worker.

## Client Support
This worker is compatible with all major V2Ray clients:
- **Android**: v2rayNG
- **iOS**: Shadowrocket, Stash, V2Box
- **Windows**: v2rayN
- **macOS**: V2RayXS, Clash Verge

## License
MIT
