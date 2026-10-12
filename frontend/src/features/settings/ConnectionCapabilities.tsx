import { Icon } from '../../components/Icon';

export function ConnectionCapabilities({ items }: { items: { name: string; description: string; granted: boolean; available?: boolean }[] }) {
  return <ul className="connection-capabilities" aria-label="Account permissions">
    {items.map(item => <li key={item.name}><span className={`connection-capability-icon ${item.granted ? 'granted' : ''}`}><Icon name={item.granted ? 'checkCircle' : 'lock'} size={16} /></span><div><b>{item.name}</b><p>{item.description}</p></div><span className={`connection-permission ${item.granted ? 'granted' : ''}`}>{item.granted ? 'Allowed' : item.available === false ? 'Unavailable' : 'Optional'}</span></li>)}
  </ul>;
}
