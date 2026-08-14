# Safari build checklist

The JavaScript extension and native Swift sources are complete. Apple requires the final Safari app/extension bundle to be produced and signed by Xcode on macOS.

1. Run `chmod +x build-safari.sh && ./build-safari.sh` on a Mac with current Xcode installed.
2. In the generated Xcode project, select the **Auto Route** app target. The build script preconfigures the supplied entitlements and sandbox permissions; confirm that Xcode shows:
   - choose your signing team;
   - add the **App Groups** capability with `group.com.autoroute.app`;
   - `Native/AutoRoute.entitlements` as the Code Signing Entitlements file;
   - **Incoming Connections (Server)** under App Sandbox.
3. Select the **Auto Route Extension** target. The build script preconfigures its supplied entitlements; confirm that Xcode shows:
   - use the same signing team;
   - add the same App Group;
   - set its entitlements to `Native/AutoRouteExtension.entitlements`, or copy the App Group key into the generated extension entitlements file.
4. Confirm the containing app bundle identifier is `com.autoroute.app` and the extension bundle identifier is `com.autoroute.app.Extension`. If Xcode chose another suffix, update that identifier in `Native/AppDelegate.swift` before copying/building.
5. Build and run the **Auto Route** macOS scheme.
6. From the `AR` menu-bar item, choose **Install for Current Network…**. If macOS blocks automated setup, choose **Setup Help** and enter `http://127.0.0.1:17654/proxy.pac` under Network → Details → Proxies → Automatic Proxy Configuration.
7. Choose **Open Safari Extension Settings**, enable Auto Route, allow access to all websites, then configure the remote proxy in the extension’s Settings page.
8. Enable **Start at Login** from the `AR` menu. The companion consumes no proxy bandwidth itself and only serves the small PAC script locally.

To remove Auto Route cleanly, choose **Restore Previous Proxy Setting…** before deleting the app.
