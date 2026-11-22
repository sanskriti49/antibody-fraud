import type { Playbook } from '../api';
import { dateTime, rule } from '../format';
import { Markdown } from '../markdown';
import { Card, Empty } from './ui';

const kbLabel: Record<string, string> = { completed: 'Indexed in Meko', local: 'Local only', indexing: 'Indexing in Meko', awaiting_upload: 'Uploading', failed: 'Upload failed' };

export function PlaybookList({ items, selected, onSelect }: { items: Playbook[]; selected: string | null; onSelect: (id: string) => void }) {
  if (!items.length) return <Empty>No playbooks loaded.</Empty>;
  return (
    <div>
      {items.map((item) => (
        <button key={item.id} className={'row' + (item.id === selected ? ' selected' : '')} onClick={() => onSelect(item.id)}>
          <div className="row-title"><span>{item.title}</span></div>
          <div className="row-side"><span className={'badge ' + (item.knowledgeBase === 'completed' ? 'memory' : 'neutral')}>{kbLabel[item.knowledgeBase] ?? item.knowledgeBase}</span></div>
          <div className="row-meta"><span>v{item.version}</span><span>used in {item.cases} cases</span></div>
        </button>
      ))}
    </div>
  );
}

export function PlaybookDetail({ playbook }: { playbook: Playbook }) {
  return (
    <div>
      <div className="detail-head">
        <div>
          <h1>{playbook.title}</h1>
          <div className="facts"><span className="mono">{playbook.id}</span><span>version {playbook.version}</span>
            <span>checksum <span className="mono">{playbook.checksum.slice(0, 12)}</span></span><span>loaded {dateTime(playbook.loadedAt)}</span></div>
        </div>
        <span className={'badge large ' + (playbook.knowledgeBase === 'completed' ? 'memory' : 'neutral')}>{kbLabel[playbook.knowledgeBase] ?? playbook.knowledgeBase}</span>
      </div>
      <Card title="When it applies" aside={<span className="note">any one trigger, all of its rules in the session</span>}>
        {playbook.triggers.map((trigger, index) => (
          <div key={index} className="path">{trigger.map((id, inner) => <span key={id} style={{ display: 'contents' }}>
            {inner > 0 && <span className="via">+</span>}<span className="rule-chip">{rule(id)}</span></span>)}</div>
        ))}
      </Card>
      <Card title="Approved text" aside={<span className="note">read-only context; never changes an action</span>}>
        <Markdown text={playbook.body} />
      </Card>
    </div>
  );
}
