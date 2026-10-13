# Why there is no "Copy Eagle Serve Link" menu item

**Status:** not built. Investigated 2026-10-12 against Eagle 4.0 build 23 (`buildVersion` 20260401) on Windows.

## The question

Eagle Serve can give every item a stable address (`/item/<ID>` and `/thumbnail/<ID>`). The obvious way to get one would be to right-click an item in Eagle and choose something like **Copy Eagle Serve Link**. Can this plugin add that entry to Eagle's item context menu?

## Short answer

Not from Eagle Serve itself. Eagle lists plugins in a **Plugin** submenu of the item context menu, but it leaves out background-service plugins, and Eagle Serve has to be one to start with Eagle. A menu entry is possible only through a second, separate window plugin. That companion plugin has not been built, because it needs two decisions that have not been made (see [What is undecided](#what-is-undecided)).

## What Eagle allows

### The plugin API has no menu hook

- `eagle.contextMenu.open(menuItems)` pops up a menu that the plugin opens itself, inside its own window. It does not add anything to Eagle's menus.
- The four plugin types (window, background service, format extension, inspector) do not include one that registers menu entries, and `manifest.json` has no field for it.
- The **Search by Image** entries in the item menu look like a plugin adding itself, but they are part of Eagle: their labels are Eagle's own strings (`context.image.reverseSearch`, `context.image.reverseSearchLocal`), and the Search by Image plugin's manifest contains nothing that registers them.

### The Plugin submenu

Eagle builds a **Plugin** submenu into the item context menu on its own. The code is in `resources/app.asar` and is readable as plain JavaScript. A plugin is listed when this holds:

```js
const executable = !!manifest.main;
const isServicePlugin = manifest?.main?.serviceMode;
if (executable && !isServicePlugin && !pluginModule.isPluginDisabled(manifest.id)) { … }
```

That is: the plugin has a window (`main` in its manifest), it is not a background service, and it is not disabled.

What an entry is:

| Property | Value |
| --- | --- |
| Label | The plugin's `name` from its manifest |
| Icon | The plugin's `logo` |
| Shortcut shown | The keyboard shortcut assigned to the plugin, if any |
| Action | `pluginModule.open(plugin)`, the same as launching the plugin from the plugin panel |
| Order | The three most recently opened plugins under a "recent" label, a separator, then the rest alphabetically |

Consequences:

- **One entry per plugin.** A plugin cannot add several entries or choose its own label.
- **Nothing is passed to the plugin.** It finds out what was right-clicked by calling `eagle.item.getSelected()` when it runs.
- **Eagle Serve is excluded**, because its manifest sets `main.serviceMode`. Removing that would put it in the menu and stop it starting with Eagle, which is the point of the plugin.

## Why it is not built

A menu entry would have to come from a companion window plugin, for example one named **Copy Eagle Serve Link**. When launched it would:

1. Read the selected items with `eagle.item.getSelected()`.
2. Read Eagle Serve's settings from its data folder (`config.json`, see the README) to learn the port, whether HTTPS is on, and whether item links are on.
3. Put `https://<address>:<port>/item/<ID>` for each selected item on the clipboard.
4. Show a notification and close its own window.

This was not done for these reasons:

- **It is a second plugin.** One `.eagleplugin` holds one plugin, so the repository would need a second manifest and entry page, and `scripts/build-release.js` would need to stage and pack two packages. Users would install two things.
- **Two product decisions are open** (next section).
- **Parts of the approach are untested.** Whether a window plugin can run and close without visibly flashing a window, and how Eagle treats a plugin that closes itself immediately, have not been tried.
- **Item links are opt-in.** The companion would only be useful with **Give every item an address by its ID** turned on, and would need to say so when it is off.

### What is undecided

1. **What the entry should do.** Copy the item link, the thumbnail link, a Markdown embed, or offer a choice. Since each plugin gets exactly one entry, several actions mean either several companion plugins or one entry that opens a small chooser.
2. **Which address goes into the link.** The server answers on several at once (`127.0.0.1`, the computer name, the LAN address, the Tailscale address and name). Nothing in the settings says which one links should use. A "use this address in copied links" setting would have to be added to Eagle Serve, most likely defaulting to the computer name.

## Other ways to reach a plugin from an item

Noted while investigating, none of them built:

- **Inspector panel.** An inspector plugin shows a section in the right-hand panel for the selected item (Extra Links works this way). It could show the item's links with copy buttons. Whether one plugin can be both a background service and an inspector has not been tested; it may also need a companion.
- **Keyboard shortcut.** Eagle lets a shortcut be assigned to a plugin (plugin panel > right-click > **Shortcuts**). This launches the plugin the same way the menu entry does, so it has the same service-plugin question.
- **Middle click.** Preferences has **Wheel button behavior > Run Plugin**. How it chooses which plugin to run was not checked.
- **Pinned plugins.** Eagle's toolbar shows pinned plugins as icons. Whether a service plugin can be pinned was not checked.
- **Extra Links.** Eagle Serve could write each item's link into the Extra Links plugin through its local API, so the link shows in the inspector without a new plugin. This ties the feature to a second plugin being installed.

## Checking this again on a newer Eagle

The rule above comes from Eagle's own code, so it can change between versions. To re-check, print the code around the service-plugin test:

```bash
node -e "
const fs = require('fs');
const buf = fs.readFileSync('C:/Program Files/Eagle/resources/app.asar');
const at = buf.indexOf('const isServicePlugin = manifest?.main?.serviceMode;');
console.log(at < 0 ? 'not found: the code has changed' :
    buf.subarray(at - 400, at + 900).toString('latin1').replace(/[^\x20-\x7e]+/g, ' '));
"
```

If the condition no longer excludes service plugins, Eagle Serve may already be in the **Plugin** submenu, and the feature becomes a matter of handling `eagle.onPluginRun` inside this plugin.
