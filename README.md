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

1. **Sign in** to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Go to **Workers & Pages** -> **Create application** -> **Create Worker**.
3. Name your worker (e.g., `aivpn`) and click **Deploy**.
4. Click **Edit Code**.
5. Copy the entire content of `index.js` from this repository and paste it into the Cloudflare editor, replacing all existing code.
6. Click **Save and Deploy**.

## Configuration (Optional)

You can customize your credentials by adding environment variables in the Cloudflare Worker settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `UUID` | Your VLESS User ID (UUID) | `7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a7a7a` |
| `PASSWORD` | Trojan Password (used for Dashboard UI) | `aivpn` |
| `PASSWORD_HASH` | SHA224 Hash of your Trojan Password | (Hash of 'aivpn') |

To add these:
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
