import type { ReactNode } from 'react';

/** Minimal renderer for the approved playbook files: headings, bullet lists, paragraphs and **bold**. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
    part.startsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> :
    part.startsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part);
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>);
    list = [];
  };
  for (const line of text.split('\n')) {
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    const item = /^- (.+)$/.exec(line);
    if (item) { list.push(item[1]!); continue; }
    flush();
    if (heading) blocks.push(heading[1]!.length === 1 ? <h1 key={blocks.length}>{heading[2]}</h1> : <h2 key={blocks.length}>{heading[2]}</h2>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="markdown">{blocks}</div>;
}
