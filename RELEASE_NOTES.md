# Release Notes: Eagle Serve

## Release Notes: v1.0.0 (WebDAV Server for Your Eagle Library)

**v1.0.0** is the first release. Eagle Serve serves the library open in Eagle over WebDAV, starting and stopping with Eagle, with every setting in a window inside Eagle.

### 1. Starts With Eagle
- Runs as a background service and serves the open library on port `41599`, under its own folder name (`https://host:41599/Main.library/…`). This is the link format obsidian-eagle-bridge uses.
- Follows you when you switch libraries, or serves any other folder you choose.
- Uses [rclone](https://rclone.org/) underneath. If rclone is not installed, **Download rclone** fetches the official build for you.

### 2. Choose Who Can Reach It
- Always available on this computer. Tick **Local network** or **Tailscale** to share it with your other devices.
- The window lists every address the server can be reached at, ready to copy.
- Addresses that appear later (Wi-Fi reconnecting, Tailscale starting) are picked up automatically.

### 3. HTTPS, Sign-in and Allowed Devices
- **HTTPS** with your own certificate, or a self-signed one generated in the window that already covers this computer's names and addresses.
- **Sign-in** with usernames and passwords, stored as bcrypt hashes. Add and remove users without restarting.
- **Allowed devices** limits connections to this computer, specific IPs, ranges, or device names such as `macbook-air`.

### 4. Good to Know
- **Read-only** is on by default: other devices can open and copy files but not change the library. Eagle does not expect files to change underneath it, so turn it off only if you need to write.
- Turn on **Give every item an address by its ID** for links like `https://host:41599/item/MV63BVOWOZLV6` (and `/thumbnail/MV63BVOWOZLV6` for its thumbnail) that keep working after the item or the library is renamed.
- Files Eagle adds show up on other devices after the folder listing cache time (5 seconds by default).
- Developed and tested on Windows. macOS support is in place but has not been run on a Mac yet.

### Installing
Download `eagle-serve-1.0.0.eagleplugin` below and double-click it, then open **Eagle Serve** from Eagle's plugin list.
