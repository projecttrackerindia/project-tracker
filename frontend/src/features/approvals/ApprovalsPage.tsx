import { useNavigate } from 'react-router-dom';
import { CalmGo, CalmHero, CalmPage } from '../../components/calm';

/**
 * Approvals (formerly Inbox): what is waiting on you to approve, grant, decide or review. Placeholder route from the calm shell; the
 * Approvals page agent replaces this body. Until then the same rows stay reachable on Today.
 */
export function ApprovalsPage() {
  const nav = useNavigate();
  return (
    <CalmPage layout="center" label="Approvals">
      <CalmHero title="Approvals." second=" What waits on you." sub="Approvals, access requests, decisions and reviews. They are on Today for now."
        action={<CalmGo onClick={() => nav('/')}>Open Today</CalmGo>} />
    </CalmPage>
  );
}
