# AIVPN Pro - V2Ray Relay Manager

AIVPN is a high-performance Cloudflare Worker application that functions as a V2Ray client manager and relay. It allows you to manage multiple VLESS and Trojan accounts through a modern, mobile-responsive web dashboard.

## Features
- **Robust Parsing**: Support for VLESS and Trojan links with or without query parameters/aliases.
- **Connect & Monitor**: Real-time "Connect" button and live system logs to monitor handshake status.
- **Dynamic Relaying**: Use your worker as a bridge to improve connectivity to your existing proxy accounts.
- **Subscription Support**: Import large lists of servers automatically from V2Ray subscription URLs.
- **Beautiful UI**: v2rayNG-inspired interface with dark mode and smooth animations.
- **Privacy First**: All accounts and logs are stored locally in your browser (`localStorage`).

## Quick Start

### Deployment
1. Create a new Cloudflare Worker.
2. Copy the content of `index.js` into the worker editor.
3. Deploy.

### Usage
1. Open your worker URL.
2. Click **Import Account** and paste your VLESS or Trojan links.
3. Click **Connect** on any account to test connectivity and view logs.
4. Use the **QR Code** button to generate a relay config for your mobile/desktop client.

## Tech Stack
- Cloudflare Workers & Sockets
- Tailwind CSS
- QRCode.js

## License
MIT
