import { useNavigate, useParams } from 'react-router-dom';
import { PlaceTabs } from '../../components/v2/PlaceTabs';
import { useAuth, useCan, useModule } from '../../stores/auth';
import { DocTrackerPage } from '../doctracker/DocTrackerPage';
import { DocumentPage } from '../documents/DocumentPage';
import { VaultPage } from '../vault/VaultPage';

/**
 * PLACEHOLDER (v2 shell, wave 1): Library with its tabs Docs · Vault, showing today's DocTracker, document page and Vault until the Library
 * builder replaces this file. Contract: export `LibraryPage`; routes `/library`, `/library/:section` (docs | vault) and
 * `/library/:section/:id`; `/library/docs?new=1&title=…` and `/library/vault?new=item&title=…` start a new one.
 */
export function LibraryPage() {
  const { section, id } = useParams();
  const nav = useNavigate();
  const docs = useModule('documents') > 0;
  const canVault = useCan('vault.use');
  const guest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const vault = canVault && !guest;
  const tabs = [...(docs ? [{ id: 'docs' as const, label: 'Docs' }] : []), ...(vault ? [{ id: 'vault' as const, label: 'Vault' }] : [])];
  const tab = section === 'vault' && vault ? 'vault' : docs ? 'docs' : 'vault';
  if (tab === 'docs' && id) return <DocumentPage />;
  return (
    <>
      <PlaceTabs label="Library" options={tabs} value={tab} onChange={(t) => nav(`/library/${t}`)} />
      {tab === 'vault' ? <VaultPage /> : <DocTrackerPage />}
    </>
  );
}
