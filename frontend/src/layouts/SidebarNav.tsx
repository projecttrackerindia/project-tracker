import { useMemo, useState, type CSSProperties } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent, type Modifier,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '../components/Icon';
import { AgentMark } from '../components/AgentMark';
import { toast } from '../stores/ui';
import { navKey, type NavDef, type NavGroup } from './navigation';
import { arrange, moved, toggle, useNavPrefs, type NavSection } from './navPrefs';
import './sidebar.css';

/** Dragging only moves up and down, inside the sidebar. */
const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * The sidebar's places, as this person arranged them: drag the handle to reorder a section (or the pinned places), fold a section away by
 * its title, and in Customize pin places to the top or hide the ones they never use. Everything is saved with their account.
 */
export function SidebarNav({ groups, collapsed, onNavigate }: { groups: NavGroup[]; collapsed: boolean; onNavigate: () => void }) {
  const { pathname } = useLocation();
  const { prefs, update, reset } = useNavPrefs();
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const sections = useMemo(() => arrange(groups, prefs, editing), [groups, prefs, editing]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sectionOf = (key: string) => sections.find((s) => s.items.some((i) => navKey(i) === key));
  const isOn = (i: NavDef) => (i.match ? i.match(pathname) : i.end ? pathname === i.to : pathname === i.to.split('?')[0] || pathname.startsWith(`${i.to.split('?')[0]}/`));

  const onEnd = (e: DragEndEvent) => {
    setDragging(null);
    const from = String(e.active.id), to = e.over ? String(e.over.id) : null;
    if (!to || from === to) return;
    const section = sectionOf(from);
    if (!section || !section.items.some((i) => navKey(i) === to)) return;   // only inside its own section
    update((p) => moved(p, section, from, to));
  };
  const dragged = dragging ? sections.flatMap((s) => s.items).find((i) => navKey(i) === dragging) : null;

  return (
    <nav className={`sidebar-nav ${editing ? 'editing' : ''}`} aria-label="Main navigation">
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[vertical]}
        onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
        {sections.map((s) => (
          <Section key={s.title} s={s} collapsedSidebar={collapsed} editing={editing} isOn={isOn} onNavigate={onNavigate}
            hidden={prefs.hidden} pinned={prefs.pinned}
            onFold={() => update((p) => ({ ...p, collapsed: toggle(p.collapsed, s.title) }))}
            onPin={(k) => update((p) => ({ ...p, pinned: p.pinned.includes(k) ? p.pinned.filter((x) => x !== k) : p.pinned.length >= 8 ? p.pinned : [...p.pinned, k], hidden: p.hidden.filter((x) => x !== k) }))}
            onHide={(k) => update((p) => ({ ...p, hidden: toggle(p.hidden, k), pinned: p.pinned.filter((x) => x !== k) }))} />
        ))}
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }}>
          {dragged ? <div className="nav-item nav-drag-ghost">{dragged.id === 'agents' ? <AgentMark size={20} /> : <Icon name={dragged.icon} />}<span>{dragged.label}</span><Icon name="grip" size={14} /></div> : null}
        </DragOverlay>
      </DndContext>
      {!collapsed && (
        <div className="nav-customize">
          {editing ? (
            <>
              <button type="button" className="nav-customize-btn primary" onClick={() => setEditing(false)}><Icon name="check" size={14} />Done</button>
              <button type="button" className="nav-customize-btn" onClick={() => { reset(); toast('The sidebar is back to its standard layout.'); }}><Icon name="undo" size={14} />Reset</button>
            </>
          ) : (
            <button type="button" className="nav-customize-btn ghost" onClick={() => setEditing(true)} title="Pin, hide and reorder the places in your sidebar"><Icon name="settings" size={14} />Customize</button>
          )}
        </div>
      )}
      {editing && <p className="nav-customize-tip">Drag <Icon name="grip" size={12} /> to reorder · <Icon name="star" size={12} /> pins to the top · <Icon name="eye" size={12} /> shows or hides. Saved to your account.</p>}
    </nav>
  );
}

