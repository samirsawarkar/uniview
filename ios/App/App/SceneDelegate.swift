import UIKit
import WebKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        // A cold start from "Open in UniView" or the share sheet.
        for context in connectionOptions.urlContexts { deliver(context.url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
        for context in URLContexts { deliver(context.url) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // MARK: - Files from other apps

    private static let maxBytes: Int64 = 2 * 1024 * 1024 * 1024

    /// Copy the document into a private temporary folder and hand it to the web UI as a same-origin URL.
    private func deliver(_ url: URL) {
        guard url.isFileURL else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
                if size > SceneDelegate.maxBytes { return }
                let dir = FileManager.default.temporaryDirectory
                    .appendingPathComponent("shared", isDirectory: true)
                    .appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let name = SceneDelegate.safeName(url.lastPathComponent)
                let copy = dir.appendingPathComponent(name)
                try FileManager.default.copyItem(at: url, to: copy)
                DispatchQueue.main.async { self.handToPage(path: copy.path, name: name, attempt: 0) }
            } catch {
                CAPLog.print("UniView could not open \(url): \(error)")
            }
        }
    }

    private func handToPage(path: String, name: String, attempt: Int) {
        guard let bridgeVC = window?.rootViewController as? CAPBridgeViewController,
              let bridge = bridgeVC.bridge,
              let web = bridgeVC.webView else { return }
        // Wait for the UI page; a script run before it loads would land in a document about to be replaced.
        if web.isLoading || web.url == nil {
            if attempt < 50 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.handToPage(path: path, name: name, attempt: attempt + 1) }
            }
            return
        }
        let base = bridge.config.localURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        // Encode each segment so names with "#", "?" or "%" are not cut off as a fragment or query.
        var segmentAllowed = CharacterSet.urlPathAllowed
        segmentAllowed.remove(charactersIn: "/?#%;")
        let encodedPath = path.split(separator: "/", omittingEmptySubsequences: true)
            .map { String($0).addingPercentEncoding(withAllowedCharacters: segmentAllowed) ?? "_" }
            .joined(separator: "/")
        let fileURL = base + "/_capacitor_file_/" + encodedPath
        guard let args = try? JSONSerialization.data(withJSONObject: [fileURL, name, ""]),
              let json = String(data: args, encoding: .utf8) else { return }
        let js = "(function(a){var u=a[0],n=a[1],m=a[2];if(window.__univiewOpenUrl){window.__univiewOpenUrl(u,n,m)}else{(window.__univiewPending=window.__univiewPending||[]).push({url:u,name:n,mime:m})}})(\(json))"
        web.evaluateJavaScript(js, completionHandler: nil)
    }

    private static func safeName(_ name: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|#%").union(.controlCharacters)
        var cleaned = name.components(separatedBy: bad).joined(separator: "_")
        if cleaned.hasPrefix(".") { cleaned = "_" + cleaned }
        if cleaned.isEmpty { cleaned = "shared-file" }
        return String(cleaned.suffix(120))
    }
}
