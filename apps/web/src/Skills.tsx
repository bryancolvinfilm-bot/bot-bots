import { ArrowRight, Download, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Bootstrap, Skill } from '../../../packages/shared/types';
import { api } from './api';
import { downloadCode } from './CodeBlock';
import { Field, Heading, Modal } from './ui';
import './skills.css';

type Act = (fn: () => Promise<unknown>, message?: string) => Promise<void>;

/** Attribution filters this view; it never limits another bot's access to a skill. */
export function SkillLibrary({ data, act, botId }: { data: Bootstrap; act: Act; botId?: string }) {
  const [filter, setFilter] = useState(botId ?? 'all');
  const [selected, setSelected] = useState<Skill>();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Skill>();
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [origin, setOrigin] = useState(botId ?? '');
  const [busy, setBusy] = useState(false);
  const editable = data.accessRole !== 'viewer';
  const originName = (skill: Skill) =>
    skill.originBotName ??
    data.bots.find((bot) => bot.id === skill.originBotId)?.name ??
    'Former bot';
  const originOptions = new Map<string, string>();
  for (const bot of data.bots) if (!bot.prototypeId) originOptions.set(bot.id, bot.name);
  for (const skill of data.skills)
    if (skill.originBotId && !originOptions.has(skill.originBotId))
      originOptions.set(skill.originBotId, originName(skill));
  const skills = data.skills.filter((skill) =>
    filter === 'all'
      ? true
      : filter === 'unassigned'
        ? !skill.originBotId && !skill.builtIn
        : skill.originBotId === filter,
  );
  function open(skill: Skill) {
    setSelected(skill);
    setContent(skill.content);
    setName(skill.name);
    setEditing(false);
    setCreating(false);
  }
  function close() {
    if (busy) return;
    setSelected(undefined);
    setCreating(false);
    setEditing(false);
  }
  async function change(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await act(fn, message);
    } finally {
      setBusy(false);
    }
  }
  const controls = (
    <button
      className="primary small"
      disabled={!editable}
      onClick={() => {
        setCreating(true);
        setEditing(true);
        setSelected(undefined);
        setName('');
        setContent('');
        setOrigin(botId ?? '');
      }}
    >
      <Plus size={15} />
      New skill
    </button>
  );
  return (
    <section
      className={`skill-library ${botId ? 'compact' : ''}`}
      aria-label={botId ? 'Bot skills' : 'Shared skills'}
    >
      {botId ? (
        <div className="panel-title">
          <h3>
            <Zap size={17} />
            Skills
          </h3>
          {controls}
        </div>
      ) : (
        <Heading
          eyebrow="A FEW TRICKS UP THEIR SLEEVES"
          title="Shared skills"
          description="Reusable Markdown playbooks for every bot. Original bot associations stay with skills, even after that bot is archived or deleted."
        >
          {controls}
        </Heading>
      )}
      {botId && (
        <p className="subtle">
          Made with this bot, shared with everyone. Choose All shared skills to use the whole
          library.
        </p>
      )}
      <div className="filter-row">
        <select
          aria-label="Filter skills by original bot"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">All shared skills</option>
          <option value="unassigned">No original bot</option>
          {[...originOptions].map(([id, label]) => (
            <option key={id} value={id}>
              Made with {label}
            </option>
          ))}
        </select>
      </div>
      {!skills.length && (
        <p className="subtle">
          No skills here yet. Ask this bot to make a skill, or add one with New skill.
        </p>
      )}
      <div className="skills-grid">
        {skills.map((skill) => (
          <button
            type="button"
            className="panel skill-card"
            key={skill.id}
            data-skill-id={skill.id}
            onClick={() => open(skill)}
          >
            <div className="section-icon">
              <Zap size={20} />
            </div>
            <h3>{skill.name.replaceAll('-', ' ')}</h3>
            <small className="skill-origin">
              {skill.builtIn
                ? 'Included with Bot-Bots'
                : skill.originBotId
                  ? `Made with ${originName(skill)}`
                  : 'Shared with everyone'}
            </small>
            <p>
              {skill.description ??
                skill.content
                  .replace(/^---[\s\S]*?---/, '')
                  .replace(/[#*`]/g, '')
                  .trim()
                  .slice(0, 140)}
            </p>
            <span>
              Open playbook <ArrowRight size={14} />
            </span>
          </button>
        ))}
      </div>
      {(selected || creating) && (
        <Modal title={creating ? 'New shared skill' : selected!.name} close={close} wide>
          {selected?.builtIn ? (
            <p className="notice">Included with Bot-Bots. This help is updated with the app.</p>
          ) : (
            <>
              <p className="subtle">
                Shared with every bot
                {selected?.originBotId ? ` · Originally made with ${originName(selected)}` : ''}.
                Bot archive or deletion keeps this skill.
              </p>
              {!creating && (
                <div className="button-row">
                  <button
                    className="secondary small"
                    disabled={!editable || busy}
                    onClick={() => setEditing(!editing)}
                  >
                    <Pencil size={13} />
                    {editing ? 'Preview Markdown' : 'Edit Markdown'}
                  </button>
                  <button
                    className="secondary small"
                    disabled={!editable || busy}
                    onClick={() => setDeleting(selected)}
                  >
                    <Trash2 size={13} />
                    Delete skill
                  </button>
                </div>
              )}
            </>
          )}
          {editing ? (
            <>
              <Field label="Skill name">
                <input
                  required
                  maxLength={160}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              {creating && (
                <Field label="Original bot (optional)">
                  <select
                    aria-label="Original bot"
                    value={origin}
                    onChange={(event) => setOrigin(event.target.value)}
                  >
                    <option value="">No original bot</option>
                    {data.bots
                      .filter((bot) => !bot.deletedAt && !bot.prototypeId)
                      .map((bot) => (
                        <option key={bot.id} value={bot.id}>
                          {bot.name}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
              <Field label="Skill Markdown (.md)">
                <textarea
                  className="code-input full-width"
                  aria-label="Skill Markdown"
                  rows={22}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
              </Field>
            </>
          ) : (
            <div className="markdown skill-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content.replace(/^---[\s\S]*?---\s*/, '')}
              </ReactMarkdown>
            </div>
          )}
          <div className="modal-footer">
            {selected && (
              <button
                className="secondary"
                onClick={() =>
                  downloadCode(
                    content,
                    `${name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'skill'}.md`,
                  )
                }
              >
                <Download size={14} />
                Download .md
              </button>
            )}
            {editing && !selected?.builtIn && (
              <button
                className="primary"
                disabled={busy || !name.trim() || !content.trim() || content.length > 60000}
                onClick={() =>
                  void change(async () => {
                    const saved = await api<Skill>(
                      creating ? '/skills' : `/skills/${encodeURIComponent(selected!.id)}`,
                      creating ? 'POST' : 'PUT',
                      { name, content, ...(creating && origin ? { originBotId: origin } : {}) },
                    );
                    setSelected(saved);
                    setCreating(false);
                    setEditing(false);
                  }, 'Skill saved')
                }
              >
                Save skill
              </button>
            )}
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title="Are you sure?" close={() => !busy && setDeleting(undefined)}>
          <p>Delete “{deleting.name}” from the shared skills library for all bots?</p>
          <div className="modal-footer">
            <button
              className="secondary"
              autoFocus
              disabled={busy}
              onClick={() => setDeleting(undefined)}
            >
              No
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void change(async () => {
                  await api(`/skills/${encodeURIComponent(deleting.id)}`, 'DELETE', {
                    confirm: true,
                  });
                  setDeleting(undefined);
                  setSelected(undefined);
                  setEditing(false);
                }, 'Skill deleted')
              }
            >
              Yes
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
