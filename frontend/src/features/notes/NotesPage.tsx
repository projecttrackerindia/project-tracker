import { useNavigate } from 'react-router-dom';
import { CalmGo, CalmHero, CalmPage } from '../../components/calm';

/** Notes: placeholder route from the calm shell; the Notes page agent replaces this body. Documents stay in the Library meanwhile. */
export function NotesPage() {
  const nav = useNavigate();
  return (
    <CalmPage layout="center" label="Notes">
      <CalmHero title="Notes." second=" Coming here soon." sub="Quick private notes with slash commands. Your documents are in the Library."
        action={<CalmGo onClick={() => nav('/library')}>Open Library</CalmGo>} />
    </CalmPage>
  );
}
