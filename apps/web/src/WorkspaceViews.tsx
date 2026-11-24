import { Activity, ArrowRight, ChevronDown, Download, FileText, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { plainMentionText } from '../../../packages/shared/mentions';
import type { Bootstrap, Memory, Page } from '../../../packages/shared/types';
import { api } from './api';
import { CodeBlock, downloadCode } from './CodeBlock';
import { filenameFor, showPreview } from '../../../packages/shared/artifacts';

import { Field, Heading, Modal } from './ui';
import { SkillLibrary } from './Skills';
export function Memories({
  data,
  act,
}: {
  data: Bootstrap;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState<Memory | null>();
  const [text, setText] = useState('');
  const [owner, setOwner] = useState('shared');
  const [category, setCategory] = useState<Memory['category']>('profile');
  return (
    <main className="page">
      <Heading
        eyebrow="THE THINGS THAT STICK"
        title="A little shared understanding."
        description="A shared profile for the team, with room for every bot’s own knowledge."
      >
        <button
          className="primary"
          onClick={() => {
            setEditing(null);
            setText('');
          }}
        >
          <Plus size={16} />
          Add a memory
        </button>
      </Heading>
      <div className="filter-row">
        <select
          aria-label="Filter memory"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All memories</option>
          <option value="shared">Shared profile</option>
          {data.bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <span className="subtle">
          Original memory is also preserved in each bot’s imported instructions.
        </span>
      </div>
      <div className="memory-grid">
        {data.memory
          .filter((m) => filter === 'all' || (filter === 'shared' ? !m.botId : m.botId === filter))
          .map((m) => (
            <article className="panel memory-card" key={m.id}>
              <div className="memory-top">
                <span className="tag">{m.category}</span>
                <span>
                  {m.botId ? data.bots.find((b) => b.id === m.botId)?.name : 'Shared with everyone'}
                </span>
                <button
                  className="icon-button"
                  aria-label="Edit memory"
                  onClick={() => {
                    setEditing(m);
                    setText(m.content);
                  }}
                >
                  <Pencil size={14} />
                </button>
              </div>
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
              <button
                className="text-button"
                onClick={() => {
                  if (
                    window.confirm(
                      'Remove this saved memory? Original imported instructions are kept.',
                    )
                  )
                    void act(() => api(`/memory/${m.id}`, 'DELETE'), 'Memory removed');
                }}
              >
                Remove memory
              </button>
            </article>
          ))}
      </div>
      {editing !== undefined && (
        <Modal
          title={editing ? 'Edit a memory' : 'Keep this in mind'}
          close={() => setEditing(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api(
                  editing ? `/memory/${editing.id}` : '/memory',
                  editing ? 'PUT' : 'POST',
                  editing
                    ? { content: text }
                    : {
                        botId: owner === 'shared' ? null : owner,
                        category: owner === 'shared' ? 'profile' : category,
                        content: text,
                      },
                );
                setEditing(undefined);
              }, 'Memory saved');
            }}
          >
            {!editing && (
              <>
                <Field label="Who remembers this?">
                  <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                    <option value="shared">Everyone · shared profile</option>
                    {data.bots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {owner !== 'shared' && (
                  <Field label="Memory type">
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value as Memory['category'])}
                    >
                      {['behavior', 'world', 'workstream'].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                )}
              </>
            )}
            <Field label="Memory">
              <textarea rows={10} required value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <div className="modal-footer">
              <button className="primary">Save memory</button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}

export function Skills({
  data,
  act,
}: {
  data: Bootstrap;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  return (
    <main className="page">
      <SkillLibrary data={data} act={act} />
    </main>
  );
}
export function Pages({ data }: { data: Bootstrap }) {
  const [selected, setSelected] = useState<Page>();
  const download = (page: Page) => {
    downloadCode(
      page.content,
      page.filename ?? filenameFor(page.language ?? page.format, page.title),
    );
  };
  return (
    <main className="page">
      <Heading
        eyebrow="IDEAS, WITH A PLACE TO LIVE"
        title="Pages from your team"
        description="Documents and little websites made by your bots, saved on your host."
      />
      {!data.pages.length ? (
        <div className="empty-panel">
          <FileText size={34} />
          <h2>A blank page is a good beginning.</h2>
          <p>Ask a bot to create a page. It will appear here, ready to preview or download.</p>
        </div>
      ) : (
        <div className="pages-grid">
          {data.pages.map((p) => (
            <article className="panel page-card" key={p.id}>
              <div className="page-thumbnail">
                <FileText size={44} />
                <span>{p.format.toUpperCase()}</span>
              </div>
              <h3>{p.title}</h3>
              <p>
                {data.bots.find((b) => b.id === p.botId)?.name} ·{' '}
                {new Date(p.createdAt).toLocaleDateString()}
              </p>
              <div>
                <button
                  className="secondary small"
                  onClick={() =>
                    p.format === 'html'
                      ? showPreview({
                          title: p.title,
                          content: p.content,
                          filename: p.filename ?? filenameFor('html', p.title),
                          language: 'html',
                          pageId: p.id,
                        })
                      : setSelected(p)
                  }
                >
                  Open page <ArrowRight size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Download ${p.title}`}
                  onClick={() => download(p)}
                >
                  <Download size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {selected && (
        <Modal title={selected.title} close={() => setSelected(undefined)} wide>
          {selected.format !== 'markdown' ? (
            <CodeBlock
              code={selected.content}
              language={selected.language}
              filename={selected.filename}
            />
          ) : (
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.content}</ReactMarkdown>
            </div>
          )}
          <div className="modal-footer">
            <button className="secondary" onClick={() => download(selected)}>
              <Download size={15} />
              Download
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

export function ActivityView({ data, chat }: { data: Bootstrap; chat: (id: string) => void }) {
  return (
    <main className="page">
      <Heading
        eyebrow="NO MYSTERY BEHIND THE MAGIC"
        title="Your team, in motion."
        description="A record of real model calls, handoffs, tools, and the occasional hiccup."
      />
      {!data.runs.length && (
        <div className="empty-panel">
          <Activity size={32} />
          <h2>Ready when you are.</h2>
          <p>Start a conversation to see your team at work.</p>
        </div>
      )}
      {data.runs.map((r) => (
        <details className="panel activity-card" key={r.id}>
          <summary>
            <span className={`status-badge ${r.status}`}>
              <span />
              {r.status}
            </span>
            <strong>{plainMentionText(r.prompt).slice(0, 95)}</strong>
            <span>{data.bots.find((b) => b.id === r.botId)?.name}</span>
            <small>{new Date(r.startedAt).toLocaleString()}</small>
            <ChevronDown size={16} />
          </summary>
          <div className="activity-detail">
            <div className="subtle">
              {r.modelId} · {r.tokens.toLocaleString()} tokens
              {r.rating ? ` · ${r.rating}/5 rating` : ''}
            </div>
            {r.events.map((e, i) => (
              <div className={`trace-event ${e.kind}`} key={i}>
                <span />
                {e.text}
              </div>
            ))}
            <button className="text-button" onClick={() => chat(r.botId)}>
              Chat with this bot <ArrowRight size={13} />
            </button>
          </div>
        </details>
      ))}
    </main>
  );
}
