import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { NotetakerChoice } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';
import { meetApi } from './meetApi';

/**
 * The notetaker for this meeting: none, transcription, or transcription with spoken suggestions when something is being missed. It is the
 * project's agent in the meeting, so it needs a project with its agent allowed to read meetings; what is not possible says why.
 */
export function NotetakerPicker({ projectId, value, onChange }: { projectId: string | null; value: NotetakerChoice; onChange: (v: NotetakerChoice) => void }) {
  const q = useWsQuery(['meet', 'notetaker', projectId ?? 'none'], () => meetApi.notetaker(projectId!), { enabled: !!projectId, staleTime: 30_000 });
  const r = q.data;
  useEffect(() => {
    // A choice the project cannot honour falls back to what it can.
    if (!r) return;
    if (!r.available && value !== 'off') onChange('off');
    else if (value === 'voice' && !r.voiceAvailable) onChange('transcript');
  }, [r, value, onChange]);
  if (!projectId) return (
    <fieldset className="mt-notetaker">
      <legend>Notetaker</legend>
      <p className="mt-hint">Choose a project to bring the notetaker. Its notes and follow-ups are kept in that project.</p>
    </fieldset>
  );
  const options: { key: NotetakerChoice; label: string; text: string; ok: boolean; why?: string | null }[] = [
    { key: 'off', label: 'Not needed', text: 'Nobody listens or records.', ok: true },
    { key: 'transcript', label: 'Transcription', text: 'Listens, writes the transcript and the minutes, and stays quiet.', ok: !!r?.available, why: r?.reason },
    { key: 'voice', label: 'Transcription + voice suggestions', text: 'Also speaks up, briefly, when an agenda point, an owner or a date is being missed.', ok: !!r?.voiceAvailable, why: r?.voiceReason },
  ];
  return (
    <fieldset className="mt-notetaker" aria-busy={q.isLoading}>
      <legend>Notetaker</legend>
      <div className="mt-choices" role="radiogroup" aria-label="Notetaker">
        {options.map((o) => (
          <label key={o.key} className={`mt-choice${value === o.key ? ' on' : ''}${o.ok ? '' : ' off'}`}>
            <input type="radio" name="notetaker" value={o.key} checked={value === o.key} disabled={!o.ok} onChange={() => onChange(o.key)} />
            <span><b>{o.label}</b><small>{o.ok || !o.why ? o.text : o.why}</small></span>
          </label>
        ))}
      </div>
      {r && !r.available && r.canSwitchOn && <p className="mt-hint"><Link to={`/projects/${projectId}?tab=agent`}>Open the project's agent settings</Link></p>}
    </fieldset>
  );
}