function Section({ s, collapsedSidebar, editing, isOn, onNavigate, hidden, pinned, onFold, onPin, onHide }: {
  s: NavSection; collapsedSidebar: boolean; editing: boolean; isOn: (i: NavDef) => boolean; onNavigate: () => void; hidden: string[]; pinned: string[];
  onFold: () => void; onPin: (key: string) => void; onHide: (key: string) => void;
}) {
  // A folded section still shows the place you are on, so you never lose where you are.
  const shown = s.collapsed && !editing ? s.items.filter(isOn) : s.items;
  return (
    <div className={`nav-section ${s.pinned ? 'nav-pinned' : ''} ${s.collapsed ? 'folded' : ''}`}>
      {collapsedSidebar ? <div className="nav-section-title">{s.title}</div> : (
        <button type="button" className="nav-section-title nav-section-toggle" aria-expanded={!s.collapsed} onClick={onFold}>
          {s.pinned && <Icon name="star" size={11} />}<span>{s.title}</span><Icon name="chevronD" size={12} />
          {s.collapsed && <em>{s.items.length}</em>}
        </button>
      )}
      <SortableContext items={shown.map(navKey)} strategy={verticalListSortingStrategy}>
        {shown.map((i) => (
          <Item key={navKey(i)} i={i} on={isOn(i)} editing={editing} draggable={!collapsedSidebar} onNavigate={onNavigate}
            hidden={hidden.includes(navKey(i))} pinned={pinned.includes(navKey(i))} inPinned={!!s.pinned}
            onPin={() => onPin(navKey(i))} onHide={() => onHide(navKey(i))} />
        ))}
      </SortableContext>
    </div>
  );
}

function Item({ i, on, editing, draggable, onNavigate, hidden, pinned, inPinned, onPin, onHide }: {
  i: NavDef; on: boolean; editing: boolean; draggable: boolean; onNavigate: () => void; hidden: boolean; pinned: boolean; inPinned: boolean;
  onPin: () => void; onHide: () => void;
}) {
  const key = navKey(i);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: key, disabled: !draggable });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className={`nav-row ${isDragging ? 'dragging' : ''} ${hidden ? 'is-hidden' : ''}`} data-nav={key}>
      {draggable && (
        <button type="button" ref={setActivatorNodeRef} className="nav-grip" aria-label={`Move ${i.label}`} title="Drag to reorder" {...attributes} {...listeners}>
          <Icon name="grip" size={13} />
        </button>
      )}
      <NavLink to={i.to} end={i.end} title={editing && i.hint ? `${i.label} - ${i.hint}` : i.label} onClick={onNavigate} draggable={false}
        className={`nav-item ${on ? 'active' : ''}`} aria-current={on ? 'page' : undefined}>
        {i.id === 'agents' ? <AgentMark size={20} animated /> : <Icon name={i.icon} />}<span>{i.label}</span>
        {!editing && !!i.badge && <em className={`nav-count ${i.to === '/reminders' ? 'nav-count-alarm' : ''}`} aria-label={i.to === '/reminders' ? `${i.badge} need attention` : `${i.badge} unread`}>{i.badge > 99 ? '99+' : i.badge}</em>}
      </NavLink>
      {editing && (
        <span className="nav-tools">
          <button type="button" className={`nav-tool ${pinned ? 'on' : ''}`} aria-pressed={pinned} aria-label={pinned ? `Unpin ${i.label}` : `Pin ${i.label}`} title={pinned ? 'Unpin' : 'Pin to the top'} onClick={onPin}><Icon name="star" size={13} /></button>
          {!inPinned && <button type="button" className={`nav-tool ${hidden ? 'off' : ''}`} aria-pressed={!hidden} aria-label={hidden ? `Show ${i.label}` : `Hide ${i.label}`} title={hidden ? 'Show it again' : 'Hide it'} onClick={onHide}><Icon name={hidden ? 'eyeOff' : 'eye'} size={13} /></button>}
        </span>
      )}
    </div>
  );
}

