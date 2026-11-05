// Quick actions on iOS (scaffold: add to the App target, call QuickActions.register() in AppDelegate's didFinishLaunching).
// The server's push sets aps.category to "QA_" + the buttons joined by "_" (FcmSender), e.g. QA_APPROVE_REJECT, QA_REPLY_READ,
// QA_DONE_SNOOZE_OPEN. Each category is registered here; pressing a button POSTs to /api/v1/notification-actions/{qa} with no sign-in.
import Foundation
import UserNotifications
import UIKit

enum QuickActions {
    static let base = URL(string: "https://projecttracker.in")!   // set to the server the app talks to
    static let labels: [String: String] = [
        "approve": "Approve", "reject": "Reject", "reply": "Reply", "read": "Mark read", "done": "Done", "snooze": "Snooze 1h", "open": "Open",
        "join": "Join", "late": "Running late", "accept": "Accept", "decline": "Decline", "maybe": "Maybe", "review": "Review", "discuss": "Discuss",
        "callback": "Call back", "message": "Message", "answer": "Answer",
    ]
    static let opens: Set<String> = ["open", "join", "review", "discuss", "callback", "answer"]
    /** Every button set the server sends (QuickActions.For). */
    static let sets: [[String]] = [["approve", "reject"], ["reply", "read"], ["done", "snooze", "open"], ["done", "snooze"], ["join", "late"],
        ["accept", "decline", "maybe"], ["review"], ["callback", "message"], ["answer", "decline", "message"], ["accept", "discuss"]]

    static func register() {
        let categories = sets.map { set -> UNNotificationCategory in
            let actions: [UNNotificationAction] = set.map { a in
                let title = labels[a] ?? a
                if a == "reply" || a == "reject" || a == "message" {
                    return UNTextInputNotificationAction(identifier: a, title: title, options: a == "reject" ? [.destructive, .authenticationRequired] : [],
                        textInputButtonTitle: title, textInputPlaceholder: a == "reject" ? "Reason for rejecting" : "Reply…")
                }
                var options: UNNotificationActionOptions = opens.contains(a) ? [.foreground] : []
                if a == "approve" { options.insert(.authenticationRequired) }   // Face ID / passcode before approving from the lock screen
                return UNNotificationAction(identifier: a, title: title, options: options)
            }
            return UNNotificationCategory(identifier: "QA_" + set.map { $0.uppercased() }.joined(separator: "_"), actions: actions, intentIdentifiers: [])
        }
        UNUserNotificationCenter.current().setNotificationCategories(Set(categories))
    }

    /** Call from userNotificationCenter(_:didReceive:withCompletionHandler:). Returns the link to open in the app, if any. */
    static func handle(_ response: UNNotificationResponse, done: @escaping (String?) -> Void) {
        let info = response.notification.request.content.userInfo
        guard let qa = info["qa"] as? String, labels[response.actionIdentifier] != nil else { done(info["link"] as? String); return }
        let action = response.actionIdentifier
        let link = info["link"] as? String ?? "/"
        let text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if opens.contains(action) { post(qa, ["action": "read"]) { _ in }; done(link); return }
        if (action == "reply" || action == "reject" || action == "message") && text.isEmpty { done(link); return }
        var body: [String: Any] = ["action": action == "message" ? "reply" : action]
        if !text.isEmpty { body["text"] = text }
        if action == "snooze" { body["preset"] = "1h" }
        post(qa, body) { ok in done(ok ? nil : link) }
    }

    private static func post(_ qa: String, _ body: [String: Any], _ done: @escaping (Bool) -> Void) {
        let key = qa.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.")))!
        var req = URLRequest(url: base.appendingPathComponent("api/v1/notification-actions/\(key)"))
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { _, res, _ in done(((res as? HTTPURLResponse)?.statusCode ?? 500) < 300) }.resume()
    }
}
