# iPhone App Setup

This repo now includes a Capacitor iPhone app shell in `ios/`.

## Before opening in Xcode

1. Install full Xcode from the App Store.
2. Point the active developer directory at Xcode:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

3. Set the Render backend URL in `public/app-config.js`:

```js
window.HNS_CONFIG = {
    serverUrl: 'https://your-render-service.onrender.com'
};
```

4. Sync the web assets into the iPhone project:

```bash
npm run cap:sync:ios
```

5. Open the iPhone project:

```bash
npm run cap:open:ios
```

## Included app behavior

- Native keep-awake bridge: `HideNSeekDisplay.setKeepAwake`
- In-app black hidden-phone overlay from the web UI
- iOS audio session set to playback in the custom bridge view controller
- Native iPhone reveal vibration bridge for the end-of-round unfound-phone loop

## Notes

- The multiplayer/game server still runs on Render.
- The iPhone app bundles the frontend locally and connects back to the Render backend via Socket.IO.
- `public/app-config.js` is copied into `ios/App/App/public/` on each Capacitor sync.
- The iPhone simulator will not give meaningful vibration feedback; test reveal vibration on a real device.
