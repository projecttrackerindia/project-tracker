import { get } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
interface Delivery { id:string; category:string; state:string; reason:string|null; createdAt:string; availableAt:string; acceptedAt:string|null; providerStatusAt:string|null }
const labels: Record<string,string> = {queued:'Scheduled',preparing:'Checking delivery',sending:'Waiting for provider',accepted:'Accepted by provider',sent:'Sent',delivered:'Delivered',read:'Read',failed:'Delivery failed',rejected:'Rejected by provider',unknown:'Outcome uncertain',suppressed:'Not sent'};
const reasons: Record<string,string> = {QUIET_HOURS:'Waiting until quiet hours end.',DAILY_DELIVERY_CAP:'Daily delivery allowance reached.',RECIPIENT_COOLDOWN:'Combining delivery pacing for this member.',PROVIDER_NOT_READY:'Waiting for provider readiness.',PROVIDER_CHECK_COOLDOWN:'Waiting for a provider check.',PROVIDER_CHECK_CHANGED:'Provider settings changed.',NOTIFICATION_EXPIRED:'The notification is no longer current.',RECIPIENT_NOT_AUTHORIZED:'Recipient access or notification consent changed.',CONNECTION_DISCONNECTED:'The business connection was removed.',PROVIDER_READINESS_FAILED:'Provider setup needs review.',PROVIDER_OUTCOME_UNKNOWN:'Waiting for a signed provider receipt. This message will not be automatically sent again.',PROVIDER_REJECTED:'The provider rejected this attempt.',PROVIDER_DELIVERY_FAILED:'The provider reported delivery failure.',QUIET_HOURS_INVALID:'Quiet-hour settings need review.',PROVIDER_ACK_MISMATCH:'Provider evidence needs review.'};
export function WhatsAppDeliveryHistory({ administrator=false }: { administrator?:boolean }) {
  const history=useWsQuery(['whatsapp',administrator?'organization-deliveries':'my-deliveries'],()=>get<Delivery[]>(administrator?'/integrations/whatsapp/deliveries':'/me/whatsapp-contact/deliveries'),
    {refetchInterval:q=>q.state.data?.some(x=>['preparing','sending'].includes(x.state))?10000:false});
  return <section aria-label={administrator?'Organization notification delivery':'Your notification delivery'}>
    <h4>{administrator?'Notification delivery':'Your recent notifications'}</h4>
    <p>Provider acceptance is followed by separate delivery receipts. Uncertain attempts are kept for reconciliation.</p>
    {history.isLoading&&<p role="status">Loading delivery history...</p>}
    {history.error&&<p role="alert">{history.error.message}</p>}
    {history.data?.length===0&&<p>No notification deliveries recorded.</p>}
    <ul className="whatsapp-delivery-history" style={{listStyle:"none",padding:0}}>{history.data?.map(item=><li key={item.id} className="integration-inline-guide" style={{display:"grid",gap:6,marginBottom:10,padding:12}}>
      <b>{({task_assignment:'Task assignment',overdue:'Overdue task',support_update:'Support update'} as Record<string,string>)[item.category]||'Notification'}</b>
      <span>{labels[item.state]||'Needs review'}</span>
      <small>{new Date(item.providerStatusAt||item.acceptedAt||item.createdAt).toLocaleString()}</small>
      {item.reason&&<p>{reasons[item.reason]||'Review this delivery with your administrator.'}</p>}
    </li>)}</ul>
  </section>;
}
