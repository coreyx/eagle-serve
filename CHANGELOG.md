# Changelog

All notable changes to the **Eagle Serve** plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-12

First release: [webdav-server-kit](https://github.com/coreyx/webdav-server-kit) re-implemented as an Eagle background-service plugin.

### Added
- **WebDAV Server as an Eagle Service**:
  - Runs `rclone serve webdav` as a child process from a `serviceMode` plugin, started automatically when Eagle starts.
  - Serves the library open in Eagle from the WebDAV root, or any other folder, and re-serves when the library is switched.
  - Stops rclone when Eagle exits, and stops a leftover rclone from a session that ended badly (tracked in `server.pid`, verified to be rclone before it is killed).
- **Network Binding**:
  - Always listens on `127.0.0.1`; **Local network** and **Tailscale** options add this computer's LAN and Tailscale (`100.64.0.0/10`) addresses, one `--addr` per address.
  - **Other addresses** field for anything else, including `0.0.0.0`.
  - Rebinds automatically when addresses appear or disappear (checked every 10 seconds).
  - Shows every reachable address in the window, including the Tailscale MagicDNS name, each with a **Copy** button.
  - Configurable port (default `41599`), with a port-in-use check before rclone is launched.
- **HTTPS**:
  - Certificate and private key paths, with the current certificate's covered names and expiry shown in the window.
  - Built-in self-signed certificate generator (RSA 4096, SHA-256, one year, full Subject Alternative Names) written with Node's `crypto` module, so OpenSSL is not required.
- **Sign-in**:
  - Apache-compatible `htpasswd` file with bcrypt hashes (cost 12), managed from the window.
  - Users can be added and removed while the server is running.
- **Allowed Devices**:
  - Access filter ported from `access_filter.py`: `self`, IP addresses, CIDR ranges (IPv4 and IPv6) and hostnames resolved by forward and reverse DNS with a 60-second cache.
  - Runs as a transparent TCP proxy in front of rclone, so TLS and authentication pass through untouched.
- **Other Options**: read-only mode, folder listing cache time (`--dir-cache-time`), symbolic link following (`-L`), and an explicit rclone path.
- **rclone Management**:
  - Finds rclone on `PATH` and in the usual winget, Scoop, Chocolatey and Homebrew locations.
  - One-click download of the official rclone release, verified against the published SHA-256 sums.
- **Settings Window**:
  - Status, addresses, error messages and a live log, with an unsaved-changes bar and **Save and restart**.
  - Native theming for Eagle's DARK, GRAY, LIGHT, LIGHTGRAY, BLUE and PURPLE themes.
  - Warnings when the folder is exposed to a network without sign-in or allowed devices, and when sign-in is used without HTTPS.
- **Packaging**:
  - `pnpm build` stages the runtime files and production dependencies and packs `dist/eagle-serve-<version>.eagleplugin`.
  - GitHub Actions workflow that tests and builds on every push and publishes a release for version tags.
- **Automated Testing**:
  - Unit tests for settings, network discovery, access rules, `htpasswd`, certificate generation and the zip extractor.
  - Integration tests against a real rclone server covering HTTP, HTTPS, sign-in, read-only, the access filter, multiple listen addresses, library switching and process cleanup.
