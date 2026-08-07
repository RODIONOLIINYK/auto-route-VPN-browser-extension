import Cocoa
import Network
import SafariServices
import ServiceManagement
import SystemConfiguration

private let appGroupIdentifier = "group.com.autoroute.app"
private let pacScriptKey = "AutoRoutePACScript"
private let routingEnabledKey = "AutoRouteEnabled"
private let serverHeartbeatKey = "AutoRouteServerHeartbeat"
private let pacPort: NWEndpoint.Port = 17654
private let pacURL = "http://127.0.0.1:17654/proxy.pac"

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var server: PACServer?
    private var heartbeatTimer: Timer?
    private let defaults = UserDefaults(suiteName: appGroupIdentifier) ?? .standard

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NSApp.windows.forEach { $0.close() }

        configureStatusItem()
        startServer()
        writeHeartbeat()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.writeHeartbeat()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        heartbeatTimer?.invalidate()
        defaults.set(0, forKey: serverHeartbeatKey)
    }

    private func configureStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.title = "AR"
        statusItem.button?.toolTip = "Auto Route for Safari"

        let menu = NSMenu()
        let status = NSMenuItem(title: "PAC server starting…", action: nil, keyEquivalent: "")
        status.tag = 100
        menu.addItem(status)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Install for Current Network…", action: #selector(installForCurrentNetwork), keyEquivalent: "i"))
        menu.addItem(NSMenuItem(title: "Restore Previous Proxy Setting…", action: #selector(restorePreviousProxy), keyEquivalent: "r"))
        menu.addItem(NSMenuItem(title: "Copy PAC URL", action: #selector(copyPACURL), keyEquivalent: "c"))
        menu.addItem(NSMenuItem(title: "Setup Help", action: #selector(showSetupHelp), keyEquivalent: "?"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open Safari Extension Settings", action: #selector(openSafariSettings), keyEquivalent: "s"))

        if #available(macOS 13.0, *) {
            let login = NSMenuItem(title: "Start at Login", action: #selector(toggleStartAtLogin(_:)), keyEquivalent: "")
            login.state = SMAppService.mainApp.status == .enabled ? .on : .off
            menu.addItem(login)
        }

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Auto Route", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    private func startServer() {
        do {
            server = try PACServer(defaults: defaults)
            server?.start()
            statusItem.menu?.item(withTag: 100)?.title = "PAC server: running locally"
        } catch {
            statusItem.menu?.item(withTag: 100)?.title = "PAC server failed to start"
            presentError("Could not start the local PAC server: \(error.localizedDescription)")
        }
    }

    private func writeHeartbeat() {
        defaults.set(Date().timeIntervalSince1970, forKey: serverHeartbeatKey)
        defaults.synchronize()
    }

    @objc private func installForCurrentNetwork() {
        guard let service = primaryNetworkServiceName() else {
            presentError("Auto Route could not identify the active macOS network service. Use Setup Help to configure the PAC URL manually.")
            return
        }

        capturePreviousProxy(for: service)
        let commands = [
            "/usr/sbin/networksetup -setautoproxyurl \(shellQuote(service)) \(shellQuote(pacURL))",
            "/usr/sbin/networksetup -setautoproxystate \(shellQuote(service)) on"
        ].joined(separator: " && ")

        do {
            try runElevated(commands)
            defaults.set(service, forKey: "AutoRouteConfiguredService")
            showMessage("Safari routing is installed for \(service). Keep this small menu-bar app running; Start at Login is recommended.")
        } catch {
            presentError("Automatic setup was not permitted. Use Setup Help and enter this PAC URL manually:\n\n\(pacURL)")
        }
    }

    @objc private func restorePreviousProxy() {
        let service = defaults.string(forKey: "AutoRouteConfiguredService") ?? primaryNetworkServiceName()
        guard let service else {
            presentError("No configured network service was found.")
            return
        }

        let previousURL = defaults.string(forKey: "AutoRoutePreviousPACURL") ?? ""
        let previousEnabled = defaults.bool(forKey: "AutoRoutePreviousPACEnabled")
        var commands: [String] = []
        if !previousURL.isEmpty {
            commands.append("/usr/sbin/networksetup -setautoproxyurl \(shellQuote(service)) \(shellQuote(previousURL))")
        }
        commands.append("/usr/sbin/networksetup -setautoproxystate \(shellQuote(service)) \(previousEnabled ? "on" : "off")")

        do {
            try runElevated(commands.joined(separator: " && "))
            showMessage("The previous automatic proxy setting was restored for \(service).")
        } catch {
            presentError("macOS did not allow the previous proxy setting to be restored automatically.")
        }
    }

    private func capturePreviousProxy(for service: String) {
        guard defaults.object(forKey: "AutoRoutePreviousPACCaptured") == nil else { return }
        let output = runProcess("/usr/sbin/networksetup", ["-getautoproxyurl", service])
        let enabled = output.range(of: "Enabled: Yes", options: .caseInsensitive) != nil
        let urlLine = output.split(separator: "\n").first { $0.lowercased().hasPrefix("url:") }
        let url = urlLine.map { String($0.dropFirst(4)).trimmingCharacters(in: .whitespaces) } ?? ""
        defaults.set(true, forKey: "AutoRoutePreviousPACCaptured")
        defaults.set(enabled, forKey: "AutoRoutePreviousPACEnabled")
        defaults.set(url == "(null)" ? "" : url, forKey: "AutoRoutePreviousPACURL")
    }

    private func primaryNetworkServiceName() -> String? {
        guard let store = SCDynamicStoreCreate(nil, "Auto Route" as CFString, nil, nil),
              let global = SCDynamicStoreCopyValue(store, "State:/Network/Global/IPv4" as CFString) as? [String: Any],
              let serviceID = global["PrimaryService"] as? String,
              let preferences = SCPreferencesCreate(nil, "Auto Route" as CFString, nil),
              let service = SCNetworkServiceCopy(preferences, serviceID as CFString),
              let name = SCNetworkServiceGetName(service)
        else { return nil }
        return name as String
    }

    private func runProcess(_ executable: String, _ arguments: [String]) -> String {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
            process.waitUntilExit()
            return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        } catch { return "" }
    }

    private func runElevated(_ shellCommand: String) throws {
        let escaped = shellCommand.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let source = "do shell script \"\(escaped)\" with administrator privileges"
        var errorInfo: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&errorInfo)
        if let errorInfo { throw NSError(domain: "AutoRouteSetup", code: 1, userInfo: errorInfo as? [String: Any]) }
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    @objc private func copyPACURL() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pacURL, forType: .string)
    }

    @objc private func showSetupHelp() {
        showMessage("Open System Settings → Network → your active connection → Details → Proxies. Enable Automatic Proxy Configuration and enter:\n\n\(pacURL)\n\nThen enable Auto Route in Safari and keep the companion running.")
    }

    @objc private func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: "com.autoroute.app.Extension") { error in
            if let error { DispatchQueue.main.async { self.presentError(error.localizedDescription) } }
        }
    }

    @available(macOS 13.0, *)
    @objc private func toggleStartAtLogin(_ sender: NSMenuItem) {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
                sender.state = .off
            } else {
                try SMAppService.mainApp.register()
                sender.state = .on
            }
        } catch { presentError(error.localizedDescription) }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func showMessage(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Auto Route"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func presentError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Auto Route"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

private final class PACServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "com.autoroute.pac-server", qos: .utility)
    private let defaults: UserDefaults

    init(defaults: UserDefaults) throws {
        self.defaults = defaults
        listener = try NWListener(using: .tcp, on: pacPort)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in self?.handle(connection) }
        listener.start(queue: queue)
    }

    private func handle(_ connection: NWConnection) {
        guard isLoopback(connection.endpoint) else { connection.cancel(); return }
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self, let data, let request = String(data: data, encoding: .utf8) else {
                connection.cancel(); return
            }
            let wantsPAC = request.hasPrefix("GET /proxy.pac ") || request.hasPrefix("GET / ")
            let body = wantsPAC ? self.currentPAC() : "Not found"
            let status = wantsPAC ? "200 OK" : "404 Not Found"
            let response = "HTTP/1.1 \(status)\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nCache-Control: no-store, max-age=0\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
            connection.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in connection.cancel() })
        }
    }

    private func currentPAC() -> String {
        guard defaults.bool(forKey: routingEnabledKey) else {
            return "function FindProxyForURL(url, host) { return 'DIRECT'; }"
        }
        return defaults.string(forKey: pacScriptKey)
            ?? "function FindProxyForURL(url, host) { return 'DIRECT'; }"
    }

    private func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        let value = "\(host)"
        return value == "127.0.0.1" || value == "::1" || value == "localhost"
    }
}
