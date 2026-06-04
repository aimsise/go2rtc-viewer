# Security Policy

go2rtc-viewer is a **LAN-only, personal-use** security-camera viewer. It is not intended to be exposed to the internet.

## Reporting a Vulnerability

- If you find a vulnerability, please **do not open a public issue**. Report it privately via GitHub's **Security Advisory** (private vulnerability reporting).
- Given the nature of a security-camera tool, please refrain from publicly sharing details (reproduction steps / PoC) until a fix is available.

## Threat Model (by design)

This tool has **no authentication**. Its safety depends on being confined to a trusted LAN. Assumptions:

- go2rtc (`:1984`) and the recordings backend (`:3914`) bind to **localhost (127.0.0.1) only by default**. Widen the bind address only to view from another LAN device, and protect it with a firewall.
- **Do not expose** these ports (`1984` / `3914` / `8555` / camera `554` / DVR `80`) to the internet (no port-forwarding / UPnP). Use a VPN for remote access.
- A camera/DVR `admin` / blank password is dangerous. **Always set a strong password**, and pass credentials via `.env` (git-ignored).
- The browser fetches `cameras.json`, so camera IPs are visible to DevTools on the LAN. Using `.env` is repository hygiene (keeping LAN layout / credentials out of commit history), not runtime secrecy.

For more, see the [Security Warnings in the README](README.md#security-warnings-must-read).
