import SafariServices
import os.log

private let appGroupIdentifier = "group.com.autoroute.app"
private let pacScriptKey = "AutoRoutePACScript"
private let routingEnabledKey = "AutoRouteEnabled"
private let serverHeartbeatKey = "AutoRouteServerHeartbeat"

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let logger = Logger(subsystem: "com.autoroute.app.Extension", category: "NativeMessaging")

    func beginRequest(with context: NSExtensionContext) {
        guard
            let item = context.inputItems.first as? NSExtensionItem,
            let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any]
        else {
            complete(context, payload: ["ok": false, "message": "Invalid native message"])
            return
        }

        guard message["type"] as? String == "applyRouting" else {
            complete(context, payload: ["ok": false, "message": "Unknown native message"])
            return
        }

        let defaults = UserDefaults(suiteName: appGroupIdentifier) ?? .standard
        let pacScript = message["pacScript"] as? String
            ?? "function FindProxyForURL(url, host) { return 'DIRECT'; }"
        let enabled = message["enabled"] as? Bool ?? false

        defaults.set(pacScript, forKey: pacScriptKey)
        defaults.set(enabled, forKey: routingEnabledKey)
        defaults.synchronize()

        let heartbeat = defaults.double(forKey: serverHeartbeatKey)
        let serverReady = Date().timeIntervalSince1970 - heartbeat < 35
        logger.info("Stored updated PAC routing rules; serverReady=\(serverReady)")

        complete(context, payload: [
            "ok": true,
            "serverReady": serverReady,
            "message": serverReady
                ? "Safari routing rules updated"
                : "Rules saved; open the Auto Route companion app"
        ])
    }

    private func complete(_ context: NSExtensionContext, payload: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
