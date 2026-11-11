// The live call / meeting / check-in timer as a Live Activity (ActivityKit scaffold): on the lock screen and in the Dynamic Island.
// Add NSSupportsLiveActivities = YES to the app's Info.plist and this widget to the Widget Extension's bundle.
import ActivityKit
import WidgetKit
import SwiftUI

struct LiveTimerAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable { var since: Date; var detail: String }
    var kind: String   // "call", "meeting" or "checkin"
    var title: String
}

struct LiveTimerActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LiveTimerAttributes.self) { ctx in
            HStack {
                VStack(alignment: .leading) { Text(ctx.attributes.title).font(.headline); Text(ctx.state.detail).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Text(ctx.state.since, style: .timer).font(.title3.monospacedDigit())
            }.padding()
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Text(ctx.attributes.title).font(.headline) }
                DynamicIslandExpandedRegion(.trailing) { Text(ctx.state.since, style: .timer).monospacedDigit() }
            } compactLeading: { Image(systemName: ctx.attributes.kind == "call" ? "phone.fill" : ctx.attributes.kind == "meeting" ? "video.fill" : "clock") }
              compactTrailing: { Text(ctx.state.since, style: .timer).monospacedDigit().frame(width: 44) }
              minimal: { Image(systemName: "clock") }
        }
    }
}

enum LiveTimer {
    static func start(kind: String, title: String, since: Date, detail: String) throws -> Activity<LiveTimerAttributes> {
        try Activity.request(attributes: LiveTimerAttributes(kind: kind, title: title), content: .init(state: .init(since: since, detail: detail), staleDate: nil))
    }
}
