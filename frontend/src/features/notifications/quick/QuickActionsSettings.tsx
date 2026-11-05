import { useState } from 'react';
import { SGroup, SRow, SSwitch, STile } from '../../settings/Grouped';
import { quickActionsOn, setQuickActionsOn } from './quickPref';

/** Which notices carry buttons, in the person's words. Only urgent ones show them; everything else stays quiet and opens on a tap. */
const KINDS: { icon: string; color: string; title: string; buttons: string }[] = [
  { icon: '✓', color: '#34c759', title: 'Approvals', buttons: 'Approve · Reject (asks for a reason)' },
  { icon: '✉', color: '#0a84ff', title: 'Messages & mentions', buttons: 'Reply · Mark read' },
  { icon: '☐', color: '#5e5ce6', title: 'Tasks & action items', buttons: 'Done · Snooze 1h · Open' },
  { icon: '⏰', color: '#ff9f0a', title: 'Reminders', buttons: 'Done · Snooze' },
  { icon: '▣', color: '#30b0c7', title: 'Meetings', buttons: 'Join · Running late · Accept · Decline · Maybe' },
  { icon: '✆', color: '#28cd41', title: 'Calls', buttons: 'Answer · Decline · Reply with message · Call back' },
  { icon: '↦', color: '#ff375f', title: 'Date extensions', buttons: 'Accept · Discuss' },
];

export function QuickActionsSettings() {
  const [on, setOn] = useState(quickActionsOn());
  return (
    <SGroup label="Quick actions">
      <SRow icon={<STile color="#0071e3">⚡︎</STile>} title="Buttons on notifications" sub="Act from the banner, the lock screen or the desktop, without opening the app">
        <SSwitch on={on} label="Buttons on notifications" onChange={(v) => { setQuickActionsOn(v); setOn(v); }} />
      </SRow>
      {KINDS.map((k) => (
        <SRow key={k.title} icon={<STile color={k.color}>{k.icon}</STile>} title={k.title} sub={k.buttons} dim={!on} />
      ))}
    </SGroup>
  );
}
