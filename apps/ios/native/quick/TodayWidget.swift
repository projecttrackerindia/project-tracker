// The Today widget (WidgetKit scaffold): today's tasks, the next meeting with Join, the check-in ring. Add a Widget Extension target and
// an App Group (group.in.projecttracker.shared); the app writes the same snapshot as Android's WidgetBridge into the group's UserDefaults
// under "glance", then calls WidgetCenter.shared.reloadAllTimelines().
import WidgetKit
import SwiftUI

struct Glance: Codable { struct Task: Codable { let title: String }; struct Meeting: Codable { let title: String; let time: String; let link: String }
    var tasks: [Task] = []; var meeting: Meeting?; var checkInPercent: Int = 0; var checkInLabel: String = "" }

struct GlanceEntry: TimelineEntry { let date: Date; let glance: Glance }

struct GlanceProvider: TimelineProvider {
    private func load() -> Glance {
        guard let data = UserDefaults(suiteName: "group.in.projecttracker.shared")?.data(forKey: "glance"),
              let g = try? JSONDecoder().decode(Glance.self, from: data) else { return Glance() }
        return g
    }
    func placeholder(in context: Context) -> GlanceEntry { GlanceEntry(date: .now, glance: Glance()) }
    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) { completion(GlanceEntry(date: .now, glance: load())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        completion(Timeline(entries: [GlanceEntry(date: .now, glance: load())], policy: .after(.now.addingTimeInterval(30 * 60))))
    }
}

struct TodayWidgetView: View {
    let entry: GlanceEntry
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("TODAY · \(entry.glance.tasks.count)").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(Array(entry.glance.tasks.prefix(3).enumerated()), id: \.offset) { _, t in
                    Label(t.title, systemImage: "circle").font(.subheadline).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing) {
                Gauge(value: Double(entry.glance.checkInPercent), in: 0...100) { EmptyView() }.gaugeStyle(.accessoryCircularCapacity).tint(.green)
                Spacer(minLength: 0)
                if let m = entry.glance.meeting, let url = URL(string: "projecttracker:/" + m.link) {
                    Link(destination: url) { Text("Join \(m.time)").font(.subheadline.weight(.semibold)).padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(Color.blue)).foregroundStyle(.white) }
                }
            }
        }
        .containerBackground(.background, for: .widget)
    }
}

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TodayWidget", provider: GlanceProvider()) { TodayWidgetView(entry: $0) }
            .configurationDisplayName("Today").description("Today's work, your next meeting and your day.")
            .supportedFamilies([.systemMedium])
    }
}
