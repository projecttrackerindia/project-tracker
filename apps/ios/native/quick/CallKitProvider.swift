// Incoming calls through CallKit (scaffold). Needs: the Voice over IP background mode, a PushKit VoIP certificate/key in the Apple
// Developer account, and the server sending VoIP pushes for ringing calls (see docs/quick-actions-native.md). CallKit shows the system's own
// call screen with Answer / Decline; "Reply with message" is offered by the missed-call notification's Message button.
import CallKit
import PushKit
import Foundation

final class CallKitProvider: NSObject, CXProviderDelegate, PKPushRegistryDelegate {
    static let shared = CallKitProvider()
    private let provider: CXProvider
    private let registry = PKPushRegistry(queue: .main)
    private var calls: [UUID: (callId: String, link: String)] = [:]

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        // Send credentials.token (hex) to the server as this device's VoIP token (endpoint "voip:" + token) - a server change still to make.
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let d = payload.dictionaryPayload
        let id = UUID()
        calls[id] = (d["call"] as? String ?? "", d["link"] as? String ?? "/")
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: d["title"] as? String ?? "ProjectTracker call")
        update.hasVideo = (d["video"] as? Bool) ?? false
        provider.reportNewIncomingCall(with: id, update: update) { _ in completion() }   // must be reported for every VoIP push
    }

    func providerDidReset(_ provider: CXProvider) { calls.removeAll() }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        if let c = calls[action.callUUID] { NotificationCenter.default.post(name: .init("pt-open-link"), object: c.link) }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        calls.removeValue(forKey: action.callUUID)
        action.fulfill()
    }
}
