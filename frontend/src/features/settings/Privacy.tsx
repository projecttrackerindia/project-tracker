import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { consentApi } from '../../api/endpoints';
import { Modal } from '../../components/ui';
import type { ConsentDocument } from '../../api/types';

/** Settings → Security row that lets anyone read the Terms of Service / Privacy Policy they're bound by. */
export function PrivacyRow() {
  const q = useQuery({ queryKey: ['consent', 'documents'], queryFn: consentApi.documents });
  const [viewing, setViewing] = useState<ConsentDocument | null>(null);
  return (
    <div className="setting-row" style={{ alignItems: 'flex-start' }}>
      <div className="setting-info">
        <h4>Terms & privacy</h4>
        <p>The legal documents you accepted to use this platform.</p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {q.data?.map((d) => (
          <button key={d.type} type="button" className="btn btn-ghost btn-sm" onClick={() => setViewing(d)}>{d.title}</button>
        ))}
      </div>
      {viewing && (
        <Modal size="lg" title={viewing.title} onClose={() => setViewing(null)} footer={<button type="button" className="btn btn-primary" onClick={() => setViewing(null)}>Close</button>}>
          <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{viewing.body}</p>
        </Modal>
      )}
    </div>
  );
}
